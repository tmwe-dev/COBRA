// modules/collega/cantiere-archivio.js — Il cantiere su disco.
//
// Un lavoro da otto aziende non sta in un turno. Se il cantiere muore a fine
// turno, o al riavvio del server, il lavoro ricomincia da capo ogni volta —
// ed è quello che è successo per quattro tentativi di fila il 6 agosto.
//
// Qui il cantiere aperto resta scritto, con il suo obiettivo. Alla richiesta
// dopo si riapre quello, se si sta ancora parlando della stessa cosa;
// altrimenti si chiude e se ne apre uno nuovo.

const path = require('path');
const { Cantiere } = require('./cantiere');
const { writeJsonAtomicSync, readJsonSafeSync } = require('../utils/atomic-file');

const SCADENZA_MS = 6 * 60 * 60 * 1000;   // sei ore: oltre, i dati non sono più freschi

class ArchivioCantieri {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'cantiere_aperto.json');
  }

  salva(cantiere) {
    if (!cantiere) return this.chiudi();
    try { writeJsonAtomicSync(this.file, cantiere.perIlDisco()); } catch (_) { /* best-effort */ }
  }

  /**
   * Riapre il cantiere lasciato a metà, se è ancora quello giusto.
   * @param {string} obiettivo  l'obiettivo del lavoro che sta partendo adesso
   */
  riapri(obiettivo) {
    const dati = readJsonSafeSync(this.file, null);
    if (!dati) return null;

    // Troppo vecchio: i prezzi e le disponibilità nel frattempo cambiano.
    if (Date.now() - (dati.aperto || 0) > SCADENZA_MS) { this.chiudi(); return null; }

    // È lo stesso lavoro? Si confrontano le parole che contano, come per i
    // piani: un obiettivo riformulato non deve far ricominciare da zero.
    if (obiettivo && dati.obiettivo && !_stessoLavoro(dati.obiettivo, obiettivo)) return null;

    return Cantiere.daDisco(dati);
  }

  chiudi() {
    try { writeJsonAtomicSync(this.file, null); } catch (_) { /* best-effort */ }
  }
}

const PAROLINE = new Set(['il','lo','la','i','gli','le','un','uno','una','di','a','da','in','con','su','per','tra','fra','e','del','della','dei','delle','al','alla','ai','che','non','piu','con']);
function _paroleUtili(t) {
  return new Set(String(t || '').toLowerCase().replace(/[^a-zà-ù0-9\s]/g, ' ')
    .split(/\s+/).filter(p => p.length > 2 && !PAROLINE.has(p)));
}
function _stessoLavoro(a, b) {
  const A = _paroleUtili(a), B = _paroleUtili(b);
  if (!A.size || !B.size) return false;
  let comuni = 0;
  for (const p of A) if (B.has(p)) comuni++;
  return comuni / Math.min(A.size, B.size) >= 0.5;
}

module.exports = { ArchivioCantieri, SCADENZA_MS };
