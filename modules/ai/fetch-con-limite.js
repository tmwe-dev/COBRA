// modules/ai/fetch-con-limite.js — Nessuna chiamata a un fornitore esterno può
// durare all'infinito.
//
// Caso reale del 5 agosto 2026: una richiesta è rimasta ferma su
// "Trying openai (gpt-4o-mini)..." per oltre tre minuti, senza eseguire un solo
// strumento. Nel codice non c'era alcun AbortController: se il fornitore non
// rispondeva, si aspettava per sempre. Il cane da guardia del supervisore
// segnava lo stato "stuck" ma non interrompeva nulla e non avvisava nessuno,
// quindi da fuori sembrava che il programma fosse morto.
//
// Con un tetto di tempo, un fornitore muto diventa un errore come un altro: il
// router lo registra e passa al successivo, che è esattamente il motivo per cui
// esistono tre fornitori.

// Una risposta con uso di strumenti può essere lenta, ma non lentissima:
// oltre il minuto e mezzo non è più attesa, è un guasto.
const LIMITE_PREDEFINITO_MS = 90000;

async function fetchConLimite(url, opzioni = {}, ms = LIMITE_PREDEFINITO_MS, etichetta = 'fornitore AI') {
  const controllore = new AbortController();
  const scadenza = setTimeout(() => controllore.abort(), ms);
  try {
    return await fetch(url, { ...opzioni, signal: controllore.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`${etichetta} non ha risposto entro ${Math.round(ms / 1000)} secondi`);
    }
    throw e;
  } finally {
    clearTimeout(scadenza);
  }
}

module.exports = { fetchConLimite, LIMITE_PREDEFINITO_MS };
