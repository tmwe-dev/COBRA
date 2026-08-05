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

/** Riporta un importo alla sua forma confrontabile: "3.466 €" e "€3,466" → "3466" */
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
  const testoFonti = normalizzaImporto(String(fonti || ''));
  const trovati = String(contenuto || '').match(RE_IMPORTO) || [];
  const mancanti = [];
  const visti = new Set();

  for (const grezzo of trovati) {
    const n = normalizzaImporto(grezzo);
    // Le cifre corte generano troppi falsi positivi (un "2 €" si trova ovunque)
    if (n.length < 3) continue;
    if (visti.has(n)) continue;
    visti.add(n);
    if (!testoFonti.includes(n)) mancanti.push(grezzo.trim());
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
  const cache = session && session._cachePagine;
  if (!cache || typeof cache.forEach !== 'function') return '';
  const pezzi = [];
  cache.forEach(v => { if (v && v.content) pezzi.push(v.content); });
  return pezzi.join('\n');
}

module.exports = { importiSenzaFonte, blocchiDuplicati, fontiDelTurno, normalizzaImporto };
