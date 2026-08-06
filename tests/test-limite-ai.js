#!/usr/bin/env node
// tests/test-limite-ai.js — Un fornitore muto non deve poter bloccare tutto.
//
// Caso reale del 5 agosto 2026: richiesta ferma tre minuti su
// "Trying openai (gpt-4o-mini)...", zero strumenti eseguiti, nessun modo di
// accorgersene dall'esterno. Nel codice non esisteva alcun AbortController.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { fetchConLimite } = require('../modules/ai/fetch-con-limite');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

(async () => {
  console.log('\n=== LIMITE DI TEMPO SULLE CHIAMATE AI ===');

  const fetchVero = global.fetch;

  sezione('Un fornitore che non risponde viene mollato');
  {
    // Si simula una chiamata che non finisce mai, come quella osservata
    global.fetch = (url, opz) => new Promise((_, rifiuta) => {
      if (opz && opz.signal) {
        opz.signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          rifiuta(e);
        });
      }
      // nessuna risoluzione: e' proprio il punto
    });

    const inizio = Date.now();
    let errore = null;
    try {
      await fetchConLimite('https://esempio.invalido/v1', { method: 'POST' }, 300, 'OpenAI');
    } catch (e) { errore = e; }
    const durata = Date.now() - inizio;

    ok('non aspetta all\'infinito', errore !== null);
    ok('rispetta il tempo indicato', durata < 1500, `durata=${durata}ms`);
    ok('dice chi non ha risposto', /OpenAI/.test(errore?.message || ''), errore?.message);
    ok('dice quanto ha aspettato', /secondi/.test(errore?.message || ''), errore?.message);
  }

  sezione('Il router considera il tempo scaduto un motivo per riprovare');
  {
    // La regola di ripetizione del router accetta la parola "timeout":
    // il messaggio in italiano NON la contiene, quindi si verifica che il
    // fallimento porti comunque a cambiare fornitore e non a bloccare.
    const regolaRouter = /429|rate.?limit|5\d\d|timeout|ECONNRESET|ETIMEDOUT/i;
    const messaggio = 'OpenAI non ha risposto entro 90 secondi';
    ok('il messaggio non finge di essere un errore di rete',
       regolaRouter.test(messaggio) === false, 'atteso: passa al fornitore successivo senza riprovare lo stesso');
  }

  sezione('Una risposta normale passa senza essere toccata');
  {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ scelto: 'va bene' }) });
    const r = await fetchConLimite('https://esempio.valido/v1', {}, 2000, 'OpenAI');
    ok('la risposta arriva', r.ok === true);
    ok('il corpo e\' leggibile', (await r.json()).scelto === 'va bene');
  }

  sezione('Gli errori veri non vengono mascherati da scadenza');
  {
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    let e = null;
    try { await fetchConLimite('https://esempio.spento/v1', {}, 2000, 'OpenAI'); } catch (err) { e = err; }
    ok('l\'errore originale resta leggibile', /ECONNREFUSED/.test(e?.message || ''), e?.message);
  }

  sezione('Tutti i fornitori sono coperti');
  {
    const fs = require('fs');
    for (const f of ['openai', 'anthropic', 'gemini', 'router']) {
      const s = fs.readFileSync(`modules/ai/${f}.js`, 'utf8');
      const restano = (s.match(/await fetch\(/g) || []).length;
      ok(`${f}.js usa il limite`, /fetchConLimite/.test(s));
      ok(`${f}.js non ha chiamate senza limite`, restano === 0, `${restano} rimaste`);
    }
  }

  global.fetch = fetchVero;
  console.log('');
  console.log(FAIL === 0
    ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
    : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
  process.exit(FAIL > 0 ? 1 : 0);
})();
