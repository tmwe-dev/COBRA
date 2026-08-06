// modules/tools/handlers/data.js — KB, files, memory, tasks, batch_scrape, local files
// Source: server.js lines 6148-6371

const path = require('path');
const fs = require('fs');
const { assertSSRFSafe } = require('../../security/ssrf');
const { creaXlsx, righeDaTesto } = require('../../utils/xlsx');
const { importiSenzaFonte, blocchiDuplicati, fontiDelTurno, valoreImporto, numeriDi } = require('../../security/verifica-dati');
const { componiDocumento, verificaFormato, TITOLO_REPORT, TITOLO_FONTI } = require('../../output/consegna');
const { componiRivista } = require('../../output/rivista');

async function saveToKb(args, ctx) {
  ctx.emitThinking('Salvo nel KB...');
  const ok = await ctx.saveToKB(args.domain, args.type, args.name, args.content, args.tags);
  return JSON.stringify({ ok, message: ok ? 'Salvato nel KB' : 'Errore salvataggio KB' });
}
async function searchKb(args, ctx) {
  ctx.emitThinking('Cerco nel KB...');
  const results = await ctx.searchKB(args.query, args.domain);
  return JSON.stringify({ ok: true, results, count: results.length });
}
async function kbUpdate(args, ctx) {
  ctx.emitThinking('Aggiorno KB...');
  const ok = await ctx.updateKB(args.title, args.content, args.category, args.domain, args.tags);
  return JSON.stringify({ ok, message: ok ? 'KB aggiornato' : 'Errore aggiornamento' });
}
async function kbDelete(args, ctx) {
  const ok = await ctx.deleteKB(args.title);
  return JSON.stringify({ ok, message: ok ? 'Entry disattivata' : 'Errore' });
}

