#!/usr/bin/env node
// tests/test-il-lavoro-sopravvive.js — Un lavoro non muore col turno.
//
// PERCHÉ QUESTO FILE
//
// COBRA aveva CINQUE strutture che seguono un lavoro: Processo, Cantiere,
// Incarico, missioni, tasks. Quattro andavano su disco. Il Processo no.
//
// Il risultato pratico: il Cantiere ricordava COSA era stato raccolto, ma
// nessuno ricordava DOVE si era arrivati nel piano. Alla ripresa il modello
// rifaceva il piano da zero — e con un piano nuovo i passi già chiusi
// tornavano "in attesa". Con otto soggetti da raccogliere non si arriva mai
// in fondo, ed è successo per quattro tentativi di fila.
//
// La correzione NON è un sesto motore: è una porta sul disco per quello che
// c'era già, dentro l'archivio che c'era già.

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
const fs = require('fs');
const os = require('os');
const { Processo } = require('../modules/process/engine');
const { Cantiere } = require('../modules/collega/cantiere');
const { ArchivioCantieri } = require('../modules/collega/cantiere-archivio');

let pass = 0, fail = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== IL LAVORO SOPRAVVIVE AL TURNO ===');

sezione('Il piano va su disco e torna identico');
{
  const p = new Processo('voli per Bogota', [
    { titolo: 'cerca da Milano' },
    { titolo: 'cerca da Madrid' },
    { titolo: 'confronta', dipendeDa: [1, 2] },
    { titolo: 'scrivi il report', dipendeDa: [3] },
  ]);
  p.iniziaPasso(1); p.completaPasso(1, { prova: 'letto google.com/flights' });
  p.iniziaPasso(2); p.falliscePasso(2, 'il sito non risponde');

  const scritto = JSON.parse(JSON.stringify(p.perIlDisco()));
  const r = Processo.daDisco(scritto);

  ok('i passi ci sono tutti', r.passi.length === 4);
  ok('il passo chiuso resta chiuso', r.passo(1).stato === 'completato');
  ok('e la sua PROVA non si perde', /google/.test(JSON.stringify(r.passo(1).prova)));
  ok('il passo fallito resta fallito', r.passo(3 - 1).stato === 'fallito');
  ok('col motivo vero', /non risponde/.test(r.passo(2).motivo || ''));
  ok('le dipendenze reggono', JSON.stringify(r.passo(3).dipendeDa) === '[1,2]');
  ok('e l obiettivo torna', r.obiettivo === 'voli per Bogota');
}

sezione('Un passo lasciato a meta non e un passo in corso');
{
  // Il turno è morto mentre il passo 2 era "in_corso". Nessuno lo sta più
  // facendo: dichiararlo in corso alla ripresa blocca il piano per sempre,
  // perché un passo in corso non è né riprendibile né chiuso.
  const p = new Processo('prova', [{ titolo: 'uno' }, { titolo: 'due' }]);
  p.iniziaPasso(2);
  const r = Processo.daDisco(JSON.parse(JSON.stringify(p.perIlDisco())));
  ok('torna disponibile invece di restare appeso', r.passo(2).stato === 'attesa');
  ok('ma il conto dei tentativi resta', r.passo(2).tentativi === 1);
  ok('cosi si vede che ci si era gia provato', r.passo(2).tentativi > 0);
}

sezione('L archivio tiene il lavoro INTERO');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lavoro-'));
  const A = new ArchivioCantieri(tmp);

  const c = new Cantiere({ campiAttesi: ['prezzo'], quanteVoci: 2 });
  c.obiettivo = 'voli per Bogota da Milano e Madrid';
  c.aperto = Date.now();
  c.annota('Milano', { prezzo: '3.155' }, 'https://x.it');

  const p = new Processo('voli per Bogota da Milano e Madrid', [
    { titolo: 'cerca Milano' }, { titolo: 'cerca Madrid' }, { titolo: 'report', dipendeDa: [1, 2] },
  ]);
  p.iniziaPasso(1); p.completaPasso(1, { prova: 'letto' });

  const criteri = [{ tipo: 'soggetti_coperti', soggetti: ['Milano', 'Madrid'] }];
  A.salva(c, p, criteri);

  // Il riavvio: un archivio nuovo, che legge lo stesso file.
  const B = new ArchivioCantieri(tmp);
  const l = B.riapriLavoro('voli Bogota da Milano e Madrid');

  ok('il cantiere torna', !!l.cantiere && l.cantiere.elenco().length === 1);
  ok('con quello che era stato raccolto', /3\.155/.test(JSON.stringify(l.cantiere.elenco())));
  ok('il piano torna', !!l.processo && l.processo.passi.length === 3);
  ok('col passo gia chiuso ancora chiuso', l.processo.passo(1).stato === 'completato');
  ok('e i criteri viaggiano col lavoro', Array.isArray(l.criteri) && l.criteri.length === 1);

  // Un lavoro diverso non deve ereditare il piano di un altro.
  const altro = B.riapriLavoro('cerca fornitori di imballaggi in Veneto');
  ok('un lavoro diverso non eredita niente', altro.cantiere === null && altro.processo === null);

  // La vecchia porta continua a funzionare: chi chiamava riapri() non si rompe.
  ok('la vecchia strada regge ancora', !!B.riapri('voli Bogota da Milano e Madrid'));

  fs.rmSync(tmp, { recursive: true, force: true });
}

sezione('Il turno salva e riprende davvero');
{
  const chat = fs.readFileSync('modules/routes/chat.js', 'utf8');
  ok('salva anche il piano', /salva\(\s*\n?\s*ctx\.session\.cantiere,\s*\n?\s*ctx\.session\.processo/.test(chat));
  ok('e i criteri', /incaricoCorrente \? incaricoCorrente\.criteri : null/.test(chat));
  ok('riprende il lavoro intero', /riapriLavoro\(/.test(chat));
  ok('e rimette il piano in sessione', /ctx\.session\.processo = lavoro\.processo/.test(chat));
  ok('dicendolo a Luca', /Riprendo il piano/.test(chat));
}

sezione('Non e un sesto motore');
{
  // La tentazione era creare un Job Engine accanto ai cinque che esistono.
  // Sarebbe stata la malattia dell'8 agosto: due implementazioni della stessa
  // cosa, e vince sempre la più comoda.
  const nuovi = fs.readdirSync('modules').filter(f => /job|orchestrat/i.test(f));
  ok('nessun motore nuovo e comparso', nuovi.length === 0, 'trovati: ' + nuovi.join(', '));

  const arch = fs.readFileSync('modules/collega/cantiere-archivio.js', 'utf8');
  ok('la persistenza sta nell archivio che c era gia', /riapriLavoro/.test(arch));
  const eng = fs.readFileSync('modules/process/engine.js', 'utf8');
  ok('e il Processo ha solo imparato ad andare su disco',
     /perIlDisco/.test(eng) && /static daDisco/.test(eng));
}

console.log(`\n╔══════════════════════════════════════════╗`);
console.log(`║  IL LAVORO SOPRAVVIVE: ${pass} PASS, ${fail} FAIL`);
console.log(`╚══════════════════════════════════════════╝`);
process.exit(fail ? 1 : 0);
