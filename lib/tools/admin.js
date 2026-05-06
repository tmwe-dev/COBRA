// lib/tools/admin.js — Admin tools: files, KB, tasks, memory
const fs = require('fs');
const path = require('path');

module.exports = function createAdminTools(deps) {
  const { log, emitThinking, kb, memory } = deps;

  async function toolSaveLocalFile(args) {
    emitThinking(`Saving file ${args.path}...`);
    try {
      const filePath = path.join(__dirname, '..', '..', 'data', 'files', args.path);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, args.content || '');
      return JSON.stringify({ ok: true, path: args.path });
    } catch (e) {
      return JSON.stringify({ error: `File save failed: ${e.message}` });
    }
  }

  async function toolSearchKb(args) {
    emitThinking(`Searching KB for: ${args.query}...`);
    const results = await kb.searchKB(args.query, args.domain);
    return JSON.stringify({ ok: true, results, count: results.length });
  }

  async function toolSaveKb(args) {
    emitThinking(`Saving to KB: ${args.name}...`);
    const ok = await kb.saveToKB(args.domain, args.type, args.name, args.content, args.tags);
    return JSON.stringify({ ok, message: ok ? 'Saved to KB' : 'KB save failed' });
  }

  async function toolUpdateKb(args) {
    emitThinking(`Updating KB: ${args.title}...`);
    const ok = await kb.updateKB(args.title, args.content, args.category, args.domain, args.tags);
    return JSON.stringify({ ok, message: ok ? 'KB updated' : 'Update failed' });
  }

  async function toolDeleteKb(args) {
    emitThinking(`Deleting from KB: ${args.title}...`);
    const ok = await kb.deleteKB(args.title);
    return JSON.stringify({ ok, message: ok ? 'Deleted from KB' : 'Delete failed' });
  }

  async function toolCreateTask(args) {
    emitThinking(`Creating task: ${args.name}...`);
    let steps;
    try { steps = JSON.parse(args.steps); } catch { steps = [{ description: args.steps }]; }
    const task = { id: Date.now(), name: args.name, description: args.description || '', steps, status: 'saved', createdAt: new Date().toISOString() };
    return JSON.stringify({ ok: true, taskId: task.id, name: task.name, steps: steps.length });
  }

  async function toolListTasks(args) {
    return JSON.stringify({ ok: true, tasks: [], count: 0 });
  }

  async function toolCompleteTask(args) {
    return JSON.stringify({ ok: true, taskId: args.taskId, message: 'Task marked complete' });
  }

  async function toolSaveMemory(args) {
    emitThinking(`Saving memory: ${args.title}...`);
    await memory.save(args.content, 'fact', 2, args.tags ? args.tags.split(',') : []);
    return JSON.stringify({ ok: true, title: args.title });
  }

  async function toolRecallMemory(args) {
    emitThinking(`Recalling memory for: ${args.query}...`);
    const ctx = await memory.loadForContext(args.query);
    return JSON.stringify({ ok: true, context: ctx });
  }

  async function toolListMemories(args) {
    return JSON.stringify({ ok: true, memories: [], count: 0 });
  }

  return {
    toolSaveLocalFile, toolSearchKb, toolSaveKb, toolUpdateKb, toolDeleteKb,
    toolCreateTask, toolListTasks, toolCompleteTask,
    toolSaveMemory, toolRecallMemory, toolListMemories,
  };
};
