#!/usr/bin/env node
// tests/test-checklist-viva.js — La checklist deve dire DOVE sei e COSA hai.
//
// Luca, 7 agosto 2026: "avevo inserito il piano che deve seguire, la
// checklist!!! dove è? deve essere nel db e crearla ogni volta in fase
// iniziale lavori e implementarla nella conversazione, è dinamica. se non gli
// dai i dati da verificare, non potrà sapere a che punto si trova".
//
// Andando a guardare, la checklist c'era — il motore a passi — e arrivava al
// modello a ogni turno. Ma diceva solo "passo 2: prendere le email", non
// QUALI email mancassero. E il cantiere, che quei dati li aveva, viveva in un
// altro posto e non entrava nel contesto insieme ai passi.
//
// Peggio: il cantiere moriva a fine turno. Un lavoro da otto aziende non sta
// in un turno, quindi ricominciava ogni volta — ed è il motivo per cui quattro
// tentativi di fila non erano arrivati in fondo.

const path = require('path');
const fs = require('fs');
const os = require('os');
process.chdir(path.resolve(__dirname, '..'));

const { Cantiere } = require('../modules/collega/cantiere');
const { ArchivioCantieri } = require('../modules/collega/cantiere-archivio');
const { Processo } = require('../modules/process/engine');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== LA CHECKLIST: DOVE SEI E COSA HAI ===');

sezione('I passi dicono dove sei');
{
  const p = new Processo('Raccogliere 8 aziende', [
    { titolo: 'Trovare le aziende' }, { titolo: 'Prendere le email' }, { titolo: 'Scrivere il file' }]);
  p.iniziaPasso(1);
  p.completaPasso(1, 'trovate otto aziende su europages con nome e citta');
  const t = p.perIlPrompt();
  ok('la lista si vede tutta', /Trovare le aziende/.test(t) && /Scrivere il file/.test(t));
  ok('con le spunte su quello che è fatto', /☑ 1\./.test(t) && /☐ 2\./.test(t));
  ok('e dice qual è il prossimo', /Prossimo passo da eseguire: 2/.test(t));
  ok('e che si chiude solo con una prova', /allegando il risultato dello strumento/.test(t));
}

sezione('Ma solo il cantiere dice COSA hai e cosa manca');
{
  const c = new Cantiere({ campiAttesi: ['citta', 'sito', 'email'], quanteVoci: 8 });
  c.annota('Celvil', { citta: 'Milano', sito: 'https://celvil.it', email: 'info@celvil.it' });
  c.annota('Rotofil', { citta: 'Casalmaggiore', sito: 'https://rotofilsrl.it' });
  c.annota('ILIP', { citta: 'Valsamoggia' });

  const t = c.perIlPrompt();
  ok('elenca quello che è già in mano', /Celvil/.test(t) && /info@celvil\.it/.test(t));
  ok('dice di NON ricercarlo', /NON vanno ricercate/.test(t));
  ok('e per ogni voce cosa manca', /Rotofil: manca email/.test(t) && /ILIP: manca sito, email/.test(t));
  ok('e quanti soggetti mancano ancora', /Servono ancora 5 soggetti/.test(t));
  ok('conta bene le complete', c.complete() === 1, String(c.complete()));
}

sezione('E le due viste arrivano INSIEME, a ogni turno');
{
  const sm = fs.readFileSync('modules/supermario.js', 'utf8');
  ok('i passi entrano nel contesto', /session\.processo\.perIlPrompt\(\)/.test(sm));
  ok('e il cantiere pure', /session\.cantiere\.perIlPrompt\(\)/.test(sm));
  const posP = sm.indexOf('session.processo.perIlPrompt()');
  const posC = sm.indexOf('session.cantiere.perIlPrompt()');
  ok('uno dopo l altro, non in posti diversi', posC > posP && (posC - posP) < 1200,
     `distanza ${posC - posP}`);
  ok('col motivo scritto', /I passi dicono DOVE sei, il cantiere dice COSA hai/.test(sm));
}

sezione('Il lavoro sopravvive al turno e al riavvio');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cant-'));
  const a = new ArchivioCantieri(dir);

  const c = new Cantiere({ campiAttesi: ['citta', 'email'], quanteVoci: 8 });
  c.obiettivo = 'Raccogliere 8 aziende di packaging in Lombardia';
  c.aperto = Date.now();
  c.annota('Celvil', { citta: 'Milano', email: 'i@celvil.it' });
  c.annota('Rotofil', { citta: 'Casalmaggiore' });
  a.salva(c);

  // Un archivio NUOVO: è come se il server si fosse riavviato
  const a2 = new ArchivioCantieri(dir);
  const r = a2.riapri('Raccogliere aziende di packaging alimentare in Lombardia ed Emilia');
  ok('il cantiere si riapre dopo un riavvio', !!r && r.elenco().length === 2);
  ok('coi dati intatti', r.elenco().find(v => v.nome === 'Celvil').campi.email === 'i@celvil.it');
  ok('e sapendo ancora cosa manca', JSON.stringify(r.buchi()).includes('email'));

  ok('un lavoro DIVERSO non lo riapre', a2.riapri('Preparare la fattura del cliente Rossi') === null);

  const vecchio = new ArchivioCantieri(fs.mkdtempSync(path.join(os.tmpdir(), 'v-')));
  const c2 = new Cantiere({ campiAttesi: ['x'], quanteVoci: 2 });
  c2.obiettivo = 'Raccogliere prezzi voli'; c2.aperto = Date.now() - (7 * 60 * 60 * 1000);
  c2.annota('a', { x: '1' });
  vecchio.salva(c2);
  ok('e uno di sette ore fa nemmeno: i prezzi cambiano',
     vecchio.riapri('Raccogliere prezzi voli') === null);
}

sezione('Il turno lo salva e lo chiude quando serve');
{
  const chat = fs.readFileSync('modules/routes/chat.js', 'utf8');
  ok('non si butta piu a inizio turno', !/ctx\.session\.cantiere = null;/.test(chat));
  ok('si prova a riaprire quello di prima', /_archivioCantieri\.riapri\(/.test(chat));
  ok('e Luca lo vede', /Riprendo da dove eravamo/.test(chat));
  ok('a fine turno si salva', /_archivioCantieri\.salva\(ctx\.session\.cantiere\)/.test(chat));
  ok('e si chiude solo a lavoro finito', /if \(r\.finito\)[\s\S]{0,120}chiudi\(\)/.test(chat));
  ok('col motivo scritto', /si riprende da qui/.test(chat));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
