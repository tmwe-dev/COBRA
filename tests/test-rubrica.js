// tests/test-rubrica.js — Ricordarsi chi ha scritto.
//
// PERCHE' ESISTE
//
// Il 7 agosto, per mandare due parole a Jose, COBRA ha letto duecento chat, ha
// trovato venti contatti che contenevano "Jose", e si e' fermato. Poi ha
// rifatto la stessa lettura al turno dopo, ed e' finito nello stesso posto.
//
// L'informazione ce l'aveva gia': ogni lettura passa davanti a nomi veri. Li
// buttava. Qui si verifica che non li butti piu', e soprattutto che ricordarli
// NON allarghi le maglie: fra due persone che hanno scritto davvero, si chiede
// ancora a Luca.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Rubrica } = require('../modules/security/rubrica');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`)); };
const nuova = () => new Rubrica(fs.mkdtempSync(path.join(os.tmpdir(), 'rub-')));

console.log('\n── Si riempie leggendo ──');
{
  const R = nuova();
  const presi = R.daLettura([
    { nome: 'Jose Programmatore Cuba', unread: 2 },
    { nome: 'Jose Maria Fernandez', unread: 0, lastMessage: 'ciao' },
    { nome: 'Brandon Lee', unread: 1 },
    { nome: '' },            // scartato
    { unread: 3 },           // scartato: senza nome
  ], 'whatsapp');
  ok('prende solo le voci con un nome', presi === 3, 'prese: ' + presi);
  ok('e le conta', R.quante() === 3);
  ok('non duplica se rilegge', (R.daLettura([{ nome: 'Brandon Lee', unread: 1 }]), R.quante() === 3));
}

console.log('\n── Trova la persona giusta ──');
{
  const R = nuova();
  R.daLettura([{ nome: 'Brandon Lee', unread: 1 }], 'whatsapp');
  const d = R.destinatario('brandon', 'whatsapp');
  ok('un solo Brandon → trovato', d.trovato && d.voce.nome === 'Brandon Lee');
  ok('il maiuscolo non conta', R.destinatario('BRANDON LEE').trovato);
  ok('chi non c\'e\' non si inventa', !R.destinatario('Nessuno').trovato);
}

console.log('\n── Fra omonimi decide solo se uno ha scritto davvero ──');
{
  const R = nuova();
  // Due Jose: uno ha scritto (ha messaggi), l'altro e' solo un nome visto.
  R.vista({ nome: 'Jose Programmatore Cuba', canale: 'whatsapp', haScritto: true });
  R.vista({ nome: 'Jose Ramirez', canale: 'whatsapp', haScritto: false });
  const d = R.destinatario('jose', 'whatsapp');
  ok('sceglie quello che ha scritto a Luca', d.trovato && d.voce.nome === 'Jose Programmatore Cuba');
  ok('e dice perche', d.come.includes('scritto'));

  // Ma se hanno scritto entrambi, NON si sceglie: si chiede.
  R.vista({ nome: 'Jose Ramirez', canale: 'whatsapp', haScritto: true });
  const d2 = R.destinatario('jose', 'whatsapp');
  ok('due che hanno scritto → NON sceglie', !d2.trovato, 'ha scelto ' + JSON.stringify(d2.voce || null));
  ok('   e li elenca entrambi', d2.candidati.length === 2);
}

console.log('\n── "conosciuto" diventa un fatto, non una stima ──');
{
  const R = nuova();
  R.vista({ nome: 'Samuel Chen', canale: 'whatsapp', haScritto: true });
  R.vista({ nome: 'Tizio Mai Visto', canale: 'whatsapp', haScritto: false });
  ok('chi ha scritto risulta conosciuto', R.conosciuto('Samuel Chen'));
  ok('chi non ha mai scritto no', !R.conosciuto('Tizio Mai Visto'));
  ok('e resta conosciuto anche dopo averlo rivisto senza messaggi',
    (R.vista({ nome: 'Samuel Chen', canale: 'whatsapp', haScritto: false }), R.conosciuto('Samuel Chen')));
}

console.log('\n── I canali non si mescolano ──');
{
  const R = nuova();
  R.vista({ nome: 'Mario Rossi', canale: 'linkedin', haScritto: true, url: 'https://linkedin.com/in/mario' });
  ok('su LinkedIn si trova', R.destinatario('Mario Rossi', 'linkedin').trovato);
  ok('su WhatsApp no', !R.destinatario('Mario Rossi', 'whatsapp').trovato);
}

console.log('\n── Sopravvive a un riavvio ──');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rub-'));
  new Rubrica(dir).vista({ nome: 'Jose Programmatore Cuba', canale: 'whatsapp', haScritto: true });
  ok('rileggendo da disco c\'e\' ancora', new Rubrica(dir).destinatario('jose').trovato);
}

console.log(`\n╔══════════════════════════════════════════╗`);
console.log(`║  RUBRICA: ${pass} PASS, ${fail} FAIL`);

console.log('\n-- Una persona ha due identita: il nome e il numero --');
{
  // Prova vera del 9 agosto: "manda un WhatsApp al numero +5353341229".
  // Bloccato con "non ti ha mai scritto e non risulta in rubrica" — mentre
  // Jose aveva scritto eccome. La rubrica lo conosceva per NOME, e il numero
  // non l'aveva mai visto nessuno.
  //
  // Una regola che protegge dal contattare sconosciuti diventa un muro contro
  // i conosciuti, se l'unica identita' che sa riconoscere e' il nome.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rub-'));
  const R = new Rubrica(tmp);
  R.daLettura([{ nome: 'Jose Programmatore Cuba', numero: '5353341229', haScritto: true }], 'whatsapp');

  ok('lo trova per nome', R.destinatario('Jose', 'whatsapp').trovato === true);
  ok('e per numero', R.destinatario('+5353341229', 'whatsapp').trovato === true);
  ok('col prefisso o senza', R.destinatario('5353341229', 'whatsapp').trovato === true);
  ok('ed e la STESSA persona',
     R.destinatario('+5353341229', 'whatsapp').voce.nome === 'Jose Programmatore Cuba');

  // E' questo che sbloccava il muro: `soloSeConosciuto` chiede proprio questo.
  ok('e risulta conosciuto anche partendo dal numero',
     R.conosciuto('+5353341229', 'whatsapp') === true);

  // Ma un numero mai visto resta sconosciuto: la protezione non si allenta.
  ok('un numero mai visto resta sconosciuto',
     R.conosciuto('+390000000000', 'whatsapp') === false);
  ok('e non viene scambiato per un altro',
     R.destinatario('+390000000000', 'whatsapp').trovato === false);

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`╚══════════════════════════════════════════╝`);
process.exit(fail ? 1 : 0);
