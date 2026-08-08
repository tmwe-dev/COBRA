// tests/test-regole-invio.js — Le regole che proteggono l'account di Luca.
//
// PERCHÉ QUESTI TEST SONO DIVERSI DAGLI ALTRI
//
// Di solito un test verifica che una cosa FUNZIONI. Qui si verifica soprattutto
// che una cosa NON succeda: che un messaggio non parta quando non deve.
//
// La differenza conta, perché un buco qui non si manifesta come un errore. Si
// manifesta come "ha funzionato tutto benissimo" — e tre settimane dopo come un
// numero WhatsApp sospeso, con dentro la rubrica di lavoro di anni.
//
// Per questo ogni regola ha due test: uno che la vede scattare, e uno che
// verifica che NON scatti quando non deve. Una regola che blocca tutto è
// sicura e inutile.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { RegoleInvio, REGOLE, DIRETTO, regolePer, pausaProssima, certezzaDestinatario, eUnNumero, _impronta } = require('../modules/security/regole-invio');

let pass = 0, fail = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { pass++; console.log(`  ✓ ${nome}`); }
  else { fail++; console.log(`  ✗ ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}

function pulita() { return fs.mkdtempSync(path.join(os.tmpdir(), 'regole-')); }

// Un martedì alle 10:00: dentro la finestra, giorno feriale. Il momento in cui
// tutto DEVE funzionare, così ogni blocco che vedremo è merito di una regola
// precisa e non del calendario.
const MARTEDI_10 = new Date('2026-08-11T10:00:00');
const nuove = () => new RegoleInvio(pulita(), 'whatsapp');

// ── 1. Quando tutto è a posto, si manda ──
//
// Va per primo di proposito: se questo fallisce, tutti i test successivi
// passerebbero per il motivo sbagliato.
console.log('\n── 1. Nelle condizioni normali il messaggio parte ──');
{
  const R = nuove();
  const v = R.puoScrivere({ a: '+39333', testo: 'Ciao Marco, ti mando il preventivo', conosciuto: true, adesso: MARTEDI_10 });
  ok('martedì alle 10, contatto conosciuto: si manda', v.si === true, JSON.stringify(v));
  ok('e dice quanti ne sono già partiti oggi', v.oggi === 0);
  ok('e quanto aspettare prima del prossimo', v.prossimaPausa >= REGOLE.whatsapp.pausaMinima);
}

// ── 2. Chi è il destinatario ──
//
// La regola più importante di tutte. Un messaggio a uno sconosciuto su WhatsApp
// non è "un po' rischioso": è il modo principale in cui i numeri finiscono
// sospesi, perché basta che una persona prema "Segnala".
console.log('\n── 2. Mai per primi a chi non ti conosce ──');
{
  const R = nuove();
  const v = R.puoScrivere({ a: '+39999', testo: 'Buongiorno, sono di TMWE', conosciuto: false, adesso: MARTEDI_10 });
  ok('a uno sconosciuto NON si scrive', v.si === false);
  ok('e il motivo lo dice chiaro', /mai scritto|rubrica/.test(v.motivo), v.motivo);
  ok('e propone la strada giusta (email o LinkedIn)', /email|LinkedIn/i.test(v.cosaFare));

  ok('allo stesso, se conosciuto, si scrive',
    R.puoScrivere({ a: '+39999', testo: 'Buongiorno', conosciuto: true, adesso: MARTEDI_10 }).si === true);
}

// ── 3. Quando ──
console.log('\n── 3. Orari e giorni ──');
{
  const R = nuove();
  const m = (d) => R.puoScrivere({ a: '+39333', testo: 'ciao', conosciuto: true, adesso: d });

  ok('alle 7 del mattino no', m(new Date('2026-08-11T07:00:00')).si === false);
  ok('alle 8:59 ancora no', m(new Date('2026-08-11T08:59:00')).si === false);
  ok('alle 9 sì', m(new Date('2026-08-11T09:00:00')).si === true);
  ok('alle 17:59 sì', m(new Date('2026-08-11T17:59:00')).si === true);
  ok('alle 18 no (la finestra chiude)', m(new Date('2026-08-11T18:00:00')).si === false);
  ok('alle 23 no', m(new Date('2026-08-11T23:00:00')).si === false);

  const sabato = m(new Date('2026-08-15T10:00:00'));
  ok('sabato no', sabato.si === false);
  ok('e lo dice che è weekend', /sabato|domenica/i.test(sabato.motivo));
  ok('domenica no', m(new Date('2026-08-16T10:00:00')).si === false);
  ok('lunedì sì', m(new Date('2026-08-10T10:00:00')).si === true);
}

// ── 4. Quanti, e ogni quanto ──
//
// Il limite orario e quello giornaliero si provano insieme al minimo intervallo,
// perché in produzione agiscono insieme: è la combinazione che descrive un
// ritmo umano, non ciascuno da solo.
console.log('\n── 4. Limiti di quantità e di ritmo ──');
{
  const R = nuove();
  const r = REGOLE.whatsapp;

  // Si riempie l'ora precedente, rispettando le pause: invii distanziati
  // abbastanza da non far scattare l'intervallo minimo.
  let t = MARTEDI_10.getTime() - 50 * 60000;
  for (let i = 0; i < r.allOra; i++) {
    R.registra({ a: `+3900${i}`, testo: `messaggio numero ${i}`, adesso: new Date(t) });
    t += 4 * 60000;
  }
  const troppi = R.puoScrivere({ a: '+39777', testo: 'uno in più', conosciuto: true, adesso: MARTEDI_10 });
  ok(`al ${r.allOra + 1}° messaggio nell'ora si ferma`, troppi.si === false, JSON.stringify(troppi));
  ok('e dice quanti ne ha mandati', new RegExp(String(r.allOra)).test(troppi.motivo), troppi.motivo);

  // Passata un'ora e mezza, quelli non contano più
  const dopo = R.puoScrivere({ a: '+39777', testo: 'uno in più', conosciuto: true,
    adesso: new Date(MARTEDI_10.getTime() + 90 * 60000) });
  ok('passata l\'ora, si riparte', dopo.si === true, JSON.stringify(dopo));
}
{
  const R = nuove();
  R.registra({ a: '+39111', testo: 'primo', adesso: new Date(MARTEDI_10.getTime() - 10000) });
  const subito = R.puoScrivere({ a: '+39222', testo: 'secondo', conosciuto: true, adesso: MARTEDI_10 });
  ok('due messaggi a 10 secondi di distanza: no', subito.si === false);
  ok('e dice quanti secondi mancano', /secondi/.test(subito.cosaFare), subito.cosaFare);

  const conCalma = R.puoScrivere({ a: '+39222', testo: 'secondo', conosciuto: true,
    adesso: new Date(MARTEDI_10.getTime() + 120000) });
  ok('a due minuti di distanza: sì', conCalma.si === true);
}
{
  const R = nuove();
  const r = REGOLE.whatsapp;
  let t = MARTEDI_10.getTime() - 8 * 3600000;   // si parte dalle 2 di notte per starci
  for (let i = 0; i < r.alGiorno; i++) {
    R.registra({ a: `+390${i}`, testo: `msg ${i}`, adesso: new Date(t) });
    t += 60000;
  }
  const v = R.puoScrivere({ a: '+39888', testo: 'ancora uno', conosciuto: true, adesso: MARTEDI_10 });
  ok(`al ${r.alGiorno + 1}° della giornata si ferma`, v.si === false, JSON.stringify(v));
  ok('e dice che il conto riparte domani', /domani/.test(v.cosaFare));

  // Il giorno dopo il conto è azzerato
  const domani = new Date(MARTEDI_10.getTime() + 26 * 3600000);   // mercoledì 12:00
  ok('il giorno dopo si riparte da zero', R.oggi(domani) === 0);
}

// ── 5. Non due volte alla stessa persona ──
console.log('\n── 5. Non si insiste con la stessa persona ──');
{
  const R = nuove();
  R.registra({ a: '+39555', testo: 'primo contatto', adesso: new Date(MARTEDI_10.getTime() - 2 * 86400000) });
  const v = R.puoScrivere({ a: '+39555', testo: 'ti ricordo', conosciuto: true, adesso: MARTEDI_10 });
  ok('a due giorni di distanza allo stesso numero: no', v.si === false);
  ok('e lo dice quanti giorni sono passati', /2 giorni/.test(v.motivo), v.motivo);
  ok('e suggerisce di scrivergli a mano se urge', /scrivigli tu/i.test(v.cosaFare));

  const dopoOtto = R.puoScrivere({ a: '+39555', testo: 'ti ricordo', conosciuto: true,
    adesso: new Date(MARTEDI_10.getTime() + 8 * 86400000) });
  ok('dopo otto giorni sì', dopoOtto.si === true, JSON.stringify(dopoOtto));

  // Ma a un ALTRO numero si scrive subito (rispettando la pausa)
  const altro = R.puoScrivere({ a: '+39666', testo: 'ciao', conosciuto: true,
    adesso: new Date(MARTEDI_10.getTime() + 300000) });
  ok('a un altro numero invece si scrive', altro.si === true);
}

// ── 6. Non lo stesso testo a tutti ──
//
// Questa nel Navigator non c'è, ed è il buco più visibile: mandare lo stesso
// identico testo a venti persone è la definizione operativa di spam.
console.log('\n── 6. Lo stesso messaggio a tutti è spam ──');
{
  const R = nuove();
  const testo = 'Buongiorno, le scrivo per proporle i nostri servizi di spedizione';
  let t = MARTEDI_10.getTime() - 3 * 3600000;
  for (let i = 0; i < 3; i++) {
    R.registra({ a: `+3910${i}`, testo, adesso: new Date(t) });
    t += 10 * 60000;
  }
  const v = R.puoScrivere({ a: '+39104', testo, conosciuto: true, adesso: MARTEDI_10 });
  ok('alla quarta copia identica si ferma', v.si === false, JSON.stringify(v));
  ok('e chiede di personalizzarlo', /personalizza/i.test(v.cosaFare));

  const diverso = R.puoScrivere({ a: '+39104', testo: testo + ' Marco, come da accordi di ieri.',
    conosciuto: true, adesso: MARTEDI_10 });
  ok('ma un testo personalizzato passa', diverso.si === true, JSON.stringify(diverso));

  ok('la punteggiatura non basta a fingere che sia diverso',
    _impronta('Ciao Marco') === _impronta('ciao, marco!!!'));
  ok('un contenuto diverso ha impronta diversa',
    _impronta('Ciao Marco') !== _impronta('Ciao Giulia'));
}

// ── 7. Il contenuto ──
console.log('\n── 7. Il messaggio in sé ──');
{
  const R = nuove();
  const m = (testo) => R.puoScrivere({ a: '+39333', testo, conosciuto: true, adesso: MARTEDI_10 });
  ok('un messaggio vuoto non parte', m('').si === false);
  ok('nemmeno fatto di soli spazi', m('    ').si === false);
  ok('uno lunghissimo non parte', m('x'.repeat(REGOLE.whatsapp.lunghezzaMassima + 1)).si === false);
  ok('uno normale sì', m('Ciao, ti confermo la spedizione di domani.').si === true);
  ok('senza destinatario non parte',
    R.puoScrivere({ a: '', testo: 'ciao', conosciuto: true, adesso: MARTEDI_10 }).si === false);
}

// ── 8. Il conto sopravvive al riavvio ──
//
// È il punto in cui il Navigator perde: i suoi contatori sono in memoria, e
// un limite giornaliero che si azzera a ogni riavvio non è un limite.
console.log('\n── 8. Il conto non si azzera riavviando ──');
{
  const dir = pulita();
  const primo = new RegoleInvio(dir, 'whatsapp');
  for (let i = 0; i < 5; i++) primo.registra({ a: `+3920${i}`, testo: `m${i}`, adesso: MARTEDI_10 });
  ok('cinque registrati', primo.oggi(MARTEDI_10) === 5);

  const dopoRiavvio = new RegoleInvio(dir, 'whatsapp');
  ok('dopo il riavvio sono ancora cinque', dopoRiavvio.oggi(MARTEDI_10) === 5,
    'trovati: ' + dopoRiavvio.oggi(MARTEDI_10));
  ok('e il file esiste davvero', fs.existsSync(path.join(dir, 'invii_whatsapp.json')));
}

// ── 9. Si registra solo quello che è partito ──
//
// Se si registrasse il tentativo invece dell'invio riuscito, un errore di rete
// consumerebbe il budget della giornata senza che nessun messaggio sia arrivato.
console.log('\n── 9. Chiedere il permesso non consuma il budget ──');
{
  const R = nuove();
  for (let i = 0; i < 10; i++) R.puoScrivere({ a: '+39333', testo: 'ciao', conosciuto: true, adesso: MARTEDI_10 });
  ok('dieci richieste, zero registrati', R.oggi(MARTEDI_10) === 0);
  R.registra({ a: '+39333', testo: 'ciao', adesso: MARTEDI_10 });
  ok('registrare aggiunge uno', R.oggi(MARTEDI_10) === 1);
}

// ── 10. Le pause sono variabili ──
//
// Una pausa fissa è un ritmo: 45 secondi esatti, sempre, è più riconoscibile
// di un invio veloce.
console.log('\n── 10. Le pause non sono tutte uguali ──');
{
  const p = Array.from({ length: 50 }, () => pausaProssima('whatsapp'));
  const r = REGOLE.whatsapp;
  ok('tutte dentro la finestra', p.every(x => x >= r.pausaMinima && x <= r.pausaMassima));
  ok('e non sono tutte lo stesso numero', new Set(p).size > 10, 'valori distinti: ' + new Set(p).size);
}

// ── 11. I numeri sono quelli che diciamo ──
//
// I valori vengono dal Navigator o sono scelti sopra le sue lacune. Se
// qualcuno li alzasse per comodità, questo test lo fa vedere.
console.log('\n── 11. I limiti sono quelli dichiarati ──');
{
  const w = REGOLE.whatsapp, l = REGOLE.linkedin;
  ok('LinkedIn: 50 al giorno (dal Navigator)', l.alGiorno === 50);
  ok('LinkedIn: 3 all\'ora (dal Navigator)', l.allOra === 3);
  ok('LinkedIn: finestra 9-19 (dal Navigator)', l.oraInizio === 9 && l.oraFine === 19);
  ok('LinkedIn: pause 45-180s (dal Navigator)', l.pausaMinima === 45 && l.pausaMassima === 180);
  ok('LinkedIn: 300 caratteri (dal Navigator)', l.lunghezzaMassima === 300);
  ok('WhatsApp: finestra 9-18 (dal loro checkWhatsAppGate)', w.oraInizio === 9 && w.oraFine === 18);
  ok('WhatsApp: niente weekend (dal loro checkWhatsAppGate)', w.weekend === false);
  ok('WhatsApp: 7 giorni fra due messaggi (dal loro send-whatsapp)', w.giorniFraStessoContatto === 7);
  ok('WhatsApp: solo a chi ti conosce (dal loro gate)', w.soloSeConosciuto === true);
  ok('WhatsApp: la pausa NON è quella loro da 4s', w.pausaMinima >= 30,
    'nel Navigator è 4-12s, qui deve essere più lenta');
}

// ── 12. Sono sicuro di CHI sto scrivendo? ──
//
// Regola chiesta da Luca il 7 agosto: non si manda a una persona di cui non
// si è certi, senza che sia lui a confermare.
//
// Il caso che la motiva è concreto. La ricerca per nome dei moduli del
// Navigator fa `label.includes(targetLower)`: "jose" prende il PRIMO risultato.
// Con un Jose Ramirez e un Jose Maria in rubrica, il messaggio parte a uno dei
// due — e su WhatsApp non si richiama.
console.log('\n── 12. Certezza sul destinatario ──');
{
  ok('un numero è sempre certo', certezzaDestinatario('+39 333 1234567').certo === true);
  ok('anche scritto male', certezzaDestinatario('333-123 45 67').certo === true);
  ok('e viene riconosciuto come numero', eUnNumero('+393331234567') === true);
  ok('un nome non è un numero', eUnNumero('jose') === false);
  ok('nemmeno un numero troppo corto', eUnNumero('12345') === false);

  // Senza l'elenco davanti, "non lo so" vale come no
  const alBuio = certezzaDestinatario('jose');
  ok('un nome senza l\'elenco chat NON è certo', alBuio.certo === false);
  ok('e lo dice perché', /non ho l'elenco/.test(alBuio.perche), alBuio.perche);

  const rubrica = ['Jose Ramirez', 'Jose Maria Lopez', 'Brandon Usa', 'Boss', 'Giulia'];

  const due = certezzaDestinatario('jose', rubrica);
  ok('due Jose: NON si sceglie', due.certo === false);
  ok('e li elenca tutti e due', due.candidati.length === 2, JSON.stringify(due.candidati));
  ok('e spiega che non sceglie a caso', /non si richiama|scelgo io/i.test(due.cosaFare));

  const uno = certezzaDestinatario('brandon', rubrica);
  ok('un solo Brandon: si procede', uno.certo === true);
  ok('e usa il nome completo, non quello parziale', uno.destinatario === 'Brandon Usa');

  const esatto = certezzaDestinatario('Jose Ramirez', rubrica);
  ok('il nome esatto vince sull\'ambiguità', esatto.certo === true && esatto.destinatario === 'Jose Ramirez');
  ok('e dice che era esatto', esatto.come === 'nome esatto');

  const nessuno = certezzaDestinatario('mohammed', rubrica);
  ok('un nome che non c\'è: si ferma', nessuno.certo === false);
  ok('e non inventa un candidato', !nessuno.candidati);
  ok('e suggerisce di controllare o dare il numero', /nome|numero/.test(nessuno.cosaFare));

  ok('maiuscole e minuscole non contano', certezzaDestinatario('BRANDON USA', rubrica).certo === true);
  ok('destinatario vuoto: no', certezzaDestinatario('', rubrica).certo === false);

  // Il caso che rende la regola necessaria, scritto per esteso
  ok('CASO REALE: "jose" con due Jose in rubrica NON parte',
    certezzaDestinatario('jose', ['Jose Ramirez', 'Jose Maria Lopez']).certo === false);
}

// ── 13. Due modi: chi guida cambia quali regole valgono ──
//
// La distinzione che Luca ha imposto il 7 agosto, e che avevo sbagliato: quelle
// regole servono a due cose diverse.
//
//   Sembrare una persona → orari, weekend, pause, cadenza. Se la persona c'è
//   davvero perché sta guidando lui, non proteggono più niente.
//
//   Non farsi segnalare → sconosciuti, messaggi identici in serie. Chi riceve
//   preme "Segnala" allo stesso modo, che dietro ci sia un programma o Luca.
//
// Un test per ognuna delle due, in entrambi i modi. Se un giorno qualcuno
// allentasse anche le seconde "per coerenza", questi controlli lo fermano.
console.log('\n── 13. Attività dirette e attività automatiche ──');
{
  const R = nuove();
  const alba = new Date('2026-08-07T07:30:00');      // venerdì mattina presto
  const sabatoNotte = new Date('2026-08-15T03:00:00');
  const m = (adesso, modo, extra = {}) =>
    R.puoScrivere({ a: '+39333', testo: 'test cobra', conosciuto: true, adesso, modo, ...extra });

  // ── Quello che CADE quando guida Luca ──
  ok('alle 7:30 in automatico: no', m(alba, 'automatico').si === false);
  ok('alle 7:30 in diretto: SI', m(alba, 'diretto').si === true);
  ok('e il blocco automatico dice che in diretto si può',
    /lo stai chiedendo tu|dimmelo/i.test(m(alba, 'automatico').cosaFare), m(alba, 'automatico').cosaFare);

  ok('sabato alle 3 in automatico: no', m(sabatoNotte, 'automatico').si === false);
  ok('sabato alle 3 in diretto: SI', m(sabatoNotte, 'diretto').si === true);

  ok('la pausa in diretto è di secondi, non di minuti',
    regolePer('whatsapp', 'diretto').pausaMinima <= 5,
    'trovata: ' + regolePer('whatsapp', 'diretto').pausaMinima);
  ok('in automatico resta lunga',
    regolePer('whatsapp', 'automatico').pausaMinima >= 45);

  // ── Nessun tetto quando guida Luca ──
  //
  // Qui prima si verificava che il tetto giornaliero in diretto "esistesse
  // ancora, perche' cento messaggi si notano comunque". Quel numero l'avevo
  // scelto io: nessuno l'aveva chiesto e nessun dato lo giustificava. Era
  // prudenza mia applicata al lavoro di qualcun altro, e il 7 agosto Luca ha
  // detto di toglierla — e' il suo account, e' lui che clicca, ed e' lui che
  // paga se lo bloccano.
  //
  // Il test resta, girato: adesso verifica che il tetto NON ci sia.
  for (const canale of ['whatsapp', 'linkedin']) {
    const d = regolePer(canale, 'diretto');
    ok(`${canale}: nessun tetto giornaliero in diretto`, d.alGiorno === Infinity, 'trovato: ' + d.alGiorno);
    ok(`${canale}: nessun tetto orario in diretto`, d.allOra === Infinity, 'trovato: ' + d.allOra);
    ok(`${canale}: nessuna finestra oraria in diretto`, d.orari === false);
    ok(`${canale}: si puo' riscrivere subito alla stessa persona`, d.giorniFraStessoContatto === 0);
    // E in automatico i limiti restano tutti: li' non c'e' nessuno che guarda.
    const a = regolePer(canale, 'automatico');
    ok(`${canale}: in automatico il tetto resta`, Number.isFinite(a.alGiorno) && a.alGiorno > 0);
    ok(`${canale}: in automatico gli orari restano`, a.orari === true);
  }

  // ── Quello che RESTA anche quando guida Luca ──
  ok('SCONOSCIUTO: bloccato anche in diretto',
    R.puoScrivere({ a: '+39777', testo: 'ciao', conosciuto: false, adesso: alba, modo: 'diretto' }).si === false);
  ok('e il motivo è lo stesso',
    /mai scritto|rubrica/.test(R.puoScrivere({ a: '+39777', testo: 'ciao', conosciuto: false, adesso: alba, modo: 'diretto' }).motivo));

  ok('LUNGHEZZA: bloccata anche in diretto',
    R.puoScrivere({ a: '+39333', testo: 'x'.repeat(2000), conosciuto: true, adesso: alba, modo: 'diretto' }).si === false);

  // Copie identiche: la soglia si allarga ma non sparisce
  {
    const R2 = nuove();
    const testo = 'Buongiorno, le proponiamo i nostri servizi';
    let t = alba.getTime() - 3600000;
    for (let i = 0; i < 5; i++) { R2.registra({ a: `+3930${i}`, testo, adesso: new Date(t) }); t += 60000; }
    // COPIE IDENTICHE: in diretto non si conta piu'. Mandare lo stesso testo a
    // venti persone e' esattamente quello che si fa con un avviso ai clienti,
    // e bloccarlo alla sesta significava impedire un lavoro normale.
    ok('COPIE IDENTICHE: in diretto non c\'e\' limite',
      R2.puoScrivere({ a: '+39306', testo, conosciuto: true, adesso: alba, modo: 'diretto' }).si === true);
    ok('in automatico invece si conta ancora',
      Number.isFinite(regolePer('whatsapp', 'automatico').copieIdentiche));
  }

  // La cadenza per contatto: cade in diretto, perché riscrivere a qualcuno è
  // una conversazione, non insistenza.
  {
    const R3 = nuove();
    R3.registra({ a: '+39555', testo: 'primo', adesso: new Date(alba.getTime() - 3600000) });
    ok('riscrivere alla stessa persona: no in automatico',
      R3.puoScrivere({ a: '+39555', testo: 'secondo', conosciuto: true,
        adesso: new Date('2026-08-11T10:00:00'), modo: 'automatico' }).si === false);
    ok('riscrivere alla stessa persona: SI in diretto',
      R3.puoScrivere({ a: '+39555', testo: 'secondo', conosciuto: true, adesso: alba, modo: 'diretto' }).si === true);
  }

  ok('nel dubbio il modo è automatico (il più prudente)',
    R.puoScrivere({ a: '+39333', testo: 'ciao', conosciuto: true, adesso: alba }).si === false);
}

console.log(`\n╔══════════════════════════════════════════╗`);
console.log(`║  REGOLE INVIO: ${pass} PASS, ${fail} FAIL`);
console.log(`╚══════════════════════════════════════════╝`);
process.exit(fail ? 1 : 0);
