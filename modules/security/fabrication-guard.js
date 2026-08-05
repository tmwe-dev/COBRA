// modules/security/fabrication-guard.js — Guardia contro i dati inventati
//
// Il rischio peggiore per una segretaria virtuale non è sbagliare: è rispondere
// con dati verosimili ma falsi. Un prezzo inventato con la stessa sicurezza di
// uno reale porta a decisioni sbagliate, e chi legge non ha modo di accorgersene.
//
// Qui si intercettano due comportamenti:
//   1. la risposta contiene dati concreti (prezzi, orari, durate, nomi di
//      compagnie) ma nessuno strumento è stato usato per ottenerli;
//   2. la risposta annuncia una ricerca ("procedo a cercare", "un momento")
//      senza che alcuna ricerca sia avvenuta.

// Dati che nessuno può conoscere senza consultare una fonte
const SEGNALI_DATI_CONCRETI = [
  // Attenzione: nessun \b dopo il simbolo di valuta. € non è un carattere di
  // parola, quindi un confine di parola dopo di esso non si verifica mai e la
  // regola non scatterebbe su "555 €".
  { nome: 'prezzo', re: /(?:€|\$|£)\s?\d[\d.,]*|\d[\d.,]*\s?(?:€|\$|£)|\b\d[\d.,]*\s?(?:EUR|USD|GBP|euro|dollari|sterline)\b/i },
  { nome: 'durata', re: /\b\d{1,2}\s?(?:ore|h)\b(?:\s?e?\s?\d{1,2}\s?(?:minuti|min)\b)?/i },
  { nome: 'orario', re: /\b(?:[01]?\d|2[0-3])[:.][0-5]\d\b/ },
  { nome: 'percentuale', re: /\b\d{1,3}([.,]\d+)?\s?%/ },
  { nome: 'codice volo', re: /\b[A-Z]{2}\s?\d{2,4}\b/ },
];

// Frasi che promettono un'azione: se non seguono strumenti, è una promessa vuota
const PROMESSE_DI_AZIONE = [
  /\bprocedo a (cercare|verificare|controllare|consultare)/i,
  /\b(sto|starò) (cercando|verificando|controllando)/i,
  /\bun momento\b/i,
  /\battendi (un attimo|un momento)\b/i,
  /\bfaccio (subito )?(una )?(ricerca|verifica)/i,
  /\bvado a (cercare|vedere|controllare)/i,
  /\badesso (cerco|verifico|controllo)/i,
];

// Contesti in cui i numeri sono legittimi anche senza strumenti
const CONTESTI_LECITI = [
  /\bnon (ho|sono riuscito|posso)\b/i,     // sta dichiarando un limite
  /\besempio\b|\bad esempio\b|\bipotetic/i, // dichiara che è un esempio
  /\bnon (dispongo|ho accesso)\b/i,
];

/**
 * Analizza una risposta prima che arrivi all'utente.
 *
 * @param {string} testo        risposta prodotta dal modello
 * @param {object} contesto     { intent, toolsUsed, kbSnippets, hasPageContent }
 * @returns {{sospetta:boolean, motivi:string[], gravita:'nessuna'|'promessa'|'invenzione'}}
 */
function analizzaRisposta(testo, contesto = {}) {
  const risposta = String(testo || '');
  const motivi = [];
  if (!risposta.trim()) return { sospetta: false, motivi, gravita: 'nessuna' };

  const toolRiusciti = (contesto.toolsUsed || []).filter(t => t.ok !== false);
  const haFonte = toolRiusciti.length > 0
    || (contesto.kbSnippets || []).length > 0
    || !!contesto.hasPageContent;

  // Se una fonte c'è, i dati possono venire da lì: nessun allarme
  if (haFonte) return { sospetta: false, motivi, gravita: 'nessuna' };

  // Dichiarare apertamente di non poter rispondere è corretto, non sospetto
  if (CONTESTI_LECITI.some(re => re.test(risposta))) {
    return { sospetta: false, motivi, gravita: 'nessuna' };
  }

  // 1. Promessa di cercare senza aver cercato
  const promessa = PROMESSE_DI_AZIONE.find(re => re.test(risposta));
  if (promessa) motivi.push('annuncia una ricerca che non ha effettuato');

  // 2. Dati concreti senza fonte
  const trovati = SEGNALI_DATI_CONCRETI.filter(s => s.re.test(risposta)).map(s => s.nome);
  if (trovati.length > 0) motivi.push(`riporta ${trovati.join(', ')} senza averli consultati`);

  const gravita = trovati.length > 0 ? 'invenzione' : (promessa ? 'promessa' : 'nessuna');
  return { sospetta: motivi.length > 0, motivi, gravita };
}

/**
 * Sostituisce una risposta inventata con una dichiarazione onesta.
 * Meglio ammettere di non avere il dato che fornirne uno falso.
 */
function rispostaOnesta(gravita, motivi) {
  if (gravita === 'invenzione') {
    return 'Non ho consultato nessuna fonte, quindi non posso darti questi dati: '
      + 'qualunque prezzo o orario ti riportassi ora me lo starei inventando.\n\n'
      + 'Dimmi di cercare e li prendo dal sito reale.';
  }
  return 'Ho annunciato una ricerca senza poterla eseguire. '
    + 'Riformula la richiesta e la faccio davvero, oppure verifica che l\'estensione Chrome sia collegata.';
}

// Frasi con cui si consegna un lavoro incompleto senza dirlo
const RESE_PREMATURE = [
  /\bnon (posso|riesco) (ad )?(accedere|interagire|procedere)\b/i,
  /\brichiedo un intervento umano\b/i,
  /\bti consiglio di (cercare|verificare|controllare) (tu|direttamente|manualmente)\b/i,
  /\bpuoi (cercare|verificare) (tu )?(direttamente|manualmente)\b/i,
];

/**
 * Verifica se la risposta consegna un lavoro incompleto senza averci provato.
 * Arrendersi dopo un solo tentativo non è un limite tecnico, è una resa.
 *
 * @param {string} testo
 * @param {object} contesto { toolsUsed, richiesta }
 * @returns {{resa:boolean, tentativi:number, suggerimento?:string}}
 */
function analizzaResa(testo, contesto = {}) {
  const risposta = String(testo || '');
  const tentativi = (contesto.toolsUsed || []).length;
  const siArrende = RESE_PREMATURE.some(re => re.test(risposta));
  if (!siArrende) return { resa: false, tentativi };

  // Con pochi tentativi alle spalle, la rinuncia è prematura
  if (tentativi < 4) {
    return {
      resa: true, tentativi,
      suggerimento: `Si è fermato dopo ${tentativi} tentativi: prima di rinunciare andrebbero provate altre strade (altro sito, URL diretto, screenshot e rilettura).`,
    };
  }
  return { resa: false, tentativi };
}

module.exports = {
  analizzaRisposta, rispostaOnesta, analizzaResa,
  SEGNALI_DATI_CONCRETI, PROMESSE_DI_AZIONE, RESE_PREMATURE,
};
