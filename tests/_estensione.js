// tests/_estensione.js — Il codice dell'estensione, tutto insieme.
//
// PERCHÉ ESISTE
//
// Nove suite leggevano `cobra-extension/background.js` per controllare come si
// comporta l'estensione: che un comando esista, che usi il ritmo, che verifichi
// il destinatario. Era giusto finché quel file conteneva tutto.
//
// Poi i comandi sono usciti da lì: 96 su 99 sono passati in
// esterni/comandi/*.js, e background.js è diventato un centralinista. Le prove
// hanno cominciato a fallire — non perché il comportamento fosse cambiato, ma
// perché guardavano nella stanza sbagliata.
//
// Una prova che si rompe quando il codice CAMBIA POSTO, senza cambiare, è una
// prova legata all'indirizzo invece che al comportamento. Qui si dà a tutte lo
// stesso corpus: l'estensione intera. Così il prossimo trasloco non le rompe.

const fs = require('fs');
const path = require('path');

const RADICE = path.resolve(__dirname, '..', 'cobra-extension');

/** Tutti i file .js dell'estensione, escluso il codice vendorizzato. */
function fileDellEstensione() {
  const fuori = [];
  const guarda = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).isDirectory()) {
        // esterni/wa e esterni/li sono copie delle estensioni del Navigator:
        // non sono codice nostro e non vanno giudicate con le nostre regole.
        if (f === 'wa' || f === 'li' || f === 'node_modules') continue;
        guarda(fp);
      } else if (f.endsWith('.js')) fuori.push(fp);
    }
  };
  guarda(RADICE);
  return fuori;
}

/** Il sorgente dell'estensione come un testo solo. */
function sorgenteEstensione() {
  return fileDellEstensione()
    .map(f => `\n// ===== ${path.relative(RADICE, f)} =====\n` + fs.readFileSync(f, 'utf8'))
    .join('\n');
}

/** Dove sta un comando, adesso: nel registro di un'area o nel vecchio switch. */
function doveStaIlComando(nome) {
  for (const f of fileDellEstensione()) {
    const src = fs.readFileSync(f, 'utf8');
    if (new RegExp(`comandi\\['${nome}'\\]`).test(src)) return path.relative(RADICE, f);
    if (new RegExp(`^ {6}case '${nome}':`, 'm').test(src)) return path.relative(RADICE, f);
  }
  return null;
}

module.exports = { RADICE, fileDellEstensione, sorgenteEstensione, doveStaIlComando };

/**
 * Il corpo di un comando, ovunque stia adesso.
 *
 * I comandi sono usciti da background.js: 96 su 99 vivono in
 * esterni/comandi/*.js come `comandi['nome'] = async function (args) { … }`.
 * Le prove che cercavano `case 'nome':` non guardavano il comportamento:
 * guardavano l'indirizzo. Qui si accetta tutte e due le forme, così il
 * prossimo trasloco non le rompe.
 */
function corpoDelComando(sorgente, nome) {
  const nuovo = new RegExp(`comandi\\['${nome}'\\] = async function \\(args\\) \\{`);
  const vecchio = new RegExp(`^ {6}case '${nome}':`, 'm');
  let i = sorgente.search(nuovo);
  if (i >= 0) {
    const j = sorgente.indexOf("\n  comandi['", i + 10);
    return sorgente.slice(i, j > 0 ? j : i + 12000);
  }
  i = sorgente.search(vecchio);
  if (i < 0) return null;
  const j = sorgente.indexOf("\n      case '", i + 10);
  return sorgente.slice(i, j > 0 ? j : i + 12000);
}

/** Tutti i nomi di comando dell'estensione, nelle due forme. */
function nomiDeiComandi(sorgente) {
  return [...new Set([
    ...[...sorgente.matchAll(/comandi\['([a-z_0-9]+)'\]/g)].map(m => m[1]),
    ...[...sorgente.matchAll(/^ {6}case '([a-z_0-9]+)':/gm)].map(m => m[1]),
  ])];
}

module.exports.corpoDelComando = corpoDelComando;
module.exports.nomiDeiComandi = nomiDeiComandi;
