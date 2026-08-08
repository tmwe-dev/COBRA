// cobra-extension/esterni/comandi/foto.js — Fotografare la pagina.
//
// Spostato da background.js senza modifiche. Nota che vale il file:
// chrome.tabs.captureVisibleTab fotografa solo la scheda in primo piano, non
// quella su cui si sta lavorando.

(function () {
  'use strict';

  const comandi = {};

  comandi['screenshot'] = async function (args) {
        // Chrome fotografa solo la scheda ATTIVA di una finestra. La scheda di
        // lavoro sta in una finestra propria, quindi renderla attiva lì non
        // disturba l'utente: la sua finestra non viene mai toccata.
        let windowId = null;
        const idScheda = await recuperaWorkTab();
        if (idScheda) {
          try {
            const wTab = await chrome.tabs.get(idScheda);
            windowId = wTab.windowId;
            if (!wTab.active) await chrome.tabs.update(idScheda, { active: true });
            // La finestra non va mai portata in primo piano: ruberebbe il fuoco
            await new Promise(r => setTimeout(r, 200));
          } catch { windowId = null; }
        }
        // Prima via: cattura diretta. Veloce, ma Chrome smette di disegnare le
        // finestre completamente coperte e restituisce "image readback failed".
        const motivi = [];
        // ── Prima l'ispettore, perché è l'unico che vede la pagina INTERA ──
        //
        // Prima veniva provata per prima la cattura diretta, più veloce. Ma
        // quella fotografa solo ciò che sta a schermo: nel monitor la pagina
        // finiva a metà e sotto restava il nero, e nessuna delle due vie
        // avrebbe mai mostrato il resto. Meglio qualche decimo di secondo in
        // più e vedere il documento per intero.
        if (idScheda && chrome.debugger) {
          try {
            const immagine = await catturaConIspettore(idScheda, args.quality || 70, true);
            if (immagine) return { ok: true, screenshot: immagine, via: 'ispettore (pagina intera)' };
            motivi.push('ispettore: nessuna immagine restituita');
          } catch (e) {
            motivi.push(`ispettore: ${e.message}`);
          }
        } else {
          motivi.push(chrome.debugger ? 'scheda di lavoro non trovata' : 'ispettore non disponibile');
        }

        // Ripiego: la cattura diretta. Vede solo la piega, ma una mezza
        // immagine è meglio di nessuna immagine.
        try {
          const dataUrl = await conLimite(
            chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: args.quality || 70 }),
            4000, 'cattura diretta');
          if (dataUrl) return { ok: true, screenshot: dataUrl.split(',')[1], via: 'cattura diretta (solo la parte visibile)' };
          motivi.push('cattura diretta: nessuna immagine restituita');
        } catch (e) {
          motivi.push(`cattura diretta: ${e.message}`);
          console.log('[COBRA Bridge] Cattura diretta non riuscita:', e.message);
        }
        // Si risponde SEMPRE, anche per dire di non essere riusciti: un errore
        // esplicito si legge nel registro, un'attesa infinita no.
        return { ok: false, error: `Nessuna immagine catturata — ${motivi.join(' | ')}` };
  };

  // Il cursore su richiesta: serve al server per mostrare dove sta
  // guardando anche quando non clicca niente — una lettura, un'attesa,
  // uno scorrimento. Senza, l'anteprima di una pagina su cui si sta
  // lavorando è identica a quella di una pagina ferma.

  comandi['mostra_cursore'] = async function (args) {
        const tab = await getWorkTab();
        if (args.selettore) {
          await muoviCursoreSu(tab.id, args.selettore, args.azione || '');
          return { ok: true, dove: args.selettore };
        }
        await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          func: (disegna, x, y, atto) => {
            // eslint-disable-next-line no-new-func
            return new Function('return ' + disegna)()(x, y, atto);
          },
          args: [disegnaCursore.toString(), Number(args.x) || 40, Number(args.y) || 40, args.azione || ''],
        });
        await new Promise(r => setTimeout(r, 450));
        return { ok: true, x: args.x, y: args.y };
  };

  const quanti = globalThis.Registro.area('foto', comandi);
  console.log(`[COBRA] foto: ${quanti} comandi registrati`);
})();
