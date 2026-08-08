// modules/utils/annunci.js — Un annuncio non è un risultato.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHÉ ESISTE
//
// Prova vera del 9 agosto, richiesta "voli Milano-Tokyo, Madrid e Bogotá".
// COBRA ha aperto, uno dopo l'altro:
//
//   bing.com/aclick?ld=e8XFh5bkk73...  (19s) → "probabile blocco anti-bot"
//   bing.com/aclick?ld=e8wMFEsosDV...  (19s) → "probabile blocco anti-bot"
//   bing.com/aclick?ld=e82kvSsvrE7...  (in corso)
//
// Un minuto buttato, zero dati. Non erano siti di voli: erano i link
// SPONSORIZZATI in cima ai risultati, che passano da un redirect di tracciamento
// pieno di parametri. Dentro, codificata in base64, c'è la destinazione vera —
// airfrance.it, aireuropa.com, kayak.it — ma il redirect quasi sempre risponde
// con una pagina vuota a chi non è un browser con una sessione pubblicitaria.
//
// Il modello li sceglie perché stanno in cima e sembrano risultati. È lo stesso
// errore che farebbe una persona distratta, con la differenza che una persona
// dopo il primo capisce.
//
// ── COSA SI FA ──
//
// Non si vieta e basta: si estrae la destinazione VERA quando c'è. Quei
// redirect portano l'indirizzo di arrivo nei propri parametri, spesso in
// base64: se si riesce a leggerlo, si va lì direttamente e si è guadagnato un
// passaggio invece di perderne uno.
//
// Se non si riesce, si dice che è un annuncio e si suggerisce di prendere un
// altro risultato. Meglio saltare un risultato che bruciare venti secondi per
// una pagina vuota.
// ══════════════════════════════════════════════════════════════════════

/** I redirect di tracciamento pubblicitario, per come si riconoscono. */
const ANNUNCI = [
  /\bbing\.com\/aclick\?/i,
  /\bgoogleadservices\.com\/pagead\/aclk/i,
  /\bgoogle\.[a-z.]+\/aclk\?/i,
  /\bdoubleclick\.net\//i,
  /\bad\.atdmt\.com\//i,
  /\badclick\.g\.doubleclick\.net\//i,
  /\bduckduckgo\.com\/y\.js\?/i,
  /\byandex\.[a-z]+\/an\/count\//i,
  /\bamazon\.[a-z.]+\/.*\/ref=.*sspa/i,
];

/** È un redirect pubblicitario invece di un risultato vero? */
function eUnAnnuncio(url) {
  const u = String(url || '');
  return ANNUNCI.some(r => r.test(u));
}

/**
 * La destinazione vera nascosta nel redirect.
 *
 * Questi indirizzi portano il sito di arrivo nei propri parametri: a volte in
 * chiaro (`&url=`), più spesso in base64 (`&u=aHR0cHM6...`). Si prova a
 * leggerlo, perché un annuncio verso airfrance.it contiene comunque
 * l'informazione che serviva.
 *
 * @returns {string|null} l'indirizzo vero, oppure null se non si legge
 */
function destinazioneVera(url, profondita = 0) {
  // ── Gli annunci sono a scatole cinesi ──
  //
  // Il primo livello di bing/aclick porta a doubleclick, e la destinazione
  // vera — airfrance.it — sta DENTRO quel secondo indirizzo, in un parametro
  // suo. Fermarsi al primo strato restituisce un altro annuncio, che viene
  // giustamente scartato: e cosi' si perde un dato che c'era.
  //
  // Tre livelli bastano e evitano di girare in tondo se un giorno un redirect
  // puntasse a se stesso.
  if (profondita > 3) return null;

  let u;
  try { u = new URL(String(url || '')); } catch (_) { return null; }

  // I nomi che questi redirect usano per la destinazione.
  const CHIAVI = ['u', 'url', 'ru', 'r', 'dest', 'destination', 'target', 'to', 'adurl', 'ds_dest_url'];

  for (const k of CHIAVI) {
    const v = u.searchParams.get(k);
    if (!v) continue;

    // In chiaro
    if (/^https?:\/\//i.test(v)) {
      const pulito = _ripulisci(v);
      if (pulito && !eUnAnnuncio(pulito)) return pulito;
      if (pulito) { const dentro = destinazioneVera(pulito, profondita + 1); if (dentro) return dentro; }
    }

    // In base64: e' la forma piu' comune su bing/aclick.
    try {
      const decodificato = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const dentro = decodeURIComponent(decodificato);
      // Tutti gli indirizzi che compaiono, non solo il primo: il primo e'
      // quasi sempre un altro passaggio di tracciamento, e quello buono sta
      // piu' avanti, dentro un parametro tipo ds_dest_url.
      for (const m of dentro.matchAll(/https?:\/\/[^\s"'<>&]+/gi)) {
        const pulito = _ripulisci(m[0]);
        if (!pulito) continue;
        if (!eUnAnnuncio(pulito)) return pulito;
        const piuDentro = destinazioneVera(pulito, profondita + 1);
        if (piuDentro) return piuDentro;
      }
    } catch (_) { /* non era base64: si prova la chiave dopo */ }
  }

  return null;
}

/**
 * Si toglie la coda di tracciamento.
 *
 * Non e' pulizia estetica: quei parametri cambiano a ogni clic, e con loro
 * cambia l'indirizzo. Due letture della stessa pagina sembrerebbero due pagine
 * diverse, e la cache del turno non servirebbe a niente.
 */
function _ripulisci(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid|gclsrc|msclkid|fbclid|mc_|ds_|esl-k|rlid|vqd|iurl|cid|aid|adid|tid|pid|oiid)/i.test(k)) {
        u.searchParams.delete(k);
      }
    }
    return u.href;
  } catch (_) { return url; }
}

/**
 * Cosa fare con un indirizzo prima di aprirlo.
 *
 * @returns {{apri: string}|{salta: true, motivo, cosaFare}}
 */
function primaDiAprire(url) {
  if (!eUnAnnuncio(url)) return { apri: url };

  const vera = destinazioneVera(url);
  if (vera) {
    return { apri: vera, eraUnAnnuncio: true,
      nota: `era un link sponsorizzato: vado diritto a ${_dominio(vera)}` };
  }

  return {
    salta: true,
    motivo: 'e\' un link sponsorizzato, non un risultato: risponde con una pagina vuota',
    cosaFare: 'Prendi un altro risultato della ricerca, oppure vai diretto al sito del vettore.',
  };
}

function _dominio(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return url; }
}

module.exports = { eUnAnnuncio, destinazioneVera, primaDiAprire, ANNUNCI };
