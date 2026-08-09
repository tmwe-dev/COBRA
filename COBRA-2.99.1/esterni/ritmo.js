// esterni/ritmo.js — Muoversi come una persona, soprattutto su LinkedIn.
//
// PERCHÉ SEPARATO DALLE REGOLE DI INVIO
//
// modules/security/regole-invio.js decide SE un messaggio può partire: orari,
// limiti, destinatario. Questo file decide COME ci si muove — quanto si aspetta
// prima di ogni gesto, quando ci si ferma a riposare, ogni quanto si smette.
//
// Sono due cose diverse. Il primo protegge il destinatario e il buon senso; il
// secondo protegge dal riconoscimento automatico. Un account può essere bloccato
// pur non avendo mandato un solo messaggio: basta leggere troppo, troppo in
// fretta, troppo regolarmente.
//
// PERCHÉ LINKEDIN HA NUMERI PIÙ SEVERI
//
// Non è una mia impressione, è scritto nel Navigator. In
// src/hooks/useLinkedInAutoSync.ts, prima riga del commento:
//
//   "LinkedIn ha detection anti-bot più aggressiva di WhatsApp: niente cadenza
//    a minuti come WA. Si pianificano N letture al giorno (default 3) in slot
//    pseudo-random distribuiti uniformemente nella finestra operativa
//    (default 9-19 CET), con jitter ±20 min."
//
// Tre letture al giorno. Non tre all'ora: al giorno. E con almeno mezz'ora fra
// una e l'altra (MIN_GAP_BETWEEN_SYNCS_MS = 30 * 60_000).
//
// DA DOVE VENGONO GLI ALTRI NUMERI
//
// Dall'estensione Partner Connect del Navigator, quella archiviata:
//
//   archive/partner-connect-extension-v3.4.3/rate-limiter.js:9-22
//     linkedin.com → perHour 20, perDay 80, minInterval 8000,
//     burstThreshold 10, cooldownAfterBurst 300000
//
//   archive/partner-connect-extension-v3.4.3/stealth.js:19-30, 86-101
//     pause gaussiane per tipo di gesto, 15 pagine per sessione,
//     5 minuti di pausa fra sessioni, 3 sessioni all'ora,
//     10% di probabilità di una pausa "di rumore" da 5-15 secondi
//
// Quel codice è in archive/ e non è più attivo da nessuna parte. Era la cosa
// più curata che avessero scritto sull'argomento, ed è finita in un cassetto:
// l'estensione che usano oggi non ha un solo limite. Qui torna in servizio.

// ── Le pause, per tipo di gesto ──
//
// Media e deviazione in millisecondi, da stealth.js. Non sono numeri a caso:
// una persona che legge un profilo ci mette qualche secondo, una che decide
// cosa fare dopo ne impiega di più, una che scorre quasi niente.
//
// La forma gaussiana conta più dei valori. Una pausa fissa — anche lunga — è un
// battito: 8 secondi esatti, sempre, si riconosce meglio di 3 secondi variabili.
const PROFILI = {
  veloce:  { media: 1500, scarto: 500 },
  leggere: { media: 4000, scarto: 1500 },
  pensare: { media: 7000, scarto: 2500 },
  navigare: { media: 2500, scarto: 800 },
  scorrere: { media: 800, scarto: 300 },
};

const LIMITI = {
  li: {
    nome: 'LinkedIn',
    allOra: 20,
    alGiorno: 80,
    intervalloMinimo: 8000,      // fra due gesti qualsiasi
    gestiPerSessione: 15,
    pausaFraSessioni: 5 * 60000,
    sessioniAllOra: 3,
    profiloBase: 'leggere',
  },
  // WhatsApp: piu' tollerante, perche' li' il rischio non e' il ritmo ma
  // il destinatario. I numeri restano prudenti ma non paralizzanti.
  wa: {
    nome: 'WhatsApp',
    allOra: 60,
    alGiorno: 300,
    intervalloMinimo: 2000,
    gestiPerSessione: 40,
    pausaFraSessioni: 60000,
    sessioniAllOra: 6,
    profiloBase: 'veloce',
  },
};