async function createFile(args, ctx) {
  ctx.emitThinking(`Creo file ${args.filename}...`);
  const _base = path.resolve(ctx.dataDir, 'files');
  const filePath = path.resolve(_base, args.filename);
  if (!filePath.startsWith(_base + path.sep) && filePath !== _base) return JSON.stringify({ error: 'Path traversal bloccato' });
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // ── I dati del file devono venire dalle pagine lette ──
  // Vale solo quando in questo turno qualcosa è stato letto davvero: se il file
  // nasce da un dettato dell'utente non c'è nulla da confrontare.
  const fonti = fontiDelTurno(ctx.session);
  if (fonti.length > 500) {
    const { totale, mancanti } = importiSenzaFonte(args.content || '', fonti);
    if (mancanti.length > 0 && mancanti.length >= Math.ceil(totale * 0.25)) {
      ctx.log(`[Verifica] create_file rifiutato: ${mancanti.length}/${totale} importi non risultano in nessuna pagina letta`);
      return JSON.stringify({
        error: 'SCRITTURA RIFIUTATA: questi importi non compaiono in nessuna pagina che hai letto in questo turno: '
          + mancanti.slice(0, 8).join(', ')
          + '. Rileggi la pagina della fonte e riporta le cifre esatte, oppure togli dal report le voci che non hai potuto verificare, '
          + 'scrivendo apertamente che il dato non era disponibile. Non stimare.',
      });
    }
  }

  const estensione = (args.filename || '').split('.').pop().toLowerCase();
  if (estensione === 'xlsx') {
    // Un .xlsx non è testo: scriverci dentro un CSV produce un file che Excel
    // rifiuta di aprire. Si costruisce l'archivio vero.
    const righe = righeDaTesto(args.content || '');
    if (righe.length === 0) return JSON.stringify({ error: 'Contenuto vuoto o non tabellare: per un Excel servono righe (CSV, JSON o tabella markdown)' });

    // Un foglio con la sola riga di intestazione non è un report: è la sua
    // promessa. È successo con la vacanza a Bora Bora — "Voli | Hotel |
    // Escursioni | Prezzi | Link" e sotto il vuoto — e l'utente si è ritrovato
    // un file scaricabile che non conteneva niente.
    const conDati = righe.filter(r => r.join('').trim().length > 0).length;
    if (conDati <= 1) {
      return JSON.stringify({
        error: 'SCRITTURA RIFIUTATA: c\'è solo la riga di intestazione e nessun dato sotto. '
          + 'Un file vuoto non aiuta: prima raccogli i dati aprendo le pagine, poi scrivi il file. '
          + 'Se non sei riuscito a raccoglierli, dillo apertamente invece di consegnare un foglio vuoto.',
      });
    }

    // Un blocco di righe ripetuto identico sotto un'altra intestazione significa
    // che i risultati di una ricerca sono stati attribuiti anche a un'altra.
    const doppi = blocchiDuplicati(righe);
    if (doppi.length > 0) {
      const d = doppi[0];
      ctx.log(`[Verifica] create_file rifiutato: righe ${d.prima}-${d.prima + d.righe - 1} identiche a ${d.seconda}-${d.seconda + d.righe - 1}`);
      return JSON.stringify({
        error: `SCRITTURA RIFIUTATA: le righe ${d.prima}-${d.prima + d.righe - 1} sono identiche alle righe `
          + `${d.seconda}-${d.seconda + d.righe - 1}. Due ricerche diverse non danno gli stessi identici risultati: `
          + 'hai copiato il blocco di una tratta sotto l\'intestazione di un\'altra. Rileggi la pagina della tratta '
          + 'sbagliata e riporta i suoi dati veri; se per quella tratta non hai letto nulla, scrivilo invece di riempirla.',
      });
    }
    // ── Lo standard di consegna si applica qui, non si spera ──
    // Il modello scriveva "**Volo**" e "€ 1.698" come testo: asterischi a
    // vista e prezzi non sommabili. Non è una questione di gusto — un foglio
    // così non si usa. Se il documento non porta già intestazione e fonti,
    // gliele si mette: le fonti sono le pagine che ha davvero aperto.
    let righeFinali = righe;
    const giaConforme = verificaFormato(righe).conforme;
    if (!giaConforme) {
      const fonti = [];
      const cache = ctx.session._cachePagine;
      if (cache && typeof cache.forEach === 'function') {
        cache.forEach(v => fonti.push({ url: v.url, title: v.title }));
      }
      for (const p of (ctx.session.pagineDelTurno || [])) {
        if (!fonti.some(f => f.url === (p.url || p))) fonti.push({ url: p.url || p, title: p.title || '' });
      }
      righeFinali = componiDocumento({
        titolo: args.titolo || args.sheet || args.filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '),
        righe, fonti,
      });
      ctx.log(`[Consegna] Documento riformattato secondo lo standard (${fonti.length} fonti in calce)`);
    }

    try {
      fs.writeFileSync(filePath, creaXlsx(righeFinali, args.sheet || 'Report'));
      ctx.wsBroadcast({ type: 'file_created', filename: args.filename });
      // La pagina sa disegnare una tabella vera se le arriva {headers, rows}.
      // Finora riceveva le righe incollate con delle barre verticali, cioe' un
      // foglio di calcolo mostrato come se fosse un blocco di testo.
      if (!Array.isArray(ctx.session.fileDelTurno)) ctx.session.fileDelTurno = [];
      ctx.session.fileDelTurno.push({ filename: args.filename });
      ctx.session.righeUltimoFile = righeFinali;
      ctx.broadcastFile({
        filename: args.filename,
        size: fs.statSync(filePath).size,
        table: { headers: righeFinali[0] || [], rows: righeFinali.slice(1, 200) },
        text: righeFinali.slice(0, 30).map(r => r.join(' | ')).join('\n'),
      });
      return JSON.stringify({ ok: true, filename: args.filename, righe: righeFinali.length, colonne: (righeFinali[0] || []).length, formato: 'standard di consegna applicato' });
    } catch (e) {
      return JSON.stringify({ error: `Creazione del file Excel fallita: ${e.message}` });
    }
  }

  // ── Un .pdf che è testo non è un pdf: è un file che non si apre ──
  //
  // Qui sotto si scrive il contenuto grezzo con qualunque estensione. Con
  // filename "report.pdf" ne usciva un file che nessun lettore PDF apre —
  // e, peggio, il criterio file_atteso lo accettava, perché guarda solo il
  // suffisso del nome. Il sistema si dichiarava soddisfatto consegnando a
  // Luca una cosa rotta: è il fallimento peggiore, perché non si vede.
  //
  // I formati che hanno una struttura vera si producono in altro modo o non
  // si producono affatto. Meglio dirlo, e dire cosa fare.
  const estFile = String(args.filename || '').split('.').pop().toLowerCase();
  const FORMATI_STRUTTURATI = {
    pdf: 'Il PDF non si scrive come testo. Produci il report con crea_report (esce impaginato in .html) '
       + 'e dillo a Luca: si apre nel browser e con Stampa → Salva come PDF diventa un PDF vero.',
    docx: 'Il .docx non si scrive come testo. Usa crea_report per il documento impaginato in .html, '
        + 'oppure create_file con estensione .xlsx se servono tabelle.',
    doc: 'Il .doc non si scrive come testo. Usa crea_report (.html) oppure .xlsx per le tabelle.',
    pptx: 'Il .pptx non si scrive come testo. Usa crea_report (.html) per un documento presentabile.',
  };
  if (FORMATI_STRUTTURATI[estFile]) {
    ctx.log(`[create_file] Rifiutato .${estFile}: sarebbe un file che non si apre`);
    return JSON.stringify({ error: `Non posso produrre un .${estFile} scrivendolo come testo: `
      + `uscirebbe un file che non si apre. ${FORMATI_STRUTTURATI[estFile]}` });
  }

  fs.writeFileSync(filePath, args.content || '');
  if (!Array.isArray(ctx.session.fileDelTurno)) ctx.session.fileDelTurno = [];
  ctx.session.fileDelTurno.push({ filename: args.filename });
  ctx.wsBroadcast({ type: 'file_created', filename: args.filename });
  const ext = (args.filename || '').split('.').pop().toLowerCase();
  if (['txt','md','json','csv','html','xml','js','css'].includes(ext)) {
    const anteprima = { filename: args.filename, size: Buffer.byteLength(args.content || ''),
      text: (args.content || '').substring(0, 10000), markdown: ext === 'md' };
    // Un csv e' una tabella: si mostra come tale, non come righe di testo.
    if (['csv','tsv'].includes(ext)) {
      try {
        const righe = righeDaTesto(args.content || '');
        if (righe.length > 1) anteprima.table = { headers: righe[0], rows: righe.slice(1, 200) };
      } catch (_) { /* se non si lascia leggere come tabella, resta il testo */ }
    }
    ctx.broadcastFile(anteprima);
  } else if (['png','jpg','jpeg','gif','svg'].includes(ext)) {
    try { const b64 = fs.readFileSync(filePath, 'base64'); ctx.broadcastFile({ filename: args.filename, size: fs.statSync(filePath).size, image: `data:image/${ext};base64,${b64}` }); } catch (_) { /* best-effort */ }
  }
  return JSON.stringify({ ok: true, filename: args.filename, path: filePath });
}

