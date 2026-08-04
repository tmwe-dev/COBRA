// modules/utils/imap.js — Lettura posta via IMAP, senza dipendenze esterne.
//
// IMAP è un protocollo testuale: si apre una connessione cifrata, si inviano
// comandi numerati e si legge la risposta finché non arriva la riga che chiude
// il comando. Qui serve solo leggere, quindi si implementano cinque comandi:
// LOGIN, SELECT, SEARCH, FETCH, LOGOUT.

const tls = require('tls');

/** Decodifica le parole codificate MIME nei campi intestazione: =?UTF-8?B?...?= */
function decodeHeader(raw) {
  if (!raw) return '';
  return raw.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, tipo, testo) => {
    try {
      if (tipo.toUpperCase() === 'B') {
        return Buffer.from(testo, 'base64').toString('utf8');
      }
      // Quoted-printable: _ vale spazio, =XX è un byte esadecimale
      const bytes = testo.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g,
        (__, hex) => String.fromCharCode(parseInt(hex, 16)));
      return Buffer.from(bytes, 'binary').toString('utf8');
    } catch { return testo; }
  }).replace(/\s+/g, ' ').trim();
}

/** Ripulisce il corpo del messaggio per ricavarne un'anteprima leggibile. */
function bodyPreview(raw, maxLen = 300) {
  if (!raw) return '';
  let testo = raw;
  // Se il corpo è interamente base64 lo si decodifica
  const compatto = testo.replace(/\s/g, '');
  if (compatto.length > 40 && /^[A-Za-z0-9+/]+={0,2}$/.test(compatto)) {
    try { testo = Buffer.from(compatto, 'base64').toString('utf8'); } catch { /* non era base64 */ }
  }
  // Quoted-printable: i byte vanno raccolti e poi interpretati come UTF-8,
  // altrimenti "=C3=A9" diventa due caratteri separati invece di "é".
  if (/=[0-9A-Fa-f]{2}/.test(testo)) {
    const binario = testo
      .replace(/=\r?\n/g, '')                                 // a capo morbidi
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    testo = Buffer.from(binario, 'binary').toString('utf8');
  }

  return testo
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')                                 // tag HTML
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLen);
}

/**
 * Apre una sessione IMAP e restituisce un oggetto con cui inviare comandi.
 * Ogni comando riceve un'etichetta progressiva; la risposta è considerata
 * completa quando arriva la riga che inizia con quella etichetta.
 */
function apriSessione({ host, port = 993, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: true },
      () => { /* connessione stabilita: si attende il saluto del server */ }
    );

    let buffer = '';
    let inAttesa = null;   // { etichetta, resolve, reject }
    let contatore = 0;
    let chiusa = false;

    const timer = setTimeout(() => {
      chiudi(new Error(`Timeout IMAP dopo ${timeoutMs}ms`));
    }, timeoutMs);

    function chiudi(errore) {
      if (chiusa) return;
      chiusa = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* già chiuso */ }
      if (inAttesa) { inAttesa.reject(errore); inAttesa = null; }
      if (errore) reject(errore);
    }

    socket.on('error', (e) => chiudi(new Error(`Connessione IMAP fallita: ${e.message}`)));
    socket.on('close', () => { if (inAttesa) chiudi(new Error('Connessione IMAP chiusa dal server')); });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      // Saluto iniziale del server
      if (!inAttesa && /^\* (OK|PREAUTH)/m.test(buffer)) {
        buffer = '';
        resolve({ comando, logout, socket });
        return;
      }
      if (!inAttesa) return;

      // La risposta è completa quando compare la riga con l'etichetta del comando
      const fine = new RegExp(`^${inAttesa.etichetta} (OK|NO|BAD)([^\r\n]*)`, 'm');
      const m = buffer.match(fine);
      if (!m) return;

      const risposta = buffer.slice(0, m.index);
      const esito = m[1];
      const dettaglio = (m[2] || '').trim();
      buffer = '';
      const pendente = inAttesa;
      inAttesa = null;
      if (esito === 'OK') pendente.resolve(risposta);
      else pendente.reject(new Error(`${pendente.nome}: ${dettaglio || esito}`));
    });

    /** Invia un comando e attende la sua risposta completa. */
    function comando(testo, nomeVisibile) {
      return new Promise((res, rej) => {
        if (chiusa) { rej(new Error('Sessione IMAP chiusa')); return; }
        const etichetta = 'c' + (++contatore);
        inAttesa = { etichetta, resolve: res, reject: rej, nome: nomeVisibile || testo.split(' ')[0] };
        buffer = '';
        socket.write(`${etichetta} ${testo}\r\n`);
      });
    }

    async function logout() {
      try { await comando('LOGOUT'); } catch { /* la chiusura può arrivare prima */ }
      chiusa = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* già chiuso */ }
    }
  });
}