// ── Quando guida Luca ──
//
// Stessa distinzione delle regole di invio, per lo stesso motivo. Le pause e i
// limiti di sessione servono a far sembrare umano un programma; se e' Luca a
// cliccare, l'umano c'e' gia'. Farlo aspettare otto secondi fra un'operazione
// e l'altra, e cinque minuti ogni quindici, significa rendere il programma
// inutilizzabile per proteggerlo da un rischio che in quel momento non corre.
//
// Restano i tetti di quantita', piu' alti: un account che fa trecento
// operazioni in un giorno si nota comunque, chiunque abbia premuto i tasti.
const DIRETTO = {
  li: { allOra: 60, alGiorno: 200, intervalloMinimo: 1200, gestiPerSessione: 999,
        pausaFraSessioni: 0, sessioniAllOra: 999, profiloBase: 'veloce' },
  wa: { allOra: 200, alGiorno: 800, intervalloMinimo: 500, gestiPerSessione: 999,
        pausaFraSessioni: 0, sessioniAllOra: 999, profiloBase: 'veloce' },
};

function limitiPer(gruppo, modo) {
  const base = LIMITI[gruppo];
  if (!base) return null;
  return modo === 'diretto' ? { ...base, ...DIRETTO[gruppo] } : base;
}

/** Un numero attorno a una media, con la forma di una distribuzione normale. */
function _gaussiana(media, scarto) {
  // Box-Muller: due numeri uniformi diventano uno normale.
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  const val = media + z * scarto;
  return Math.max(200, Math.round(val));   // mai sotto due decimi di secondo
}

function pausaPer(tipo) {
  const p = PROFILI[tipo] || PROFILI.veloce;
  return _gaussiana(p.media, p.scarto);
}

// ── Il registro dei gesti ──
//
// Sta in chrome.storage, non in memoria: il service worker viene spento da
// Chrome ogni pochi minuti, e un contatore che riparte da zero a ogni risveglio
// e' un contatore che non conta.
const _CHIAVE = 'cobra_ritmo_v1';

async function _leggi() {
  try {
    const d = await chrome.storage.local.get([_CHIAVE]);
    return d[_CHIAVE] || { gesti: [], sessioni: [], sessioneDa: 0, nellaSessione: 0 };
  } catch (_) {
    return { gesti: [], sessioni: [], sessioneDa: 0, nellaSessione: 0 };
  }
}

async function _scrivi(stato) {
  try { await chrome.storage.local.set({ [_CHIAVE]: stato }); } catch (_) { /* best-effort */ }
}

/**
 * Si può fare un gesto adesso su questo sito? E quanto bisogna aspettare prima?
 *
 * Torna sempre { si, aspetta, motivo }. Quando `si` è false il chiamante NON
 * deve procedere: non è un suggerimento.
 */
