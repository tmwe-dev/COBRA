#!/usr/bin/env node
// tests/test-collega-algoritmo.js — L'algoritmo del Collega.
//
// Luca, 6 agosto 2026: "cosa vuole l'utente, quale risultato vuole ottenere...
// ho tutte le informazioni minime?... quali risorse ho?... procedo con una
// verifica e giudico se quello che ho in mano mi soddisfa, nel caso contrario
// faccio altri tentativi, e se mi rendo conto che la cosa non è fattibile
// esattamente come vorrei, cerco alternative... questo deve essere il
// logaritmo."
//
// Il pezzo che mancava nel CODICE, non solo nel prompt: si poteva soltanto
// insistere sulla stessa strada. Se la cosa non era ottenibile, due giri
// identici e una consegna monca.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

const { Collega } = require('../modules/collega/collega');
const { Incarico } = require('../modules/collega/incarico');
const { promptIncarico } = require('../modules/collega/prompt');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }


// ── Cosa il Collega puo' RAGGIUNGERE, non solo cosa ha sempre davanti ──
//
// Il 6 agosto il prompt del Collega e' passato da 16.570 a 3.563 caratteri:
// identita', voce, il conto fra chiedere e sprecare, il contratto JSON. Il
// resto — metodo, criteri, esempi — sta nei manuali di collega/manuali, che
// si aprono quando servono.
//
// Le regole esistono ancora e sono raggiungibili: i controlli guardano
// l'insieme, perche' e' quello il sapere del Collega.
function _tuttoIlSapere() {
  const P = require('../modules/collega/prompt');
  return [P.promptIncarico(), P.promptValutazione()]
    .concat(P.elencoManuali().map(n => P.manuale(n)))
    .join('\n\n');
}

const P = _tuttoIlSapere();
const muto = () => {};

console.log('\n=== L ALGORITMO: CAPIRE, VERIFICARE, GIUDICARE, CAMBIARE STRADA ===');

