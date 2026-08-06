// modules/security/ssrf.js — Protezione SSRF
//
// Due livelli:
//   isSSRFSafe(url)       — controllo sincrono e immediato sull'hostname letterale.
//                           Blocca gli IP privati scritti direttamente, in tutte le
//                           notazioni (decimale puntata, decimale intera, ottale,
//                           esadecimale, IPv6, IPv4-mapped).
//   assertSSRFSafe(url)   — controllo asincrono completo: risolve il DNS e verifica
//                           che nessun indirizzo restituito sia privato. Necessario
//                           perché un dominio pubblico può puntare a 127.0.0.1
//                           (DNS rebinding), che il solo controllo sull'hostname
//                           non intercetta.

const dns = require('dns').promises;

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'metadata.google.internal', 'metadata', 'instance-data',
]);

// Suffissi di rete interna: non devono mai essere raggiunti
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain'];

/** Espande le notazioni alternative di un indirizzo IPv4 in forma puntata. */
function parseIPv4(host) {
  // Forma puntata classica: 192.168.1.1
  const dotted = host.split('.');
  if (dotted.length === 4 && dotted.every(p => /^\d+$/.test(p))) {
    const n = dotted.map(Number);
    if (n.every(x => x >= 0 && x <= 255)) return n;
  }
  // Intero singolo (decimale, ottale con 0, esadecimale con 0x)
  let value = null;
  if (/^0x[0-9a-f]+$/i.test(host)) value = parseInt(host, 16);
  else if (/^0[0-7]+$/.test(host)) value = parseInt(host, 8);
  else if (/^\d+$/.test(host)) value = parseInt(host, 10);
  if (value !== null && Number.isFinite(value) && value >= 0 && value <= 0xFFFFFFFF) {
    return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
  }
  // Forma puntata con segmenti ottali/esadecimali: 0177.0.0.01
  if (dotted.length === 4) {
    const n = dotted.map(p => {
      if (/^0x[0-9a-f]+$/i.test(p)) return parseInt(p, 16);
      if (/^0[0-7]+$/.test(p)) return parseInt(p, 8);
      if (/^\d+$/.test(p)) return parseInt(p, 10);
      return NaN;
    });
    if (n.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) return n;
  }
  return null;
}

/** Vero se l'IPv4 (come array di 4 ottetti) appartiene a una rete non instradabile. */
function isPrivateIPv4(o) {
  if (!o) return false;
  const [a, b] = o;
  if (a === 0) return true;                        // 0.0.0.0/8 "questa rete"
  if (a === 10) return true;                       // privata
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local (include metadata cloud)
  if (a === 172 && b >= 16 && b <= 31) return true; // privata
  if (a === 192 && b === 168) return true;         // privata
  if (a === 192 && b === 0) return true;           // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a >= 224) return true;                       // multicast e riservati
  return false;
}

/** Vero se l'IPv6 è loopback, link-local, unique-local, o mappa un IPv4 privato. */
function isPrivateIPv6(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::' || h === '::1') return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;   // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;   // fc00::/7 unique-local
  // IPv4-mapped: ::ffff:127.0.0.1 oppure ::ffff:7f00:1
  const mapped = h.match(/^::ffff:(.+)$/);
  if (mapped) {
    const inner = mapped[1];
    if (inner.includes('.')) return isPrivateIPv4(parseIPv4(inner));
    const hexParts = inner.split(':');
    if (hexParts.length === 2) {
      const hi = parseInt(hexParts[0], 16), lo = parseInt(hexParts[1], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return isPrivateIPv4([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255]);
      }
    }
  }
  return false;
}

/** Vero se l'indirizzo (IPv4 o IPv6) non deve essere raggiungibile. */
function isPrivateAddress(addr) {
  if (!addr) return true;
  if (addr.includes(':')) return isPrivateIPv6(addr);
  return isPrivateIPv4(parseIPv4(addr));
}

/**
 * Controllo sincrono. Blocca protocolli non-HTTP, hostname interni noti e
 * indirizzi IP privati scritti in qualunque notazione.
 * Non risolve il DNS: per quello serve assertSSRFSafe.
 */
function isSSRFSafe(urlString) {
  try {
    const u = new URL(urlString);
    if (!['http:', 'https:'].includes(u.protocol)) return false;

    const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!hostname) return false;
    if (BLOCKED_HOSTNAMES.has(hostname)) return false;
    if (BLOCKED_SUFFIXES.some(s => hostname.endsWith(s))) return false;

    // Credenziali nell'URL: vettore comune di offuscamento (http://evil.com@127.0.0.1)
    if (u.username || u.password) return false;

    if (hostname.includes(':')) return !isPrivateIPv6(hostname);

    const v4 = parseIPv4(hostname);
    if (v4) return !isPrivateIPv4(v4);

    return true; // nome di dominio: la verifica reale avviene in assertSSRFSafe
  } catch { return false; }
}