async function saveMemory(args, ctx) {
  ctx.emitThinking('Salvo nella memoria...');
  const memory = { id: Date.now(), title: args.title, content: args.content, tags: args.tags, ts: new Date().toISOString() };
  ctx.memories.push(memory);
  ctx.persistMemories();
  await ctx.saveToKB('memories', 'data', args.title, args.content, args.tags);
  return JSON.stringify({ ok: true, id: memory.id });
}

async function createTask(args, ctx) {
  ctx.emitThinking(`Creo job: ${args.name}...`);
  let steps; try { steps = JSON.parse(args.steps); } catch { steps = [{ description: args.steps }]; }
  const task = { id: Date.now(), name: args.name, description: args.description || '', steps, tags: args.tags || '', output_type: args.output_type || 'summary', status: 'saved', runs: 0, lastRun: null, createdAt: new Date().toISOString() };
  ctx.tasks.push(task);
  ctx.persistTasks();
  ctx.wsBroadcast({ type: 'task_created', taskId: task.id, name: task.name, steps: steps.length });
  return JSON.stringify({ ok: true, taskId: task.id, name: task.name, steps: steps.length, message: `Job "${task.name}" salvato con ${steps.length} step.` });
}

async function runTask(args, ctx) {
  let task = null;
  if (args.task_id) task = ctx.tasks.find(t => t.id === args.task_id);
  else if (args.task_name) { const q = args.task_name.toLowerCase(); task = ctx.tasks.find(t => t.name.toLowerCase().includes(q)); }
  if (!task) return JSON.stringify({ error: 'Job non trovato. Usa list_tasks.' });
  ctx.emitThinking(`Eseguo job: ${task.name}...`);
  ctx.emitReasoning(`Avvio job "${task.name}" (${task.steps.length} step)`, '🚀');
  ctx.wsBroadcast({ type: 'job_started', taskId: task.id, name: task.name });
  const results = [];
  for (let i = 0; i < task.steps.length; i++) {
    const step = task.steps[i], desc = step.description || step.tool || `Step ${i+1}`;
    ctx.emitReasoning(`Step ${i+1}/${task.steps.length}: ${desc}`, '⚙️');
    if (step.tool && ctx.executeTool) {
      try { const r = await ctx.executeTool(step.tool, step.args || {}); results.push({ step: i+1, tool: step.tool, ok: true, result: typeof r === 'string' ? r.substring(0, 500) : r }); }
      catch (e) { results.push({ step: i+1, tool: step.tool, ok: false, error: e.message }); ctx.emitReasoning(`Step ${i+1} fallito: ${e.message}`, '❌'); }
    } else { results.push({ step: i+1, description: desc, ok: true, note: 'Step descrittivo' }); }
  }
  task.runs = (task.runs || 0) + 1; task.lastRun = new Date().toISOString(); task.status = 'completed'; ctx.persistTasks();
  ctx.wsBroadcast({ type: 'job_completed', taskId: task.id, name: task.name });
  return JSON.stringify({ ok: true, taskId: task.id, name: task.name, runs: task.runs, results });
}

