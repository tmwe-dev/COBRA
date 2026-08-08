// modules/collega/requisiti.js — Trasformare una richiesta in una checklist.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHÉ ESISTE
//
// Il Collega sa produrre criteri verificabili, e quando lo fa il lavoro viene
// controllato sul serio. Il problema è che li produce a occhio, e a occhio si
// perdono pezzi. Il caso tipico:
//
//   "Cercami tutte le compagnie con voli diretti Cina → PHX, SAN e LAS,
//    indicami aeroporti, frequenze, aircraft e crea un confronto."
//
// diventa spesso un piano generico:
//
//   1. cercare voli
//   2. confrontare
//   3. creare report
//
// Tre passi che si possono dichiarare fatti senza che nessuno sappia dire se
// mancano LAS, le frequenze o gli aeromobili. Quello che serviva era:
//
//   ☐ PHX  ☐ SAN  ☐ LAS
//   ☐ aeroporto per ogni riga
//   ☐ frequenza per ogni riga
//   ☐ aeromobile per ogni riga
//   ☐ fonte per ogni numero
//   ☐ documento finale
//
// ── COSA FA ──
//
// Legge l'obiettivo e ne estrae i requisiti che si possono contare: i soggetti
// nominati, i campi chiesti, se serve una fonte, se serve un documento. Poi li
// confronta con i criteri che il Collega ha scritto e restituisce quelli
// MANCANTI.
//
// Non sostituisce il Collega: lo completa. Il Collega capisce l'intenzione —
// cosa vuole davvero Luca — e quella è una cosa che il codice non sa fare.
// Contare gli elenchi in una frase, invece, il codice lo fa meglio: non si
// distrae e non decide che tre città su quattro bastano.
//
// ── PERCHÉ DETERMINISTICO ──
//
// Chiedere a un modello "quali requisiti hai dimenticato?" ha lo stesso
// difetto di chiedergli se ha finito: risponde di no. Qui si contano parole,
// e le parole o ci sono o non ci sono.
// ══════════════════════════════════════════════════════════════════════

// I campi che si chiedono davvero, nel lavoro di Luca. Non è un dizionario
// generale: è la lingua della logistica e dei viaggi, dove "frequenza" e
// "aeromobile" sono colonne di una tabella, non parole qualsiasi.
const CAMPI_NOTI = [
  { chiave: 'prezzo', dice: /\b(prezz|tariff|cost|quotazion|importo|budget|euro|€)\w*/i },
  { chiave: 'orario', dice: /\b(orari|partenz|arriv|durat)\w*/i },
  { chiave: 'data', dice: /\b(data|date|giorno|periodo|quando)\b/i },
  { chiave: 'frequenza', dice: /\b(frequenz|cadenz|quante volte|settimanal|giornalier)\w*/i },
  { chiave: 'aeromobile', dice: /\b(aircraft|aeromobil|velivol|tipo di aereo)\w*/i },
  { chiave: 'aeroporto', dice: /\b(aeroport|scal|hub|airport)\w*/i },
  { chiave: 'compagnia', dice: /\b(compagni|vettor|airline|operator)\w*/i },
  { chiave: 'email', dice: /\b(email|e-mail|posta elettronica|contatt)\w*/i },
  { chiave: 'telefono', dice: /\b(telefon|numero|cellulare|recapit)\w*/i },
  { chiave: 'sito', dice: /\b(sito|website|pagina web)\b/i },
  { chiave: 'indirizzo', dice: /\b(indirizz|sede|ubicazion)\w*/i },
  { chiave: 'transito', dice: /\b(transit|tempi di resa|lead time|consegna in)\w*/i },
  { chiave: 'capacita', dice: /\b(capacit|volume|peso|kg|tonnellat)\w*/i },
];

/** Una richiesta che finisce in un documento, anche se non lo dice. */
const VUOLE_UN_DOCUMENTO = /\b(confront|comparaz|report|tabella|elenc|riepilog|prospett|analis|panoramic)\w*/i;

