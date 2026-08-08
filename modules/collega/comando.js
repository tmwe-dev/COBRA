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
 * Quanto è difficile questo lavoro, in un numero.
 *
 * NON si guarda la lunghezza del messaggio: "Vai." è lungo quattro lettere e
 * può valere mezz'ora di ricerche. Si guarda cosa è stato promesso.
 *
 * Prima c'era una soglia sola — tre criteri, oppure uno dei quattro
 * "impegnativi" — e due esiti possibili. Funzionava, ma appiattiva casi molto
 * diversi: un confronto fra otto compagnie con prezzi da verificare e un file
 * finale prendeva lo stesso modello di una ricerca con due criteri qualsiasi.
 * E nell'altro verso, un lavoro con un solo `file_atteso` — scrivere un
 * appunto — pretendeva il modello grosso.
 *
 * Adesso il peso si somma, ogni voce dice quanto pesa e perché, e le soglie
 * sono scritte in un punto solo. Il conto è deterministico: lo stesso incarico
 * dà sempre lo stesso numero, e il numero si può leggere ad alta voce.
 */
const PESI = {
  origine_verificabile: { peso: 25, perche: 'ogni numero va verificato su una pagina aperta' },
  file_atteso:          { peso: 15, perche: 'c\'è un documento da produrre' },
  campi_obbligatori:    { peso: 12, perche: 'ogni elemento deve avere campi precisi' },
  soggetti_coperti:     { peso: 10, perche: 'più soggetti, ognuno per conto suo' },
  formato_consegna:     { peso: 5,  perche: 'il documento ha un formato da rispettare' },
  nessun_duplicato:     { peso: 5,  perche: 'i risultati non si possono ripetere' },
  elementi_minimi:      { peso: 3,  perche: 'serve una quantità minima di risultati' },
};

const SOGLIE = [
  { fino: 20, tier: 'standard' },
  { fino: 55, tier: 'power' },
  { fino: Infinity, tier: 'power' },
];

function difficoltaDi(incarico) {
  const criteri = (incarico && incarico.criteri) || [];
  const voci = [];
  let punti = 0;

  for (const c of criteri) {
    const v = PESI[c.tipo];
    if (!v) continue;
    let peso = v.peso;

    // Un criterio non pesa sempre uguale. Tre soggetti sono tre ricerche;
    // otto sono un lavoro che non sta in un turno.
    if (c.tipo === 'soggetti_coperti' && Array.isArray(c.soggetti)) {
      peso += Math.min(20, Math.max(0, c.soggetti.length - 2) * 5);
    }
    if (c.tipo === 'campi_obbligatori' && Array.isArray(c.campi)) {
      peso += Math.min(10, Math.max(0, c.campi.length - 2) * 2);
    }
    if (c.tipo === 'elementi_minimi' && Number(c.quanti) > 5) {
      peso += Math.min(10, Number(c.quanti) - 5);
    }

    punti += peso;
    voci.push({ tipo: c.tipo, peso, perche: v.perche });
  }

  // Più criteri diversi significano più cose da tenere insieme in una volta.
  if (criteri.length >= 4) {
    punti += 8;
    voci.push({ tipo: 'insieme', peso: 8, perche: `${criteri.length} criteri da tenere insieme` });
  }

  const punteggio = Math.min(100, punti);
  const tier = (SOGLIE.find(s => punteggio <= s.fino) || SOGLIE[SOGLIE.length - 1]).tier;

  // La riga che si legge ad alta voce: chi guarda il registro deve capire
  // perché è stato scelto quel modello senza aprire questo file.
  const perche = voci.length
    ? `difficoltà ${punteggio}/100 — ` + voci.sort((a, b) => b.peso - a.peso)
        .slice(0, 3).map(v => `${v.perche} (${v.peso})`).join('; ')
    : 'difficoltà 0/100 — lavoro semplice';

  return { punteggio, tier, perche, voci };
}

function modelloPer(incarico) {
  const d = difficoltaDi(incarico);
  return { tier: d.tier, punteggio: d.punteggio, perche: d.perche };
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

// ── La domanda giusta da fare alla conoscenza ──
//
// La ricerca nella KB partiva dal messaggio grezzo di Luca. Funziona finche'
// il messaggio descrive il lavoro; smette di funzionare esattamente quando
// serve di piu':
//
//   "vai"                        → cerca "vai"
//   "vai con quello di prima"    → cerca "vai con quello di prima"
//   "procedi"                    → cerca "procedi"
//
// Tre ricerche inutili, e sono le risposte piu' frequenti che da' una persona
// a cui hai appena chiesto conferma. Il paradosso: piu' il Collega fa bene il
// suo lavoro — capire e chiedere — piu' il messaggio successivo e' corto e
// vuoto, e piu' la KB diventa cieca.
//
// L'incarico invece contiene sempre la sostanza: l'obiettivo scritto per
// esteso, i soggetti, i campi che servono. Quella e' la domanda da fare.
//
// Si tiene anche il messaggio, in coda: a volte contiene un nome proprio che
// nell'obiettivo e' stato riassunto via.
function domandaPerLaConoscenza(incarico, messaggio = '') {
  const pezzi = [];
  if (incarico && incarico.obiettivo) pezzi.push(String(incarico.obiettivo));

  for (const c of (incarico && incarico.criteri) || []) {
    if (c.tipo === 'soggetti_coperti' && Array.isArray(c.soggetti)) pezzi.push(c.soggetti.join(' '));
    if (c.tipo === 'campi_obbligatori' && Array.isArray(c.campi)) pezzi.push(c.campi.join(' '));
  }

  // Il messaggio serve solo se aggiunge qualcosa: "vai" non aggiunge niente.
  const m = String(messaggio || '').trim();
  if (m.length > 12) pezzi.push(m);

  const domanda = pezzi.join(' ').replace(/\s+/g, ' ').trim();
  // Senza incarico non c'e' niente di meglio del messaggio: si torna a quello.
  return domanda || m;
}

module.exports = { ordineDiLavoro, ambitiPer, modelloPer, difficoltaDi, PESI, inChiaro, domandaPerLaConoscenza };