async function deleteTask(args, ctx) {
  const idx = ctx.tasks.findIndex(t => t.id === args.task_id);
  if (idx === -1) return JSON.stringify({ error: 'Job non trovato' });
  const removed = ctx.tasks.splice(idx, 1)[0]; ctx.persistTasks();
  return JSON.stringify({ ok: true, message: `Job "${removed.name}" eliminato` });
}

async function listTasks(args, ctx) {
  return JSON.stringify({ ok: true, tasks: ctx.tasks.map(t => ({ id: t.id, name: t.name, description: t.description || '', steps: t.steps.length, tags: t.tags || '', status: t.status, runs: t.runs || 0, lastRun: t.lastRun, createdAt: t.createdAt })), count: ctx.tasks.length });
}

async function batchScrape(args, ctx) {
  ctx.emitThinking('Batch scraping...');
  let urls; try { urls = JSON.parse(args.urls); } catch { return JSON.stringify({ error: 'JSON array non valido' }); }
  const results = await Promise.allSettled(urls.slice(0, 10).map(async url => {
    const check = await assertSSRFSafe(url);
    if (!check.safe) throw new Error(`URL bloccato: ${check.reason}`);
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) throw new Error('Redirect senza destinazione');
      const target = new URL(loc, url).href;
      const rc = await assertSSRFSafe(target);
      if (!rc.safe) throw new Error(`Redirect bloccato: ${rc.reason}`);
      const r2 = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const h2 = await r2.text();
      return { url: target, text: h2.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 3000) };
    }
    const html = await resp.text();
    return { url, text: html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 3000) };
  }));
  // Anche qui la lettura è grezza, senza browser: sui siti che si disegnano
  // con javascript arriva il guscio. Un guscio spacciato per risultato è il
  // modo in cui nascono le "pagine bianche": lo si dichiara per quello che è,
  // e si indica la strada giusta per quegli indirizzi. Il browser è uno solo,
  // quindi i gusci si riaprono con navigate() uno per volta.
  const riusciti = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const pieni = riusciti.filter(r => (r.text || '').length >= 800);
  const gusci = riusciti.filter(r => (r.text || '').length < 800).map(r => r.url);
  if (ctx.registroFonti) {
    for (const r of riusciti) { try { ctx.registroFonti.registra(r.url, { caratteri: (r.text || '').length }); } catch (_) { /* best-effort */ } }
  }
  const esito = { ok: true, results: pieni, count: pieni.length };
  if (gusci.length) {
    esito.pagineDaAprireNelBrowser = gusci;
    esito.avviso = `${gusci.length} pagine sono arrivate vuote: si caricano con javascript. `
      + 'NON considerarle senza dati — aprile una per una con navigate(), che usa il browser vero.';
    ctx.log(`[batch_scrape] ${pieni.length} piene, ${gusci.length} gusci rimandati al browser`);
  }
  return JSON.stringify(esito);
}

