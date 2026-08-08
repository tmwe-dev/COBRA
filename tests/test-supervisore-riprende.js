#!/usr/bin/env node
// tests/test-supervisore-riprende.js — Un lavoro a metà si riprende da solo.
//
// PERCHÉ QUESTO FILE
//
// Il lavoro adesso sopravvive al turno: il cantiere dice cosa è stato
// raccolto, il piano dice dove si è arrivati, i criteri dicono quando sarà
// finito. Ma sopravvivere non basta.
//
// Finora la ripresa dipendeva da Luca: doveva riscrivere la richiesta — e
// riscrivendola otteneva un incarico nuovo, un piano nuovo, e un modello che
// ricominciava da capo. Il lavoro c'era su disco e non lo guardava nessuno.
//
// Il Supervisore è codice, non un secondo modello. Un supervisore che chiedesse
// a un'AI se il lavoro è finito avrebbe lo stesso difetto che stiamo curando:
// direbbe di sì.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
const fs = require('fs');
const { guarda, dovrebbeRiprendere, pacchettoDiRipresa } = require('../modules/collega/ripresa');
const { Processo } = require('../modules/process/engine');
const { Cantiere } = require('../modules/collega/cantiere');

let pass = 0, fail = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

function lavoroAMeta() {
  const p = new Processo('confronto fornitori imballaggi in Veneto', [
    { titolo: 'cerca aziende' },
    { titolo: 'raccogli email', dipendeDa: [1] },
    { titolo: 'scrivi il report', dipendeDa: [2] },
  ]);
  p.iniziaPasso(1); p.completaPasso(1, { prova: '20 aziende trovate' });
  p.iniziaPasso(2); p.falliscePasso(2, 'quattro siti senza contatti');

  const c = new Cantiere({ campiAttesi: ['sito', 'email'], quanteVoci: 3 });
  c.obiettivo = 'confronto fornitori imballaggi in Veneto';
  c.aperto = Date.now();
  c.annota('Alfa Srl', { sito: 'alfa.it', email: 'info@alfa.it' }, 'https://alfa.it');
  c.annota('Beta Spa', { sito: 'beta.it' }, 'https://beta.it');

  return { cantiere: c, processo: p, obiettivo: c.obiettivo,
    criteri: [{ tipo: 'campi_obbligatori', campi: ['sito', 'email'] }] };
}

console.log('\n=== IL SUPERVISORE RIPRENDE ===');

sezione('Quando riprendere, e quando no');
{
  const l = lavoroAMeta();
  for (const m of ['vai', 'continua', 'riprendi', 'prosegui', 'avanti', 'finisci']) {
    ok(`"${m}" riprende il lavoro aperto`, dovrebbeRiprendere(m, l).si === true);
  }
  ok('anche riformulandolo con altre parole',
     dovrebbeRiprendere('come va il confronto dei fornitori di imballaggi?', l).si === true);

  // Il caso che protegge: Luca cambia argomento. Riprendere il lavoro vecchio
  // significherebbe ignorare quello che ha appena chiesto.
  ok('ma un altro argomento NON lo riprende',
     dovrebbeRiprendere('mandami un messaggio a Sara su LinkedIn', l).si === false);
  ok('nemmeno una domanda qualsiasi',
     dovrebbeRiprendere('che ore sono?', l).si === false);
  ok('e senza lavoro aperto non c e niente da riprendere',
     dovrebbeRiprendere('vai', { cantiere: null, processo: null }).si === false);

  // "vai" dentro una frase lunga non è una conferma: è una richiesta nuova.
  ok('"vai" dentro una richiesta nuova non conta',
     dovrebbeRiprendere('vai su booking e cercami un hotel a Palermo per tre notti', l).si === false);
}

