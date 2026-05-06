// ═════════════════════════════════════════════════════════════
// interact-drag-upload.js — DRAG & DROP & FILE UPLOAD TOOLS
// Extracted from server.js cases: drag_drop, upload_file
// ═════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');

module.exports = function createInteractDragUploadTools(deps) {
  const {
    log, session, emitThinking,
    takeActiveScreenshot, _getActivePage
  } = deps;

  async function toolDragDrop(args) {
    emitThinking(`Drag da "${args.source}" a "${args.target}"...`);
    const _activePage = _getActivePage();
    if (!_activePage) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
    try {
      const sourceBox = await _activePage.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, args.source);
      const targetBox = await _activePage.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, args.target);
      if (!sourceBox) return JSON.stringify({ error: `Elemento source "${args.source}" non trovato` });
      if (!targetBox) return JSON.stringify({ error: `Elemento target "${args.target}" non trovato` });

      // Simula drag: mousedown → mousemove → mouseup
      await _activePage.mouse.move(sourceBox.x, sourceBox.y);
      await _activePage.mouse.down();
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        const x = sourceBox.x + (targetBox.x - sourceBox.x) * (i / steps);
        const y = sourceBox.y + (targetBox.y - sourceBox.y) * (i / steps);
        await _activePage.mouse.move(x, y);
        await new Promise(r => setTimeout(r, 30));
      }
      await _activePage.mouse.up();
      await new Promise(r => setTimeout(r, 500));

      // Anche dispatch dragstart/dragend per HTML5 drag API
      await _activePage.evaluate((srcSel, tgtSel) => {
        const src = document.querySelector(srcSel);
        const tgt = document.querySelector(tgtSel);
        if (src && tgt) {
          const dt = new DataTransfer();
          src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
          tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
          tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
          src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        }
      }, args.source, args.target);
      await takeActiveScreenshot(session.lastPage?.url, session.lastPage?.title);
      return JSON.stringify({ ok: true, from: args.source, to: args.target });
    } catch (e) {
      return JSON.stringify({ error: `Drag failed: ${e.message}` });
    }
  }

  async function toolUploadFile(args) {
    emitThinking(`Upload file su "${args.selector}"...`);
    const _activePage = _getActivePage();
    if (!_activePage) return JSON.stringify({ error: 'Nessuna pagina attiva.' });
    try {
      let filePath = args.file_path;
      const localDir = path.join(__dirname, 'data', 'local_files');
      const localPath = path.join(localDir, filePath);
      if (fs.existsSync(localPath)) filePath = localPath;
      if (!fs.existsSync(filePath)) {
        return JSON.stringify({ error: `File non trovato: ${args.file_path}` });
      }
      const fileInput = await _activePage.$(args.selector);
      if (!fileInput) return JSON.stringify({ error: `Input file "${args.selector}" non trovato nella pagina` });
      await fileInput.uploadFile(filePath);
      await new Promise(r => setTimeout(r, 1000));
      await takeActiveScreenshot(session.lastPage?.url, session.lastPage?.title);
      return JSON.stringify({ ok: true, uploaded: path.basename(filePath), selector: args.selector });
    } catch (e) {
      return JSON.stringify({ error: `Upload failed: ${e.message}` });
    }
  }

  return {
    toolDragDrop,
    toolUploadFile
  };
};