// Local file tools (sandboxed in data/files/)
function _filesBase(ctx) { return path.resolve(ctx.dataDir, 'files'); }

async function listLocalFiles(args, ctx) {
  const base = _filesBase(ctx), bp = path.resolve(base, args.path || '');
  if (!bp.startsWith(base)) return JSON.stringify({ error: 'Path traversal bloccato' });
  if (!fs.existsSync(bp)) return JSON.stringify({ ok: true, files: [], message: 'Cartella non trovata' });
  const files = fs.readdirSync(bp).filter(f => !args.pattern || f.includes(args.pattern));
  return JSON.stringify({ ok: true, files, count: files.length });
}

async function readLocalFile(args, ctx) {
  const base = _filesBase(ctx), fp = path.resolve(base, args.path);
  if (!fp.startsWith(base + path.sep)) return JSON.stringify({ error: 'Path traversal bloccato' });
  if (!fs.existsSync(fp)) return JSON.stringify({ error: 'File non trovato: ' + args.path });
  const content = fs.readFileSync(fp, 'utf8');
  const ext = (args.path || '').split('.').pop().toLowerCase();
  ctx.broadcastFile({ filename: path.basename(args.path), size: fs.statSync(fp).size, text: content.substring(0, 10000), markdown: ext === 'md' });
  return JSON.stringify({ ok: true, content: content.substring(0, 10000), path: args.path });
}

async function saveLocalFile(args, ctx) {
  const base = _filesBase(ctx), fp = path.resolve(base, args.path);
  if (!fp.startsWith(base + path.sep)) return JSON.stringify({ error: 'Path traversal bloccato' });
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, args.content || '');
  const ext = (args.path || '').split('.').pop().toLowerCase();
  if (['txt','md','json','csv','html','xml','js','css'].includes(ext)) ctx.broadcastFile({ filename: path.basename(args.path), size: Buffer.byteLength(args.content || ''), text: (args.content || '').substring(0, 10000), markdown: ext === 'md' });
  return JSON.stringify({ ok: true, path: args.path });
}

async function searchLocalFiles(args, ctx) {
  const base = _filesBase(ctx);
  if (!fs.existsSync(base)) return JSON.stringify({ ok: true, results: [] });
  const results = [];
  const search = (dir) => { for (const f of fs.readdirSync(dir)) { const fp = path.join(dir, f), stat = fs.statSync(fp); if (stat.isDirectory()) { search(fp); continue; } if (f.toLowerCase().includes(args.query.toLowerCase())) { results.push({ path: path.relative(base, fp), name: f, size: stat.size }); } else if (args.content_search && stat.size < 100000) { try { if (fs.readFileSync(fp, 'utf8').toLowerCase().includes(args.query.toLowerCase())) results.push({ path: path.relative(base, fp), name: f, size: stat.size }); } catch (_) { /* best-effort */ } } } };
  search(base);
  return JSON.stringify({ ok: true, results: results.slice(0, 20), count: results.length });
}

