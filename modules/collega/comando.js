// modules/collega/comando.js — Un comandante solo: l'incarico.
//
// COSA C'ERA PRIMA
//
// Sette punti decidevano, e i primi tre non si parlavano:
//
//   1. routeIntent guardava le PAROLE del messaggio e sceglieva gli ambiti
//   2. selectModel guardava la LUNGHEZZA del messaggio e sceglieva il modello
//   3. selectTools consegnava gli strumenti di quegli ambiti
//   4. il Collega scriveva l'incarico — DOPO che tutto era già deciso
//   5. il turno rattoppava in sei punti diversi
//   6. il Supervisore poteva interrompere
//   7. il calcolatore di rischio poteva bloccare
//
// Le conseguenze, tutte verificate dal vivo il 6 e 7 agosto:
//
//   - "compila il modulo su Google Voli" → la parola "voli" faceva togliere
//     fill_form, e il modulo non si compilava. Mai.
//   - "Vai." di quattro lettere → modello piccolo per un lavoro da sei criteri.
//   - criterio file_atteso senza gli strumenti per scrivere file.
//   - criterio origine_verificabile senza il browser.
//
// Ogni volta la stessa forma: qualcuno decideva PRIMA di sapere cosa serviva.
//
// COME FUNZIONA ADESSO
//
// Comanda l'incarico, e basta. Il Collega capisce cosa serve e lo scrive;
// da lì discendono ambiti, strumenti e modello, per deduzione, in un posto
// solo. SuperMario non indovina più: consegna quello che l'incarico chiede.
//
// Restano due freni, e restano apposta: il Supervisore che ferma i giri a
// vuoto e il calcolatore di rischio che ferma le azioni irreversibili. Un
// freno non è un comandante — non decide dove si va, decide solo quando ci
// si ferma.

/** Gli ambiti che servono per soddisfare questo incarico. */
function ambitiPer(incarico) {
  const criteri = (incarico && incarico.criteri) || [];
  const obiettivo = String((incarico && incarico.obiettivo) || '').toLowerCase();
  const tipi = new Set(criteri.map(c => c.tipo));
  const ambiti = new Set();
  const perche = [];

  // ── Serve guardare fuori? ──
  // Se si pretende che i dati vengano da una pagina, il browser non è
  // opzionale. E un obiettivo che parla di cercare, confrontare o trovare
  // vuole comunque di che guardare.
  const pretendeFonti = tipi.has('origine_verificabile');
  const parlaDiCercare = /\b(cerca|cercare|trova|trovare|confront|verific|raccogli|raccogliere|elenc|list|prezz|tariff|costo|costi|fornitor|aziend|volo|voli|hotel|articol|notizi|rassegna)/.test(obiettivo);
  if (pretendeFonti || parlaDiCercare) {
    ambiti.add('search'); ambiti.add('browse');
    perche.push(pretendeFonti
      ? 'i dati devono venire da pagine aperte davvero'
      : 'l\'obiettivo chiede di cercare o confrontare');
  }

  // ── Serve toccare una pagina? ──
  // Chi cerca su un portale deve poter compilare il modulo di RICERCA.
  // Le azioni che impegnano restano protette dal calcolatore di rischio,
  // non dal togliere lo strumento: toglierlo impediva anche di cercare.
  if (ambiti.has('browse')) {
    ambiti.add('interact');
    perche.push('per compilare i moduli di ricerca dei portali');
  }

  // ── Serve parlare con qualcuno? ──
  //
  // Senza questo, l'incarico non chiede mai l'ambito "communicate" e il modello
  // non vede gli strumenti per scrivere: risponde "non posso mandare messaggi".
  // E' successo il 7 agosto, con gli strumenti gia' pronti e collegati.
  if (/\b(manda|mandare|scrivi(?!\s+(un\s+)?(file|report|documento))|invia|inviare|rispondi|contatta|contattare|messaggio|whatsapp|linkedin|email|mail)\b/i.test(obiettivo)) {
    ambiti.add('communicate');
    perche.push('l\'obiettivo parla di scrivere o contattare qualcuno');
  }

  // ── Serve produrre qualcosa? ──
  if (tipi.has('file_atteso') || tipi.has('formato_consegna')) {
    ambiti.add('file'); ambiti.add('data');
    perche.push('è stato promesso un file');
  }

  // ── Serve raccogliere più soggetti? ──
  const quanti = (criteri.find(c => c.tipo === 'elementi_minimi') || {}).quanti || 0;
  const campi = (criteri.find(c => c.tipo === 'campi_obbligatori') || {}).campi || [];
  const soggetti = (criteri.find(c => c.tipo === 'soggetti_coperti') || {}).soggetti || [];
  if (quanti > 1 || campi.length > 0 || soggetti.length > 1) {
    ambiti.add('data');
    perche.push('il lavoro raccoglie più soggetti: serve dove posarli');
  }

  // ── La rete: un incarico senza ambiti non è un incarico ──
  if (ambiti.size === 0) {
    ambiti.add('search'); ambiti.add('browse');
    perche.push('nessun criterio indicava strumenti: do quelli di base');
  }

  return { ambiti: [...ambiti], perche };
}

/**
 * Quanto è difficile questo lavoro.
 *
 * NON si guarda la lunghezza del messaggio: "Vai." è lungo quattro lettere e
 * può valere mezz'ora di ricerche. Si guarda cosa è stato promesso.
 */
function modelloPer(incarico) {
  const criteri = (incarico && incarico.criteri) || [];
  const tipi = new Set(criteri.map(c => c.tipo));
  const impegnativi = ['origine_verificabile', 'file_atteso', 'soggetti_coperti', 'campi_obbligatori'];

  if (criteri.length >= 3 || criteri.some(c => impegnativi.includes(c.tipo))) {
    return { tier: 'power', perche: `${criteri.length} criteri, di cui verificabili dal codice` };
  }
  return { tier: 'standard', perche: 'lavoro semplice' };
}

/**
 * L'ordine di lavoro completo: cosa serve, perché, e con quale testa.
 * Un posto solo, deducibile, spiegabile a voce.
 */
function ordineDiLavoro(incarico) {
  const a = ambitiPer(incarico);
  const m = modelloPer(incarico);
  return {
    ambiti: a.ambiti,
    tier: m.tier,
    perche: [...a.perche, m.perche],
    obiettivo: (incarico && incarico.obiettivo) || '',
    criteri: (incarico && incarico.criteri) || [],
  };
}

/** Come si racconta l'ordine a chi guarda il pannello. */
function inChiaro(ordine) {
  return `Per questo lavoro mi servono: ${ordine.ambiti.join(', ')} — ${ordine.perche.join('; ')}.`;
}

module.exports = { ordineDiLavoro, ambitiPer, modelloPer, inChiaro };
