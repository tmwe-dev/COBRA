// modules/security/spiegazioni.js — Dire in italiano cosa sta per succedere.
//
// IL PROBLEMA CHE RISOLVE
//
// Il 6 agosto 2026 Luca si è visto comparire questo, con due bottoni:
//
//   ⚠ DESTRUCTIVE — annota
//   [DESTRUCTIVE] annota
//   { "nome": "Essebi Packaging", "campi": "{\"citta\":\"Castiglione del
//     Lago\",\"email\":\"info@essebipackaging.com\"}", "fonte": "..." }
//   [Approva] [Rifiuta]
//
// Tre cose sbagliate insieme: la parola "DESTRUCTIVE" per un appunto, il JSON
// grezzo al posto di una frase, e nessuna spiegazione del perché lo si stesse
// chiedendo. Chi legge non può decidere: può solo premere a caso.
//
// Qui si traduce: cosa fa lo strumento, su cosa, e perché serve un permesso.

const COSA_FA = {
  annota: 'prendere un appunto sul lavoro in corso',
  stato_lavoro: 'rileggere gli appunti presi finora',
  scrivi_raccolta: 'scrivere il file con quello che ha raccolto',
  leggi_modulo: 'guardare com\'è fatto un modulo prima di compilarlo',
  leggi_manuale: 'rileggere le proprie istruzioni',
  create_file: 'creare un file',
  crea_report: 'preparare il report impaginato',
  fill_form: 'compilare i campi di un modulo',
  click_element: 'premere un pulsante sulla pagina',
  navigate: 'aprire una pagina',
  send_email: 'INVIARE UNA EMAIL',
  save_to_kb: 'salvare una informazione in archivio',
  kb_delete: 'CANCELLARE una informazione dall\'archivio',
  execute_js: 'eseguire del codice dentro la pagina',
};

const PERCHE = {
  send: 'Manda qualcosa fuori da questo computer, a una persona vera: una volta '
      + 'partito non si richiama.',
  destructive: 'Cancella o sovrascrive qualcosa che poi non si recupera.',
  write: 'Scrive sul tuo computer.',
  sconosciuto: 'Questo strumento non è ancora stato classificato, quindi non so '
      + 'cosa faccia di preciso. Nel dubbio chiedo — e sarebbe da sistemare: '
      + 'uno strumento senza classificazione è una svista, non una minaccia.',
};

/** Le cose importanti degli argomenti, in una riga leggibile. */
function inBreve(argomenti = {}) {
  const pezzi = [];
  for (const [k, v] of Object.entries(argomenti || {})) {
    let valore = v;
    if (typeof valore === 'string' && /^\s*[{[]/.test(valore)) {
      try { valore = JSON.parse(valore); } catch (_) { /* resta testo */ }
    }
    if (valore && typeof valore === 'object') {
      valore = Object.entries(valore).map(([a, b]) => `${a}: ${b}`).join(', ');
    }
    const testo = String(valore == null ? '' : valore).trim();
    if (!testo) continue;
    pezzi.push(`${k}: ${testo.length > 90 ? testo.slice(0, 90) + '…' : testo}`);
  }
  return pezzi.join(' · ');
}

/**
 * L'avviso da mostrare, in italiano.
 * @returns {{titolo:string, cosa:string, dettaglio:string, perche:string}}
 */
function spiega(strumento, argomenti = {}, rischio = 'sconosciuto') {
  const cosa = COSA_FA[strumento] || `usare lo strumento "${strumento}"`;
  return {
    titolo: `COBRA vuole ${cosa}`,
    cosa,
    dettaglio: inBreve(argomenti),
    perche: PERCHE[rischio] || PERCHE.sconosciuto,
    strumento,
    rischio,
  };
}

module.exports = { spiega, inBreve, COSA_FA, PERCHE };