/** Una richiesta che contiene numeri presi dal mondo, non dalla memoria. */
const VUOLE_UNA_FONTE = /\b(prezz|tariff|cost|disponibil|orari|frequenz|quotazion|quant)\w*/i;

/** Una richiesta che chiede di scegliere, non solo di elencare. */
const VUOLE_UNA_RACCOMANDAZIONE = /\b(consigli|raccomand|qual è il miglior|quale conviene|meglio|scegli|suggerisci)\w*/i;

/**
 * I soggetti nominati in una frase: sigle e nomi propri in elenco.
 *
 * Si cercano i pezzi che stanno in una lista — "PHX, SAN e LAS", "Milano,
 * Madrid e Bogotá" — perché è lì che si perdono: il modello ne tratta due e
 * dichiara fatto.
 */
function soggettiNominati(testo) {
  const t = String(testo || '');
  const trovati = new Set();

  // Sigle di tre lettere maiuscole: codici aeroportuali, e nel lavoro di Luca
  // sono la forma più frequente di elenco.
  for (const m of t.matchAll(/\b([A-Z]{3})\b/g)) {
    // Si scartano le parole italiane che capita di scrivere maiuscole.
    if (!/^(PER|NON|CON|TRA|GLI|CHE|SUL|DEL|DAL|NEL|UNA|UNO|SUO|MIO)$/.test(m[1])) trovati.add(m[1]);
  }

  // Elenchi di nomi propri separati da virgole e "e": "Milano, Madrid e Bogotá".
  // Si prende la parte di frase che contiene almeno una virgola e una "e".
  for (const m of t.matchAll(/((?:[A-ZÀ-Ù][\wà-ù'’-]+(?:\s+[A-ZÀ-Ù][\wà-ù'’-]+)?)(?:\s*,\s*(?:[A-ZÀ-Ù][\wà-ù'’-]+(?:\s+[A-ZÀ-Ù][\wà-ù'’-]+)?))+(?:\s+e\s+(?:[A-ZÀ-Ù][\wà-ù'’-]+(?:\s+[A-ZÀ-Ù][\wà-ù'’-]+)?))?)/g)) {
    for (const pezzo of m[1].split(/\s*,\s*|\s+e\s+/)) {
      const p = pezzo.trim();
      if (p.length > 2) trovati.add(p);
    }
  }

  // "da X a Y" e "X → Y": due estremi, due soggetti.
  for (const m of t.matchAll(/\b(?:da|from)\s+([A-ZÀ-Ù][\wà-ù'’-]+)\s+(?:a|verso|to|→|->)\s+([A-ZÀ-Ù][\wà-ù'’-]+)/gi)) {
    if (m[1]) trovati.add(m[1]); if (m[2]) trovati.add(m[2]);
  }

  return [...trovati];
}

/** I campi chiesti esplicitamente nella frase. */
function campiChiesti(testo) {
  const t = String(testo || '');
  return CAMPI_NOTI.filter(c => c.dice.test(t)).map(c => c.chiave);
}

/**
 * Cosa manca nella checklist rispetto a quello che la richiesta chiedeva.
 *
 * @param {string} obiettivo   l'obiettivo scritto dal Collega (o la richiesta)
 * @param {Array}  criteri     i criteri che il Collega ha già messo
 * @returns {{mancanti: Array, checklist: Array, perche: string}}
 */
