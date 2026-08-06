// modules/output/rivista.js — Il report come lo farebbe una rivista, non un
// foglio di calcolo travestito.
//
// PERCHÉ
//
// I file consegnati finora erano tabelle nude: nessuna gerarchia, nessun
// giudizio, prezzi in colonna e arrangiati. Chi li riceveva doveva farsi da
// solo il lavoro che aveva chiesto di far fare: capire COSA CONVIENE.
//
// Questo modulo produce un documento HTML impaginato — copertina, la
// raccomandazione in apertura con il perché, sezioni con le carte dei
// risultati, immagini quando ci sono, fonti in coda — che si legge come un
// dossier preparato da una persona, si apre in qualunque browser e si salva
// in PDF con Cmd+P (il foglio di stile di stampa è già pronto).
//
// LA REGOLA NON NEGOZIABILE
//
// La raccomandazione è OBBLIGATORIA. Un report senza un consiglio motivato è
// un elenco, e un elenco non è il lavoro: è la materia prima del lavoro.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STILE = `
  :root {
    --inchiostro: #1a1a2e; --carta: #fafaf8; --accento: #b8860b;
    --grigio: #6b7280; --linea: #e5e2da;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--carta); color: var(--inchiostro);
    font-family: Georgia, 'Times New Roman', serif; line-height: 1.65; }
  .pagina { max-width: 820px; margin: 0 auto; padding: 0 36px 60px; }

  header.copertina { padding: 72px 0 40px; border-bottom: 3px double var(--inchiostro);
    margin-bottom: 44px; position: relative; }
  /* Un filetto d'oro sopra il titolo: dà alla copertina un punto di partenza
     per l'occhio. Senza, la pagina comincia nel vuoto e sembra una bozza. */
  header.copertina::before { content: ''; display: block; width: 64px; height: 4px;
    background: var(--accento); margin-bottom: 26px; }
  .occhiello { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11px;
    letter-spacing: 3px; text-transform: uppercase; color: var(--accento); margin-bottom: 14px; }
  h1 { font-size: 42px; line-height: 1.12; font-weight: 700; margin-bottom: 18px;
    text-wrap: balance; hyphens: none; }
  .sottotitolo { font-size: 18px; color: var(--grigio); font-style: italic; max-width: 620px; }
  .data { font-family: Arial, sans-serif; font-size: 12px; color: var(--grigio); margin-top: 22px; }

  .raccomandazione { background: var(--inchiostro); color: var(--carta);
    padding: 34px 38px; margin: 0 0 48px; border-radius: 3px; }
  .raccomandazione .etichetta { font-family: Arial, sans-serif; font-size: 11px;
    letter-spacing: 3px; text-transform: uppercase; color: var(--accento); margin-bottom: 12px; }
  .raccomandazione .consiglio { font-size: 24px; line-height: 1.35; font-weight: 700;
    margin-bottom: 14px; text-wrap: balance; }
  .raccomandazione .perche { font-size: 15px; line-height: 1.7; opacity: .92; }

  section { margin-bottom: 46px; }
  h2 { font-size: 13px; font-family: Arial, sans-serif; letter-spacing: 2.5px;
    text-transform: uppercase; color: var(--accento); border-bottom: 1px solid var(--linea);
    padding-bottom: 8px; margin-bottom: 22px; }
  .commento { font-size: 16px; margin-bottom: 22px; max-width: 660px; }
  .commento:first-letter { font-size: 150%; font-weight: 700; }

  .carte { display: grid; grid-template-columns: repeat(auto-fill, minmax(248px, 1fr)); gap: 18px; align-items: stretch; }
  .carta { border: 1px solid var(--linea); background: #fff; border-radius: 3px;
    padding: 18px 20px; display: flex; flex-direction: column; gap: 6px; }
  /* Il prezzo va spinto in fondo: così su carte con testi di lunghezza diversa
     i prezzi restano allineati fra loro e si confrontano con un colpo d'occhio,
     invece di ballare a mezz'aria costringendo a rileggere ogni riquadro. */
  .carta .prezzo { margin-top: auto; }
  .carta.migliore { border: 2px solid var(--accento); position: relative; }
  .carta.migliore::before { content: 'CONSIGLIATO'; position: absolute; top: -9px; left: 14px;
    background: var(--accento); color: #fff; font-family: Arial, sans-serif; font-size: 9px;
    letter-spacing: 2px; padding: 2px 8px; border-radius: 2px; }
  .carta .nome { font-weight: 700; font-size: 16px; }
  .carta .dettaglio { font-family: Arial, sans-serif; font-size: 12.5px; color: var(--grigio); }
  .carta .prezzo { font-size: 24px; font-weight: 700; margin-top: 6px; }
  .carta .prezzo small { font-size: 12px; color: var(--grigio); font-weight: 400; }
  .carta .nota { font-size: 12.5px; font-style: italic; color: var(--grigio);
    border-top: 1px dashed var(--linea); padding-top: 8px; margin-top: 4px; }
  .carta a { color: var(--accento); font-family: Arial, sans-serif; font-size: 12px; }

  figure { margin: 22px 0; }
  figure img { width: 100%; border-radius: 3px; display: block; }
  figcaption { font-family: Arial, sans-serif; font-size: 11.5px; color: var(--grigio);
    margin-top: 8px; font-style: italic; }

  footer { border-top: 3px double var(--inchiostro); padding-top: 26px; margin-top: 20px; }
  footer h2 { border: none; }
  footer ol { padding-left: 20px; }
  footer li { font-family: Arial, sans-serif; font-size: 12.5px; color: var(--grigio); margin-bottom: 6px; }
  footer a { color: var(--accento); word-break: break-all; }
  .firma { margin-top: 28px; font-size: 12px; font-family: Arial, sans-serif; color: var(--grigio); }

  @media print {
    /* Margini di stampa veri: senza @page il browser mette i suoi, che tagliano
       il filetto della copertina e attaccano il testo al bordo del foglio. */
    @page { margin: 18mm 16mm; }
    body { background: #fff; font-size: 11.5pt; }
    .pagina { max-width: none; padding: 0; }
    .raccomandazione { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .carta.migliore::before { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    header.copertina::before { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    section { break-inside: avoid; }
    /* Un titolo di sezione in fondo alla pagina, con il contenuto sulla
       successiva, è il difetto tipografico che si nota per primo. */
    h2 { break-after: avoid; }
    .carta { break-inside: avoid; }
    figure { break-inside: avoid; }
    footer { break-before: auto; }
    a { text-decoration: none; }
  }
`;

/**
 * @param {object} spec
 * @param {string} spec.titolo
 * @param {string} spec.sottotitolo
 * @param {object} spec.raccomandazione  { consiglio, perche } — OBBLIGATORIA
 * @param {Array}  spec.sezioni  [{ titolo, commento, carte: [{nome, dettaglio, prezzo, valuta, nota, link, migliore}], immagine: {src, didascalia} }]
 * @param {Array}  spec.fonti    [{ url, title }]
 * @returns {{ ok: boolean, html?: string, errore?: string }}
 */
function componiRivista(spec = {}) {
  const r = spec.raccomandazione || {};
  if (!r.consiglio || String(r.consiglio).trim().length < 15) {
    return { ok: false, errore: 'Manca la raccomandazione: un report senza un consiglio motivato è un elenco, e un elenco non è il lavoro. Scrivi cosa consigli e perché.' };
  }
  if (!r.perche || String(r.perche).trim().length < 30) {
    return { ok: false, errore: 'La raccomandazione c\'è ma manca il perché: un consiglio senza motivo non si può né accettare né discutere.' };
  }
  const sezioni = Array.isArray(spec.sezioni) ? spec.sezioni : [];
  const carteTotali = sezioni.reduce((n, s) => n + (Array.isArray(s.carte) ? s.carte.length : 0), 0);
  if (carteTotali < 2) {
    return { ok: false, errore: 'Servono almeno due risultati concreti nelle sezioni: con meno di due opzioni non c\'è confronto, e senza confronto la raccomandazione non ha base.' };
  }
  const fonti = Array.isArray(spec.fonti) ? spec.fonti : [];
  if (fonti.length === 0) {
    return { ok: false, errore: 'Mancano le fonti: senza gli indirizzi letti il documento non è verificabile.' };
  }

  const htmlSezioni = sezioni.map(s => {
    const carte = (Array.isArray(s.carte) ? s.carte : []).map(c => `
      <div class="carta${c.migliore ? ' migliore' : ''}">
        <div class="nome">${esc(c.nome)}</div>
        ${c.dettaglio ? `<div class="dettaglio">${esc(c.dettaglio)}</div>` : ''}
        ${c.prezzo != null && c.prezzo !== '' ? `<div class="prezzo">${esc(c.prezzo)} <small>${esc(c.valuta || '€')}</small></div>` : ''}
        ${c.nota ? `<div class="nota">${esc(c.nota)}</div>` : ''}
        ${c.link ? `<a href="${esc(c.link)}">vai alla fonte ↗</a>` : ''}
      </div>`).join('');
    const img = s.immagine && s.immagine.src
      ? `<figure><img src="${esc(s.immagine.src)}" alt="${esc(s.immagine.didascalia || '')}" loading="lazy">
         ${s.immagine.didascalia ? `<figcaption>${esc(s.immagine.didascalia)}</figcaption>` : ''}</figure>`
      : '';
    return `<section>
      <h2>${esc(s.titolo || '')}</h2>
      ${s.commento ? `<p class="commento">${esc(s.commento)}</p>` : ''}
      ${img}
      ${carte ? `<div class="carte">${carte}</div>` : ''}
    </section>`;
  }).join('\n');

  const htmlFonti = fonti.map(f => {
    const url = typeof f === 'string' ? f : f.url;
    const titolo = typeof f === 'string' ? '' : (f.title || '');
    return `<li>${titolo ? esc(titolo) + ' — ' : ''}<a href="${esc(url)}">${esc(url)}</a></li>`;
  }).join('\n');

  const data = new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });

  const html = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.titolo || 'Report')}</title>
<style>${STILE}</style>
</head>
<body>
<div class="pagina">
  <header class="copertina">
    <div class="occhiello">Dossier riservato · preparato per Luca</div>
    <h1>${esc(spec.titolo || 'Report')}</h1>
    ${spec.sottotitolo ? `<p class="sottotitolo">${esc(spec.sottotitolo)}</p>` : ''}
    <div class="data">${esc(data)}</div>
  </header>

  <div class="raccomandazione">
    <div class="etichetta">La raccomandazione</div>
    <div class="consiglio">${esc(r.consiglio)}</div>
    <div class="perche">${esc(r.perche)}</div>
  </div>

  ${htmlSezioni}

  <footer>
    <h2>Fonti consultate</h2>
    <ol>${htmlFonti}</ol>
    <div class="firma">Documento preparato da COBRA · ogni dato proviene dalle pagine elencate sopra · per il PDF: stampa (Cmd+P) → Salva come PDF</div>
  </footer>
</div>
</body>
</html>`;

  return { ok: true, html };
}

module.exports = { componiRivista };
