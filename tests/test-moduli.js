#!/usr/bin/env node
// tests/test-moduli.js — Compilare un modulo: prima guardare, poi scrivere,
// poi verificare.
//
// Luca, 6 agosto 2026: "come legge lo scraper la pagina? cosa fa prima di
// intervenire sui campi? come si comporta se non riesce a compilarne uno?
// abbiamo considerato tutti i possibili limiti dei diversi browser e sistemi
// operativi?"
//
// Andando a guardare: PRIMA di toccare un campo non faceva quasi niente.
// Prendeva il selettore che il modello aveva indovinato e assegnava .value,
// assumendo sempre un <input> o una <textarea>. Su moduli normalissimi —
// un CRM, un portale fornitori, un modulo di contatto — questo produce
// guasti che non danno errore:
//
//   <select>    assegnare .value con un testo che non coincide con nessuna
//               opzione non fa niente. Campo vuoto, nessun errore.
//   checkbox    la spunta sta in .checked, non in .value. "true" scritto in
//               .value lascia la casella com'era.
//   React/Vue   il modulo riscrive il campo dopo l'evento; senza rileggere,
//               un campo tornato vuoto risultava compilato.
//   a capo      un valore con un ritorno a capo rompeva la stringa di
//               JavaScript costruita a mano.
//   macOS       Ctrl+A non seleziona tutto: sposta a inizio riga. Il vecchio
//               testo restava e il nuovo si accodava.

const path = require('path');
const fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));

let PASS = 0, FAIL = 0;
function ok(nome, cond, dettaglio = '') {
  if (cond) { PASS++; console.log(`  \x1b[32mv\x1b[0m ${nome}`); }
  else { FAIL++; console.log(`  \x1b[31mx\x1b[0m ${nome}${dettaglio ? ' — ' + dettaglio : ''}`); }
}
function sezione(t) { console.log(`\n\x1b[1m-- ${t} --\x1b[0m`); }

const ext = fs.readFileSync('cobra-extension/background.js', 'utf8');
const srv = fs.readFileSync('modules/tools/handlers/interaction.js', 'utf8');

