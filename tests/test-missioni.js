// tests/test-missioni.js — Il diario deve ricordare gli errori, non solo i successi.
//
// PERCHE' ESISTE
//
// Luca ha chiesto tre volte, il 7 agosto: "si ricorda quando ha sbagliato?".
// La risposta era no, e per rispondergli ho dovuto ricostruire la giornata
// leggendo response_log.jsonl riga per riga.
//
// C'erano gia' quattro memorie — memories, learned_facts, lezioni, registro
// fonti — e nessuna teneva il conto dei LAVORI. Le lezioni erano il caso
// peggiore: otto righe di cui cinque identiche ("i dati compaiono dopo 79
// secondi", "dopo 25", "dopo 80"...). Accumulare non e' imparare.
//
// Questo file verifica le tre cose che servono davvero: che una missione si
// possa chiudere, che gli inciampi si ricordino, e che un lavoro simile
// gia' fatto si ritrovi PRIMA di rifarlo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Missioni } = require('../modules/memory/missioni');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`)); };
const nuovo = () => new Missioni(fs.mkdtempSync(path.join(os.tmpdir(), 'mis-')));

console.log('\n── Una missione si apre, si annota e si chiude ──');
{
  const M = nuovo();
  const id = M.apri('manda un messaggio WhatsApp a Jose', { ambiti: ['communicate'] });
  M.annota(id, { strumento: 'whatsapp_scrivi', pagina: 'https://web.whatsapp.com/' });
  M.chiudi(id, 'consegnato');
  ok('registrata', M.quante() === 1);
  const r = M.riepilogo();
  ok('risulta consegnata', r.esiti.consegnato === 1);
  ok('e sa cosa ha toccato', r.ultime[0].richiesta.includes('Jose'));
}

console.log('\n── Gli inciampi si ricordano: è il punto ──');
{
  const M = nuovo();
  const id = M.apri('leggi i messaggi non letti su LinkedIn e fammi un riepilogo');
  M.inciampo(id, 'crea_report', 'Mancano le fonti: senza gli indirizzi letti il documento non è verificabile');
  M.chiudi(id, 'incompleto');

  const sapere = M.cosaSappiamoSu('leggi i messaggi non letti su LinkedIn');
  ok('un lavoro simile si ritrova', sapere.length > 0, 'non ha trovato niente');
  ok('e porta con sé l\'inciampo', /crea_report/.test(sapere),
    'ricorda il lavoro ma non cosa era andato storto: è metà del valore');
  ok('con il motivo, non solo il nome', /fonti/.test(sapere));
}

console.log('\n── Riconosce lo stesso lavoro detto in un altro modo ──');
{
  const M = nuovo();
  const id = M.apri('manda un messaggio WhatsApp a Jose Programmatore Cuba');
  M.chiudi(id, 'consegnato');
  ok('"scrivi a Jose su WhatsApp" trova quello di prima',
    M.simili('scrivi a Jose su WhatsApp').length === 1);
  ok('ma "confronta i prezzi dei fornitori" non trova niente',
    M.simili('confronta i prezzi dei fornitori di trasporto').length === 0,
    'accosta lavori che non c\'entrano: il ricordo diventa rumore');
}

console.log('\n── Un intoppo che si ripete si vede ──');
{
  const M = nuovo();
  for (let i = 0; i < 3; i++) {
    const id = M.apri(`riepilogo numero ${i}`);
    M.inciampo(id, 'crea_report', 'mancano le fonti');
    M.chiudi(id, 'incompleto');
  }
  const r = M.riepilogo();
  ok('compare fra i ricorrenti', r.inciampiRicorrenti.some(x => x.cosa === 'crea_report'));
  ok('con quante volte', r.inciampiRicorrenti[0].volte === 3);
}

console.log('\n── Sopravvive a un riavvio ──');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mis-'));
  const A = new Missioni(dir);
  const id = A.apri('prepara il preventivo per Palawan');
  A.inciampo(id, 'create_file', 'formato .pdf non producibile');
  A.chiudi(id, 'consegnato');
  const B = new Missioni(dir);
  ok('rileggendo da disco c\'è ancora', B.quante() === 1);
  ok('e l\'inciampo pure', /create_file/.test(B.cosaSappiamoSu('preventivo Palawan')));
}

console.log('\n── Non si ricorda quello che non è un lavoro ──');
{
  const M = nuovo();
  const id = M.apri('ciao');
  // Una missione senza esito non viene mai proposta come precedente: è
  // rumore, non memoria.
  ok('una missione mai chiusa non risulta fra le simili', M.simili('ciao').length === 0);
}

console.log('\n── La scrivania: sapere che il tavolo non è vuoto ──');
//
// I file c'erano già — sedici — e gli strumenti per guardarli pure. In due
// giorni non sono stati chiamati nessuna volta. Non mancava il contenitore:
// mancava che COBRA sapesse che c'erano.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mis-'));
  const cartellaFile = path.join(dir, 'files');
  fs.mkdirSync(cartellaFile);
  fs.writeFileSync(path.join(cartellaFile, 'aziende_chimiche.xlsx'), 'x'.repeat(3000));
  fs.writeFileSync(path.join(cartellaFile, 'voli_bangkok.html'), 'y'.repeat(1000));

  const M = new Missioni(dir);
  const id = M.apri('trova le aziende chimiche in Lombardia');
  M.annota(id, { file: 'aziende_chimiche.xlsx' });
  M.chiudi(id, 'consegnato');

  const s = M.scrivania(cartellaFile);
  ok('vede i file sul tavolo', s.length === 2, 'trovati: ' + s.length);
  ok('e sa da quale lavoro viene ognuno',
    s.some(f => f.nome === 'aziende_chimiche.xlsx' && /chimiche/.test(f.da || '')),
    'elenca i file ma non dice a cosa servivano: è metà del valore');

  const b = M.bloccoScrivania(cartellaFile);
  ok('il blocco per il prompt nomina i file', /aziende_chimiche/.test(b));
  ok('e dice come aprirli', /read_local_file/.test(b),
    'senza questo il modello sa che esistono ma non che può guardarli');
  ok('resta corto', b.length < 900, b.length + ' caratteri: troppo, non lo legge nessuno');

  // Cartella vuota: niente blocco. Una riga che dice "non c'è niente" è
  // rumore, e il prompt di rumore ne ha già abbastanza.
  const vuota = fs.mkdtempSync(path.join(os.tmpdir(), 'vuota-'));
  ok('con il tavolo vuoto non dice niente', M.bloccoScrivania(vuota) === '');
}

console.log(`\n╔══════════════════════════════════════════╗`);
console.log(`║  DIARIO DELLE MISSIONI: ${pass} PASS, ${fail} FAIL`);
console.log(`╚══════════════════════════════════════════╝`);
process.exit(fail ? 1 : 0);
