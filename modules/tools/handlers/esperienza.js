// modules/tools/handlers/esperienza.js — Ricordarsi dei siti, e delle
// procedure che si sono imparate.
//
// Sono la stessa cosa vista da due lati: quello che si sa di un POSTO
// (memoria dei siti) e quello che si sa di un LAVORO (le procedure). Stanno
// nello stesso file perche' vengono richiamati insieme — prima di lavorare su
// un sito si guarda tutti e due.

function _memoria(ctx) {
  if (!ctx._memoriaSiti) {
    const { MemoriaSiti } = require('../../memory/siti');
    ctx._memoriaSiti = new MemoriaSiti(ctx.dataDir);
  }
  return ctx._memoriaSiti;
}

function _procedure(ctx) {
  if (!ctx._procedure) {
    const { Procedure } = require('../../memory/procedure');
    ctx._procedure = new Procedure(ctx.dataDir);
  }
  return ctx._procedure;
}

// ── I SITI ──

async function cosaSoDelSito(args, ctx) {
  const url = String(args.url || args.sito || ctx.session.lastPage?.url || '').trim();
  if (!url) return JSON.stringify({ ok: false, motivo: 'non mi hai detto quale sito' });
  const s = _memoria(ctx).cosaSoDi(url);
  if (!s.conosciuto) {
    return JSON.stringify({ ok: true, conosciuto: false, dominio: s.dominio,
      nota: 'Non ci sono mai stato: guarda la pagina e poi annota cosa hai imparato.' });
  }
  return JSON.stringify({ ok: true, ...s });
}

async function annotaSulSito(args, ctx) {
  const url = String(args.url || args.sito || ctx.session.lastPage?.url || '').trim();
  const cosa = String(args.cosa || '').trim();
  if (!url || !cosa) return JSON.stringify({ ok: false, motivo: 'servono il sito e cosa hai visto' });

  // Il caso che vale piu' degli altri: A non ha funzionato, B si'. Quella
  // coppia trasforma un errore in un vantaggio permanente — al prossimo giro
  // su questo sito, B si prova per prima.
  if (args.invece_di) {
    const r = _memoria(ctx).imparaDalFallimento(url, {
      fallito: String(args.invece_di), riuscito: cosa, perche: String(args.perche || ''),
    });
    ctx.emitReasoning(`Su ${r.dominio} me lo ricordo: "${String(args.invece_di).slice(0, 40)}" non va, "${cosa.slice(0, 40)}" si'`, '🧠');
    return JSON.stringify(r);
  }

  const r = _memoria(ctx).annota(url, {
    cosa, tipo: String(args.tipo || 'osservazione'),
    esito: args.funziona === undefined ? null : !!args.funziona,
    dettaglio: String(args.perche || ''),
  });
  if (r.ok) ctx.emitReasoning(`Me lo segno su ${r.dominio}: ${cosa.slice(0, 50)}`, '🧠');
  return JSON.stringify(r);
}

// ── LE PROCEDURE ──

async function imparaProcedura(args, ctx) {
  const nome = String(args.nome || '').trim();
  let passi = args.passi;
  if (typeof passi === 'string') { try { passi = JSON.parse(passi); } catch { passi = null; } }
  if (!nome || !Array.isArray(passi) || !passi.length) {
    return JSON.stringify({ ok: false,
      motivo: 'servono un nome e i passi',
      cosaFare: 'passi = [{"cosa":"scrivi la citta di partenza","dove":"origine","valore":"{{partenza}}"}]. '
        + 'Usa {{nome}} per i valori che cambiano ogni volta, e descrivi i campi per SIGNIFICATO '
        + '("origine", "peso"), mai per selettore CSS: un selettore si rompe al primo cambio di pagina.' });
  }
  const r = _procedure(ctx).registra(nome, {
    quando: String(args.quando || ''), sito: String(args.sito || ''), passi,
  });
  if (r.ok) ctx.emitReasoning(`Imparata la procedura "${nome}" (${r.passi} passi)`, '📖');
  return JSON.stringify(r);
}

async function usaProcedura(args, ctx) {
  const nome = String(args.nome || '').trim();
  let valori = args.valori;
  if (typeof valori === 'string') { try { valori = JSON.parse(valori); } catch { valori = {}; } }
  const r = _procedure(ctx).preparaPer(nome, valori || {});
  if (r.ok) ctx.emitReasoning(`Seguo la procedura "${r.nome}"`, '📖');
  return JSON.stringify(r);
}

async function elencoProcedure(args, ctx) {
  return JSON.stringify({ ok: true, procedure: _procedure(ctx).elenco() });
}

module.exports = {
  cosa_so_del_sito: cosaSoDelSito,
  annota_sul_sito: annotaSulSito,
  impara_procedura: imparaProcedura,
  usa_procedura: usaProcedura,
  elenco_procedure: elencoProcedure,
};
