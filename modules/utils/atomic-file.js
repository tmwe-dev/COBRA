// modules/utils/atomic-file.js — Scrittura atomica su file
//
// Una writeFileSync diretta lascia il file troncato o parziale se il processo
// muore a metà scrittura: al riavvio il JSON è corrotto e i dati sono persi.
// Qui si scrive su un file temporaneo, si forza il flush su disco e poi si
// rinomina: rename è atomico sullo stesso filesystem, quindi il file di
// destinazione è sempre o la versione vecchia o quella nuova, mai una via di mezzo.

const fs = require('fs');
const path = require('path');

/**
 * Scrive `data` in `filePath` in modo atomico.
 * @returns {boolean} true se la scrittura è riuscita
 */
function writeAtomicSync(filePath, data) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);      // forza la scrittura fisica prima del rename
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, filePath);
    return true;
  } catch (e) {
    try { if (fd !== null) fs.closeSync(fd); } catch { /* già chiuso */ }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* niente da pulire */ }
    return false;
  }
}

/** Serializza un valore in JSON e lo scrive atomicamente. */
function writeJsonAtomicSync(filePath, value, { pretty = true } = {}) {
  let text;
  try { text = JSON.stringify(value, null, pretty ? 2 : 0); }
  catch { return false; }
  if (text === undefined) return false;
  return writeAtomicSync(filePath, text);
}

/**
 * Legge un JSON tollerando file mancanti o corrotti.
 * Se il file è illeggibile lo mette da parte con estensione .corrotto
 * invece di cancellarlo, così i dati restano recuperabili.
 */
function readJsonSafeSync(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    try {
      const backup = `${filePath}.corrotto.${Date.now()}`;
      fs.renameSync(filePath, backup);
      console.error(`[Persistenza] ${path.basename(filePath)} illeggibile (${e.message}). Salvato come ${path.basename(backup)}.`);
    } catch { /* impossibile mettere da parte: si procede col fallback */ }
    return fallback;
  }
}

module.exports = { writeAtomicSync, writeJsonAtomicSync, readJsonSafeSync };
