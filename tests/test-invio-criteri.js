// tests/test-invio-criteri.js — Un invio non si giudica contando parole.
//
// PERCHE' ESISTE
//
// Per "manda un messaggio WhatsApp a Jose" il Collega aveva prodotto il
// criterio { campi_obbligatori: [numero_telefono, testo_messaggio] }. Quel
// criterio cerca quelle parole nel TESTO della risposta, e in un "fatto,
// mandato" non ci sono. Verdetto: non completo. Due insistenze. E in quelle
// insistenze l'Esecutore ha smesso di usare whatsapp_scrivi — che il numero
// non lo vuole — si e' messo a cercare un numero di telefono, ed e' ripiegato
// sul vecchio whatsapp_send, quello senza regole ne' verifica di chi sia il
// destinatario.
//
// Per ore ho cercato il divieto nei prompt e nei permessi. Non c'era nessun
// divieto: c'era un supervisore che continuava a dire "non hai finito".
//
// Questo file tiene ferma la regola: su un invio, campi_obbligatori si scarta.

const { Incarico } = require('../modules/collega/incarico');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`)); };

console.log('\n── Su un invio, campi_obbligatori si scarta ──');

const invii = [
  'manda un messaggio WhatsApp a Jose',
  'scrivi a Samuel su LinkedIn',
  'invia una email a Brandon',
  'rispondi a Jose su whatsapp',
];
for (const obiettivo of invii) {
  const i = new Incarico({
    obiettivo,
    criteri: [
      { tipo: 'campi_obbligatori', campi: ['numero_telefono', 'testo_messaggio'] },
      { tipo: 'elementi_minimi', quanti: 1 },
    ],
  });
  ok(`"${obiettivo.slice(0, 34)}" → niente campi_obbligatori`,
    !i.criteri.some(c => c.tipo === 'campi_obbligatori'),
    'criteri rimasti: ' + JSON.stringify(i.criteri));
  ok('   e resta un incarico valido', i.valido());
}

console.log('\n── Ma su un lavoro di raccolta resta, che li serve ──');
for (const obiettivo of [
  'raccogli i prezzi dei fornitori di trasporto',
  'fammi una tabella dei voli Milano Madrid con prezzo e orario',
]) {
  const i = new Incarico({
    obiettivo,
    criteri: [{ tipo: 'campi_obbligatori', campi: ['prezzo', 'orario'] }],
  });
  ok(`"${obiettivo.slice(0, 34)}" → campi_obbligatori conservato`,
    i.criteri.some(c => c.tipo === 'campi_obbligatori'));
}

console.log('\n── E un invio senza criteri resta valido ──');
{
  const i = new Incarico({ obiettivo: 'manda un messaggio WhatsApp a Jose', criteri: [] });
  ok('non nasce invalido per mancanza di criteri', i.valido(),
    'criteri: ' + JSON.stringify(i.criteri));
}

console.log(`\n╔══════════════════════════════════════════╗`);
console.log(`║  INVIO E CRITERI: ${pass} PASS, ${fail} FAIL`);
console.log(`╚══════════════════════════════════════════╝`);
process.exit(fail ? 1 : 0);
