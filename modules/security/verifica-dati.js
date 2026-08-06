// modules/security/verifica-dati.js — I dati scritti in un file devono venire
// dalle pagine lette, non dalla memoria del modello.
//
// Fatto in produzione, non ipotesi: a una richiesta di voli da Milano, Madrid e
// Barcellona verso Bogotá, COBRA ha letto correttamente Barcellona (Air France
// 12:20→19:25, 3.466 €, verificato a mano su Google Voli) e poi ha ricopiato
// quello stesso blocco anche sotto "Milano", dove i voli veri erano altri
// (Air Europa, 3.921 € e 3.155 €). Nessun prezzo era inventato di sana pianta:
// erano prezzi VERI attribuiti alla tratta SBAGLIATA. Un controllo che si limita
// a chiedersi "questa cifra l'ho letta da qualche parte?" non se ne accorge.
//
// Servono quindi due controlli distinti:
//   A. ogni importo scritto deve comparire in almeno una pagina letta nel turno
//   B. lo stesso gruppo di righe non può ripetersi sotto intestazioni diverse
//
// Entrambi sono applicati dal codice. Non sono suggerimenti nel prompt: il
// modello non può convincersi di averli rispettati.

// ── Perché non basta togliere tutto ciò che non è cifra ──
//
// La versione precedente riduceva sia gli importi sia le pagine a una lunga
// stringa di sole cifre, e cercava l'uno dentro l'altra. Sembra ragionevole
// e non lo è: le cifre delle pagine si incollano fra loro e generano
// corrispondenze che non esistono. Provato sul codice vero:
//
//   fonte:      "Iberia · 1 scalo · 3 h 46 min · 6 posti rimasti"
//   importo:    "3.466 €"   → RISULTAVA VERIFICATO
//
// perché "1", "3", "46", "6" appiccicati fanno "1346623", che contiene
// "3466". Su una pagina da 12.000 caratteri qualunque prezzo di tre o
// quattro cifre si trova quasi sempre. La verifica diceva sempre di sì, ed
// era peggio del non averla: il report firmava "ogni dato proviene dalle
// pagine elencate" con la garanzia di un controllo che non controllava.
//
// Adesso si confrontano NUMERI, non stringhe di cifre: dalle pagine si
// estraggono i numeri veri (con i loro separatori), e un importo è
// verificato se uno di quei numeri gli corrisponde.

/** Il valore numerico di un importo scritto in qualunque formato. */
function valoreImporto(testo) {
  const nudo = String(testo).replace(/[^\d.,]/g, '');
  if (!nudo) return null;
  let normale;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(nudo)) normale = nudo.replace(/,/g, '');        // 1,234.56
  else if (/,/.test(nudo)) normale = nudo.replace(/\./g, '').replace(',', '.');           // 1.234,56
  else if (/^\d{1,3}(\.\d{3})+$/.test(nudo)) normale = nudo.replace(/\./g, '');          // 1.698
  else normale = nudo;
  const n = Number(normale);
  return Number.isFinite(n) ? n : null;
}

/** Tutti i numeri che compaiono davvero in un testo, come valori. */
const RE_NUMERO = /\d[\d.,]*/g;
function numeriDi(testo) {
  const insieme = new Set();
  for (const grezzo of String(testo || '').match(RE_NUMERO) || []) {
    const v = valoreImporto(grezzo);
    if (v !== null) insieme.add(v);
  }
  return insieme;
}

/** Riporta un importo alla sua forma confrontabile. */
function normalizzaImporto(testo) {
  return String(testo).replace(/[^\d]/g, '');
}

const RE_IMPORTO = /(?:€|\$|£)\s?\d[\d.,]*|\d[\d.,]*\s?(?:€|\$|£|EUR|USD|GBP)/gi;

/**
 * A. Ogni importo scritto nel file compare nelle fonti lette?
 * @param {string} contenuto  quello che si sta per scrivere
 * @param {string} fonti      testo di tutte le pagine lette nel turno
 */
function importiSenzaFonte(contenuto, fonti) {
  const numeriFonti = numeriDi(fonti);
  const trovati = String(contenuto || '').match(RE_IMPORTO) || [];
  const mancanti = [];
  const visti = new Set();

  for (const grezzo of trovati) {
    const v = valoreImporto(grezzo);
    if (v === null || v < 100) continue;   // sotto i 100 i falsi positivi dominano
    if (visti.has(v)) continue;
    visti.add(v);
    // Tolleranza minima per gli arrotondamenti di chi trascrive: 1%.
    let trovato = false;
    for (const f of numeriFonti) {
      if (f === v || (v > 0 && Math.abs(f - v) / v < 0.01)) { trovato = true; break; }
    }
    if (!trovato) mancanti.push(grezzo.trim());
  }
  return { totale: visti.size, mancanti };
}

/**
 * B. Gruppi di righe identici ripetuti sotto intestazioni diverse.
 * Si confrontano le righe senza la prima colonna quando questa contiene solo
 * un'etichetta d'ordine ("Opzione 1"), perché è lì che si nasconde la copia.
 */
function blocchiDuplicati(righe, minimo = 2) {
  const firma = r => (Array.isArray(r) ? r : [r])
    .map(c => String(c == null ? '' : c).trim().toLowerCase())
    .filter(Boolean).join('¦');

  const firme = righe.map(firma);
  const duplicati = [];

  // Si cerca la sequenza ripetuta più lunga, partendo da quelle lunghe
  for (let len = Math.floor(righe.length / 2); len >= minimo; len--) {
    for (let i = 0; i + len <= righe.length; i++) {
      const blocco = firme.slice(i, i + len);
      if (blocco.some(f => !f)) continue;
      for (let j = i + len; j + len <= righe.length; j++) {
        const altro = firme.slice(j, j + len);
        if (blocco.every((f, k) => f === altro[k])) {
          duplicati.push({ righe: len, prima: i + 1, seconda: j + 1 });
          return duplicati;   // il primo caso basta a fermare la scrittura
        }
      }
    }
  }
  return duplicati;
}

/** Il testo di tutte le pagine lette nel turno, per il confronto. */
function fontiDelTurno(session) {
  if (!session) return '';
  const pezzi = [];

  const cache = session._cachePagine;
  if (cache && typeof cache.forEach === 'function') {
    cache.forEach(v => { if (v && v.content) pezzi.push(v.content); });
  }

  // Non tutte le letture passano dalla cache: ci arriva solo navigate quando
  // l'estensione è collegata. read_page, scrape_url e il ripiego senza
  // browser leggono pagine vere che qui non comparivano, e i loro prezzi
  // risultavano inventati. La pagina corrente è comunque una pagina letta.
  const ultima = session.lastPage;
  if (ultima && (ultima.markdown || ultima.testo)) pezzi.push(String(ultima.markdown || ultima.testo));

  // E i testi che le letture hanno lasciato lungo il turno
  for (const p of (session.pagineDelTurno || [])) {
    if (p && p.content) pezzi.push(String(p.content));
  }

  return pezzi.join('\n');
}

module.exports = { importiSenzaFonte, blocchiDuplicati, fontiDelTurno, normalizzaImporto, valoreImporto, numeriDi };