sezione('Il foglio dice cosa e fatto e cosa manca');
{
  const l = lavoroAMeta();
  const r = guarda(l, 'vai');
  ok('il supervisore dice di riprendere', r.riprendere === true);
  const t = r.pacchetto;

  ok('la prima cosa e NON RICOMINCIARE', /NON RICOMINCIARE DA CAPO/.test(t));
  ok('c e l obiettivo', /confronto fornitori/.test(t));
  ok('quello che e gia fatto', /GIÀ FATTI/.test(t) && /cerca aziende/.test(t));
  ok('quello che e gia fallito', /GIÀ PROVATI E FALLITI/.test(t) && /senza contatti/.test(t));
  ok('con l invito a cambiare strada', /cambia strada, non ripetere/.test(t));
  ok('quello che e gia raccolto', /Alfa Srl/.test(t) && /alfa\.it/.test(t));
  ok('cosa manca, in elenco', /MANCA QUESTO/.test(t));
  ok('e quando sara finito', /SARÀ FINITO QUANDO/.test(t));

  // Corto per scelta: la cronologia costa e contiene i tentativi falliti,
  // che sono proprio le strade da non ripercorrere.
  ok('e sta in poche righe', t.split('\n').length < 40, `${t.split('\n').length} righe`);
}

sezione('Lo stallo si dice, non si nasconde');
{
  // Il passo 3 dipende dal 2, che è fallito: nessun passo può partire.
  // Insistere sul piano è inutile, e tacerlo fa girare a vuoto.
  const l = lavoroAMeta();
  const r = guarda(l, 'continua');
  ok('quando nessun passo puo partire lo dichiara', /IN STALLO/.test(r.pacchetto));
  ok('e dice di cercare un altra strada', /un'altra\s+strada|altra strada/i.test(r.pacchetto));
}

sezione('Un lavoro gia finito non si riprende');
{
  const p = new Processo('cerca tre voli', [{ titolo: 'cerca' }]);
  p.iniziaPasso(1); p.completaPasso(1, { prova: 'tre voli' });
  const c = new Cantiere({ quanteVoci: 1 });
  c.obiettivo = 'cerca tre voli'; c.aperto = Date.now();
  c.annota('Wizz', { prezzo: '55' }, 'https://x');
  const r = guarda({ cantiere: c, processo: p, obiettivo: c.obiettivo, criteri: [] }, 'vai');
  ok('il cancello dice che e finito, e non si riapre', r.riprendere === false);
  ok('col motivo scritto', /gia' finito|già finito/.test(r.perche));
}

sezione('Il Supervisore e codice, non un secondo modello');
{
  const src = fs.readFileSync('modules/collega/ripresa.js', 'utf8');
  ok('non chiama nessun modello', !/callAI|chiamaModello|openai|anthropic/i.test(src));
  ok('non scrive su disco', !/writeFile|appendFile/.test(src));
  ok('e chiede il verdetto al cancello, non se lo inventa',
     /require\('\.\/completamento'\)/.test(src));

  // Deterministico: lo stesso lavoro dà sempre lo stesso foglio.
  const l = lavoroAMeta();
  ok('lo stesso lavoro da sempre lo stesso foglio',
     pacchettoDiRipresa(l, { mancano: ['x'] }) === pacchettoDiRipresa(l, { mancano: ['x'] }));
}

sezione('Il turno lo usa davvero');
{
  const chat = fs.readFileSync('modules/routes/chat.js', 'utf8');
  ok('il supervisore guarda prima del Collega',
     chat.indexOf('supervisore.guarda(') < chat.indexOf('collega.ascolta('));
  ok('e il foglio finisce nel prompt', /systemPrompt \+= '\\n\\n' \+ _ripresa\.pacchetto/.test(chat));
  ok('rimette in sessione il cantiere e il piano',
     /ctx\.session\.processo = _aperto\.processo/.test(chat));
  ok('e se la ripresa fallisce si lavora lo stesso', /Ripresa saltata/.test(chat));
  ok('Luca lo vede succedere', /Riprendo il lavoro di prima/.test(chat));
}

console.log(`\n╔══════════════════════════════════════════╗`);
console.log(`║  IL SUPERVISORE RIPRENDE: ${pass} PASS, ${fail} FAIL`);
console.log(`╚══════════════════════════════════════════╝`);
process.exit(fail ? 1 : 0);
