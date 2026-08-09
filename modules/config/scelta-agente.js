// modules/config/scelta-agente.js — Cambiare interlocutore dicendolo.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHE' ESISTE
//
// Per cambiare agente bisognava aprire un menu. Una cosa che serve piu' volte
// al giorno — Brandon parla inglese, Jose spagnolo, e quando ci sono numeri
// da guardare serve l'analista — costava tre clic e un cambio di contesto.
//
// Adesso si dice: "parla in inglese", "passa all'analista", "torna a COBRA".
//
// ── PERCHE' NON LO DECIDE IL MODELLO ──
//
// La tentazione era darlo in mano al modello: capisce l'italiano, capirebbe
// anche questo. Ma cambiare voce e lingua e' una preferenza dell'UTENTE, non
// una mossa di lavoro, e le preferenze non si affidano a chi ogni tanto
// interpreta. Se Luca dice "parla in inglese" deve succedere sempre, non
// quasi sempre.
//
// E' la stessa ragione per cui il Cancello e la tassonomia sono codice: le
// cose che devono valere si scrivono, non si chiedono.
//
// ── COSA NON FA ──
//
// Non intercetta una frase qualsiasi che contiene "inglese". "traduci in
// inglese questa mail" e' un LAVORO, non un cambio di interlocutore, e deve
// arrivare intatto all'Esecutore. Perche' scatti servono un verbo di comando
// e un soggetto che sia l'agente — le due cose insieme.
// ══════════════════════════════════════════════════════════════════════

const { AGENTI, quello, predefinito } = require('./agenti');

/**
 * I verbi con cui una persona chiede di cambiare interlocutore.
 *
 * "parla", "passa a", "usa", "metti", "torna a". Non "traduci", non "scrivi":
 * quelli sono lavori.
 */
const CHIEDE_DI_CAMBIARE = /\b(parl[aiae]|passa|passiamo|usa|usiamo|metti|mettiamo|torna|torniamo|cambia|cambiamo|attiva|voglio)\b/i;

/** Come si nomina ogni agente, oltre al suo nome. */
const COME_LO_CHIAMI = [
  { lingua: 'en', dice: /\b(inglese|english|americano|americana|uk|en)\b/i },
  { lingua: 'es', dice: /\b(spagnolo|spagnola|espa(n|ñ)ol|castigliano|es)\b/i },
  { lingua: 'it', dice: /\b(italiano|italiana|it)\b/i },
];

/** Chi si riconosce dal mestiere invece che dalla lingua. */
const PER_MESTIERE = [
  { cerca: /\b(analista|analisi|numeri|dati freddi|rigoroso)\b/i, nome: 'ANALISTA' },
];

function _senzaAccenti(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Se questo messaggio chiede di cambiare agente, quale.
 *
 * @returns {{agente, come, frase}|null} null se non e' una richiesta di cambio
 */
function riconosci(messaggio) {
  const t = String(messaggio || '').trim();
  if (!t || t.length > 120) return null;   // una frase lunga e' un incarico
  const piatto = _senzaAccenti(t);

  // Il nome esatto vince su tutto: "COBRA ES" non lascia dubbi.
  //
  // Dal piu' LUNGO al piu' corto, e non e' un dettaglio: "COBRA" e' contenuto
  // dentro "COBRA ES", quindi in ordine naturale la richiesta di parlare
  // spagnolo faceva rispondere l'italiano. Il piu' specifico vince — e' la
  // stessa regola dei codici nella tassonomia.
  for (const a of [...AGENTI].sort((x, y) => y.nome.length - x.nome.length)) {
    const nome = _senzaAccenti(a.nome);
    if (new RegExp(`\\b${nome.replace(/\s+/g, '\\s+')}\\b`, 'i').test(piatto)) {
      return { agente: a, come: 'per nome', frase: t };
    }
  }

  // ── Il verbo deve stare all'INIZIO ──
  //
  // Non basta che ci sia da qualche parte. Trovato da un test:
  //
  //     "cerca documenti in inglese sulla dogana USA"  →  cambiava agente
  //
  // perche' fra i verbi c'era `usa`, e "USA" e' anche il paese. Una parola in
  // fondo alla frase non e' un comando: e' un complemento.
  //
  // Una preferenza si esprime come un ordine, e un ordine comincia col verbo:
  // "parla in inglese", "passa all'analista". Se il verbo non e' nelle prime
  // parole, quella frase e' un lavoro — e i lavori devono arrivare interi
  // all'Esecutore, non essere mangiati da un cambio di voce.
  const inizio = piatto.split(/\s+/).slice(0, 3).join(' ');
  if (!CHIEDE_DI_CAMBIARE.test(inizio)) return null;

  for (const m of PER_MESTIERE) {
    if (m.cerca.test(piatto)) {
      const a = AGENTI.find((x) => x.nome.includes(m.nome));
      if (a) return { agente: a, come: 'per mestiere', frase: t };
    }
  }

  for (const l of COME_LO_CHIAMI) {
    if (l.dice.test(piatto)) {
      const a = AGENTI.find((x) => x.lingua === l.lingua);
      if (a) return { agente: a, come: 'per lingua', frase: t };
    }
  }

  // "torna come prima", "torna normale": si torna al predefinito.
  if (/\b(torna|torniamo)\b/i.test(piatto) && /\b(normale|come prima|solito|predefinito|italiano)\b/i.test(piatto)) {
    return { agente: predefinito(), come: 'ritorno', frase: t };
  }

  return null;
}

/** Come lo si conferma a Luca. Una riga, nella lingua nuova. */
function conferma(agente) {
  const saluti = {
    it: `Sono ${agente.nome}. ${agente.carattere}`,
    en: `${agente.nome} here. From now on I answer in English.`,
    es: `Soy ${agente.nome}. A partir de ahora respondo en español.`,
  };
  return saluti[agente.lingua] || saluti.it;
}

module.exports = { riconosci, conferma, CHIEDE_DI_CAMBIARE };
