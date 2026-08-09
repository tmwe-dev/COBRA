// cobra-extension/esterni/comandi/pagina.js — Guardare e toccare gli elementi.
//
// L'ultimo blocco uscito da background.js, e il piu' vario: click, lettura,
// scorrimento, iframe, shadow DOM, attese, appunti.
//
// Spostato senza modifiche. La regola che si vede nel codice: i framework
// moderni non ascoltano `click`, ascoltano la sequenza del puntatore
// (pointerdown, mousedown, pointerup, mouseup, click). Su WhatsApp `.click()`
// non apriva la conversazione, e per un giorno intero e' sembrato un problema
// di selettori.

(function () {
  'use strict';

  const comandi = {};

  // ── Rispondere dentro la conversazione ──
  //
  // Il pezzo che chiudeva il cerchio: leggere serve a poco se poi non si
  // puo' rispondere. Prima l'unica strada era linkedin_send_message, che
  // vuole l'indirizzo di un profilo — un dato che la messaggistica non
  // espone. Quindi si poteva leggere Samuel Chen e non rispondergli mai.
  //
  // Qui si apre la conversazione per nome (stesso codice della lettura,
  // stesse garanzie: se il nome corrisponde a due persone ci si ferma) e
  // si scrive nella casella che e' gia' li'.
  //
  // La casella si svuota e si VERIFICA che si sia svuotata, come su
  // WhatsApp: e' il difetto che ha fatto arrivare a Jose "test cobratest
  // cobratest cobra". Qui non e' ancora successo, e non deve.
  // ── Chiedere il collegamento a qualcuno ──
  //
  // Questo comando non c'era, e il buco e' costato l'8 agosto intero.
  // `linkedin_connect` passava da `extRelay` — cioe' da un'ALTRA
  // estensione LinkedIn, quella con `direction: from-webapp-li`, che sul
  // computer di Luca non risponde. Nessuno raccoglieva il comando: nessuna
  // pagina si apriva, nessun errore, solo un'attesa fino al timeout.
  // Quattro tentativi, quattro "Extension timeout", e Luca che diceva la
  // cosa giusta: "io non vedo cercare su linkedin la pagina corretta".
  //
  // Il ponte di COBRA aveva gia' nove comandi LinkedIn funzionanti e non
  // questo. Adesso e' qui, con lo stesso metodo degli altri: la pagina se
  // la prepara Pagine, il ritmo lo mette Ritmo, e il pulsante si cerca per
  // SIGNIFICATO — ruolo piu' nome accessibile — non per classe CSS.
  // ══════════════════════════════════════════════════════
  // GUARDARE LA PAGINA, E POTERNE NOMINARE I PEZZI
  // ══════════════════════════════════════════════════════
  //
  // Il modello non scrive piu' selettori CSS: guarda, e poi agisce su
  // quello che ha visto. `guarda` restituisce E1, E2, E3... e i comandi
  // dopo accettano quei nomi. Un elemento inventato non esiste, quindi
  // non puo' essere nominato — che e' il punto.

  comandi['guarda'] = async function (args) {
        const _pg = args.tabId
          ? { ok: true, scheda: { id: Number(args.tabId) } }
          : await (async () => {
              const [att] = await chrome.tabs.query({ active: true, currentWindow: true });
              if (!att) return { ok: false, motivo: 'nessuna scheda attiva' };
              return { ok: true, scheda: att };
            })();
        if (!_pg.ok) return _pg;
        if (globalThis.Ritmo) await globalThis.Ritmo.comeUnaPersona(_pg.scheda.id, 'leggere', async () => {});
        return await globalThis.Sguardo.guarda(_pg.scheda.id, {
          quanti: args.quanti, ancheInvisibili: args.ancheInvisibili,
        });
  };

  comandi['agisci'] = async function (args) {
        const _pa = args.tabId
          ? { id: Number(args.tabId) }
          : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        if (!_pa) return { ok: false, motivo: 'nessuna scheda attiva' };
        const cosa = String(args.cosa || 'clicca');
        // Scrivere e premere sono gesti che si vedono: passano dal ritmo.
        if (globalThis.Ritmo && cosa !== 'guarda') {
          await globalThis.Ritmo.comeUnaPersona(_pa.id, 'pensare', async () => {});
        }
        return await globalThis.Sguardo.agisci(_pa.id, args.id, cosa, args.valore);
  };

  comandi['click'] = async function (args) {
        const tab = await getWorkTab();
        // Il cursore arriva prima del click: così nella fotografia si vede
        // DOVE COBRA ha messo le mani, non solo cosa è successo dopo.
        await muoviCursoreSu(tab.id, args.selector, 'clic');
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Element not found: ' + sel };
          realisticClick(el);
          // CRITICAL: el.click() nativo come fallback — genera evento trusted che bypassa isTrusted check (Google, etc.)
          try { if (typeof el.click === 'function') el.click(); } catch {}
          return { ok: true, clicked: el.tagName + (el.textContent?.trim().substring(0, 40) || '') };
        }, [args.selector]);
  };

  comandi['double_click'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };
          realisticDblClick(el);
          return { ok: true };
        }, [args.selector]);
  };

  comandi['right_click'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };
          realisticRightClick(el);
          return { ok: true };
        }, [args.selector]);
  };

  comandi['click_coord'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (x, y) => {
          eval(MOUSE_CODE);
          const el = document.elementFromPoint(x, y);
          if (!el) return { ok: false, error: `Nothing at ${x},${y}` };
          realisticClick(el);
          try { if (typeof el.click === 'function') el.click(); } catch {}
          return { ok: true, element: el.tagName, text: el.textContent?.trim().substring(0, 40) };
        }, [args.x, args.y]);
  };

  comandi['hover'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };
          simulateHover(el);
          return { ok: true };
        }, [args.selector]);
  };

  comandi['drag_drop'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (fromSel, toSel) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const from = resolveElement(fromSel);
          const to = resolveElement(toSel);
          if (!from) return { ok: false, error: 'From not found' };
          if (!to) return { ok: false, error: 'To not found' };
          simulateDrag(from, to);
          return { ok: true };
        }, [args.from, args.to]);
  };

  comandi['scroll'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (dir, amount, sel, smooth) => {
          eval(RESOLVE_CODE);
          const target = sel ? resolveElement(sel) : window;
          const behavior = smooth ? 'smooth' : 'auto';
          const px = amount || 500;
          const opts = dir === 'up' ? { top: -px, behavior } :
                       dir === 'down' ? { top: px, behavior } :
                       dir === 'left' ? { left: -px, behavior } :
                       { left: px, behavior };
          if (target === window) window.scrollBy(opts);
          else target.scrollBy(opts);
          return { ok: true, scrolled: dir, amount: px };
        }, [args.direction || 'down', args.amount || 500, args.selector || null, args.smooth !== false]);
  };

  comandi['scroll_to_element'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return { ok: true };
        }, [args.selector]);
  };

  // Singolo tasto (Enter, Tab, Escape, Backspace, frecce, F1-F12)

  comandi['press_key'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (key, repeat) => {
          const keyMap = {
            enter:'Enter', tab:'Tab', escape:'Escape', esc:'Escape', backspace:'Backspace',
            delete:'Delete', space:' ', arrowup:'ArrowUp', arrowdown:'ArrowDown',
            arrowleft:'ArrowLeft', arrowright:'ArrowRight', home:'Home', end:'End',
            pageup:'PageUp', pagedown:'PageDown',
            f1:'F1', f2:'F2', f3:'F3', f4:'F4', f5:'F5', f6:'F6', f7:'F7', f8:'F8', f9:'F9', f10:'F10', f11:'F11', f12:'F12'
          };
          const mapped = keyMap[key.toLowerCase()] || key;
          const target = document.activeElement || document.body;
          for (let i = 0; i < (repeat || 1); i++) {
            const prevented = !target.dispatchEvent(new KeyboardEvent('keydown', { key: mapped, code: mapped, bubbles: true, cancelable: true }));
            if (!prevented && mapped === 'Tab') {
              // Simula cambio focus
              const focusable = [...document.querySelectorAll('input, select, textarea, button, a[href], [tabindex]')]
                .filter(e => ((e.getBoundingClientRect().width || 0) >= 2 && (e.getBoundingClientRect().height || 0) >= 2) && !e.disabled);
              const idx = focusable.indexOf(target);
              if (idx >= 0 && idx < focusable.length - 1) focusable[idx + 1].focus();
            }
            target.dispatchEvent(new KeyboardEvent('keyup', { key: mapped, code: mapped, bubbles: true }));
          }
          return { ok: true, key: mapped, repeat: repeat || 1 };
        }, [args.key, args.repeat || 1]);
  };

  // Combo tastiera (Ctrl+C, Ctrl+V, Ctrl+A, Ctrl+Z, Shift+Enter, etc.)

  comandi['key_combo'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (combo) => {
          const parts = combo.toLowerCase().split('+').map(s => s.trim());
          const mod = {
            ctrl: parts.includes('ctrl') || parts.includes('control'),
            shift: parts.includes('shift'),
            alt: parts.includes('alt') || parts.includes('option'),
            meta: parts.includes('meta') || parts.includes('cmd') || parts.includes('command'),
          };
          const keyPart = parts.filter(p => !['ctrl','control','shift','alt','option','meta','cmd','command'].includes(p))[0] || '';
          const keyMap = { enter:'Enter', tab:'Tab', escape:'Escape', backspace:'Backspace', delete:'Delete', space:' ', arrowup:'ArrowUp', arrowdown:'ArrowDown', arrowleft:'ArrowLeft', arrowright:'ArrowRight' };
          const key = keyMap[keyPart] || keyPart;
          const target = document.activeElement || document.body;

          target.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), bubbles: true, cancelable: true,
            ctrlKey: mod.ctrl, shiftKey: mod.shift, altKey: mod.alt, metaKey: mod.meta }));
          target.dispatchEvent(new KeyboardEvent('keyup', { key, code: 'Key' + key.toUpperCase(), bubbles: true,
            ctrlKey: mod.ctrl, shiftKey: mod.shift, altKey: mod.alt, metaKey: mod.meta }));

          // Azioni native per combo comuni
          if ((mod.ctrl || mod.meta) && key === 'a') {
            if (target.select) target.select();
            else document.execCommand('selectAll');
            return { ok: true, action: 'select_all' };
          }
          if ((mod.ctrl || mod.meta) && key === 'c') { document.execCommand('copy'); return { ok: true, action: 'copy' }; }
          if ((mod.ctrl || mod.meta) && key === 'v') { document.execCommand('paste'); return { ok: true, action: 'paste' }; }
          if ((mod.ctrl || mod.meta) && key === 'x') { document.execCommand('cut'); return { ok: true, action: 'cut' }; }
          if ((mod.ctrl || mod.meta) && key === 'z') { document.execCommand('undo'); return { ok: true, action: 'undo' }; }
          if ((mod.ctrl || mod.meta) && mod.shift && key === 'z') { document.execCommand('redo'); return { ok: true, action: 'redo' }; }
          return { ok: true, combo };
        }, [args.combo]);
  };

  // Selezione testo

  comandi['select_text'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (sel, start, end) => {
          eval(RESOLVE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };
          if (el.setSelectionRange) {
            el.focus();
            el.setSelectionRange(start || 0, end || el.value.length);
            return { ok: true, selected: el.value.substring(start || 0, end || el.value.length) };
          }
          // Per contenteditable o testo generico
          const range = document.createRange();
          const textNode = el.firstChild;
          if (textNode) {
            range.setStart(textNode, start || 0);
            range.setEnd(textNode, end || textNode.length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            return { ok: true, selected: selection.toString() };
          }
          return { ok: false, error: 'No text content' };
        }, [args.selector, args.start, args.end]);
  };

  // Focus management

  comandi['focus'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };
          el.focus();
          el.dispatchEvent(new Event('focus', { bubbles: true }));
          return { ok: true, element: el.tagName };
        }, [args.selector]);
  };

  // Drag & drop file upload

  comandi['file_drop'] = async function (args) {
        const tab = await getWorkTab();
        return await runIsolated(tab.id, (sel, fileName, fileType, fileDataB64) => {
          const el = sel ? document.querySelector(sel) : document.querySelector('[class*="drop"], [class*="upload"], [data-testid*="drop"]');
          if (!el) return { ok: false, error: 'No drop zone found' };

          const byteStr = atob(fileDataB64);
          const bytes = new Uint8Array(byteStr.length);
          for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
          const file = new File([bytes], fileName, { type: fileType || 'application/octet-stream' });

          const dt = new DataTransfer();
          dt.items.add(file);
          const rect = el.getBoundingClientRect();
          const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;

          el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: cy }));
          el.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: cy }));
          el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: cy }));
          return { ok: true, fileName, size: file.size, method: 'drag_drop' };
        }, [args.selector || null, args.fileName || 'file.pdf', args.fileType || 'application/pdf', args.fileData || '']);
  };

  comandi['download_file'] = async function (args) {
        if (!await ensurePermission('downloads')) return { ok: false, error: 'Downloads permission denied by user' };
        const downloadId = await chrome.downloads.download({ url: args.url, filename: args.filename || undefined });
        return { ok: true, downloadId };
  };

  comandi['download_status'] = async function (args) {
        if (!await ensurePermission('downloads')) return { ok: false, error: 'Downloads permission denied by user' };
        const [item] = await chrome.downloads.search({ id: args.downloadId });
        if (!item) return { ok: false, error: 'Download not found' };
        return { ok: true, state: item.state, filename: item.filename, bytesReceived: item.bytesReceived, totalBytes: item.totalBytes };
  };

  comandi['clipboard_read'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, async () => {
          try {
            const text = await navigator.clipboard.readText();
            return { ok: true, text };
          } catch (e) {
            return { ok: false, error: 'Clipboard read failed: ' + e.message };
          }
        });
  };

  comandi['clipboard_write'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, async (text) => {
          try {
            await navigator.clipboard.writeText(text);
            return { ok: true };
          } catch (e) {
            // Fallback: textarea + execCommand
            const t = document.createElement('textarea');
            t.value = text;
            document.body.appendChild(t);
            t.select();
            document.execCommand('copy');
            t.remove();
            return { ok: true, method: 'fallback' };
          }
        }, [args.text]);
  };

  comandi['iframe_list'] = async function (args) {
        const tab = await getWorkTab();
        const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
        return { ok: true, frames: frames.map(f => ({ frameId: f.frameId, url: f.url, parentFrameId: f.parentFrameId })) };
  };

  comandi['iframe_execute'] = async function (args) {
        const tab = await getWorkTab();
        let frameId = args.frameId;
        if (frameId === undefined && args.urlPattern) {
          const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
          const match = frames.find(f => f.url.includes(args.urlPattern));
          if (!match) return { ok: false, error: `No iframe matching "${args.urlPattern}"` };
          frameId = match.frameId;
        }
        if (frameId === undefined) return { ok: false, error: 'Specify frameId or urlPattern' };
        return await runInFrame(tab.id, frameId, (code) => {
          try { return { ok: true, result: eval(code) }; } catch (e) { return { ok: false, error: e.message }; }
        }, [args.code]);
  };

  comandi['iframe_click'] = async function (args) {
        const tab = await getWorkTab();
        let frameId = args.frameId;
        if (frameId === undefined && args.urlPattern) {
          const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
          const match = frames.find(f => f.url.includes(args.urlPattern));
          if (!match) return { ok: false, error: 'Frame not found' };
          frameId = match.frameId;
        }
        return await runInFrame(tab.id, frameId, (sel) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Element not found in iframe' };
          realisticClick(el);
          return { ok: true, clicked: el.textContent?.trim().substring(0, 40) };
        }, [args.selector]);
  };

  // Shadow DOM query

  comandi['shadow_query'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          const els = queryShadowAll(document, sel);
          return { ok: true, count: els.length, elements: els.slice(0, 20).map(el => ({
            tag: el.tagName.toLowerCase(), text: el.textContent?.trim().substring(0, 60),
            id: el.id || '', className: el.className || '',
            visible: ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2) })) };
        }, [args.selector]);
  };

  comandi['shadow_click'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          eval(MOUSE_CODE);
          const el = queryShadow(document, sel);
          if (!el) return { ok: false, error: 'Not found in Shadow DOM' };
          realisticClick(el);
          return { ok: true };
        }, [args.selector]);
  };

  // Attendi network idle (nessuna richiesta per N ms)

  comandi['wait_network_idle'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, async (idleMs, timeout) => {
          const start = Date.now();
          let lastActivity = Date.now();
          const origFetch = window.fetch;
          const origXHR = XMLHttpRequest.prototype.open;

          window.fetch = function(...a) { lastActivity = Date.now(); return origFetch.apply(this, a); };
          XMLHttpRequest.prototype.open = function(...a) { lastActivity = Date.now(); return origXHR.apply(this, a); };

          while (Date.now() - start < timeout) {
            if (Date.now() - lastActivity >= idleMs) {
              window.fetch = origFetch;
              XMLHttpRequest.prototype.open = origXHR;
              return { ok: true, waited: Date.now() - start };
            }
            await new Promise(r => setTimeout(r, 100));
          }
          window.fetch = origFetch;
          XMLHttpRequest.prototype.open = origXHR;
          return { ok: false, error: 'Network not idle', waited: timeout };
        }, [args.idleMs || 1000, args.timeout || 15000]);
  };

  // Attendi download completato

  comandi['wait_download'] = async function (args) {
        const timeout = args.timeout || 30000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const [item] = await chrome.downloads.search({ id: args.downloadId });
          if (item && item.state === 'complete') return { ok: true, filename: item.filename, size: item.totalBytes };
          if (item && item.state === 'interrupted') return { ok: false, error: 'Download failed', reason: item.error };
          await new Promise(r => setTimeout(r, 500));
        }
        return { ok: false, error: 'Download timeout' };
  };

  comandi['get_page_content'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          // ── HTML → Markdown pulito (stile FireScrape) ──
          const NOISE_SELS = ['nav','header','footer','[role="navigation"]','[role="banner"]','[role="contentinfo"]','.nav','.navbar','.header','.footer','.sidebar','.menu','.breadcrumb','.pagination','.ad','.ads','[class*="ad-"]','[id*="ad-"]','.cookie','[class*="cookie"]','.popup','.modal','.overlay','.social-share','[class*="social"]','.comments','#comments','script','style','noscript','iframe','svg','[aria-hidden="true"]','form:not([role="search"])'];
          const MAIN_SELS = ['main','article','[role="main"]','#content','#main-content','.main-content','.post-content','.article-content','.entry-content','.page-content','.content'];

          function getMain() {
            for (const s of MAIN_SELS) { const el = document.querySelector(s); if (el && el.textContent.trim().length > 200) return el.cloneNode(true); }
            return document.body.cloneNode(true);
          }
          function removeNoise(root) {
            for (const s of NOISE_SELS) { root.querySelectorAll(s).forEach(el => el.remove()); }
            root.querySelectorAll('[style]').forEach(el => { const st = el.style; if (st.display==='none'||st.visibility==='hidden'||st.opacity==='0') el.remove(); });
            return root;
          }
          function nodeToMd(node, depth) {
            if (depth > 40) return node.textContent || '';
            if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
            if (node.nodeType !== 1) return '';
            const tag = node.tagName.toLowerCase();
            const inner = () => [...node.childNodes].map(c => nodeToMd(c, depth+1)).join('');
            switch(tag) {
              case 'h1': return '\n\n# '+inner().trim()+'\n\n';
              case 'h2': return '\n\n## '+inner().trim()+'\n\n';
              case 'h3': return '\n\n### '+inner().trim()+'\n\n';
              case 'h4': return '\n\n#### '+inner().trim()+'\n\n';
              case 'p': return '\n\n'+inner().trim()+'\n\n';
              case 'br': return '\n';
              case 'hr': return '\n\n---\n\n';
              case 'blockquote': return '\n\n> '+inner().trim().replace(/\n/g,'\n> ')+'\n\n';
              case 'ul': case 'ol': {
                const items = [];let i=1;
                for (const li of node.children) { if (li.tagName?.toLowerCase()==='li') { items.push((tag==='ol'?i+'. ':'- ')+nodeToMd(li,depth+1).trim()); i++; } }
                return '\n\n'+items.join('\n')+'\n\n';
              }
              case 'li': return inner().trim();
              case 'strong': case 'b': { const t=inner().trim(); return t?'**'+t+'**':''; }
              case 'em': case 'i': { const t=inner().trim(); return t?'*'+t+'*':''; }
              case 'code': return '`'+inner().trim()+'`';
              case 'pre': { const code=node.querySelector('code'); return '\n\n```\n'+(code||node).textContent.trim()+'\n```\n\n'; }
              case 'a': { const href=node.getAttribute('href'); const t=inner().trim(); if(!t)return ''; if(!href||href==='#')return t; try{return '['+t+']('+new URL(href,location.href).href+')';}catch{return t;} }
              case 'img': { const src=node.getAttribute('src'); const alt=node.getAttribute('alt')||'img'; if(!src)return ''; try{return '!['+alt+']('+new URL(src,location.href).href+')';}catch{return '';} }
              case 'table': {
                const rows=[];node.querySelectorAll('tr').forEach(tr=>{const cells=[];tr.querySelectorAll('th,td').forEach(c=>cells.push(nodeToMd(c,depth+1).trim().replace(/\|/g,'\\|')));rows.push(cells);});
                if(!rows.length)return '';const cols=Math.max(...rows.map(r=>r.length));
                const norm=r=>{while(r.length<cols)r.push('');return r;};
                return '\n\n| '+norm(rows[0]).join(' | ')+' |\n| '+Array(cols).fill('---').join(' | ')+' |\n'+rows.slice(1).map(r=>'| '+norm(r).join(' | ')+' |').join('\n')+'\n\n';
              }
              default: return inner();
            }
          }
          const root = removeNoise(getMain());
          const md = nodeToMd(root, 0).replace(/\n{3,}/g,'\n\n').trim();
          const meta = { title: document.title, url: location.href, description: document.querySelector('meta[name="description"]')?.content||'', lang: document.documentElement.lang||'' };
          const output = '# '+meta.title+'\n> '+meta.url+'\n\n---\n\n'+md;
          return { ok: true, title: meta.title, url: meta.url, markdown: output.substring(0, 20000), text: root.innerText.substring(0, 8000), stats: { chars: output.length, words: output.split(/\s+/).length } };
        });
  };

  comandi['get_links'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          const links = [];
          for (const a of document.querySelectorAll('a[href]')) {
            { const _r = a.getBoundingClientRect(); if (_r.width < 2 || _r.height < 2) continue; }
            links.push({ text: a.textContent.trim().substring(0, 80), href: a.href, target: a.target || '' });
          }
          return { ok: true, links: links.slice(0, 100) };
        });
  };

  comandi['get_buttons'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          const buttons = [];
          for (const el of document.querySelectorAll('button, [role="button"], input[type="submit"], a.btn, a[class*="button"]')) {
            { const _r = el.getBoundingClientRect(); if (_r.width < 2 || _r.height < 2) continue; }
            buttons.push({
              text: el.textContent.trim().substring(0, 60), type: el.type || '', disabled: el.disabled || false,
              selector: el.id ? '#' + el.id : 'text:' + el.textContent.trim().substring(0, 30)
            });
          }
          return { ok: true, buttons: buttons.slice(0, 50) };
        });
  };

  comandi['get_interactive'] = async function (args) {
        const tab = await getWorkTab();
        // Attendi che la pagina sia caricata (evita query su pagine in loading)
        try {
          const tabInfo = await chrome.tabs.get(tab.id);
          if (tabInfo.status !== 'complete') {
            await waitForTabLoad(tab.id, 10000);
            await new Promise(r => setTimeout(r, 500)); // extra settle time per SPA/Google
          }
        } catch {}
        // Pre-dismiss any blocking overlays/popups before scanning
        try {
          await run(tab.id, () => {
            const dismissTexts = ['non consentire','deny','block','rifiuta','no thanks','dismiss','chiudi','non ora','close','accetta','accept','ok','got it','ho capito','consenti','allow'];
            document.querySelectorAll('[class*="modal"] button, [class*="dialog"] button, [class*="overlay"] button, [class*="popup"] button, [class*="consent"] button, [class*="cookie"] button, [class*="banner"] button').forEach(el => {
              const txt = (el.textContent || '').trim().toLowerCase();
              if (txt.length < 40 && dismissTexts.some(d => txt.includes(d))) { try { el.click(); } catch {} }
            });
          });
        } catch {}
        return await run(tab.id, () => {
          // CSS.escape fallback
          const cssEsc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape : (s) => s.replace(/([^\w-])/g, '\\$1');
          function buildSelector(el) {
            if (el.id) return '#' + cssEsc(el.id);
            if (el.name) return el.tagName.toLowerCase() + '[name="' + cssEsc(el.name) + '"]';
            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel) return 'aria:' + ariaLabel;
            const placeholder = el.placeholder;
            if (placeholder) return 'placeholder:' + placeholder;
            const text = el.textContent?.trim();
            if (text && text.length <= 30 && text.length > 0) return 'text:' + text.substring(0, 30);
            // Fallback: nth-child
            const parent = el.parentElement;
            if (parent) {
              const idx = [...parent.children].indexOf(el) + 1;
              return el.tagName.toLowerCase() + ':nth-child(' + idx + ')';
            }
            return el.tagName.toLowerCase();
          }
          const items = [];
          const giaVisti = new Set();
          for (const el of document.querySelectorAll('input, select, textarea, button, [role="button"], a[href], [contenteditable="true"]')) {
            { const _r = el.getBoundingClientRect(); if (_r.width < 2 || _r.height < 2) continue; }
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            giaVisti.add(el);
            items.push({
              tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '',
              text: el.textContent?.trim().substring(0, 50) || '', placeholder: el.placeholder || '',
              ariaLabel: el.getAttribute('aria-label') || '', role: el.getAttribute('role') || '',
              href: el.href || '', value: el.value?.substring(0, 30) || '',
              disabled: el.disabled || false,
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              selector: buildSelector(el)
            });
          }
          // ── Seconda passata: i cliccabili che non sono link né pulsanti ──
          //
          // Sull'ERP TMWE la prima passata trovava DUE elementi su una pagina
          // piena di comandi, e la risposta era "non ci sono pulsanti visibili":
          // vera alla lettera e inservibile. Quel gestionale — come molti
          // applicativi aziendali di vecchia data — è fatto di <div onclick>,
          // <td> e immagini: cento comandi reali, zero <a> e zero <button>.
          //
          // Si raccoglie quindi anche ciò che è cliccabile di fatto. Per non
          // riempire l'elenco di rumore sui siti moderni, dove il puntatore a
          // mano è ovunque, si tiene solo l'elemento più interno di ogni gruppo
          // e solo se porta un'etichetta breve e leggibile.
          const cliccabili = [];
          for (const el of document.querySelectorAll('div,td,span,li,img,nobr,label')) {
            if (giaVisti.has(el)) continue;
            { const _r = el.getBoundingClientRect(); if (_r.width < 2 || _r.height < 2) continue; }
            const rect = el.getBoundingClientRect();
            if (rect.width < 8 || rect.height < 8) continue;

            const haGestore = !!(el.onclick || el.getAttribute('onclick'));
            let aMano = false;
            try { aMano = getComputedStyle(el).cursor === 'pointer'; } catch (_) { /* elemento sparito */ }
            if (!haGestore && !aMano) continue;

            // Se contiene un altro candidato, il comando vero è quello dentro
            if (el.querySelector('[onclick],input,button,a[href],select')) continue;

            const testo = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
            const etichetta = testo || el.getAttribute('title') || el.getAttribute('alt') || '';
            if (!etichetta || etichetta.length > 40) continue;

            cliccabili.push({
              tag: el.tagName.toLowerCase(), type: '', name: '', id: el.id || '',
              text: etichetta.substring(0, 50), placeholder: '',
              ariaLabel: el.getAttribute('title') || el.getAttribute('alt') || '',
              // Il server lo tratta come un pulsante: per chi lo deve usare è
              // esattamente quello, indipendentemente dal tag scelto nel 2009.
              role: 'button', cliccabileDiFatto: true,
              href: '', value: '', disabled: false,
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              selector: buildSelector(el)
            });
            if (cliccabili.length >= 80) break;
          }

          return { ok: true, url: location.href, title: document.title,
                   elements: items.concat(cliccabili).slice(0, 160),
                   standard: items.length, cliccabiliDiFatto: cliccabili.length };
        }).catch(async (err) => {
          // Retry dopo breve pausa (pagina potrebbe non essere ancora pronta)
          await new Promise(r => setTimeout(r, 1500));
          try {
            return await run(tab.id, () => {
              const items = [];
              for (const el of document.querySelectorAll('input, select, textarea, button, [role="button"], a[href]')) {
                { const _r = el.getBoundingClientRect(); if (_r.width < 2 || _r.height < 2) continue; }
                const r = el.getBoundingClientRect();
                if (r.width === 0 && r.height === 0) continue;
                items.push({
                  tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '',
                  text: el.textContent?.trim().substring(0, 50) || '', placeholder: el.placeholder || '',
                  ariaLabel: el.getAttribute('aria-label') || '', role: el.getAttribute('role') || '',
                  selector: el.id ? '#' + el.id : (el.name ? el.tagName.toLowerCase() + '[name="' + el.name + '"]' : el.tagName.toLowerCase())
                });
              }
              return { ok: true, url: location.href, title: document.title, elements: items.slice(0, 80), retried: true };
            });
          } catch (e2) {
            return { ok: false, error: 'get_interactive failed: ' + (err.message || '') + ' / retry: ' + (e2.message || '') };
          }
        });
  };

  // ════════════════════════════════════════
  // 17b. PAGE SNAPSHOT — mappa strutturata per AI decision
  // ════════════════════════════════════════

  comandi['get_page_snapshot'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, () => {
          const cssEsc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape : (s) => s.replace(/([^\w-])/g, '\\$1');
          function buildSel(el) {
            if (el.id) return '#' + cssEsc(el.id);
            if (el.name) return el.tagName.toLowerCase() + '[name="' + cssEsc(el.name) + '"]';
            const aria = el.getAttribute('aria-label');
            if (aria) return 'aria:' + aria;
            if (el.placeholder) return 'placeholder:' + el.placeholder;
            if (el.className && typeof el.className === 'string') {
              const cls = el.className.trim().split(/\s+/).slice(0, 2).map(c => cssEsc(c)).join('.');
              if (cls) return el.tagName.toLowerCase() + '.' + cls;
            }
            const text = (el.textContent || '').trim();
            if (text.length > 0 && text.length <= 30) return 'text:' + text;
            return el.tagName.toLowerCase();
          }
          return {
            ok: true, url: location.href, title: document.title,
            buttons: [...document.querySelectorAll('button, [role="button"], input[type="submit"], a.btn, a[class*="button"]')]
              .filter(el => ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)).slice(0, 25)
              .map(el => ({ text: el.textContent?.trim().slice(0, 50), selector: buildSel(el), disabled: el.disabled || false })),
            inputs: [...document.querySelectorAll('input, textarea, select')]
              .filter(el => ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)).slice(0, 25)
              .map(el => ({ type: el.type || el.tagName.toLowerCase(), name: el.name, placeholder: el.placeholder, value: el.value?.slice(0, 30), label: el.labels?.[0]?.textContent?.trim()?.slice(0,40) || '', selector: buildSel(el), required: el.required || false })),
            links: [...document.querySelectorAll('a[href]')]
              .filter(el => ((el.getBoundingClientRect().width || 0) >= 2 && (el.getBoundingClientRect().height || 0) >= 2)).slice(0, 30)
              .map(el => ({ text: el.textContent?.trim().slice(0, 50), href: el.href, selector: buildSel(el) })),
            headings: [...document.querySelectorAll('h1, h2, h3')].slice(0, 15)
              .map(el => ({ level: el.tagName, text: el.textContent?.trim().slice(0, 80) })),
            mainText: (document.querySelector('main, article, [role="main"]') || document.body)
              .textContent?.trim().slice(0, 2000),
          };
        });
  };

  comandi['highlight'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (sel) => {
          eval(RESOLVE_CODE);
          const el = resolveElement(sel);
          if (!el) return { ok: false, error: 'Not found' };
          el.style.outline = '3px solid #a78bfa';
          el.style.outlineOffset = '2px';
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = ''; }, 3000);
          return { ok: true };
        }, [args.selector]);
  };

  comandi['execute_js'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (code) => {
          try { return { ok: true, result: eval(code) }; } catch (e) { return { ok: false, error: e.message }; }
        }, [args.code]);
  };

  comandi['request_human'] = async function (args) {
        // Notifica l'utente che serve intervento manuale
        notify('human_takeover', { reason: args.reason || 'Intervento manuale richiesto', type: args.type || 'generic' });
        // Anche notifica Chrome nativa
        chrome.notifications.create('cobra-takeover', {
          type: 'basic', iconUrl: 'icons/cobra-128.png',
          title: 'COBRA — Intervento richiesto',
          message: args.reason || 'Serve il tuo intervento nel browser.'
        });
        return { ok: true, notified: true, reason: args.reason };
  };

  comandi['resume_after_human'] = async function (args) {
        const tab = await getWorkTab();
        const url = tab.url;
        return { ok: true, url, title: tab.title, note: 'Agent resumed' };
  };

  comandi['get_storage'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (type) => {
          const storage = type === 'session' ? sessionStorage : localStorage;
          const items = {};
          for (let i = 0; i < storage.length && i < 50; i++) {
            const key = storage.key(i);
            items[key] = storage.getItem(key)?.substring(0, 200);
          }
          return { ok: true, type, count: storage.length, items };
        }, [args.type || 'local']);
  };

  comandi['read_table'] = async function (args) {
        const tab = await getWorkTab();
        return await run(tab.id, (sel, maxRows) => {
          eval(RESOLVE_CODE);
          const table = sel ? resolveElement(sel) : document.querySelector('table');
          if (!table) return { ok: false, error: 'No table found' };

          const headers = [];
          const rows = [];
          const headerEls = table.querySelectorAll('thead th, thead td, tr:first-child th');
          for (const th of headerEls) headers.push(th.textContent.trim());

          const bodyRows = table.querySelectorAll('tbody tr, tr');
          for (let i = 0; i < Math.min(bodyRows.length, maxRows || 50); i++) {
            const cells = [];
            for (const td of bodyRows[i].querySelectorAll('td, th')) {
              cells.push(td.textContent.trim().substring(0, 200));
            }
            if (cells.length > 0) rows.push(cells);
          }
          return { ok: true, headers, rows, totalRows: bodyRows.length };
        }, [args.selector || null, args.maxRows || 50]);
  };

  const quanti = globalThis.Registro.area('pagina', comandi);
  console.log(`[COBRA] pagina: ${quanti} comandi registrati`);
})();