/**
 * Controllo completo: applica isSSRFSafe e poi risolve il DNS, verificando che
 * NESSUN indirizzo restituito sia privato. Copre il DNS rebinding, dove un
 * dominio pubblico risolve verso la rete interna.
 *
 * @returns {Promise<{safe: boolean, reason?: string, addresses?: string[]}>}
 */
/**
 * @param {string} urlString
 * @param {object} opz
 * @param {'server'|'browser'} opz.lato  chi aprirà l'indirizzo.
 *
 *   'server'  — la richiesta parte da questo processo, che sta dentro la rete
 *               di Luca. È il caso pericoloso: un dominio che risolve a un
 *               indirizzo interno permetterebbe di leggere un gestionale, un
 *               NAS, la console del router. Se non si riesce a sapere dove
 *               punta, NON si va. Fail-closed, ed è il valore predefinito:
 *               chi aggiunge un chiamante domani è protetto senza saperlo.
 *
 *   'browser' — la pagina la apre Chrome, che risolve per conto suo e applica
 *               le proprie protezioni. Negare qui non protegge niente: fermerebbe
 *               solo il lavoro quando il resolver ha un singhiozzo. Questo caso
 *               va dichiarato esplicitamente da chi lo usa.
 */
async function assertSSRFSafe(urlString, { timeoutMs = 3000, lato = 'server' } = {}) {
  if (!isSSRFSafe(urlString)) {
    return { safe: false, reason: 'Hostname o protocollo non consentito' };
  }
  let hostname;
  try { hostname = new URL(urlString).hostname.toLowerCase().replace(/^\[|\]$/g, ''); }
  catch { return { safe: false, reason: 'URL non valido' }; }

  // Se è già un IP letterale, isSSRFSafe lo ha validato: niente DNS da risolvere
  if (hostname.includes(':') || parseIPv4(hostname)) return { safe: true };

  let addresses;
  try {
    addresses = await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('DNS timeout')), timeoutMs)),
    ]);
  } catch (e) {
    // Un resolver che non risponde NON è un verdetto di sicurezza.
    //
    // Osservato in produzione: un EAI_AGAIN passeggero ha fatto fallire tre
    // navigazioni in pochi millisecondi; il modello, vedendo tre errori
    // istantanei, ha dichiarato il passo fallito inventando una spiegazione
    // ("i siti non hanno caricato"). Un guasto della rete si era travestito da
    // limite del programma.
    //
    // La distinzione che conta: se il DNS RISPONDE e indica un indirizzo
    // interno, si blocca — quella è la difesa vera, e resta intatta. Se invece
    // il DNS non risponde affatto, non sappiamo nulla, e per un dominio
    // pubblico e ben formato (isSSRFSafe è già passato sopra) si procede.
    // Nel percorso bridge la pagina la apre comunque Chrome, che risolve per
    // conto suo: negare qui non protegge niente e ferma il lavoro.
    const transitorio = /EAI_AGAIN|ETIMEDOUT|ESERVFAIL|DNS timeout|queryA ETIMEOUT/i.test(e.message || '');
    if (transitorio) {
      // Qui la strada si divide, e prima non si divideva: la stessa risposta
      // valeva per una richiesta che parte da dentro la rete e per una pagina
      // aperta da Chrome. Sono due rischi diversi e meritano due risposte.
      if (lato === 'browser') {
        return {
          safe: true,
          degradato: true,
          reason: `DNS non raggiungibile (${e.message}): apre Chrome, che risolve per conto suo`,
        };
      }
      return {
        safe: false,
        degradato: true,
        reason: `DNS non raggiungibile (${e.message}): non so dove punta questo indirizzo, `
          + 'e una richiesta che parte da qui potrebbe finire sulla rete interna. Riprova fra poco.',
      };
    }
    // NXDOMAIN e simili: il dominio non esiste, non c'è nulla da proteggere,
    // ma nemmeno da visitare. Si nega con un motivo che non confonda.
    return { safe: false, reason: `Il dominio non esiste o non è raggiungibile: ${e.message}` };
  }

  const list = (addresses || []).map(a => a.address);
  if (list.length === 0) return { safe: false, reason: 'Nessun indirizzo risolto' };

  const privates = list.filter(isPrivateAddress);
  if (privates.length > 0) {
    return { safe: false, reason: `Il dominio risolve a indirizzi interni: ${privates.join(', ')}`, addresses: list };
  }
  return { safe: true, addresses: list };
}

module.exports = { isSSRFSafe, assertSSRFSafe, isPrivateAddress, parseIPv4, isPrivateIPv4, isPrivateIPv6 };
