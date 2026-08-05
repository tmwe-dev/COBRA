// modules/tools/handlers/data.js — KB, files, memory, tasks, batch_scrape, local files
// Source: server.js lines 6148-6371

const path = require('path');
const fs = require('fs');
const { assertSSRFSafe } = require('../../security/ssrf');
const { creaXlsx, righeDaTesto } = require('../../utils/xlsx');

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

  const estensione = (args.filename || '').split('.').pop().toLowerCase();
  if (estensione === 'xlsx') {
    // Un .xlsx non è testo: scriverci dentro un CSV produce un file che Excel
    // rifiuta di aprire. Si costruisce l'archivio vero.
    const righe = righeDaTesto(args.content || '');
    if (righe.length === 0) return JSON.stringify({ error: 'Contenuto vuoto o non tabellare: per un Excel servono righe (CSV, JSON o tabella markdown)' });
    try {
      fs.writeFileSync(filePath, creaXlsx(righe, args.sheet || 'Report'));
      ctx.wsBroadcast({ type: 'file_created', filename: args.filename });
      ctx.broadcastFile({ filename: args.filename, size: fs.statSync(filePath).size,
        text: righe.slice(0, 30).map(r => r.join(' | ')).join('\n') });
      return JSON.stringify({ ok: true, filename: args.filename, righe: righe.length, colonne: (righe[0] || []).length });
    } catch (e) {
      return JSON.stringify({ error: `Creazione del file Excel fallita: ${e.message}` });
    }
  }

  fs.writeFileSync(filePath, args.content || '');
  ctx.wsBroadcast({ type: 'file_created', filename: args.filename });
  const ext = (args.filename || '').split('.').pop().toLowerCase();
  if (['txt','md','json','csv','html','xml','js','css'].includes(ext)) {
    ctx.broadcastFile({ filename: args.filename, size: Buffer.byteLength(args.content || ''), text: (args.content || '').substring(0, 10000), markdown: ext === 'md' });
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
  return JSON.stringify({ ok: true, results: results.filter(r => r.status === 'fulfilled').map(r => r.value), count: results.filter(r => r.status === 'fulfilled').length });
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

module.exports = {
  save_to_kb: saveToKb, search_kb: searchKb, kb_update: kbUpdate, kb_delete: kbDelete,
  create_file: createFile, save_memory: saveMemory,
  create_task: createTask, run_task: runTask, delete_task: deleteTask, list_tasks: listTasks,
  batch_scrape: batchScrape,
  list_local_files: listLocalFiles, read_local_file: readLocalFile, save_local_file: saveLocalFile, search_local_files: searchLocalFiles,
};