// La funzione vera, estratta dall'estensione ed eseguita su un DOM finto.
function compilatore() {
  const corpo = ext.match(/case 'compila_campo': \{[\s\S]*?return await run\(tab\.id, (\(sel, valore\) => \{[\s\S]*?\n        \}), \[args\.selettore/);
  return new Function('document', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event',
    'return ' + corpo[1] + ';');
}
const EventoFinto = function (nome) { this.type = nome; };
function protoConSetter() {
  const p = function () {};
  Object.defineProperty(p.prototype, 'value', {
    set(v) { this._v = v; }, get() { return this._v; }, configurable: true,
  });
  return p;
}

console.log('\n=== MODULI: GUARDARE, SCRIVERE, VERIFICARE ===');

sezione('Prima di scrivere, si guarda il campo');
{
  ok('esiste il comando che compila conoscendo i tipi', /case 'compila_campo'/.test(ext));
  ok('un campo che non c e viene detto', /campo non trovato/.test(ext));
  ok('uno invisibile pure', /campo presente ma non visibile/.test(ext));
  ok('uno disabilitato spiega perche', /la pagina non permette di compilarlo/.test(ext));
  ok('e uno di sola lettura', /campo di sola lettura/.test(ext));
}

sezione('Ogni tipo di campo viene trattato per quello che è');
{
  const finto = (opz) => {
    const P = protoConSetter();
    const el = Object.create(P.prototype);
    Object.assign(el, { tagName: 'INPUT', type: 'text', disabled: false, readOnly: false,
      isContentEditable: false, focus() {}, dispatchEvent() {}, click() { this.checked = !this.checked; },
      getBoundingClientRect: () => ({ width: 120, height: 30 }) }, opz);
    return { el, P };
  };
  const esegui = (el, P, valore) => {
    const doc = { querySelector: () => el };
    return compilatore()(doc, P, P, EventoFinto)('#x', valore);
  };

  // Elenco a tendina: il caso che falliva in silenzio
  const opzioni = [{ value: 'IT', text: 'Italia' }, { value: 'FR', text: 'Francia' }];
  const { el: sel, P: Ps } = finto({ tagName: 'SELECT', options: opzioni, value: '' });
  const rSel = esegui(sel, Ps, 'Italia');
  ok('un elenco riconosce l opzione dal testo visibile', rSel.ok === true && sel.value === 'IT', JSON.stringify(rSel));

  const { el: sel2, P: Ps2 } = finto({ tagName: 'SELECT', options: opzioni, value: '' });
  const rSel2 = esegui(sel2, Ps2, 'Germania');
  ok('e se l opzione non esiste lo DICE invece di tacere', rSel2.ok === false, JSON.stringify(rSel2));
  ok('elencando quali opzioni ci sono davvero',
     Array.isArray(rSel2.opzioniDisponibili) && rSel2.opzioniDisponibili.includes('Italia'),
     JSON.stringify(rSel2.opzioniDisponibili));

  // Casella da spuntare: la spunta non è un testo
  const { el: chk, P: Pc } = finto({ type: 'checkbox', checked: false });
  const rChk = esegui(chk, Pc, 'true');
  ok('una casella si spunta davvero', rChk.ok === true && chk.checked === true, JSON.stringify(rChk));
  const { el: chk2, P: Pc2 } = finto({ type: 'checkbox', checked: true });
  ok('e si toglie la spunta quando si chiede', esegui(chk2, Pc2, 'false').ok === true && chk2.checked === false);

  // Testo normale
  const { el: txt, P: Pt } = finto({ type: 'text', _v: '' });
  const rTxt = esegui(txt, Pt, 'Mario Rossi');
  ok('un campo di testo si compila', rTxt.ok === true && txt.value === 'Mario Rossi');

  // Un valore con un a capo dentro non rompe piu niente
  const { el: area, P: Pa } = finto({ tagName: 'TEXTAREA', _v: '' });
  const conACapo = 'Via Roma 1\nMilano';
  ok('un valore con un a capo passa intero', esegui(area, Pa, conACapo).ok === true && area.value === conACapo);

  // Apici e virgolette: rompevano la stringa di JavaScript
  const { el: ap, P: Pap } = finto({ type: 'text', _v: '' });
  ok("apici e virgolette non rompono niente", esegui(ap, Pap, "L'Oréal \"Paris\"").ok === true);
}

sezione('Il campo viene RILETTO: si riferisce quello che c e, non quello che si sperava');
{
  ok('la rilettura c e', /rilettoDalCampo/.test(ext));
  ok('e il motivo e spiegato', /La rilettura è il punto/.test(ext));

  // Un modulo che svuota il campo subito dopo — il caso React
  const P = protoConSetter();
  const el = Object.create(P.prototype);
  Object.assign(el, { tagName: 'INPUT', type: 'text', disabled: false, readOnly: false,
    isContentEditable: false, focus() {}, dispatchEvent() { this._v = ''; },
    getBoundingClientRect: () => ({ width: 120, height: 30 }) });
  const r = compilatore()({ querySelector: () => el }, P, P, EventoFinto)('#x', 'Mario');
  ok('un campo che la pagina svuota NON risulta compilato', r.ok === false, JSON.stringify(r));
  ok('e si dice esattamente cosa e successo', /svuotato il campo subito dopo/.test(r.motivo || ''), r.motivo);
}

sezione('Si puo guardare il modulo prima di toccarlo');
{
  ok('esiste il comando nell estensione', /case 'leggi_modulo'/.test(ext));
  ok('e lo strumento sul server', /async function leggiModulo/.test(srv));
  ok('legge l etichetta come la vede una persona', /label\[for=/.test(ext));
  ok('anche quando l etichetta contiene il campo', /el\.closest\('label'\)/.test(ext));
  ok('dice quali campi sono obbligatori', /obbligatorio:/.test(ext));
  ok('e per gli elenchi quali opzioni esistono', /voce\.opzioni = /.test(ext));
  ok('salta i campi nascosti', /tipo === 'hidden'/.test(ext));

  const { COBRA_TOOLS } = require('../modules/tools/schemas');
  const h = require('../modules/tools/handlers');
  ok('e dichiarato fra gli strumenti', COBRA_TOOLS.some(t => t.function.name === 'leggi_modulo'));
  ok('col suo gestore', typeof h.leggi_modulo === 'function');
  const sm = require('../modules/supermario');
  ok('chi compila moduli ce l ha in mano',
     sm.selectTools(['interact'], COBRA_TOOLS).some(t => t.function.name === 'leggi_modulo'));
}

sezione('Il tasto per selezionare tutto cambia col sistema operativo');
{
  ok('su Mac si usa Meta, altrove Control', /darwin' \? 'Meta' : 'Control'/.test(srv));
  ok('in entrambe le vie, ponte e ripiego', (srv.match(/darwin/g) || []).length >= 2);
  ok('col motivo scritto', /su Mac Ctrl\+A va a inizio riga/.test(srv));
}

sezione('Quando un campo non si compila, si sa perche');
{
  ok('il motivo torna al chiamante', /motivo: esito\?\.motivo/.test(srv));
  ok('insieme al tipo di campo', /tipo: esito\?\.tipo/.test(srv));
  ok('e a quello che c e adesso nel campo', /letto: esito\?\.rilettoDalCampo/.test(srv));
  ok('e alle opzioni di un elenco', /opzioniDisponibili: esito\?\.opzioniDisponibili/.test(srv));
  ok('i campi di pagamento restano vietati', /Non posso compilare campi di pagamento/.test(srv));
}

console.log('');
console.log(FAIL === 0
  ? `\x1b[32mRISULTATO: ${PASS} PASS, 0 FAIL\x1b[0m`
  : `\x1b[31mRISULTATO: ${PASS} PASS, ${FAIL} FAIL\x1b[0m`);
process.exit(FAIL > 0 ? 1 : 0);
