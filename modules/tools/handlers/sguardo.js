// modules/tools/handlers/sguardo.js — Guardare la pagina, e agire su cio' che
// si e' visto.
//
// PERCHE' ESISTE
//
// Per agire su una pagina il modello doveva produrre un selettore CSS. Due
// guasti, tutti e due silenziosi:
//
//   1. il selettore se lo INVENTA. Non ha guardato: ha indovinato un nome
//      plausibile. Un selettore inventato non da' errore — da' zero elementi
//      trovati, quindi zero campi compilati e un modulo che parte vuoto.
//   2. anche quando e' giusto, e' fragile. `div:nth-child(4)` smette di
//      significare qualcosa alla prima riscrittura del CSS.
//
// Qui il modello guarda prima, riceve un elenco di cose che ESISTONO — con un
// nome corto, E1, E2, E3 — e poi agisce su quelle. Non puo' nominare una cosa
// che non c'e', perche' i nomi glieli diamo noi.
//
// La differenza pratica:
//
//   PRIMA   click_element({ selector: '#search-btn' })    ← indovinato
//   ADESSO  guarda()  →  E7 pulsante "Cerca"
//           agisci({ id: 'E7', cosa: 'clicca' })          ← scelto

async function _ponte(ctx, comando, args = {}) {
  if (!ctx.isBridgeReady || !ctx.isBridgeReady()) {
    return { ok: false, motivo: 'il browser non e\' collegato', cosaFare: 'Apri COBRA nel browser e riprova.' };
  }
  try {
    const r = await ctx.bridgeCommand(comando, args);
    return (r && r.result) || r || { ok: false, motivo: 'il ponte non ha risposto' };
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
}

async function guardaPagina(args, ctx) {
  ctx.emitReasoning('Guardo cosa c\'e\' sulla pagina...', '👀');
  const d = await _ponte(ctx, 'guarda', { quanti: Number(args.quanti) || 120 });
  if (!d.ok) return JSON.stringify(d);

  // Si segna che la pagina e' stata guardata: `agisci` lo pretende, cosi' come
  // fill_form pretende che il modulo sia stato letto. Un freno, non un consiglio.
  ctx.session._paginaGuardata = { quando: Date.now(), url: d.url, quanti: d.quanti };

  ctx.emitReasoning(`${d.quanti} cose su cui posso agire`, '🔎');
  return JSON.stringify({
    ok: true,
    url: d.url,
    titolo: d.titolo,
    diCosaParla: d.diCosaParla,
    elementi: d.elementi,
    quanti: d.quanti,
    quantiInTutto: d.quantiInTutto,
    come: 'Agisci su questi con agisci({id:"E7", cosa:"clicca"}) oppure '
      + 'agisci({id:"E3", cosa:"scrivi", valore:"Milano"}). Gli id valgono '
      + 'finche\' non cambi pagina. NON inventare selettori CSS: usa questi.',
  });
}

async function agisciSuElemento(args, ctx) {
  const id = String(args.id || '').trim().toUpperCase();
  const cosa = String(args.cosa || 'clicca').toLowerCase();
  if (!id) return JSON.stringify({ ok: false, motivo: 'non mi hai detto su quale elemento' });

  // ── Guarda prima di agire ──
  //
  // Stessa regola di leggi_modulo → fill_form, e per la stessa ragione: senza
  // aver guardato, "E7" non significa niente e il modello lo starebbe
  // inventando come inventava i selettori.
  const g = ctx.session._paginaGuardata;
  const oraUrl = ctx.session.lastPage?.url || '';
  const stessaPagina = g && (!g.url || !oraUrl || g.url.split('?')[0] === oraUrl.split('?')[0]);
  if (!g || !stessaPagina) {
    return JSON.stringify({
      ok: false,
      motivo: g ? 'ho guardato un\'altra pagina: gli elementi sono altri' : 'non ho ancora guardato questa pagina',
      cosaFare: 'Chiama guarda_pagina, poi agisci su uno degli id che ti restituisce.',
    });
  }

  const verbo = { clicca: 'Premo', scrivi: 'Scrivo in', guarda: 'Guardo' }[cosa] || 'Agisco su';
  ctx.emitReasoning(`${verbo} ${id}${args.valore ? `: "${String(args.valore).slice(0, 40)}"` : ''}`, '🖱️');

  const d = await _ponte(ctx, 'agisci', { id, cosa, valore: args.valore });

  if (d.ok) {
    // Dopo un'azione la pagina non e' piu' quella di prima: gli id di prima
    // possono non valere. Lo si dice, invece di lasciarlo scoprire.
    if (cosa === 'clicca') {
      ctx.session._paginaGuardata = null;
      d.attenzione = 'La pagina puo\' essere cambiata: guarda di nuovo prima di agire ancora.';
    }
  } else {
    ctx.emitReasoning(d.motivo || 'non ce l\'ho fatta', '⚠️');
  }
  return JSON.stringify(d);
}

module.exports = { guarda_pagina: guardaPagina, agisci: agisciSuElemento };
