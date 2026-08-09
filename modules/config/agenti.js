// modules/config/agenti.js — I colleghi fra cui Luca può scegliere.
//
// COSA SONO, E COSA NON SONO
//
// Sono quattro teste diverse attaccate allo STESSO cervello. Ognuno ha la sua
// lingua, la sua voce e il suo carattere, ma nessuno di loro sa niente da solo:
// tutti chiamano `cobra_consulta`, che è COBRA che gira sul Mac di Luca.
//
// Questa è la differenza fra "quattro agenti" e "quattro comandanti". Luca me
// l'ha detto chiaro il 7 agosto: «non voglio 7 comandanti, ne voglio uno e un
// esecutore». Qui il comandante resta uno. Cambiare agente cambia con chi
// parla, non chi decide — come cambiare interlocutore in azienda senza cambiare
// chi firma.
//
// PERCHÉ QUATTRO E NON UNO
//
// Il lavoro di Luca non è tutto uguale. Con Brandon negli Stati Uniti si parla
// inglese, con Jose spagnolo. E quando ci sono dei numeri da guardare serve
// qualcuno che stia zitto sui convenevoli e dica subito se il dato regge —
// che è un carattere, non una lingua.
//
// COSA VA CAMBIATO A MANO SU ELEVENLABS
//
// Gli agenti non inglesi vogliono il modello vocale Flash v2.5: creandoli da
// qui vengono su in inglese, e la lingua va girata nella console. Sono due
// scelte in un menu, ma senza quelle l'agente parla la lingua sbagliata.
// La colonna `daSistemare` dice quali aspettano ancora quel passaggio.

const AGENTI = [
  {
    id: 'agent_0101kzcvcdegecebg62zq656pxjf',
    nome: 'COBRA',
    lingua: 'it',
    bandiera: '🇮🇹',
    voce: '18ZMGuois2TnhI0bJ7nn',
    nomeVoce: 'il presidente',
    carattere: 'Il collega di tutti i giorni. Calmo, complice, va al punto.',
    quandoUsarlo: 'Sempre, se non hai un motivo per cambiare.',
    daSistemare: null,
    predefinito: true,
  },
  {
    id: 'agent_0301kzdtypp0evvs09jn8nttdj0b',
    nome: 'COBRA EN',
    lingua: 'en',
    bandiera: '🇬🇧',
    voce: 'plP9aw1rizYgjFfuvLQ7',
    nomeVoce: 'Heather, americana',
    carattere: 'Stesso carattere, in inglese.',
    quandoUsarlo: 'Partner americani e asiatici, vettori, documenti IATA in inglese.',
    daSistemare: null,
  },
  {
    id: 'agent_9501kzdv004hegr9zmsfby5677rv',
    nome: 'COBRA ES',
    lingua: 'es',
    bandiera: '🇪🇸',
    voce: 'scn1gPWkdVd8FhODJoei',
    nomeVoce: 'Maria, colombiana',
    carattere: 'Stesso carattere, in spagnolo.',
    quandoUsarlo: 'Corrispondenti in Spagna e America Latina.',
    daSistemare: 'Su ElevenLabs: modello Flash v2.5, lingua spagnolo.',
  },
  {
    id: 'agent_9601kzdv0n4bfr8s9p021twnczw1',
    nome: 'COBRA ANALISTA',
    lingua: 'it',
    bandiera: '📊',
    voce: 'HuK8QKF35exsCh2e7fLT',
    nomeVoce: 'Carmelo, italiano',
    // Il carattere è diverso davvero, non è una sfumatura: temperatura 0.4
    // invece di 0.6, e un prompt che gli impone di separare ciò che ha
    // verificato da ciò che sta supponendo. Serve quando la risposta comoda
    // costa dei soldi.
    carattere: 'Asciutto. Prima il numero, poi cosa significa. Dice quando un dato non regge.',
    quandoUsarlo: 'Confronti fra fornitori, margini, tariffe, quando i conti devono tornare.',
    daSistemare: 'Su ElevenLabs: modello Flash v2.5, lingua italiano.',
  },
];

function elenco() {
  return AGENTI.map(a => ({ ...a }));
}

function quello(id) {
  return AGENTI.find(a => a.id === id) || AGENTI.find(a => a.predefinito) || AGENTI[0];
}

/**
 * Chi parla quando nessuno ha scelto.
 *
 * ── PERCHE' SERVE UNA FUNZIONE, INVECE DI UN `if` ──
 *
 * Fino al 9 agosto `ctx._agenteScelto` partiva vuoto, e tanto tts.js quanto
 * supermario.js facevano `if (ctx._agenteScelto)`. Con quel campo vuoto:
 *
 *   - la voce cadeva su ELEVENLABS_VOICE_ID nelle costanti, che non e' la
 *     voce di NESSUNO dei quattro agenti;
 *   - il blocco "# CHI SEI ADESSO" non entrava mai nel prompt.
 *
 * Cioe': COBRA parlava con la voce di uno sconosciuto e senza il proprio
 * carattere, sempre, salvo che Luca aprisse il menu — e anche allora la
 * scelta viveva in memoria e moriva al primo riavvio. Ne abbiamo fatti dieci
 * in una notte.
 *
 * `quello()` sapeva gia' cadere sul predefinito. Semplicemente nessuno la
 * chiamava, perche' la si chiamava solo dentro un `if` che era falso.
 */
function predefinito() {
  return AGENTI.find(a => a.predefinito) || AGENTI[0];
}

module.exports = { AGENTI, elenco, quello, predefinito };