async function chiediIlPasso(gruppo, tipo, modo = 'automatico') {
  const L = limitiPer(gruppo, modo);
  if (!L) return { si: true, aspetta: 0 };
  const diretto = modo === 'diretto';

  const stato = await _leggi();
  const ora = Date.now();

  // Si tiene solo la giornata: il resto e' peso inutile.
  stato.gesti = (stato.gesti || []).filter(t => ora - t < 86400000);
  stato.sessioni = (stato.sessioni || []).filter(t => ora - t < 3600000);

  const nellUltimOra = stato.gesti.filter(t => ora - t < 3600000).length;
  if (nellUltimOra >= L.allOra) {
    await _scrivi(stato);
    return { si: false, aspetta: 0,
      motivo: `su ${L.nome} ho gia' fatto ${nellUltimOra} operazioni nell'ultima ora (limite ${L.allOra})`,
      cosaFare: 'Aspetto che passi un po\' di tempo. Su LinkedIn insistere si nota.' };
  }
  if (stato.gesti.length >= L.alGiorno) {
    await _scrivi(stato);
    return { si: false, aspetta: 0,
      motivo: `su ${L.nome} ho gia' fatto ${stato.gesti.length} operazioni oggi (limite ${L.alGiorno})`,
      cosaFare: 'Il conto riparte domani.' };
  }

  // ── Le sessioni ──
  //
  // Una persona non lavora su LinkedIn per tre ore filate: fa un giro, si
  // ferma, torna dopo. Quindici gesti e poi cinque minuti di pausa, e non piu'
  // di tre giri all'ora.
  if (stato.nellaSessione >= L.gestiPerSessione) {
    const daFinePausa = ora - (stato.sessioneDa + 0);
    if (daFinePausa < L.pausaFraSessioni) {
      const manca = Math.ceil((L.pausaFraSessioni - daFinePausa) / 1000);
      await _scrivi(stato);
      return { si: false, aspetta: 0,
        motivo: `ho fatto ${stato.nellaSessione} operazioni di fila su ${L.nome}`,
        cosaFare: `Mi fermo ${manca} secondi, come farebbe una persona che si alza un attimo.` };
    }
    // Pausa finita: comincia una sessione nuova
    if (stato.sessioni.length >= L.sessioniAllOra) {
      await _scrivi(stato);
      return { si: false, aspetta: 0,
        motivo: `ho gia' fatto ${stato.sessioni.length} sessioni su ${L.nome} in un'ora`,
        cosaFare: 'Aspetto la prossima ora.' };
    }
    stato.nellaSessione = 0;
    stato.sessioneDa = ora;
    stato.sessioni.push(ora);
  }
  if (!stato.sessioneDa) {
    stato.sessioneDa = ora;
    stato.sessioni.push(ora);
  }

  // ── Quanto aspettare prima di questo gesto ──
  const ultimo = stato.gesti.length ? stato.gesti[stato.gesti.length - 1] : 0;
  const passato = ora - ultimo;
  let aspetta = pausaPer(tipo || L.profiloBase);
  if (ultimo && passato < L.intervalloMinimo) {
    aspetta = Math.max(aspetta, L.intervalloMinimo - passato);
  }

  // Una volta su dieci, una pausa piu' lunga senza motivo apparente. E' il
  // dettaglio che distingue una persona distratta da un programma: chi lavora
  // ogni tanto si ferma a guardare qualcos'altro.
  // La pausa "di rumore" serve a somigliare a una persona distratta. Se la
  // persona c'e' davvero e sta aspettando una risposta, e' solo lentezza.
  if (!diretto && Math.random() < 0.10) {
    aspetta += 5000 + Math.random() * 10000;
  }

  stato.gesti.push(ora);
  stato.nellaSessione = (stato.nellaSessione || 0) + 1;
  await _scrivi(stato);

  return { si: true, aspetta: Math.round(aspetta), nellaSessione: stato.nellaSessione,
    oggi: stato.gesti.length, limiteGiorno: L.alGiorno };
}

/** Com'è messo il ritmo, per poterlo raccontare senza indovinare. */
async function comeVaIlRitmo() {
  const stato = await _leggi();
  const ora = Date.now();
  const gesti = (stato.gesti || []).filter(t => ora - t < 86400000);
  return {
    oggi: gesti.length,
    ultimOra: gesti.filter(t => ora - t < 3600000).length,
    nellaSessione: stato.nellaSessione || 0,
    sessioniQuestOra: (stato.sessioni || []).filter(t => ora - t < 3600000).length,
    limiti: LIMITI,
  };
}

