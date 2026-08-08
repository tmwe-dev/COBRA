// modules/collega/recupero.js — Quando qualcosa non riesce, capire PERCHÉ
// prima di decidere cosa fare.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHÉ ESISTE
//
// I ripieghi di COBRA oggi sono sequenze fisse:
//
//     metodo 1 fallito → metodo 2 → metodo 3 → mi arrendo
//
// Funziona quando il guasto è quello previsto. Non funziona quando è un altro,
// e allora si provano tre strade che non c'entrano niente col problema vero.
// L'8 agosto: `linkedin_connect` andava in timeout perché nessuna estensione
// ascoltava su quel canale, e sono stati fatti quattro tentativi identici —
// riprovare non poteva funzionare, perché il problema non era il tentativo.
//
// La differenza sta in una domanda: **che tipo di guasto è?**
//
//   passeggero      la pagina non era pronta, la rete ha singhiozzato, la
//                   scheda dormiva  →  RIPROVARE ha senso
//   di strategia    il pulsante non c'è più, il modulo è cambiato, il
//                   selettore non trova niente  →  riprovare è inutile,
//                   serve un ALTRO MODO
//   dipendenza      serve una password, un codice, una conferma, un file che
//                   non c'è  →  serve LUCA, e insistere lo fa solo aspettare
//   impossibile     il dato non esiste, la tratta non c'è  →  si CHIUDE
//                   dicendolo, ed è una risposta legittima
//
// Riprovare un guasto di strategia è il modo più comune di girare a vuoto.
// Chiedere a Luca un guasto passeggero è il modo più comune di disturbarlo per
// niente.
//
// ── PERCHÉ DETERMINISTICO ──
//
// Si legge il messaggio d'errore, che è un fatto. Chiedere a un modello di
// classificare il proprio fallimento è chiedergli di giudicarsi: dirà che è
// passeggero, perché è la risposta che gli permette di riprovare.
// ══════════════════════════════════════════════════════════════════════

const TIPI = {
  PASSEGGERO: 'passeggero',
  STRATEGIA: 'strategia',
  DIPENDENZA: 'dipendenza',
  IMPOSSIBILE: 'impossibile',
  SCONOSCIUTO: 'sconosciuto',
};

