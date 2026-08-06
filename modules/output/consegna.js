// modules/output/consegna.js — Lo standard di consegna: come deve essere fatto
// un documento che esce da COBRA.
//
// PERCHÉ
//
// Il report della vacanza a Bora Bora era tecnicamente valido e praticamente
// inservibile: quattro righe, "**Volo**" con gli asterischi a vista perché il
// markdown non era stato tolto, i prezzi scritti come testo — quindi non
// sommabili — e nessuna traccia di dove venissero i dati. Chi lo riceve non può
// controllarlo né usarlo, e chi lo consegna al capo ci fa una figura.
//
// Il problema non era l'estetica: mancava uno standard. Qui c'è, ed è uno solo
// per tutto quello che COBRA produce.
//
// COSA IMPONE
//
//   1. Intestazione: cosa è stato chiesto, quando, da chi
//   2. Corpo: una riga per elemento, colonne dichiarate
//   3. Fonti: in fondo, l'elenco di cosa è stato letto e quando
//   4. Numeri come numeri, non come testo
//   5. Niente markdown nelle celle: un foglio non è una chat
//
// Le prime tre le verifica il codice; le ultime due le applica il codice.

const { convertiNumero } = require('../utils/xlsx');

const TITOLO_FONTI = 'FONTI CONSULTATE';
const TITOLO_REPORT = 'REPORT';

/** Toglie il markdown dalle celle: **Volo** deve arrivare come Volo. */
function ripulisci(valore) {
  if (valore === null || valore === undefined) return '';
  return String(valore)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Un valore che rappresenta una quantità diventa un numero vero, così si
 * somma e si ordina. "1.698" e "€ 1.698,50" diventano 1698 e 1698.5;
 * "80-120" resta testo perché è un intervallo, non una quantità.
 */
function normalizzaCella(valore) {
  const testo = ripulisci(valore);
  if (!testo) return '';
  const nudo = testo.replace(/[€$£]|EUR|USD|GBP/gi, '').trim();
  // Solo cifre, punti, virgole e spazi: qualunque altra cosa è una descrizione
  if (!/^-?[\d.,\s]+$/.test(nudo) || !/\d/.test(nudo)) return testo;

  // Il punto italiano separa le migliaia, non i decimali: "1.698" vale
  // millesecentonovantotto, non uno virgola sei. Affidarsi a parseFloat
  // trasformava un prezzo di 1.698 euro in 1,70 — un errore di tre ordini di
  // grandezza dentro un report che qualcuno porta al proprio capo.
  const senzaSpazi = nudo.replace(/\s/g, '');
  let normale;
  // Il formato anglosassone è l'italiano allo specchio: la virgola separa le
  // migliaia e il punto i decimali. "$1,234.56" letto con le regole italiane
  // diventava 1.23456 — lo stesso errore di tre ordini di grandezza che le
  // righe qui sopra dicono di aver corretto, sopravvissuto sull'altro lato.
  // Si riconosce dalla forma: virgole a gruppi di tre E un punto dopo.
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(senzaSpazi)) {
    normale = senzaSpazi.replace(/,/g, '');
  } else if (/,/.test(senzaSpazi)) {
    // Formato italiano: i punti sono migliaia, la virgola è il decimale
    normale = senzaSpazi.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(senzaSpazi)) {
    // Solo punti, a gruppi di tre: sono migliaia
    normale = senzaSpazi.replace(/\./g, '');
  } else {
    normale = senzaSpazi;
  }
  const n = Number(normale);
  return Number.isFinite(n) ? n : testo;
}

/**
 * Costruisce il documento nello standard di casa.
 *
 * @param {object} spec
 * @param {string} spec.titolo      cosa è stato chiesto
 * @param {Array}  spec.righe       [[intestazioni...], [dati...], ...]
 * @param {Array}  spec.fonti       [{url, title}] pagine realmente lette
 * @param {string} spec.richiestaDa chi l'ha chiesto
 * @returns {Array} righe pronte per il foglio
 */