// ── UNA COSA PER VOLTA ──
//
// Regola di Luca, 7 agosto: "non deve mai effettuare le cose in serie,
// meccanicamente, mai piu' di una chiamata quindi mai sovrapposizione".
//
// Ha ragione, e il difetto era reale: i comandi nuovi su LinkedIn partivano
// appena chiamati. Se il modello ne chiedeva tre — leggi la posta, apri Samuel,
// apri Sudeep — partivano insieme e arrivavano a LinkedIn nello stesso istante.
// Nessuna persona apre tre conversazioni contemporaneamente: e' la firma piu'
// riconoscibile che esista.
//
// Qui c'e' una coda: la seconda operazione aspetta che la prima abbia finito,
// e in mezzo passa una pausa che non e' mai la stessa.
let _codaLi = Promise.resolve();

// Quanto al massimo puo' durare UN passo prima che la coda lo pianti li'.
// Non e' il tempo che serve al lavoro: e' il tempo oltre il quale un lavoro
// che non risponde va considerato perso.
const _MASSIMO_PER_PASSO = 25000;

/** Una promessa che non puo' restare appesa per sempre. */
function _conLimite(promessa, ms, cosa) {
  return new Promise((risolvi) => {
    let finito = false;
    const t = setTimeout(() => {
      if (finito) return;
      finito = true;
      console.warn(`[COBRA Ritmo] ${cosa}: nessuna risposta dopo ${ms / 1000}s, proseguo`);
      risolvi(null);
    }, ms);
    Promise.resolve(promessa).then(
      (v) => { if (!finito) { finito = true; clearTimeout(t); risolvi(v); } },
      (e) => { if (!finito) { finito = true; clearTimeout(t); console.warn(`[COBRA Ritmo] ${cosa} fallito: ${e && e.message}`); risolvi(null); } }
    );
  });
}

// ── Una coda che non si puo' piantare ──
//
// Il 7 agosto linkedin_elenco_chat e' passato da 17 secondi a un timeout di
// 90, mentre la stessa scheda rispondeva alla diagnosi in 0,3. La pagina
// stava benissimo: era la coda a essere ferma.
//
// Il motivo: avevo ricaricato LinkedIn mentre un executeScript era in corso.
// Quella chiamata non ha mai risposto — ne' bene ne' male — e siccome ogni
// lavoro nuovo si aggancia al precedente, TUTTI quelli dopo sono rimasti in
// attesa di una cosa che non sarebbe mai arrivata.
//
// Una coda serve a non fare due cose insieme. Non deve poter diventare il
// motivo per cui non se ne fa piu' nessuna. Adesso ogni passo ha un limite:
// se non risponde entro quello, si registra e si va avanti.
// Oltre questo, chi ha chiesto il lavoro si e' gia' arreso: il ponte lascia
// cadere i comandi dopo 90-180 secondi, e rifare un gesto che nessuno sta piu'
// aspettando serve solo a far aspettare quello dopo.
const _TROPPO_VECCHIO = 45000;

function inFila(lavoro, cosa = 'un\'operazione') {
  // ── Non fare lavoro che nessuno aspetta piu' ──
  //
  // Il 7 agosto linkedin_elenco_chat scadeva a 90 secondi mentre la pagina
  // rispondeva in 135 millisecondi. La coda non era bloccata: era PIENA.
  //
  // Ogni tentativo scaduto lasciava il suo gesto in fila e continuava a
  // girare. Tre tentativi accumulati facevano aspettare il quarto per un
  // minuto e mezzo — e il quarto scadeva a sua volta, aggiungendosene un
  // quinto. Una coda che si autoalimenta.
  //
  // Qui ogni lavoro si segna quando e' entrato. Se quando arriva il suo turno
  // e' passato troppo tempo, chi l'aveva chiesto se n'e' andato: si salta.
  const entrato = Date.now();
  const forse = () => {
    const atteso = Date.now() - entrato;
    if (atteso > _TROPPO_VECCHIO) {
      console.warn(`[COBRA Ritmo] salto "${cosa}": in coda da ${Math.round(atteso / 1000)}s, chi l'aveva chiesto si e' gia' arreso`);
      return Promise.resolve(null);
    }
    return _conLimite(lavoro(), _MASSIMO_PER_PASSO, cosa);
  };
  const mio = _codaLi.then(forse, forse);
  _codaLi = mio.then(() => {}, () => {});
  return mio;
}