// Il report impaginato: copertina, raccomandazione obbligatoria con il
// perché, sezioni a carte, immagini quando ci sono, fonti in coda. Si apre
// nel browser e si salva in PDF con la stampa. Un elenco senza consiglio
// viene rifiutato qui, dal codice.
async function creaReport(args, ctx) {
  ctx.emitThinking('Impagino il report...');
  let spec = {};
  try { spec = typeof args.spec === 'string' ? JSON.parse(args.spec) : (args.spec || args); }
  catch (e) { return JSON.stringify({ error: 'La specifica del report non e\' JSON valido: ' + e.message }); }

  // Le fonti non le dichiara il modello: sono le pagine davvero aperte
  const fonti = [];
  const cache = ctx.session._cachePagine;
  if (cache && typeof cache.forEach === 'function') cache.forEach(v => fonti.push({ url: v.url, title: v.title }));
  for (const p of (ctx.session.pagineDelTurno || [])) {
    if (!fonti.some(x => x.url === (p.url || p))) fonti.push({ url: p.url || p, title: p.title || '' });
  }
  spec.fonti = fonti;

  // ── Il percorso raccomandato deve essere il più controllato, non il meno ──
  //
  // crea_report importava importiSenzaFonte e blocchiDuplicati e non li
  // chiamava: i controlli giravano solo su create_file, e per giunta solo nel
  // ramo .xlsx. Ma il sistema stesso indirizza qui — il prompt del Collega
  // dice che per ricerche e confronti "l'estensione giusta è html", e ogni
  // formato non producibile viene convertito in html.
  //
  // Quindi il documento che Luca riceve più spesso era l'unico a uscire senza
  // verifica, mentre in fondo alla pagina rivista.js firma "ogni dato proviene
  // dalle pagine elencate sopra". Firmare ciò che nessuno ha controllato è
  // peggio che non firmarlo.
  //
  // Qui si guardano i CAMPI, non il testo: nel report il prezzo è un campo
  // suo, e quasi mai porta il simbolo della valuta attaccato. Cercandolo con
  // la regola degli importi — che il simbolo lo pretende — un prezzo su due
  // sarebbe risultato inesistente e quindi non verificabile: il controllo si
  // sarebbe spento da solo proprio dove serve.
  const testoFonti = fontiDelTurno(ctx.session);
  const carte = (spec.sezioni || []).flatMap(sez => (sez.carte || []).map(c => ({ ...c, sezione: sez.titolo })));

  if (testoFonti.trim().length > 0) {
    const numeriLetti = numeriDi(testoFonti);
    const inventati = [];
    for (const c of carte) {
      const v = valoreImporto(c.prezzo);
      if (v === null || v < 100) continue;   // sotto i 100 la coincidenza è la regola
      let trovato = false;
      for (const f of numeriLetti) {
        if (f === v || Math.abs(f - v) / v < 0.01) { trovato = true; break; }
      }
      if (!trovato) inventati.push(`${c.nome || 'una voce'}: ${c.prezzo}`);
    }
    if (inventati.length > 0) {
      ctx.log(`[Report] rifiutato: ${inventati.length} prezzi non stanno in nessuna pagina letta`);
      return JSON.stringify({ error: 'REPORT RIFIUTATO: questi prezzi non compaiono in nessuna delle pagine aperte: '
        + inventati.join('; ') + '. Un numero senza fonte non si consegna: rileggi la pagina e riporta il valore '
        + 'che c\'è scritto, oppure togli la voce e dillo.' });
    }
  }

  // Due sezioni con le stesse identiche voci sono la ricerca fatta una volta
  // sola e ricopiata sotto l'altro titolo. È già successo: i prezzi di
  // Barcellona, veri, comparsi sotto l'intestazione Milano.
  const perSezione = new Map();
  for (const c of carte) {
    const firma = `${String(c.nome || '').trim().toLowerCase()}¦${c.prezzo}`;
    if (!perSezione.has(c.sezione)) perSezione.set(c.sezione, []);
    perSezione.get(c.sezione).push(firma);
  }
  const sezioni = [...perSezione.entries()].filter(([, v]) => v.length >= 2);
  for (let a = 0; a < sezioni.length; a++) {
    for (let b = a + 1; b < sezioni.length; b++) {
      if (sezioni[a][1].join('|') === sezioni[b][1][0] + (sezioni[b][1].length > 1 ? '|' + sezioni[b][1].slice(1).join('|') : '')) {
        ctx.log(`[Report] rifiutato: "${sezioni[a][0]}" e "${sezioni[b][0]}" hanno le stesse identiche voci`);
        return JSON.stringify({ error: `REPORT RIFIUTATO: le voci di "${sezioni[a][0]}" e "${sezioni[b][0]}" sono identiche, `
          + 'prezzo per prezzo. Una delle due ricerche non è stata fatta: falla, invece di ricopiare l\'altra.' });
      }
    }
  }

  const esito = componiRivista(spec);
  if (!esito.ok) {
    ctx.log('[Report] rifiutato: ' + esito.errore);
    return JSON.stringify({ error: 'REPORT RIFIUTATO: ' + esito.errore });
  }

  const nome = (args.filename || 'report').replace(/[^\w.-]/g, '_').replace(/\.html?$/i, '') + '.html';
  const base = path.resolve(ctx.dataDir, 'files');
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.resolve(base, nome), esito.html);
  if (!Array.isArray(ctx.session.fileDelTurno)) ctx.session.fileDelTurno = [];
  ctx.session.fileDelTurno.push({ filename: nome });

  // ── Il criterio "formato_consegna" deve giudicare IL DOCUMENTO ──
  //
  // Bug trovato il 6 agosto, ed è quello che ha fatto fallire Tokyo. Il
  // criterio veniva valutato su "righeUltimoFile", che scriveva SOLO il ramo
  // xlsx di create_file: per un report .html restava vuoto, e la verifica
  // ripiegava sul messaggio di chat. Un messaggio di chat non contiene
  // "REPORT", "Preparato il" e "FONTI CONSULTATE", quindi il criterio
  // falliva SEMPRE — e nel log si legge tre volte "il documento non e'
  // presentabile: manca l'intestazione", rivolto a un Esecutore che il
  // documento l'aveva prodotto per davvero, giusto e impaginato.
  //
  // Il prompt del Collega ordina di mettere formato_consegna SEMPRE insieme
  // a file_atteso, e di preferire l'html: cioè la combinazione consigliata
  // era quella che non poteva riuscire.
  //
  // Qui il report dichiara sé stesso nella forma che la verifica conosce.
  // Non è un trucco per far passare il controllo: componiRivista ha già
  // rifiutato il documento se mancavano titolo, raccomandazione, due
  // risultati o le fonti — quello che si dichiara è vero perché è stato
  // verificato prima.
  ctx.session.righeUltimoFile = [
    [TITOLO_REPORT, String(spec.titolo || nome)],
    ['Preparato il', new Date().toLocaleDateString('it-IT')],
    ...(spec.sezioni || []).flatMap(sez => [
      [String(sez.titolo || '')],
      ...(sez.carte || []).map(c => [String(c.nome || ''), c.prezzo != null ? String(c.prezzo) : '', String(c.dettaglio || '')]),
    ]),
    [TITOLO_FONTI],
    ...fonti.map(f => [String(f.url || '')]),
  ];

  ctx.wsBroadcast({ type: 'file_created', filename: nome });
  ctx.broadcastFile({ filename: nome, size: Buffer.byteLength(esito.html), text: 'Report impaginato: aprilo per la versione completa.', markdown: false });
  ctx.log(`[Report] ${nome} impaginato (${fonti.length} fonti)`);
  return JSON.stringify({ ok: true, filename: nome, fonti: fonti.length,
    nota: 'Report impaginato pronto. Si apre nel browser; per il PDF: stampa e Salva come PDF.' });
}

module.exports = {
  crea_report: creaReport,
  save_to_kb: saveToKb, search_kb: searchKb, kb_update: kbUpdate, kb_delete: kbDelete,
  create_file: createFile, save_memory: saveMemory,
  create_task: createTask, run_task: runTask, delete_task: deleteTask, list_tasks: listTasks,
  batch_scrape: batchScrape,
  list_local_files: listLocalFiles, read_local_file: readLocalFile, save_local_file: saveLocalFile, search_local_files: searchLocalFiles,
};
