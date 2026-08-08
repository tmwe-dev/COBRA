#!/usr/bin/env node
// tests/test-un-comandante.js — Un comandante solo: l'incarico.
//
// Luca, 7 agosto 2026: "non voglio 7 comandanti. ne voglio uno, e voglio un
// esecutore."
//
// Prima decidevano in sette, e i primi tre lo facevano PRIMA di sapere cosa
// servisse: routeIntent guardava le PAROLE del messaggio, selectModel la sua
// LUNGHEZZA. Il Collega scriveva l'incarico dopo, e il turno rattoppava in sei
// punti diversi. Le conseguenze, tutte viste dal vivo:
//
//   - "compila il modulo su Google Voli" → la parola "voli" faceva togliere
//     fill_form. Il modulo non si compilava. Mai.
//   - "Vai." di quattro lettere → modello piccolo per sei criteri.
//   - file_atteso senza gli strumenti per scrivere file.
//   - origine_verificabile senza il browser.
//
// Ogni volta la stessa forma: qualcuno decideva prima di sapere.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

const { ordineDiLavoro, ambitiPer, modelloPer, inChiaro } = require('../modules/collega/comando');
const { Incarico } = require('../modules/collega/incarico');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== UN COMANDANTE SOLO: L INCARICO ===');

sezione('I casi veri che fallivano');
{
  // Google Voli: l'incarico chiede fonti → serve il browser E poter compilare
  const voli = new Incarico({ obiettivo: 'Cercare voli Milano-Tokyo su Google Voli',
    criteri: [{ tipo: 'origine_verificabile' }, { tipo: 'campi_obbligatori', campi: ['prezzo', 'compagnia'] }] });
  const o1 = ordineDiLavoro(voli);
  ok('la ricerca voli ha il browser', o1.ambiti.includes('browse'));
  ok('E può compilare il modulo di ricerca', o1.ambiti.includes('interact'),
     o1.ambiti.join(','));
  ok('col motivo scritto', /moduli di ricerca/.test(o1.perche.join('; ')));

  // "Vai." → il modello lo decide l'incarico, non il messaggio
  ok('sei criteri vogliono il modello forte', modelloPer(voli).tier === 'power');

  // file_atteso → strumenti per scrivere
  const report = new Incarico({ obiettivo: 'Preparare il confronto',
    criteri: [{ tipo: 'file_atteso', estensione: 'html' }, { tipo: 'formato_consegna' }] });
  ok('chi promette un file può scriverlo', ordineDiLavoro(report).ambiti.includes('file'));

  // raccolta → dove posare
  const raccolta = new Incarico({ obiettivo: 'Raccogliere 8 aziende',
    criteri: [{ tipo: 'elementi_minimi', quanti: 8 }, { tipo: 'campi_obbligatori', campi: ['email'] }] });
  ok('chi raccoglie ha dove posare', ordineDiLavoro(raccolta).ambiti.includes('data'));
}

sezione('Si deduce dai criteri, non dalle parole');
{
  // Stesso obiettivo, criteri diversi → ordini diversi
  const senza = ordineDiLavoro(new Incarico({ obiettivo: 'Preparare un documento',
    criteri: [{ tipo: 'file_atteso', estensione: 'html' }] }));
  const con = ordineDiLavoro(new Incarico({ obiettivo: 'Preparare un documento',
    criteri: [{ tipo: 'file_atteso', estensione: 'html' }, { tipo: 'origine_verificabile' }] }));
  ok('senza criterio delle fonti, niente browser', !senza.ambiti.includes('browse'));
  ok('col criterio delle fonti, il browser c è', con.ambiti.includes('browse'));
  ok('e in entrambi i casi si può scrivere il file',
     senza.ambiti.includes('file') && con.ambiti.includes('file'));
}

sezione('Nessun incarico resta senza strumenti');
{
  const vuoto = ordineDiLavoro(new Incarico({ obiettivo: 'Fare una cosa', criteri: [{ tipo: 'nessun_duplicato' }] }));
  ok('un incarico spoglio riceve comunque le mani di base', vuoto.ambiti.length > 0, vuoto.ambiti.join(','));
  ok('e lo dice', /do quelli di base/.test(vuoto.perche.join('; ')));
  ok('anche senza incarico del tutto', ordineDiLavoro(null).ambiti.length > 0);
}

sezione('L ordine si sa spiegare a voce');
{
  const o = ordineDiLavoro(new Incarico({ obiettivo: 'Cercare fornitori',
    criteri: [{ tipo: 'origine_verificabile' }, { tipo: 'file_atteso', estensione: 'xlsx' }] }));
  const frase = inChiaro(o);
  ok('è una frase, non un elenco di sigle', /Per questo lavoro mi servono/.test(frase));
  ok('dice quali ambiti', /browse/.test(frase));
  ok('e perché', /pagine aperte davvero|promesso un file/.test(frase));
}

sezione('Il turno obbedisce all ordine, e non rattoppa piu');
{
  const chat = fs.readFileSync('modules/routes/chat.js', 'utf8');
  ok('l ordine nasce dall incarico', /const ordine = ordineDiLavoro\(incaricoCorrente\)/.test(chat));
  ok('e sostituisce gli ambiti indovinati', /routing\.scopes = ordine\.ambiti/.test(chat));
  ok('il modello viene dall ordine', /ctx\._ordineDiLavoro\s*\n?\s*\? \{ tier: ctx\._ordineDiLavoro\.tier/.test(chat));
  ok('il vecchio rattoppo sul modello e sparito',
     !/ma l'incarico chiede/.test(chat));
  ok('Luca vede la decisione e il perché', /emitReasoning\(inChiaro\(ordine\)/.test(chat));
  ok('e resta scritta nel log', /\[Comando\]/.test(chat));
}

sezione('I due freni restano, perche un freno non e un comandante');
{
  const sup = fs.readFileSync('modules/supervisor/cobra.js', 'utf8');
  ok('il Supervisore puo ancora fermare i giri a vuoto', /force_stop|circular_loop/.test(sup));
  const risk = fs.readFileSync('modules/risk/calculator.js', 'utf8');
  ok('il rischio puo ancora fermare l irreversibile', /requires_confirmation/.test(risk));
  const com = fs.readFileSync('modules/collega/comando.js', 'utf8');
  ok('ed e scritto perche non contano come comandanti',
     /non decide dove si va, decide solo quando ci\s*\n?\/\/ si ferma/.test(com));
}

sezione('Tutti e due sanno dove si trovano');
{
  const A = require('../modules/prompts/agents');
  const nav = String((A.AGENT_PROMPTS || A).navigator || '');
  ok('l Esecutore sa di essere dentro un programma con un estensione',
     /Sei dentro COBRA, un programma/.test(nav) && /estensione/.test(nav));
  ok('sa che quello che fa succede davvero', /Quello che fai succede davvero/.test(nav));
  ok('e che il lavoro e una sequenza, non una frase', /SEQUENZA di operazioni/.test(nav));
  ok('e che puo fare decine di passi', /decine di passi/.test(nav));

  const c = require('../modules/collega/prompt').promptIncarico();
  ok('il Collega sa di comandare da solo', /Tu sei l'unico che comanda/.test(c));
  ok('e che tutto discende dall incarico', /tutto discende dall'incarico/.test(c));
  ok('quindi che scriverlo vago fa partire vago', /Se lo\s*\n?scrivi vago/.test(c));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
