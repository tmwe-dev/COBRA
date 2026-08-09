#!/usr/bin/env node
// tests/test-cantiere.js — Dove si posa il lavoro finché non è finito.
//
// Prova fisica del 6 agosto 2026, scenario "ufficio commerciale": otto aziende
// di packaging con nome, città, sito ed email, in un Excel.
// Esito: 2 criteri su 6, nessun file. Sette pagine aperte in quattro minuti e
// mezzo, e alla fine niente in mano.
//
// La causa non era leggere né scrivere: NON C'ERA UN POSTO DOVE POSARE QUELLO
// CHE SI TROVAVA. Il turno conservava le pagine viste e il testo grezzo, ma
// non i risultati. A ogni insistenza il modello riceveva solo la propria
// ultima risposta e doveva ricavare tutto daccapo — mentre il testo delle
// pagine precedenti era già uscito dal contesto.
//
// È il muratore che a ogni giro ributta giù il muro perché nessuno gli ha
// dato un ponteggio dove appoggiare i mattoni.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

const { Cantiere } = require('../modules/collega/cantiere');

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

console.log('\n=== IL CANTIERE: SI POSA MENTRE SI TROVA ===');

(async () => {

sezione('Il caso vero: il nome sull elenco, la email sul sito');
{
  const c = new Cantiere({ campiAttesi: ['citta', 'sito', 'email'], quanteVoci: 8 });

  // Primo giro: dall'elenco arrivano nome e città
  c.annota('Rotofil', { citta: 'Milano' }, 'https://europages.it');
  c.annota('Minigrip', { citta: 'Bologna' }, 'https://europages.it');
  ok('due voci posate', c.elenco().length === 2);
  ok('nessuna ancora completa', c.complete() === 0);

  // Secondo giro: si apre il sito della prima e si trova la email
  c.annota('Rotofil', { sito: 'https://rotofil.com', email: 'info@rotofil.com' }, 'https://rotofil.com');
  ok('la seconda annotazione NON crea un doppione', c.elenco().length === 2, `${c.elenco().length} voci`);
  ok('completa la voce che c era', c.complete() === 1);
  ok('e la città del primo giro non si è persa',
     c.elenco().find(v => v.nome === 'Rotofil').campi.citta === 'Milano');
  ok('le fonti si accumulano', c.elenco().find(v => v.nome === 'Rotofil').fonti.length === 2);
}

sezione('Un dato buono non viene sostituito da uno peggiore');
{
  const c = new Cantiere({ campiAttesi: ['email'] });
  c.annota('Acme', { email: 'commerciale@acme.it' }, 'sito ufficiale');
  c.annota('Acme', { email: 'info@generico.com' }, 'elenco di terzi');
  ok('resta il primo, letto da chi lo aveva davvero',
     c.elenco()[0].campi.email === 'commerciale@acme.it', c.elenco()[0].campi.email);
}

sezione('Il cantiere dice sempre cosa manca');
{
  const c = new Cantiere({ campiAttesi: ['citta', 'email'], quanteVoci: 3 });
  c.annota('Alfa', { citta: 'Torino', email: 'a@alfa.it' });
  c.annota('Beta', { citta: 'Genova' });
  const buchi = c.buchi();
  ok('sa quale voce e incompleta', buchi.length === 1 && buchi[0].nome === 'Beta', JSON.stringify(buchi));
  ok('e quale campo manca', buchi[0].campiMancanti.includes('email'));
  ok('e che mancano ancora soggetti', c.riepilogo().voci === 2 && c.riepilogo().attese === 3);
  ok('quindi il lavoro non risulta finito', c.finito() === false);

  c.annota('Beta', { email: 'b@beta.it' });
  c.annota('Gamma', { citta: 'Roma', email: 'g@gamma.it' });
  ok('e quando tutto c e, risulta finito', c.finito() === true);
}

sezione('Quello che c e sul tavolo torna al modello');
{
  const c = new Cantiere({ campiAttesi: ['citta', 'email'], quanteVoci: 4 });
  c.annota('Rotofil', { citta: 'Milano', email: 'info@rotofil.com' });
  c.annota('Minigrip', { citta: 'Bologna' });
  c.ricorda('europages.it risponde vuoto: non riprovarci');

  const p = c.perIlPrompt();
  ok('elenca quello che ha gia', /Rotofil/.test(p) && /Milano/.test(p));
  ok('dicendo di NON ricercarlo', /NON vanno ricercate/.test(p));
  ok('dice cosa manca, voce per voce', /Minigrip: manca email/.test(p));
  ok('e quanti soggetti mancano ancora', /Servono ancora 2 soggetti/.test(p));
  ok('riporta le cose imparate', /europages\.it risponde vuoto/.test(p));
  ok('e ricorda di posare subito', /appena la trovi/.test(p));
  // A cantiere vuoto NON si tace: verificato il 6 agosto, il modello ha
  // visitato dieci aziende senza annotarne una, perché la regola era sepolta
  // a metà di undicimila caratteri di prompt. Una regola che non si vede non
  // esiste.
  const vuoto = new Cantiere({ campiAttesi: ['citta', 'email'], quanteVoci: 8 }).perIlPrompt();
  ok('un cantiere vuoto dice comunque cosa fare', vuoto.length > 0);
  ok('e lo dice per primo, non a metà', /^# PRIMA DI TUTTO/.test(vuoto));
  ok('nominando quanti soggetti e quali campi', /8 soggetti/.test(vuoto) && /citta, email/.test(vuoto));
  ok('e dicendo di annotare subito', /Appena trovi UN soggetto/.test(vuoto));
  ok('e con quale strumento chiudere', /scrivi_raccolta, non con create_file/.test(vuoto));
}

sezione('Il file si scrive da quello che c e, non da quello che si ricorda');
{
  const c = new Cantiere({ campiAttesi: ['citta', 'email'] });
  c.annota('Alfa', { citta: 'Torino', email: 'a@alfa.it' });
  c.annota('Beta', { citta: 'Genova', email: 'b@beta.it' });
  const righe = c.perIlFile();
  ok('la prima riga sono le intestazioni', righe[0][0] === 'nome' && righe[0].includes('email'));
  ok('poi una riga per voce', righe.length === 3);
  ok('coi valori al posto giusto', righe[1][0] === 'Alfa' && righe[1][2] === 'a@alfa.it', JSON.stringify(righe[1]));
  ok('e un campo mancante resta vuoto, non sparisce la riga',
     (() => { const d = new Cantiere({ campiAttesi: ['citta', 'email'] });
       d.annota('Solo', { citta: 'Bari' }); return d.perIlFile()[1][2] === ''; })());
}

sezione('Non si posa aria');
{
  const c = new Cantiere({ campiAttesi: ['x'] });
  ok('senza nome non si annota', c.annota('', { x: '1' }).ok === false);
  ok('senza nessun valore nemmeno', c.annota('Vuoto', {}).ok === false);
  ok('e i campi vuoti vengono ignorati',
     (() => { c.annota('Tal', { x: 'buono', y: '   ' }); return c.elenco()[0].campi.y === undefined; })());
}

sezione('E il cantiere e agganciato al lavoro vero');
{
  const chat = fs.readFileSync('modules/routes/chat.js', 'utf8');
  // Non si azzera piu' a ogni turno: si riapre quello lasciato a meta'.
  // Un lavoro da otto soggetti non sta in un turno, e ributtarlo ogni volta
  // significa non finirlo mai — quattro tentativi di fila lo hanno dimostrato.
  // La chiamata e' diventata riapriLavoro(): riprende il cantiere E il piano,
  // che sono le due meta' della stessa cosa. L'intenzione della prova — non si
  // riparte da zero — e' la stessa, e adesso copre anche i passi.
  ok('a ogni turno si riprende quello aperto', /_archivioCantieri\.riapriLavoro\(/.test(chat));
  ok('e non lo si butta piu', !/ctx\.session\.cantiere = null;/.test(chat));
  ok('prende le misure dai criteri dell incarico', /new Cantiere\(\{[\s\S]{0,120}campiAttesi: campi/.test(chat));
  ok('i soggetti da coprire ci entrano subito', /for \(const nome of soggetti\)/.test(chat));
  ok('e torna al modello a ogni ripresa', (chat.match(/_bloccoCantiere\(ctx\)/g) || []).length >= 3);
  // Si controlla l'INTENZIONE — il cantiere arriva al modello gia' alla prima
  // chiamata — non la forma esatta dell'espressione. La versione precedente
  // pretendeva `systemPrompt + _bloccoCantiere(ctx), msgs` alla lettera, ed e'
  // diventata rossa il 9 agosto perche' in mezzo si e' aggiunto
  // `_bloccoRicerca(ctx)`: il comportamento era identico, cambiava solo la
  // punteggiatura. Un test che si rompe quando il codice migliora insegna a
  // ignorare i test.
  ok('compreso il PRIMO giro, non solo le insistenze',
     /callAI\(systemPrompt(?:\s*\+\s*_blocco\w+\(ctx\))*\s*\+\s*_bloccoCantiere\(ctx\)(?:\s*\+\s*_blocco\w+\(ctx\))*\s*,\s*msgs/.test(chat));

  const { COBRA_TOOLS } = require('../modules/tools/schemas');
  const h = require('../modules/tools/handlers');
  for (const n of ['annota', 'stato_lavoro', 'scrivi_raccolta']) {
    ok(`lo strumento ${n} esiste ed è collegato`,
       COBRA_TOOLS.some(t => t.function.name === n) && typeof h[n] === 'function');
  }
  const sm = require('../modules/supermario');
  ok('chi raccoglie ce l ha in mano',
     sm.selectTools(['search'], COBRA_TOOLS).some(t => t.function.name === 'annota'));

  // La regola non sta piu' nel prompt fisso: sta nel manuale "raccolta", che
  // arriva quando serve. Il prompt fisso e' passato da 11.645 a 4.564
  // caratteri proprio per questo — una regola sepolta non viene letta.
  const manuali = require('../modules/prompts/manuali');
  const raccolta = manuali.manuale('raccolta') || '';
  ok('la regola sta nel manuale della raccolta', /POSA MENTRE TROVI/.test(raccolta));
  ok('col perché', /non ci sono piu|si perde|e perso/i.test(raccolta));
  ok('e il manuale arriva quando si raccoglie',
     manuali.pertinenti({ messaggio: 'trova 8 aziende', scopes: ['file'] }).some(m => m.nome === 'raccolta'));
  ok('ma non quando si chiacchiera',
     !manuali.pertinenti({ messaggio: 'che ore sono', scopes: ['chat'] }).some(m => m.nome === 'raccolta'));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
})();
