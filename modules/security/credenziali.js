// modules/security/credenziali.js — Gli accessi ai sistemi chiusi.
//
// A COSA SERVE
//
// Luca lavora su sistemi che richiedono un accesso: portali corrieri per le
// fatture, banche dati aziendali, gestionali. Senza credenziali COBRA si ferma
// sulla porta e metà del lavoro vero resta fuori.
//
// LA SCELTA DI PROGETTO CHE CONTA
//
// Il modello NON vede mai la password. Mai.
//
// Il modello chiama `accedi("ups.com")`. Il CODICE tira fuori le credenziali,
// le manda all'estensione, l'estensione compila i campi. La password non
// entra nel prompt, non entra nella risposta, non entra nel log, non passa
// dal fornitore di AI.
//
// Non è un dettaglio: COBRA legge pagine web non fidate tutto il giorno. Se
// una password fosse nel suo contesto, basterebbe una pagina scritta apposta
// per convincerlo a ripeterla. Così non c'è niente da farsi ripetere.
//
// LE ALTRE DUE DIFESE
//
//   1. Le credenziali sono LEGATE AL DOMINIO. Quella di ups.com funziona solo
//      su ups.com. Non esiste un modo di mandarla altrove — nemmeno per
//      errore, nemmeno se qualcuno convince il modello a provarci.
//
//   2. Sul disco stanno CIFRATE. Il file da solo non serve a niente: senza la
//      chiave è rumore. Chi copia il file non ha copiato le password.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ALGORITMO = 'aes-256-gcm';

/** Il dominio, ridotto alla forma con cui si confronta. */
function dominioDi(x) {
  const s = String(x || '').trim().toLowerCase();
  if (!s) return '';
  try {
    const u = s.includes('://') ? new URL(s) : new URL('https://' + s);
    return u.hostname.replace(/^www\./, '');
  } catch { return s.replace(/^www\./, '').split('/')[0]; }
}

/** La chiave di cifratura, dal .env. Senza, non si salva niente. */
function chiaveDa(segreto) {
  if (!segreto || String(segreto).length < 16) return null;
  return crypto.createHash('sha256').update(String(segreto)).digest();
}

function cifra(testo, chiave) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGORITMO, chiave, iv);
  const dato = Buffer.concat([c.update(String(testo), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), dato: dato.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

function decifra(pacchetto, chiave) {
  try {
    const d = crypto.createDecipheriv(ALGORITMO, chiave, Buffer.from(pacchetto.iv, 'base64'));
    d.setAuthTag(Buffer.from(pacchetto.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(pacchetto.dato, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }   // chiave sbagliata o file manomesso
}

class Credenziali {
  /**
   * @param {string} dataDir
   * @param {string} segreto  da COBRA_CREDENZIALI_CHIAVE nel .env
   */
  constructor(dataDir, segreto) {
    this.file = path.join(dataDir, 'accessi.enc.json');
    this.chiave = chiaveDa(segreto);
    this.voci = [];
    this._carica();
  }

  get attiva() { return !!this.chiave; }

  _carica() {
    if (!this.chiave) return;
    try {
      const grezzo = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.voci = Array.isArray(grezzo) ? grezzo : [];
    } catch { this.voci = []; }
  }

  _salva() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.voci, null, 2), { mode: 0o600 });
    } catch (_) { /* meglio non riuscire a salvare che scrivere in chiaro */ }
  }

  /**
   * Si aggiunge un accesso. La password viene cifrata subito e non esiste mai
   * in chiaro su disco.
   */
  aggiungi({ url, utente, password, note = '' }) {
    if (!this.chiave) {
      return { ok: false, motivo: 'Manca COBRA_CREDENZIALI_CHIAVE nel file .env: senza, le password finirebbero in chiaro e non lo faccio.' };
    }
    const dominio = dominioDi(url);
    if (!dominio) return { ok: false, motivo: 'Indirizzo non riconosciuto' };
    if (!utente || !password) return { ok: false, motivo: 'Servono sia utente sia password' };

    const voce = {
      dominio,
      url: String(url).trim(),
      utente: String(utente).trim(),
      segreto: cifra(password, this.chiave),
      note: String(note || '').slice(0, 200),
      aggiunta: new Date().toISOString(),
      usata: 0,
      ultimoUso: null,
    };
    this.voci = this.voci.filter(v => v.dominio !== dominio || v.utente !== voce.utente);
    this.voci.push(voce);
    this._salva();
    return { ok: true, dominio, utente: voce.utente };
  }

  /** L'elenco, SENZA le password. È quello che si mostra e si registra. */
  elenco() {
    return this.voci.map(v => ({
      dominio: v.dominio, url: v.url, utente: v.utente, note: v.note,
      aggiunta: v.aggiunta, usata: v.usata, ultimoUso: v.ultimoUso,
    }));
  }

  togli(dominio, utente = null) {
    const d = dominioDi(dominio);
    const prima = this.voci.length;
    this.voci = this.voci.filter(v => !(v.dominio === d && (!utente || v.utente === utente)));
    this._salva();
    return { ok: true, tolte: prima - this.voci.length };
  }

  /**
   * Le credenziali per un dominio — SOLO per quel dominio.
   *
   * È il punto in cui si applica la difesa più importante: si cerca per
   * dominio, quindi non esiste una strada per cui la password di ups.com
   * finisca su un altro sito. Nemmeno sbagliando, nemmeno se qualcuno
   * convincesse il modello a chiederlo.
   */
  per(url) {
    if (!this.chiave) return null;
    const d = dominioDi(url);
    if (!d) return null;
    // Corrispondenza esatta o sottodominio: fatture.ups.com usa quella di ups.com
    const v = this.voci.find(x => x.dominio === d)
      || this.voci.find(x => d.endsWith('.' + x.dominio));
    if (!v) return null;
    const password = decifra(v.segreto, this.chiave);
    if (password === null) return null;
    v.usata++; v.ultimoUso = new Date().toISOString();
    this._salva();
    return { dominio: v.dominio, url: v.url, utente: v.utente, password };
  }

  /** Se per questo indirizzo c'è un accesso — senza tirarlo fuori. */
  conosce(url) {
    const d = dominioDi(url);
    return !!(d && this.voci.some(x => x.dominio === d || d.endsWith('.' + x.dominio)));
  }
}

module.exports = { Credenziali, dominioDi };