function componiDocumento(spec = {}) {
  const righeGrezze = Array.isArray(spec.righe) ? spec.righe : [];
  const fonti = Array.isArray(spec.fonti) ? spec.fonti : [];
  const larghezza = righeGrezze.reduce((m, r) => Math.max(m, (Array.isArray(r) ? r : [r]).length), 1);
  const riempi = (arr) => { const a = [...arr]; while (a.length < larghezza) a.push(''); return a; };

  const out = [];
  out.push(riempi([TITOLO_REPORT, ripulisci(spec.titolo || '')]));
  out.push(riempi(['Preparato il', new Date().toLocaleString('it-IT')]));
  if (spec.richiestaDa) out.push(riempi(['Richiesto da', ripulisci(spec.richiestaDa)]));
  out.push(riempi(['']));

  for (const r of righeGrezze) {
    out.push(riempi((Array.isArray(r) ? r : [r]).map(normalizzaCella)));
  }

  // Le fonti chiudono sempre il documento: senza, quello che c'è sopra non è
  // verificabile, e quello che non è verificabile non vale.
  out.push(riempi(['']));
  out.push(riempi([TITOLO_FONTI]));
  if (fonti.length === 0) {
    out.push(riempi(['(nessuna pagina consultata per questo documento)']));
  } else {
    out.push(riempi(['#', 'Indirizzo', 'Pagina']));
    fonti.forEach((f, i) => {
      const url = typeof f === 'string' ? f : (f.url || '');
      const titolo = typeof f === 'string' ? '' : (f.title || '');
      out.push(riempi([i + 1, url, ripulisci(titolo)]));
    });
  }
  return out;
}

/**
 * Verifica che un documento rispetti lo standard.
 * È un controllo di forma, non di contenuto: dice se il documento è
 * presentabile, non se i dati sono giusti — a quello pensano gli altri criteri.
 */
function verificaFormato(righe) {
  const dati = Array.isArray(righe) ? righe : [];
  const testo = dati.map(r => (Array.isArray(r) ? r : [r]).join(' ')).join('\n');
  const problemi = [];

  if (!new RegExp(`^\\s*${TITOLO_REPORT}\\b`, 'im').test(testo)) {
    problemi.push('manca l\'intestazione con l\'oggetto del report');
  }
  if (!/Preparato il/i.test(testo)) problemi.push('manca la data di preparazione');
  if (!new RegExp(TITOLO_FONTI, 'i').test(testo)) {
    problemi.push('manca l\'elenco delle fonti in fondo al documento');
  }

  // Un documento con meno di due righe di contenuto è una promessa, non un
  // report: è già successo di consegnare la sola intestazione.
  //
  // Si contano SOLO le righe prima delle fonti: altrimenti l'elenco degli
  // indirizzi in calce fa sembrare pieno un documento che sopra è vuoto, ed è
  // esattamente il caso che si vuole cogliere.
  const iFonti = dati.findIndex(r => new RegExp(`^\\s*${TITOLO_FONTI}`, 'i').test((Array.isArray(r) ? r : [r]).join('').trim()));
  const corpo = iFonti >= 0 ? dati.slice(0, iFonti) : dati;
  const contenuto = corpo.filter(r => {
    const t = (Array.isArray(r) ? r : [r]).join('').trim();
    return t && !new RegExp(`^(${TITOLO_REPORT}|Preparato il|Richiesto da)`, 'i').test(t);
  }).length;
  if (contenuto < 2) problemi.push('non c\'è abbastanza contenuto: sembra un documento vuoto');

  const conMarkdown = dati.some(r => (Array.isArray(r) ? r : [r]).some(c => /\*\*|^#{1,6}\s|`/.test(String(c || ''))));
  if (conMarkdown) problemi.push('ci sono segni di formattazione (** o #) dentro le celle');

  return { conforme: problemi.length === 0, problemi };
}

/** Le regole, in parole, per l'Esecutore. */
function perIlPrompt() {
  return `# FORMATO DI CONSEGNA (vale per OGNI file che produci)

Il documento non lo compili a piacere: ha una forma fissa.

1. In cima: "${TITOLO_REPORT}" e in una riga cosa è stato chiesto, poi la data.
2. Poi la tabella: la prima riga sono i nomi delle colonne, sotto una riga per
   ogni elemento. Nessuna cella deve contenere due informazioni diverse.
3. In fondo, sempre: "${TITOLO_FONTI}" e l'elenco degli indirizzi che hai
   davvero aperto. Un report senza fonti non è verificabile e non passa.
4. I prezzi si scrivono come numeri puri — 1698, non "€ 1.698,00" — così si
   sommano. La valuta va nel nome della colonna: "Prezzo (€)".
5. Niente asterischi, cancelletti o apici nelle celle: un foglio non è una chat.

Il rispetto di questa forma lo controlla il codice. Un documento che non ce
l'ha viene rifiutato, e ti viene detto cosa manca.`;
}

module.exports = { componiDocumento, verificaFormato, perIlPrompt, normalizzaCella, ripulisci, TITOLO_FONTI, TITOLO_REPORT };
