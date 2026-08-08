// modules/routes/consulta.js — La porta da cui l'agente vocale chiede a COBRA.
//
// PERCHÉ SERVE
//
// L'agente COBRA su ElevenLabs non gira sul Mac di Luca: gira sui server di
// ElevenLabs. Il suo prompt gli dice "a ogni turno chiami `cobra_consulta`" —
// ma quello strumento non è mai esistito, e anche esistendo puntava a
// 127.0.0.1, che dai server di ElevenLabs non è raggiungibile.
//
// Questa è quella porta. Da fuori arriva quello che Luca ha detto; da qui
// esce quello che l'agente deve rispondere.
//
// IL PROBLEMA DEI TEMPI, CHE È IL PUNTO DIFFICILE
//
// Un turno di COBRA può durare minuti: apre pagine, confronta, scrive file.
// Una chiamata webhook no — chi la fa si stanca dopo pochi secondi, e una
// conversazione a voce si rompe molto prima.
//
// Quindi non si aspetta la fine. Si aspetta un po', e:
//
//   - se il lavoro è finito in tempo → si risponde con la risposta vera
//   - se no → si risponde "ci sto lavorando" e si lascia un numero
//
// L'agente richiama con quel numero e riceve il risultato quando c'è. È lo
// stesso identico modo in cui si comporta una persona a cui chiedi una cosa
// che richiede tempo: non resta muta finché non ha finito, dice "aspetta" e
// poi torna. Il prompt dell'agente già lo prevede: "guardo, dammi un momento".
//
// SICUREZZA
//
// Questa porta, se il tunnel è aperto, è raggiungibile da internet. Quindi:
//
//   - vuole un token nell'intestazione, e senza quello risponde 401
//   - il token è separato da quello di COBRA: se domani si chiude il tunnel,
//     si butta questo senza toccare il resto
//   - non espone nessun altro comando: da qui si può solo parlare, cioè fare
//     le stesse cose che Luca farebbe scrivendo nel pannello

const http = require('http');

const ATTESA_RISPOSTA_MS = 12000;   // quanto si aspetta prima di dire "un momento"
const VITA_LAVORO_MS = 900000;      // un lavoro dimenticato non resta in memoria per sempre

const _lavori = new Map();
let _prossimoId = 0;

function _pulisci() {
  const ora = Date.now();
  for (const [id, l] of _lavori) {
    if (ora - l.iniziato > VITA_LAVORO_MS) _lavori.delete(id);
  }
}

/** Un turno di COBRA, chiamando la pipeline vera invece di riscriverla. */
function _avviaTurno(messaggio, porta, token) {
  return new Promise((risolvi) => {
    const corpo = JSON.stringify({ message: messaggio, voiceMode: true });
    const req = http.request({
      host: '127.0.0.1', port: porta, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo), 'X-Cobra-Token': token },
    }, (r) => {
      let dati = '';
      r.on('data', (c) => { dati += c; });
      r.on('end', () => {
        try {
          const j = JSON.parse(dati);
          risolvi({ ok: true, testo: j.content || j.message || j.error || '' });
        } catch (e) { risolvi({ ok: false, testo: '', errore: 'risposta illeggibile' }); }
      });
    });
    req.on('error', (e) => risolvi({ ok: false, testo: '', errore: e.message }));
    req.write(corpo);
    req.end();
  });
}

function register(router, ctx) {
  const TOKEN = process.env.COBRA_VOCE_TOKEN || '';

  const rispondi = (res, codice, corpo) => {
    res.writeHead(codice, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(corpo));
  };

  router.post('/api/cobra-consulta', async (corpo, res, _percorso, req) => {
    // ── La porta è chiusa se non è stata aperta apposta ──
    //
    // Senza token nel .env questa strada non esiste. Non è un caso limite: è
    // il comportamento normale, perché finché Luca non decide di aprire il
    // tunnel non c'è motivo che questo indirizzo risponda a qualcuno.
    if (!TOKEN) {
      return rispondi(res, 503, {
        say: 'La voce non è ancora collegata. Luca deve mettere COBRA_VOCE_TOKEN nel file .env.',
      });
    }
    const dato = req && (req.headers['x-cobra-voce'] || req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (dato !== TOKEN) {
      ctx.log('[Voce] chiamata rifiutata: token assente o sbagliato');
      return rispondi(res, 401, { say: 'Non sei autorizzato a parlare con COBRA.' });
    }

    let dati = {};
    try { dati = JSON.parse(corpo || '{}'); } catch (_) { /* corpo illeggibile */ }

    _pulisci();

    // ── Caso A: sta richiamando per un lavoro già avviato ──
    if (dati.id) {
      const l = _lavori.get(String(dati.id));
      if (!l) {
        return rispondi(res, 200, { say: 'Quel lavoro non lo trovo più. Ripetimi cosa ti serve.' });
      }
      if (l.finito) {
        _lavori.delete(String(dati.id));
        return rispondi(res, 200, { say: l.risposta, finito: true });
      }
      // Ancora in corso: si aspetta ancora un po' prima di rispondere di nuovo
      const arrivata = await Promise.race([
        l.promessa,
        new Promise(r => setTimeout(() => r(null), ATTESA_RISPOSTA_MS)),
      ]);
      if (arrivata) {
        _lavori.delete(String(dati.id));
        return rispondi(res, 200, { say: arrivata.testo, finito: true });
      }
      const secondi = Math.round((Date.now() - l.iniziato) / 1000);
      return rispondi(res, 200, {
        say: `Ci sto ancora lavorando, sono ${secondi} secondi. Richiamami fra poco.`,
        id: String(dati.id), in_corso: true,
      });
    }

    // ── Caso B: una richiesta nuova ──
    const messaggio = String(dati.messaggio || dati.message || dati.testo || '').trim();
    if (!messaggio) {
      return rispondi(res, 200, { say: 'Non ho capito cosa ti serve. Ripeti pure.' });
    }

    ctx.log(`[Voce] "${messaggio.slice(0, 60)}"`);

    const porta = Number(process.env.PORT) || 3000;
    const promessa = _avviaTurno(messaggio, porta, process.env.COBRA_API_TOKEN || '');

    const id = String(++_prossimoId);
    const lavoro = { iniziato: Date.now(), finito: false, risposta: '', promessa };
    _lavori.set(id, lavoro);
    promessa.then((r) => { lavoro.finito = true; lavoro.risposta = r.testo; });

    const subito = await Promise.race([
      promessa,
      new Promise(r => setTimeout(() => r(null), ATTESA_RISPOSTA_MS)),
    ]);

    if (subito) {
      _lavori.delete(id);
      if (!subito.ok) {
        return rispondi(res, 200, { say: 'Non riesco a raggiungere i miei strumenti adesso. Riprovo fra poco.' });
      }
      return rispondi(res, 200, { say: subito.testo, finito: true });
    }

    // Non è finito in tempo: si dice così, e si lascia il numero per richiamare.
    return rispondi(res, 200, {
      say: 'Ci sto lavorando, dammi un momento.',
      id, in_corso: true,
    });
  });

  // Serve a Luca per provare che il tunnel arriva davvero fin qui, senza
  // scomodare il modello e senza consumare un turno.
  router.get('/api/cobra-consulta/prova', (b, res) => {
    rispondi(res, 200, {
      vivo: true,
      configurato: !!TOKEN,
      nota: TOKEN ? 'La porta c\'è e vuole il token.' : 'Manca COBRA_VOCE_TOKEN nel .env.',
    });
  });
}

module.exports = { register };
