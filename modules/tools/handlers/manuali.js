// modules/tools/handlers/manuali.js — Chiedere un manuale quando serve.

const manuali = require('../../prompts/manuali');

/**
 * Il testo completo di un manuale, chiesto per nome.
 *
 * Nel prompt sta solo l'indice: poche righe che dicono quali manuali
 * esistono. Chi ha bisogno del testo intero se lo fa dare, invece di
 * portarselo dietro sempre — anche quando non serve.
 */
async function leggiManuale(args, ctx) {
  const nome = String(args.nome || '').trim().toLowerCase();
  const testo = manuali.manuale(nome);
  if (!testo) {
    return JSON.stringify({
      error: `Non c'è nessun manuale che si chiami "${nome}".`,
      disponibili: manuali.elenco().map(m => m.nome),
    });
  }
  ctx.emitReasoning(`Apro il manuale: ${nome}`, '📖');
  return JSON.stringify({ ok: true, manuale: nome, testo });
}

module.exports = { leggi_manuale: leggiManuale };
