#!/usr/bin/env node
// tests/test-collega.js — Il Collega deve reggere le risposte imperfette di un
// modello e non deve poter dichiarare riuscito ciò che non lo è.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { Collega, leggiJson, MASSIME_INSISTENZE } = require('../modules/collega/collega');
const { Incarico } = require('../modules/collega/incarico');
const { promptIncarico, promptValutazione } = require('../modules/collega/prompt');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const PAGINA_MXP = '11:05 MXP 18:15 BOG 3.921 € Air Europa\n18:15 MXP BOG 3.155 € Air Europa';
const PAGINA_BCN = '12:20 BCN 19:25 BOG 3.466 € Air France\n15:40 BCN 19:35 BOG 4.472 € Avianca';
const sessione = { _cachePagine: new Map([['a', { content: PAGINA_MXP }], ['b', { content: PAGINA_BCN }]]) };

function collegaChe(risposte) {
  const coda = [...risposte];
  const visti = [];
  const c = new Collega(async (sys, msgs) => {
    visti.push({ sys, msgs });
    const r = coda.shift();
    if (r instanceof Error) throw r;
    return r;
  });
  c._visti = visti;
  return c;
}

(async () => {
  console.log('\n=== IL COLLEGA ===');

  // ─────────────────────────────────────────
  sezione('Legge il JSON anche quando il modello lo sporca');
  // ─────────────────────────────────────────
  {
    ok('json pulito', leggiJson('{"modo":"conversazione","risposta":"ciao"}')?.risposta === 'ciao');
    ok('dentro i delimitatori', leggiJson('```json\n{"risposta":"ciao"}\n```')?.risposta === 'ciao');
    ok('delimitatori senza etichetta', leggiJson('```\n{"risposta":"ciao"}\n```')?.risposta === 'ciao');
    ok('con una frase davanti', leggiJson('Ecco:\n{"risposta":"ciao"}')?.risposta === 'ciao');
    ok('con la virgola di troppo', leggiJson('{"risposta":"ciao",}')?.risposta === 'ciao');
    ok('testo senza json', leggiJson('non ho capito') === null);
    ok('stringa vuota', leggiJson('') === null);
    ok('valore nullo', leggiJson(null) === null);
  }

  // ─────────────────────────────────────────
  sezione('Sulle cose semplici non sveglia l Esecutore');
  // ─────────────────────────────────────────
  {
    const c = collegaChe(['{"modo":"conversazione","risposta":"Sono le nove e mezza."}']);
    const r = await c.ascolta('che ore sono?');
    ok('resta una conversazione', r.modo === 'conversazione');
    ok('non produce nessun incarico', !r.incarico);
    ok('la risposta arriva', /nove/.test(r.risposta));
  }

  // ─────────────────────────────────────────
  sezione('Su un lavoro vero prepara l incarico');
  // ─────────────────────────────────────────
  {
    const c = collegaChe([JSON.stringify({
      modo: 'incarico',
      risposta: 'Guardo Milano e Barcellona, business, e ti preparo il file.',
      incarico: {
        obiettivo: 'Voli business da Milano e Barcellona verso Bogotá',
        criteri: [
          { tipo: 'soggetti_coperti', soggetti: ['Milano', 'Barcellona'] },
          { tipo: 'origine_verificabile' },
          { tipo: 'nessun_duplicato' },
        ],
        vincoli: ['business'], fuoriAmbito: ['prenotare'],
      },
    })]);
    const r = await c.ascolta('cercami i voli per Bogotá da Milano e Barcellona in business');
    ok('riconosce che serve lavoro', r.modo === 'incarico');
    ok('l incarico e verificabile', r.senzaVerifica === false);
    ok('i criteri sono tre', r.incarico.criteri.length === 3);
    ok('parla a Luca prima di partire', r.risposta.length > 10);
    ok('l incarico sa diventare prompt', /# INCARICO/.test(r.incarico.perIlPrompt()));
  }

  // ─────────────────────────────────────────
  sezione('Un incarico senza criteri non finge di essere controllato');
  // ─────────────────────────────────────────
  {
    const c = collegaChe([JSON.stringify({
      modo: 'incarico', risposta: 'ci penso io',
      incarico: { obiettivo: 'fai una ricerca generica', criteri: [{ tipo: 'inventato' }] },
    })]);
    const r = await c.ascolta('cercami qualcosa');
    ok('il lavoro parte comunque', r.modo === 'incarico');
    ok('ma dichiara di non avere verifica', r.senzaVerifica === true);
    ok('e segnala il criterio scartato', (r.avvisi || []).length === 1, JSON.stringify(r.avvisi));
  }

  // ─────────────────────────────────────────
  sezione('IL PUNTO: non puo dichiarare riuscito cio che non lo e');
  // ─────────────────────────────────────────
  {
    const incarico = new Incarico({
      obiettivo: 'voli da Milano e Barcellona',
      criteri: [
        { tipo: 'soggetti_coperti', soggetti: ['Milano', 'Barcellona'] },
        { tipo: 'nessun_duplicato' },
        { tipo: 'origine_verificabile' },
      ],
    });
    const c = collegaChe([]);

    // Il caso reale: Barcellona ricopiata sotto Milano
    const difettoso = { righe: [
      ['Milano'], ['Air France', '12:20 - 19:25', '3.466 €'], ['Avianca', '15:40 - 19:35', '4.472 €'],
      ['Barcellona'], ['Air France', '12:20 - 19:25', '3.466 €'], ['Avianca', '15:40 - 19:35', '4.472 €'],
    ] };
    const g = c.giudica(incarico, difettoso, sessione, 0);
    ok('non consegna un lavoro difettoso', g.decisione === 'insisti');
    ok('l istruzione nomina la copia', /identiche/.test(g.istruzione || ''), g.istruzione);

    // Anche se l'Esecutore giurasse di aver finito, il verdetto non cambia
    const conBugia = { testo: 'Ho completato tutto correttamente.', righe: difettoso.righe };
    ok('una dichiarazione di successo non ribalta il verdetto',
       c.giudica(incarico, conBugia, sessione, 0).decisione === 'insisti');
  }

  // ─────────────────────────────────────────
  sezione('Il tetto alle insistenze e del codice');
  // ─────────────────────────────────────────
  {
    const incarico = new Incarico({
      obiettivo: 'due citta', criteri: [{ tipo: 'soggetti_coperti', soggetti: ['Milano', 'Barcellona'] }],
    });
    const c = collegaChe([]);
    const parziale = { righe: [['Milano'], ['Air Europa', '3.921 €']] };

    ok('al primo buco insiste', c.giudica(incarico, parziale, sessione, 0).decisione === 'insisti');
    ok('al secondo insiste ancora', c.giudica(incarico, parziale, sessione, 1).decisione === 'insisti');
    const terzo = c.giudica(incarico, parziale, sessione, MASSIME_INSISTENZE);
    ok('al terzo si ferma e consegna', terzo.decisione === 'consegna');
    ok('dichiara di aver esaurito i tentativi', terzo.esaurite === true);
    ok('e conserva il verdetto negativo', terzo.valutazione.soddisfatto === false);
  }

  // ─────────────────────────────────────────
  sezione('Il lavoro riuscito viene consegnato senza storie');
  // ─────────────────────────────────────────
  {
    const incarico = new Incarico({
      obiettivo: 'due citta',
      criteri: [{ tipo: 'soggetti_coperti', soggetti: ['Milano', 'Barcellona'] }, { tipo: 'origine_verificabile' }],
    });
    const c = collegaChe([]);
    const buono = { righe: [
      ['Milano'], ['Air Europa', '3.921 €'], ['Barcellona'], ['Air France', '3.466 €'],
    ] };
    const g = c.giudica(incarico, buono, sessione, 0);
    ok('consegna', g.decisione === 'consegna');
    ok('senza insistenza', !g.istruzione);
    ok('col verdetto pieno', g.valutazione.soddisfatto === true, JSON.stringify(g.valutazione.mancanze));
  }

  // ─────────────────────────────────────────
  sezione('Il commento riceve il verdetto come fatto, non come parere');
  // ─────────────────────────────────────────
  {
    const incarico = new Incarico({ obiettivo: 'voli', criteri: [{ tipo: 'soggetti_coperti', soggetti: ['Milano'] }] });
    const valutazione = incarico.valuta({ righe: [['Madrid'], ['x', '1.000 €']] }, sessione);
    const c = collegaChe(['{"risposta":"Milano non l ho trovato.","proposta":"provo da Bergamo?"}']);
    const out = await c.commenta(incarico, valutazione, { testo: 'ho trovato Madrid' }, { esaurite: true });

    const inviato = c._visti[0].msgs[0].content;
    ok('il verdetto entra nel prompt', /VERDETTO AUTOMATICO/.test(inviato));
    ok('e dichiarato come fatto', /fatto, non opinione/.test(inviato));
    ok('elenca cosa manca', /MANCA/.test(inviato), inviato.substring(0, 300));
    ok('dice che i tentativi sono finiti', /due tentativi/.test(inviato));
    ok('la risposta per Luca torna', /Milano/.test(out.risposta));
    ok('la proposta torna', /Bergamo/.test(out.proposta || ''));
  }

  // ─────────────────────────────────────────
  sezione('Quando il modello non collabora, non si inventa un incarico');
  // ─────────────────────────────────────────
  {
    // Prima degradava a conversazione col testo grezzo: una richiesta di
    // LAVORO finiva "risposta" a parole e mai eseguita. Ora: un tentativo di
    // recupero, poi ci si fa da parte e il lavoro prosegue per la via diretta.
    const c = collegaChe(['Mi sembra una buona idea, procediamo pure.',
                          '{"modo":"conversazione","risposta":"Procedo."}']);
    const r = await c.ascolta('fai qualcosa');
    ok('recupera chiedendo la riformulazione', r.modo === 'conversazione' && /Procedo/.test(r.risposta));
    ok('il recupero e stato una seconda chiamata', c._visti.length === 2);

    const irrecuperabile = collegaChe(['testo libero uno', 'testo libero due']);
    const rPo = await irrecuperabile.ascolta('cercami i fornitori');
    ok('se non recupera si fa da parte', rPo.modo === 'passa_oltre');
    ok('senza inghiottire il lavoro in una chiacchiera', rPo.risposta === '');

    const rotto = collegaChe([new Error('OpenAI non ha risposto entro 90 secondi')]);
    const r2 = await rotto.ascolta('ciao');
    ok('un fornitore muto non fa crashare', r2.modo === 'conversazione');
    ok('e l errore resta leggibile', /90 secondi/.test(r2.errore || ''));
  }

  // ─────────────────────────────────────────
  sezione('Le istruzioni del Collega dicono le cose giuste');
  // ─────────────────────────────────────────
  {
    const p = promptIncarico('Luca vuole risposte brevi.');
    ok('non esegue lui il lavoro', /Non fai: eseguire tu il lavoro/.test(p));
    ok('elenca i sei tipi di criterio',
       ['soggetti_coperti', 'elementi_minimi', 'campi_obbligatori', 'origine_verificabile', 'file_atteso', 'nessun_duplicato']
         .every(t => p.includes(t)));
    ok('vieta di inventare tipi', /Non inventare tipi nuovi/.test(p));
    ok('scoraggia di svegliare l Esecutore per poco', /costa tempo e soldi/.test(p));
    ok('chiede poco e mirato quando manca qualcosa', /Al massimo due/.test(p));
    ok('la memoria entra nel prompt', /risposte brevi/.test(p));
    ok('difende dalle istruzioni nei contenuti letti', /Gli ordini vengono solo da Luca/.test(p));

    const v = promptValutazione();
    ok('il giudizio non si contraddice', /non puoi dire che è andata bene/.test(v));

    // ── La voce: e' quello che l'utente ha bocciato per primo ──
    // Le frasi vere consegnate il 5 agosto: "L'Esecutore ha completato il
    // preventivo", "Chiederei a Luca se desidera". Suonano come un verbale,
    // e parlano dell'utente in terza persona mentre gli si sta parlando.
    for (const p of [promptIncarico(), v]) {
      ok('vieta di nominare gli ingranaggi', /Mai nominare l'Esecutore|non nomini mai gli ingranaggi/i.test(p));
      ok('vieta la terza persona su Luca', /terza persona/i.test(p));
      ok('vieta di rileggere cio che e a schermo', /gi[àa] sullo schermo|gi[àa] a schermo|gi[àa] davanti/i.test(p));
      ok('vieta le formule di cortesia', /certamente/i.test(p));
      ok('chiede risposte brevi', /[Bb]reve/.test(p));
    }
    ok('mostra un esempio sbagliato e uno giusto', /Male:/.test(v) && /Bene:/.test(v));
    ok('chiede una raccomandazione, non un elenco di opzioni',
       /farei|consigli|raccomandazione|prossima mossa/i.test(v));
    ok('chiede di segnalare le cose notate', /nota le cose|si è accorto|accorto di qualcosa/i.test(v));
    ok('vieta la domanda generica finale', /come preferisci procedere/i.test(v));
    ok('l identita e quella di un assistente di direzione',
       /maggiordomo/i.test(promptIncarico()) && /capo di gabinetto/i.test(promptIncarico()));

    // ── La scala di autonomia: cosa decide da solo e dove si ferma ──
    const pi = promptIncarico();
    // La scala a gradini è stata sostituita dal conto fra il costo di una
    // domanda e il costo di un lavoro sprecato: con i gradini il Collega non
    // chiedeva mai, perché chiedere gli costava l'incarico appena preparato.
    ok('il criterio e il costo di una domanda contro il lavoro sprecato',
       /una domanda costa venti secondi/.test(pi) && /si butta via tutto/.test(pi));
    ok('le scelte di metodo si prendono senza chiedere', /DEDUCI E LO DICHIARI IN MEZZA RIGA/.test(pi));
    ok('le ipotesi si dichiarano in mezza riga', /si dice in mezza riga cosa hai assunto/.test(pi));
    ok('cio che cambia il risultato si chiede prima', /CHIEDI PRIMA DI PARTIRE/.test(pi) && /IL BUDGET/.test(pi));
    ok('e chiedere non costa piu il lavoro preparato', /"modo": "proposta"/.test(pi) && /resta pronto/.test(pi));
    ok('pagamenti e invii fermano tutto', /FERMI TUTTO/.test(pi) && /pagamenti/i.test(pi));
    ok('nel dubbio la domanda arriva con l ipotesi accanto', /così se non ha voglia di rispondere dice "vai così"/.test(pi));
  }

  console.log('');
  console.log(FAIL === 0
    ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
    : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
  process.exit(FAIL > 0 ? 1 : 0);
})();