function requisitiMancanti(obiettivo, criteri = []) {
  const t = String(obiettivo || '');
  const gia = new Set((criteri || []).map(c => c.tipo));
  const mancanti = [];
  const checklist = [];

  // ── I soggetti ──
  const soggetti = soggettiNominati(t);
  const soggettiGia = (criteri || []).find(c => c.tipo === 'soggetti_coperti');
  if (soggetti.length >= 2) {
    for (const s of soggetti) checklist.push({ cosa: s, tipo: 'soggetto' });
    if (!soggettiGia) {
      mancanti.push({ tipo: 'soggetti_coperti', soggetti,
        perche: `la richiesta ne nomina ${soggetti.length}: ${soggetti.join(', ')}` });
    } else {
      // Il criterio c'è ma è incompleto: è il caso peggiore, perché sembra
      // controllato. Tre soggetti su quattro passano la verifica.
      const dentro = new Set((soggettiGia.soggetti || []).map(x => String(x).toLowerCase()));
      const fuori = soggetti.filter(s => !dentro.has(s.toLowerCase()));
      if (fuori.length) {
        mancanti.push({ tipo: 'soggetti_coperti', soggetti: [...(soggettiGia.soggetti || []), ...fuori],
          perche: `il criterio non copriva: ${fuori.join(', ')}` });
      }
    }
  }

  // ── I campi ──
  const campi = campiChiesti(t);
  const campiGia = (criteri || []).find(c => c.tipo === 'campi_obbligatori');
  if (campi.length) {
    for (const c of campi) checklist.push({ cosa: c, tipo: 'campo' });
    if (!campiGia) {
      mancanti.push({ tipo: 'campi_obbligatori', campi,
        perche: `la richiesta chiede: ${campi.join(', ')}` });
    } else {
      const dentro = new Set((campiGia.campi || []).map(x => String(x).toLowerCase()));
      const fuori = campi.filter(c => !dentro.has(c.toLowerCase()));
      if (fuori.length) {
        mancanti.push({ tipo: 'campi_obbligatori', campi: [...(campiGia.campi || []), ...fuori],
          perche: `il criterio non chiedeva: ${fuori.join(', ')}` });
      }
    }
  }

  // ── La fonte ──
  if (VUOLE_UNA_FONTE.test(t) && !gia.has('origine_verificabile')) {
    checklist.push({ cosa: 'fonte per ogni numero', tipo: 'fonte' });
    mancanti.push({ tipo: 'origine_verificabile',
      perche: 'la richiesta contiene numeri che devono venire da una pagina aperta' });
  }

  // ── Il documento ──
  if (VUOLE_UN_DOCUMENTO.test(t) && !gia.has('file_atteso')) {
    checklist.push({ cosa: 'documento finale', tipo: 'file' });
    mancanti.push({ tipo: 'file_atteso', estensione: 'html',
      perche: 'la richiesta chiede un confronto o un elenco: finisce in un documento' });
  }

  // ── Nessun duplicato, quando ci sono più soggetti ──
  if (soggetti.length >= 2 && !gia.has('nessun_duplicato')) {
    mancanti.push({ tipo: 'nessun_duplicato',
      perche: 'con più soggetti, copiare la stessa riga sotto due nomi è l\'errore più comune' });
  }

  const perche = mancanti.length
    ? `la richiesta chiedeva ${checklist.length} cose contabili, ${mancanti.length} non erano nei criteri`
    : 'i criteri coprono quello che la richiesta chiedeva';

  return { mancanti, checklist, perche, vuoleRaccomandazione: VUOLE_UNA_RACCOMANDAZIONE.test(t) };
}

/**
 * La checklist da mostrare, con le caselle.
 *
 * Serve a Luca più che al modello: è il modo di vedere in tre righe se il
 * lavoro copre quello che aveva chiesto, senza rileggere un report.
 */
function checklistInChiaro(obiettivo, criteri = []) {
  const { checklist } = requisitiMancanti(obiettivo, criteri);
  if (!checklist.length) return '';
  const righe = ['CHECKLIST DI QUESTA RICHIESTA:'];
  for (const v of checklist) righe.push(`  ☐ ${v.cosa}`);
  return righe.join('\n');
}

module.exports = {
  requisitiMancanti, checklistInChiaro, soggettiNominati, campiChiesti,
  CAMPI_NOTI,
};