(async () => {

sezione('Le domande sono nell ordine giusto, e sono tutte');
{
  ok('1 — cosa vuole davvero', /## 1\. COSA VUOLE DAVVERO/.test(P));
  ok('    e si immagina il risultato prima di partire', /Immagina il documento finito prima di cominciare/.test(P));
  ok('2 — ho il minimo per partire', /## 2\. HO IL MINIMO PER PARTIRE\?/.test(P));
  ok('    distingue cio che serve da cio che aiuta', /SENZA CUI il lavoro è inutile/.test(P) && /lavorare\s*\n?\s*MEGLIO/.test(P));
  ok('    e vieta l interrogatorio', /Mai un interrogatorio/.test(P));
  ok('3 — con cosa lo faccio', /## 3\. CON COSA LO FACCIO/.test(P));
  ok('4 — prima una prova', /## 4\. FAI UNA PROVA E GUARDA COM'È ANDATA/.test(P));
  ok('5 — quello che ho in mano mi soddisfa?', /mi soddisfa\?/i.test(P));
  ok('6 — prima insisti, poi cambia strada', /## 6\. NON VA\? PRIMA INSISTI, POI CAMBIA STRADA/.test(P));
  ok('7 — cambiare strada = risolvere in altro modo', /## 7\. CAMBIARE STRADA VUOL DIRE RISOLVERE LO STESSO PROBLEMA/.test(P));
  ok('8 — consegna e anticipa', /## 8\. CONSEGNA E ANTICIPA/.test(P));
}

sezione('Sa quali risorse ha, e quali no');
{
  ok('sa di avere un browser vero', /un browser vero, che apre pagine/.test(P));
  ok('sa di poter scrivere file', /la possibilità di scrivere file/.test(P));
  ok('sa di avere il registro delle fonti', /il registro delle fonti/.test(P));
  ok('sa cosa NON puo fare', /Non hai: prenotare, pagare/.test(P));
  ok('e che un piano fuori dalle risorse va cambiato, non tentato', /il piano va cambiato, non tentato/.test(P));
}

sezione('Fatica o possibilita: la distinzione che fa risparmiare le ore');
{
  ok('il prompt la nomina', /se è mancata FATICA/.test(P) && /se è mancata POSSIBILITÀ/.test(P));
  ok('e da il segnale per riconoscerla', /manca esattamente quello che\s*\n?mancava prima/.test(P));

  const incarico = new Incarico({ obiettivo: 'Prezzi hotel a Tokyo',
    criteri: [{ tipo: 'elementi_minimi', quanti: 3 }, { tipo: 'origine_verificabile' }] });
  const c = new Collega(async () => '', muto);
  const esitoVuoto = { testo: 'nessun prezzo trovato', file: [], pagine: [] };

  const primo = c.giudica(incarico, esitoVuoto, {}, 0, null, 0);
  ok('al primo tentativo si insiste, non si cambia', primo.decisione === 'insisti', primo.decisione);

  const mancanze = primo.valutazione.mancanze.slice();
  const secondo = c.giudica(incarico, esitoVuoto, {}, 1, mancanze, 0);
  ok('se il tentativo non ha spostato niente, si cambia strada', secondo.decisione === 'cambia_strada', secondo.decisione);

  const diverse = c.giudica(incarico, esitoVuoto, {}, 1, ['tutt altra mancanza'], 0);
  ok('se invece qualcosa si e mosso, si insiste ancora', diverse.decisione === 'insisti', diverse.decisione);

  const giaCambiata = c.giudica(incarico, esitoVuoto, {}, 1, mancanze, 1);
  ok('ma si cambia strada una volta sola, non all infinito', giaCambiata.decisione !== 'cambia_strada', giaCambiata.decisione);

  const esaurite = c.giudica(incarico, esitoVuoto, {}, 2, ['altro'], 1);
  ok('esaurite le insistenze si consegna dichiarandolo', esaurite.decisione === 'consegna' && esaurite.esaurite === true);
}

sezione('La strada alternativa viene cercata davvero');
{
  const incarico = new Incarico({ obiettivo: 'Prezzi hotel 5 stelle a Tokyo, 14-28 settembre',
    criteri: [{ tipo: 'origine_verificabile' }] });
  let sistemaVisto = '', contestoVisto = '';
  const c = new Collega(async (sys, msgs) => {
    sistemaVisto = sys; contestoVisto = msgs[0].content;
    return JSON.stringify({
      istruzione: 'Apri il listino ufficiale delle catene (Marriott, Peninsula) invece dei comparatori.',
      obiettivo: 'Forbice di listino ufficiale per 5 stelle a Tokyo nel periodo',
      avviso: 'I comparatori i prezzi non li mostrano senza login: prendo i listini ufficiali, danno la stessa forbice.',
    });
  }, muto);

  const alt = await c.ripensa(incarico, { mancanze: ['nessun prezzo con fonte'] },
    { testo: 'niente', pagine: [{ url: 'https://www.booking.com/tokyo' }] });

  ok('torna una strada nuova', !!alt);
  ok('con un ordine operativo concreto', /listino ufficiale/.test(alt.istruzione));
  ok('un obiettivo riformulato', /forbice di listino/i.test(alt.obiettivo));
  ok('e una riga per Luca che spiega il perche', /senza login/.test(alt.avviso));

  ok('a chi decide viene detto che riprovare uguale non serve', /è la strada/.test(sistemaVisto));
  ok('gli si vieta di ripetere l ordine di prima', /Non ripetere l'ordine di prima/.test(sistemaVisto));
  ok('gli si ricorda cosa puo e non puo fare chi esegue', /non può prenotare, pagare/.test(sistemaVisto));
  ok('la scelta segue il criterio di chi paga', /come la sceglierebbe chi paga/.test(sistemaVisto));
  ok('riceve cosa manca', /nessun prezzo con fonte/.test(contestoVisto));
  ok('e quali pagine sono gia state aperte a vuoto', /booking\.com/.test(contestoVisto));
}

sezione('Se la strada alternativa non arriva, non si blocca niente');
{
  const incarico = new Incarico({ obiettivo: 'x', criteri: [{ tipo: 'origine_verificabile' }] });
  const rotto = new Collega(async () => { throw new Error('modello giù'); }, muto);
  ok('un modello caduto non fa esplodere il turno', (await rotto.ripensa(incarico, { mancanze: [] }, {})) === null);
  const fuoriFormato = new Collega(async () => 'non è json', muto);
  ok('una risposta fuori formato nemmeno', (await fuoriFormato.ripensa(incarico, { mancanze: [] }, {})) === null);
}

sezione('Il cambio di strada e agganciato al lavoro vero');
{
  const c = fs.readFileSync('modules/routes/chat.js', 'utf8');
  ok('il turno tiene conto di cosa mancava prima', /let mancanzePrecedenti = null/.test(c));
  ok('e di quante volte ha gia cambiato strada', /let stradeCambiate = 0/.test(c));
  ok('il giudizio li riceve entrambi', /insistenze,\s*\n\s*mancanzePrecedenti, stradeCambiate/.test(c));
  ok('esiste il ramo che cambia strada', /giudizio\.decisione === 'cambia_strada'/.test(c));
  ok('la nuova strada viene chiesta al Collega', /await collega\.ripensa\(/.test(c));
  ok('e finisce davvero nel prompt di chi esegue', /CAMBIO DI STRADA DECISO DAL COLLEGA/.test(c));
  ok('Luca vede che si sta cambiando strada', /type: 'cambio_strada'/.test(c));
  ok('e il motivo glielo si dice', /emitReasoning\(altra\.avviso/.test(c));
  ok('se anche l altra fallisce si consegna, non si cicla', /Anche l'altra strada è fallita/.test(c));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
})();
