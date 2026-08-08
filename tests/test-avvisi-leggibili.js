#!/usr/bin/env node
// tests/test-avvisi-leggibili.js — Un avviso che non si capisce non è un avviso.
//
// Visto a schermo il 6 agosto 2026, con due bottoni sotto:
//
//   ⚠ DESTRUCTIVE — annota
//   [DESTRUCTIVE] annota
//   { "nome": "Essebi Packaging", "campi": "{\"citta\":\"Castiglione del
//     Lago\",\"email\":\"info@essebipackaging.com\"}", "fonte": "..." }
//   [Approva] [Rifiuta]
//
// Tre errori insieme:
//   1. "DESTRUCTIVE" per un appunto. I sei strumenti aggiunti quel giorno non
//      erano dichiarati da nessuna parte, e tutto ciò che il sistema non
//      conosce viene trattato come distruttivo. Il lavoro si fermava a OGNI
//      annotazione — ed è per questo che il cantiere non ha mai funzionato.
//   2. Il JSON grezzo al posto di una frase.
//   3. Nessuna spiegazione del perché venisse chiesto.
//
// Chi legge una cosa così non può decidere: può solo premere a caso.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

const { spiega, inBreve } = require('../modules/security/spiegazioni');
const sm = require('../modules/supermario');
// La classificazione che COMANDA è quella del calcolatore di rischio, non
// l'elenco di supermario: il 6 agosto avevo corretto solo il secondo, e
// COBRA continuava a chiedere il permesso per prendere un appunto.
const { computeEffectiveRisk } = require('../modules/risk/calculator');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== AVVISI CHE SI CAPISCONO ===');

sezione('Gli strumenti aggiunti oggi non chiedono piu il permesso per niente');
{
  for (const t of ['annota', 'stato_lavoro', 'leggi_modulo', 'leggi_manuale']) {
    const r = sm.getToolRisk(t);
    ok(`${t}: è lettura nell'elenco strumenti`, r.level === 'read' && r.confirm === false, JSON.stringify(r));
    const e = computeEffectiveRisk(t, {});
    ok(`${t}: e ANCHE per il calcolatore di rischio`,
       e.level === 'read' && e.requires_confirmation === false, JSON.stringify(e));
  }
  const w = sm.getToolRisk('scrivi_raccolta');
  ok('scrivi_raccolta: scrive un file, come create_file', w.level === 'write' && w.confirm === false, JSON.stringify(w));
  const we = computeEffectiveRisk('scrivi_raccolta', {});
  ok('e il calcolatore non lo blocca piu',
     we.level === 'write_local' && we.requires_confirmation === false, JSON.stringify(we));
  ok('mentre una cancellazione resta bloccata',
     computeEffectiveRisk('kb_delete', {}).requires_confirmation === true);
  ok('e create_file resta com era', sm.getToolRisk('create_file').level === 'write');
}

sezione('Ma uno strumento mai visto continua a fermarsi');
{
  const r = sm.getToolRisk('strumento_inventato_domani');
  ok('chiede comunque conferma', r.confirm === true);
  ok('senza chiamarsi "distruttivo": non lo sappiamo', r.level === 'sconosciuto', r.level);
}

sezione('L avviso dice cosa fa, su cosa, e perche');
{
  const s = spiega('annota', {
    nome: 'Essebi Packaging',
    campi: '{"citta":"Castiglione del Lago","email":"info@essebipackaging.com"}',
    fonte: 'https://essebipackaging.com/contatti/',
  }, 'sconosciuto');

  ok('il titolo è una frase, non un codice', /COBRA vuole prendere un appunto/.test(s.titolo), s.titolo);
  ok('non compare la parola DESTRUCTIVE', !/DESTRUCTIVE/i.test(s.titolo + s.dettaglio + s.perche));
  ok('il JSON annidato viene aperto e reso leggibile',
     /citta: Castiglione del Lago/.test(s.dettaglio), s.dettaglio);
  ok('e non resta con le virgolette scappate', !/\\"/.test(s.dettaglio));
  ok('si dice perché lo si sta chiedendo', s.perche.length > 20);
  ok('e per uno strumento sconosciuto si ammette di non sapere',
     /non so\s+cosa faccia/.test(s.perche), s.perche);
}

sezione('E per le azioni davvero serie il tono cambia');
{
  const e = spiega('send_email', { to: 'cliente@acme.it', subject: 'Preventivo' }, 'send');
  ok('si capisce che parte davvero', /INVIARE UNA EMAIL/.test(e.titolo));
  ok('e che non si torna indietro', /non si richiama/.test(e.perche));
  ok('col destinatario in chiaro', /cliente@acme\.it/.test(e.dettaglio));

  const d = spiega('kb_delete', { chiave: 'listino2025' }, 'destructive');
  ok('una cancellazione si dichiara tale', /CANCELLARE/.test(d.titolo));
  ok('e dice che non si recupera', /non si recupera/.test(d.perche));
}

sezione('I valori lunghi non allagano la scheda');
{
  const lungo = inBreve({ testo: 'x'.repeat(300) });
  ok('vengono accorciati', lungo.length < 120, `${lungo.length} caratteri`);
  ok('con i puntini che lo dicono', /…$/.test(lungo));
  ok('e i campi vuoti spariscono', inBreve({ a: '', b: 'c' }) === 'b: c');
  ok('un oggetto senza niente non produce righe', inBreve({}) === '');
}

sezione('E arriva davvero a schermo');
{
  const ex = fs.readFileSync('modules/tools/executor.js', 'utf8');
  ok('l esecutore prepara la spiegazione', /const spiegazione = spiega\(name, args/.test(ex));
  ok('e la manda al pannello', /titolo: spiegazione\.titolo/.test(ex) && /perche: spiegazione\.perche/.test(ex));

  const ui = fs.readFileSync('public/index.html', 'utf8');
  ok('il pannello mostra il titolo in italiano', /msg\.titolo \|\| /.test(ui));
  ok('il dettaglio leggibile', /if \(msg\.dettaglio\)/.test(ui));
  ok('e il perché', /Perché te lo chiedo/.test(ui));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