/** Racchiude un valore fra virgolette per l'invio IMAP. */
function virgolette(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Legge i messaggi dalla casella.
 *
 * @param {object} cfg  host, port, user, pass
 * @param {object} opts limit (default 10), onlyUnread (default true), mailbox (default INBOX)
 * @returns {Promise<{ok:boolean, mailbox:string, totale:number, messaggi:Array}>}
 */
async function leggiPosta(cfg, opts = {}) {
  const { host, port = 993, user, pass } = cfg || {};
  if (!host || !user || !pass) throw new Error('Configurazione IMAP incompleta: servono host, user e pass');

  const limite = Math.min(Math.max(Number(opts.limit) || 10, 1), 50);
  const soloNonLette = opts.onlyUnread !== false;
  const casella = opts.mailbox || 'INBOX';

  const s = await apriSessione({ host, port, timeoutMs: opts.timeoutMs || 15000 });
  try {
    await s.comando(`LOGIN ${virgolette(user)} ${virgolette(pass)}`, 'LOGIN');
    const selezione = await s.comando(`SELECT ${virgolette(casella)}`, 'SELECT');
    const totale = Number((selezione.match(/\* (\d+) EXISTS/) || [])[1] || 0);

    const ricerca = await s.comando(soloNonLette ? 'SEARCH UNSEEN' : 'SEARCH ALL', 'SEARCH');
    const ids = ((ricerca.match(/^\* SEARCH([^\r\n]*)/m) || [])[1] || '')
      .trim().split(/\s+/).filter(Boolean);

    if (ids.length === 0) {
      await s.logout();
      return { ok: true, mailbox: casella, totale, nonLette: 0, messaggi: [] };
    }

    // I più recenti stanno in fondo alla lista
    const scelti = ids.slice(-limite).reverse();
    const dati = await s.comando(
      `FETCH ${scelti.join(',')} (FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT]<0.600>)`,
      'FETCH'
    );

    const messaggi = analizzaFetch(dati);
    await s.logout();
    return {
      ok: true,
      mailbox: casella,
      totale,
      nonLette: soloNonLette ? ids.length : undefined,
      messaggi: messaggi.slice(0, limite),
    };
  } catch (e) {
    try { await s.logout(); } catch { /* best-effort */ }
    throw e;
  }
}

/** Estrae i messaggi dalla risposta grezza di FETCH. */
function analizzaFetch(raw) {
  const messaggi = [];
  // Ogni messaggio inizia con "* <numero> FETCH"
  const blocchi = raw.split(/^\* (\d+) FETCH /m);
  for (let i = 1; i < blocchi.length; i += 2) {
    const numero = blocchi[i];
    const corpo = blocchi[i + 1] || '';
    const from = decodeHeader((corpo.match(/^From:\s*([^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)/mi) || [])[1]);
    const subject = decodeHeader((corpo.match(/^Subject:\s*([^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)/mi) || [])[1]);
    const date = ((corpo.match(/^Date:\s*([^\r\n]*)/mi) || [])[1] || '').trim();
    const letta = /\\Seen/.test((corpo.match(/FLAGS \(([^)]*)\)/) || [])[1] || '');

    // Il corpo del testo è l'ultimo literal della risposta.
    // La parentesi che chiude il blocco FETCH non fa parte del messaggio.
    const parti = corpo.split(/BODY\[TEXT\]<0>\s*\{\d+\}\r?\n/);
    const testo = parti.length > 1
      ? parti[parti.length - 1].replace(/\r?\n\)\s*$/, '')
      : '';

    if (from || subject) {
      messaggi.push({
        n: Number(numero),
        da: from || '(mittente sconosciuto)',
        oggetto: subject || '(nessun oggetto)',
        data: date,
        letta,
        anteprima: bodyPreview(testo),
      });
    }
  }
  return messaggi;
}

module.exports = { leggiPosta, decodeHeader, bodyPreview, analizzaFetch };