// L'ordine conta: si guarda prima quello che ha conseguenze più gravi
// sbagliarlo. Classificare come "passeggero" un guasto che richiede Luca
// significa farlo aspettare senza dirglielo.
const SEGNI = [
  {
    tipo: TIPI.DIPENDENZA,
    dice: /\b(password|credenzial|login|accedi|autentic|non sei loggato|not logged|sign in|2fa|otp|codice di verifica|captcha|verifica che sei|paywall|abbonamento|subscription required|403|401|unauthorized|forbidden)\w*/i,
    cosaFare: 'Serve Luca: non è una cosa che si sblocca riprovando. Digli ESATTAMENTE '
      + 'cosa serve (quale sito, quale accesso) e fermati.',
  },
  {
    tipo: TIPI.IMPOSSIBILE,
    dice: /\b(nessun risultato|no results|nessun volo|non esist|not found|404|nessuna tratta|non ci sono|zero risultati|nessuna corrispondenza)\w*/i,
    cosaFare: 'Il dato non c\'è. Non è un fallimento: è una risposta. Verificalo su UNA '
      + 'seconda fonte, poi dillo a Luca con quello che hai guardato.',
  },
  {
    tipo: TIPI.STRATEGIA,
    dice: /\b(selettore|selector|non trovo|not found on page|nessun elemento|no such element|element not|pulsante|button not|campo non|il modulo|form changed|non e' fra gli elementi|zero campi|nessun campo)\w*/i,
    cosaFare: 'La pagina non è come pensavi. NON riprovare uguale: chiama guarda_pagina '
      + 'e agisci sugli elementi che ti restituisce, oppure cambia sito.',
  },
  {
    tipo: TIPI.PASSEGGERO,
    dice: /\b(timeout|scaduto|non ha risposto|network|rete|econnreset|etimedout|socket|troppo lento|loading|sta caricando|non e' pronta|discarded|scheda dormiva|503|502|429|rate limit)\w*/i,
    cosaFare: 'Può essere passata: aspetta e riprova UNA volta. Se casca ancora, '
      + 'è un problema di strategia travestito da lentezza — cambia strada.',
  },
];

/**
 * Che tipo di guasto è.
 *
 * @param {string} messaggio  il motivo del fallimento, come l'ha detto lo strumento
 * @param {number} giaProvato quante volte si è già provato questa stessa cosa
 */
function checosaE(messaggio, giaProvato = 0) {
  const t = String(messaggio || '');

  let trovato = null;
  for (const s of SEGNI) {
    if (s.dice.test(t)) { trovato = s; break; }
  }

  if (!trovato) {
    return {
      tipo: TIPI.SCONOSCIUTO,
      riprovare: giaProvato < 1,
      cosaFare: giaProvato < 1
        ? 'Non riconosco il guasto: prova UNA volta e guarda cosa cambia.'
        : 'Non riconosco il guasto e hai già provato. Cambia strada, oppure di\' a Luca cosa vedi.',
      perche: 'il messaggio d\'errore non dice di che si tratta',
    };
  }

  // ── La regola che vale più di tutta la tabella ──
  //
  // Un guasto passeggero che si ripete NON è passeggero. Due timeout di fila
  // sullo stesso comando non sono sfortuna: sono un problema di strategia
  // travestito da lentezza. L'8 agosto sono stati quattro, e ogni volta la
  // risposta è stata "riprova".
  if (trovato.tipo === TIPI.PASSEGGERO && giaProvato >= 2) {
    return {
      tipo: TIPI.STRATEGIA,
      riprovare: false,
      cosaFare: 'Sembrava un problema di lentezza, ma è già la ' + (giaProvato + 1)
        + 'ª volta: non lo è. Riprovare uguale non porta da nessuna parte — '
        + 'cambia strumento o cambia strada.',
      perche: `"${t.slice(0, 60)}" si ripete da ${giaProvato} tentativi: non è un caso`,
      eraSembrato: TIPI.PASSEGGERO,
    };
  }

  return {
    tipo: trovato.tipo,
    riprovare: trovato.tipo === TIPI.PASSEGGERO && giaProvato < 2,
    cosaFare: trovato.cosaFare,
    perche: `"${t.slice(0, 60)}"`,
  };
}

/**
 * Le domande da farsi quando un elemento non si trova, in ordine di costo.
 *
 * Non è un elenco di ripieghi da eseguire alla cieca: è la scaletta che
 * seguirebbe una persona, dalla cosa più probabile e più economica alla più
 * rara e più cara. Chi la usa si ferma appena una risponde.
 */
const SCALETTA_ELEMENTO_MANCANTE = [
  { domanda: 'la pagina ha finito di caricare?', come: 'wait_network_idle, poi guarda_pagina' },
  { domanda: 'c\'è un riquadro o un banner davanti?', come: 'detect_block, poi togli l\'ostacolo' },
  { domanda: 'sono sulla pagina giusta?', come: 'guarda_pagina e leggi url e titolo' },
  { domanda: 'l\'elemento è più in basso?', come: 'scroll_page, poi guarda_pagina di nuovo' },
  { domanda: 'il nome è cambiato?', come: 'guarda_pagina e cerca per SIGNIFICATO, non per testo esatto' },
  { domanda: 'è dentro un componente annidato?', come: 'guarda_pagina entra negli shadow root da solo' },
  { domanda: 'serve un accesso?', come: 'detect_block: se è un muro di login, servono le credenziali di Luca' },
  { domanda: 'il sito ha risposto con un errore?', come: 'guarda la console e le richieste di rete' },
  { domanda: 'esiste un\'altra strada per lo stesso dato?', come: 'un altro sito, un URL diretto, una ricerca' },
];

/** La scaletta come testo, per il prompt di chi deve recuperare. */
function scalettaInChiaro() {
  const righe = ['PRIMA DI ARRENDERTI, IN QUEST\'ORDINE:'];
  SCALETTA_ELEMENTO_MANCANTE.forEach((s, i) => {
    righe.push(`  ${i + 1}. ${s.domanda} → ${s.come}`);
  });
  righe.push('Fermati appena una risponde. Se arrivi in fondo, di\' a Luca cosa hai provato.');
  return righe.join('\n');
}

/**
 * Il consiglio completo per un fallimento: cosa è, cosa fare, e la scaletta
 * quando serve.
 */
function comeRecuperare(messaggio, giaProvato = 0) {
  const d = checosaE(messaggio, giaProvato);
  const fuori = { ...d };
  if (d.tipo === TIPI.STRATEGIA) fuori.scaletta = scalettaInChiaro();
  return fuori;
}

module.exports = {
  checosaE, comeRecuperare, scalettaInChiaro,
  TIPI, SCALETTA_ELEMENTO_MANCANTE,
};
