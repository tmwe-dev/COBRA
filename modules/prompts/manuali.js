// modules/prompts/manuali.js — I manuali: fuori dal prompt, a portata di mano.
//
// IL PROBLEMA CHE RISOLVE
//
// Il 6 agosto 2026 il prompt assemblato che arrivava al modello misurava
// 25.035 caratteri. Dentro c'era anche la regola per annotare il lavoro:
// 812 caratteri, il 3% del totale. Il modello ha visitato dieci aziende
// senza usarla una volta.
//
// Non era sbagliata: era invisibile. E la sezione più lunga di tutte —
// 2.246 caratteri sul parlato — veniva spedita anche quando nessuno stava
// parlando ad alta voce.
//
// COME LAVORA
//
// I manuali stanno in file .md separati, ognuno con titolo e tag. Nel prompt
// ci va solo l'INDICE: poche righe che dicono quali manuali esistono e quando
// servono. Il testo completo arriva in due modi:
//
//   - da solo, se i tag combaciano con quello che si sta facendo;
//   - a richiesta, con lo strumento leggi_manuale.
//
// Così il prompt resta corto e le regole che servono si vedono, invece di
// annegare in mezzo a quelle che oggi non c'entrano.

const fs = require('fs');
const path = require('path');

const CARTELLA = path.join(__dirname, 'kb');

let _cache = null;

/** Legge i manuali dal disco una volta sola. */
function carica() {
  if (_cache) return _cache;
  _cache = new Map();
  let file = [];
  try { file = fs.readdirSync(CARTELLA).filter(f => f.endsWith('.md')); }
  catch { return _cache; }

  for (const f of file) {
    const nome = f.replace(/\.md$/, '');
    if (nome === 'INDICE') continue;
    let testo = '';
    try { testo = fs.readFileSync(path.join(CARTELLA, f), 'utf8'); } catch { continue; }

    // Intestazione: titolo e tag, fra due righe di tre trattini
    const m = testo.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const intestazione = m ? m[1] : '';
    const corpo = (m ? m[2] : testo).trim();
    const titolo = (intestazione.match(/titolo:\s*(.+)/) || [])[1] || nome;
    const tags = ((intestazione.match(/tags:\s*\[(.*?)\]/) || [])[1] || '')
      .split(',').map(t => t.trim().toLowerCase()).filter(Boolean);

    _cache.set(nome, { nome, titolo: titolo.trim(), tags, corpo });
  }
  return _cache;
}

/** L'indice, che è l'unica cosa che sta sempre nel prompt. */
function indice() {
  try { return fs.readFileSync(path.join(CARTELLA, 'INDICE.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '').trim(); }
  catch { return ''; }
}

/** Un manuale intero, per nome. */
function manuale(nome) {
  const m = carica().get(String(nome || '').trim().toLowerCase());
  return m ? m.corpo : null;
}

function elenco() {
  return [...carica().values()].map(m => ({ nome: m.nome, titolo: m.titolo, tags: m.tags, caratteri: m.corpo.length }));
}

/**
 * Quali manuali servono adesso, guardando cosa si sta per fare.
 *
 * Si guarda il messaggio e gli ambiti attivi: chi deve compilare un modulo
 * riceve il manuale dei moduli, chi cerca riceve quello della ricerca. Il
 * manuale della voce arriva solo quando si parla davvero.
 */
function pertinenti({ messaggio = '', scopes = [], voiceMode = false } = {}) {
  const testo = String(messaggio).toLowerCase();
  const scelti = [];

  for (const m of carica().values()) {
    if (m.nome === 'voce') { if (voiceMode) scelti.push(m); continue; }
    const perTag = m.tags.some(t => t.length > 3 && testo.includes(t));
    const perScope =
      (m.nome === 'ricerca' && (scopes.includes('search') || scopes.includes('browse')))
      || (m.nome === 'navigazione' && (scopes.includes('browse') || scopes.includes('interact')))
      || (m.nome === 'raccolta' && (scopes.includes('data') || scopes.includes('file')))
      || (m.nome === 'processi' && scopes.length >= 3);
    if (perTag || perScope) scelti.push(m);
  }
  return scelti;
}

/** Il blocco pronto per il prompt: indice sempre, manuali pertinenti quando servono. */
function perIlPrompt(contesto = {}) {
  const pezzi = [];
  const idx = indice();
  if (idx) pezzi.push(idx);
  for (const m of pertinenti(contesto)) {
    pezzi.push(`# ${m.titolo}\n\n${m.corpo}`);
  }
  return pezzi.join('\n\n');
}

module.exports = { indice, manuale, elenco, pertinenti, perIlPrompt, _svuotaCache: () => { _cache = null; } };