/** Sblocca la coda a mano. Serve quando si sa di aver interrotto qualcosa. */
function sbloccaCoda() {
  _codaLi = Promise.resolve();
  return { ok: true, nota: 'coda azzerata: la prossima operazione parte subito' };
}

/**
 * Il gesto umano completo su una scheda: aspetta il proprio turno, fa una
 * pausa credibile, muove il mouse, ogni tanto scorre, poi esegue.
 *
 * `tipo` viene dai profili: 'leggere' per aprire una conversazione,
 * 'pensare' prima di scrivere, 'navigare' per spostarsi.
 */
async function comeUnaPersona(tabId, tipo, lavoro) {
  return inFila(async () => {
    await new Promise(r => setTimeout(r, pausaPer(tipo)));
    // Il movimento del mouse e' un di piu': se la pagina non risponde — perche'
    // sta navigando, o e' stata ricaricata — si prosegue senza. Prima una
    // chiamata appesa qui bloccava tutta la coda.
    await _conLimite(_mouseEScorrimento(tabId), 8000, 'movimento del mouse');
    return await lavoro();
  }, `gesto "${tipo}"`);
}

/**
 * Muove il puntatore lungo una traiettoria curva e ogni tanto scorre la
 * pagina di poco.
 *
 * Perche' curva: un mouse che va da A a B in linea retta a velocita' costante
 * non esiste fuori dai programmi. La mano umana parte, accelera, corregge e
 * rallenta — e i sistemi che cercano gli automatismi guardano esattamente
 * questo, prima ancora dei tempi.
 */
async function _mouseEScorrimento(tabId) {
  if (!tabId) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const g = (m, s) => {
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        return Math.max(0, m + Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * s);
      };
      const W = window.innerWidth, H = window.innerHeight;
      let x = g(W / 2, W / 5), y = g(H / 2, H / 5);
      const bx = g(W / 2, W / 4), by = g(H / 2, H / 4);   // il punto di arrivo
      const passi = 12 + Math.floor(Math.random() * 10);

      for (let i = 1; i <= passi; i++) {
        const t = i / passi;
        // Accelera e rallenta invece di andare a velocita' fissa.
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const nx = x + (bx - x) * e + g(0, 3);
        const ny = y + (by - y) * e + g(0, 3);
        const el = document.elementFromPoint(
          Math.min(W - 1, Math.max(0, nx)), Math.min(H - 1, Math.max(0, ny)));
        if (el) {
          el.dispatchEvent(new MouseEvent('mousemove', {
            clientX: nx, clientY: ny, bubbles: true, composed: true,
          }));
        }
        await new Promise(r => setTimeout(r, 12 + Math.random() * 28));
      }

      // Una volta su tre si scorre un po', come chi scorre l'occhio.
      if (Math.random() < 0.34) {
        const quanto = Math.round(g(140, 90)) * (Math.random() < 0.25 ? -1 : 1);
        const dove = document.querySelector('.msg-conversations-container__conversations-list')
          || document.querySelector('#pane-side') || window;
        try {
          if (dove === window) window.scrollBy({ top: quanto, behavior: 'smooth' });
          else dove.scrollBy({ top: quanto, behavior: 'smooth' });
        } catch (_) { /* alcune liste non si lasciano scorrere: pazienza */ }
        await new Promise(r => setTimeout(r, 400 + Math.random() * 900));
      }
    },
  });
}

/** Prima di premere un tasto o un pulsante: una persona ci mette un momento. */
async function primaDiScrivere() {
  await new Promise(r => setTimeout(r, pausaPer('pensare')));
}

globalThis.Ritmo = {
  chiedi: chiediIlPasso, stato: comeVaIlRitmo, pausaPer, limitiPer,
  inFila, comeUnaPersona, primaDiScrivere, sbloccaCoda,
  LIMITI, DIRETTO, PROFILI,
};
