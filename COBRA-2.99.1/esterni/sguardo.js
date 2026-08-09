// cobra-extension/esterni/sguardo.js — Guardare la pagina come la guarda una
// persona, e poterla nominare.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHÉ ESISTE
//
// Fino a qui il modello, per agire, doveva produrre un selettore CSS:
//
//     click_element({ selector: '#search-btn' })
//     fill_form({ fields: { 'input[name="from"]': 'Milano' } })
//
// Due guasti, tutti e due silenziosi.
//
// Il primo: il selettore se lo INVENTA. Non ha guardato la pagina, ha
// indovinato un nome plausibile. Un selettore inventato non da' errore — da'
// zero elementi trovati, quindi zero campi compilati e un modulo che parte
// vuoto. E' successo l'8 agosto, ed e' il motivo per cui fill_form adesso
// pretende che il modulo sia stato letto prima.
//
// Il secondo: anche quando e' giusto, e' fragile. `div:nth-child(4)` smette di
// significare qualcosa alla prima riscrittura del CSS. Su Facebook le classi
// (`x1n2onr6`) cambiano a ogni build. Su LinkedIn il riquadro della nota e'
// `position: fixed`, e mezzo codice lo scartava come invisibile.
//
// ── COSA FA INVECE QUESTO ──
//
// Guarda la pagina una volta e produce un elenco di cose su cui si puo' agire,
// ognuna con un nome corto e stabile:
//
//     E1   casella di testo   "Da dove parti"        (vuota)
//     E2   casella di testo   "Dove vuoi andare"     (vuota)
//     E3   pulsante           "Cerca"
//     E7   menu               "Passeggeri"           "1 adulto"
//
// Il modello dice `click(E3)`. Non scrive CSS, non indovina niente: sceglie fra
// cose che ESISTONO, perche' gliele abbiamo mostrate noi.
//
// ── PERCHÉ IL NOME REGGE ──
//
// Ogni elemento porta con sé come ritrovarsi: ruolo + nome accessibile +
// posizione fra i suoi simili. Se la pagina si ridisegna — e le pagine moderne
// si ridisegnano da sole, senza cambiare indirizzo — E3 viene ritrovato per
// SIGNIFICATO ("il pulsante che si chiama Cerca"), non per posizione nel DOM.
// E' la stessa idea di mappa.js, portata dai sei ruoli fissi della
// messaggistica a qualunque pagina.
//
// ── COSA GUARDA, E COSA NO ──
//
// Guarda: ruolo (dichiarato o dedotto), nome accessibile (aria-label,
// etichetta collegata, placeholder, title, testo), valore, stato
// (disabilitato, spuntato, aperto), e il rettangolo che occupa sullo schermo.
//
// Entra dentro gli shadow root, perche' i componenti moderni ci nascondono
// dentro i pulsanti veri, e dentro gli iframe della stessa origine.
//
// NON guarda offsetParent per decidere se una cosa si vede: un elemento in
// `position: fixed` ha SEMPRE offsetParent nullo, ed e' esattamente il caso dei
// riquadri e dei banner — cioe' le cose su cui bisogna agire piu' spesso.
// Si misura il rettangolo e si legge lo stile calcolato.
//
// Il rettangolo serve a due cose: far ragionare il modello sulla posizione
// ("il pulsante sotto il campo destinazione") e permettere, come ultima
// spiaggia, di cliccare per coordinate quando l'elemento non si lascia
// prendere in nessun altro modo.
// ══════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // Ogni scheda ha il suo sguardo piu' recente: serve per risolvere "E3" alla
  // chiamata dopo. Non e' una cache dei dati — quelli si rileggono sempre — e'
  // solo la memoria di COME si ritrova quell'elemento.
  const _ultimoSguardo = new Map(); // tabId -> { quando, url, elementi: [...] }

  // ── La funzione che viene iniettata nella pagina ──
  //
  // Sta tutta qui dentro e non usa niente di fuori: verra' serializzata e
  // eseguita nel contesto della pagina, dove non esiste nient'altro.
  function _osserva(soloVisibili, quantiAlMassimo) {
    // ── Si vede davvero? ──
    //
    // Non si guarda offsetParent: un elemento `position: fixed` ha SEMPRE
    // offsetParent nullo, ed e' proprio il caso dei riquadri modali e dei
    // banner. Si misura lo spazio occupato e si legge lo stile.
    const siVede = (el) => {
      try {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        if (Number(st.opacity) === 0) return false;
        return true;
      } catch (_) { return false; }
    };

    const pulisci = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);

    // ── Il nome accessibile ──
    //
    // L'ordine non e' casuale: e' quello che segue chi legge la pagina con uno
    // screen reader, e coincide con quello che una persona chiamerebbe "il
    // nome" di quel campo.
    const nomeDi = (el) => {
      const perEtichetta = () => {
        if (el.id) {
          const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lab) return lab.innerText;
        }
        const dentro = el.closest('label');
        if (dentro) return dentro.innerText;
        return '';
      };
      const perAriaLabelledby = () => {
        const rif = el.getAttribute('aria-labelledby');
        if (!rif) return '';
        return rif.split(/\s+/).map(id => {
          const n = document.getElementById(id);
          return n ? n.innerText : '';
        }).join(' ');
      };
      return pulisci(
        el.getAttribute('aria-label')
        || perAriaLabelledby()
        || perEtichetta()
        || el.getAttribute('placeholder')
        || el.getAttribute('title')
        || el.getAttribute('alt')
        || (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
            ? el.getAttribute('name') || ''
            : el.innerText)
      );
    };

    // ── Il ruolo ──
    //
    // Se la pagina lo dichiara si crede a lei. Altrimenti si deduce dal tag,
    // che e' la stessa cosa che fa il browser per l'albero di accessibilita'.
    const ruoloDi = (el) => {
      const dichiarato = el.getAttribute('role');
      if (dichiarato) return dichiarato.toLowerCase();
      const t = el.tagName.toLowerCase();
      if (t === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
      if (t === 'button') return 'button';
      if (t === 'select') return 'combobox';
      if (t === 'textarea') return 'textbox';
      if (t === 'input') {
        const ty = (el.getAttribute('type') || 'text').toLowerCase();
        if (ty === 'checkbox') return 'checkbox';
        if (ty === 'radio') return 'radio';
        if (ty === 'submit' || ty === 'button' || ty === 'reset') return 'button';
        if (ty === 'range') return 'slider';
        if (ty === 'file') return 'file';
        return 'textbox';
      }
      if (el.isContentEditable) return 'textbox';
      return 'generic';
    };

    // ── Dove cercare ──
    //
    // Gli shadow root vanno aperti a mano: querySelectorAll non ci entra, e i
    // componenti moderni ci mettono dentro proprio i pulsanti veri. Stessa cosa
    // per gli iframe della stessa origine (quelli di un'altra origine non si
    // possono leggere, ed e' giusto cosi').
    const radici = [document];
    const apriOmbre = (radice, profondita) => {
      if (profondita > 4) return;
      let nodi;
      try { nodi = radice.querySelectorAll('*'); } catch (_) { return; }
      for (const n of nodi) {
        if (n.shadowRoot) { radici.push(n.shadowRoot); apriOmbre(n.shadowRoot, profondita + 1); }
      }
    };
    apriOmbre(document, 0);
    for (const f of document.querySelectorAll('iframe')) {
      try { if (f.contentDocument) radici.push(f.contentDocument); } catch (_) { /* altra origine */ }
    }

    const SU_CUI_SI_AGISCE = [
      'a[href]', 'button', 'input', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="checkbox"]',
      '[role="radio"]', '[role="combobox"]', '[role="listbox"]', '[role="option"]',
      '[role="menuitem"]', '[role="tab"]', '[role="switch"]', '[role="searchbox"]',
      '[contenteditable="true"]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    const visti = new Set();
    const grezzi = [];
    for (const radice of radici) {
      let nodi;
      try { nodi = radice.querySelectorAll(SU_CUI_SI_AGISCE); } catch (_) { continue; }
      for (const el of nodi) {
        if (visti.has(el)) continue;
        visti.add(el);
        if (soloVisibili && !siVede(el)) continue;
        grezzi.push(el);
      }
    }

    // ── L'ordine: come si legge la pagina ──
    //
    // Dall'alto in basso, da sinistra a destra. Non l'ordine del DOM, che su
    // una pagina con griglie e colonne non c'entra niente con quello che vede
    // una persona. Cosi' E1 e' davvero la prima cosa in alto.
    const conRett = grezzi.map(el => ({ el, r: el.getBoundingClientRect() }));
    conRett.sort((a, b) => {
      const dy = Math.round(a.r.top / 24) - Math.round(b.r.top / 24);
      return dy !== 0 ? dy : a.r.left - b.r.left;
    });

    // ── Come ritrovarlo domani ──
    //
    // Non si salva un selettore CSS: si salva la descrizione di significato,
    // piu' l'indice fra i suoi simili come spareggio. Alla riscrittura del CSS
    // la descrizione regge; alla riscrittura della pagina intera non regge
    // niente, e infatti si riguarda.
    const contatoreRuolo = {};
    const elementi = conRett.slice(0, quantiAlMassimo).map((x, i) => {
      const el = x.el, r = x.r;
      const ruolo = ruoloDi(el);
      const nome = nomeDi(el);
      contatoreRuolo[ruolo + '|' + nome] = (contatoreRuolo[ruolo + '|' + nome] || 0) + 1;

      const stato = [];
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') stato.push('disabilitato');
      if (el.checked || el.getAttribute('aria-checked') === 'true') stato.push('spuntato');
      if (el.getAttribute('aria-expanded') === 'true') stato.push('aperto');
      if (el.required || el.getAttribute('aria-required') === 'true') stato.push('obbligatorio');

      let valore = '';
      if ('value' in el && typeof el.value === 'string') valore = pulisci(el.value);
      else if (el.isContentEditable) valore = pulisci(el.innerText);

      return {
        id: 'E' + (i + 1),
        ruolo,
        nome,
        valore,
        stato,
        // Il rettangolo, arrotondato: serve a ragionare sulla posizione e a
        // cliccare per coordinate quando non c'e' altro modo.
        area: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        // Come ritrovarlo: prima il significato, poi lo spareggio.
        ritrova: {
          ruolo,
          nome,
          quale: contatoreRuolo[ruolo + '|' + nome] - 1,
          // L'id dell'elemento e il name valgono ancora, quando ci sono: non
          // sono fragili come una classe generata.
          idHtml: el.id || '',
          nomeCampo: el.getAttribute('name') || '',
        },
      };
    });

    return {
      ok: true,
      url: location.href,
      titolo: document.title,
      elementi,
      quanti: elementi.length,
      quantiInTutto: grezzi.length,
      // Un testo corto di cosa c'e' scritto: serve al modello per capire DOVE
      // si trova, non solo cosa puo' premere.
      diCosaParla: pulisci((document.querySelector('h1') || {}).innerText || document.title),
    };
  }

  // ── Ritrovare un elemento a partire dal suo nome corto ──
  //
  // Iniettata anche questa. Prova nell'ordine: l'id HTML (se c'era), il nome
  // del campo, poi il significato — ruolo piu' nome accessibile — e come
  // ultima cosa la posizione sullo schermo.
  function _ritrova(ritrova, area, cosaFare, valore) {
    const siVede = (el) => {
      try {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const st = getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
      } catch (_) { return false; }
    };
    const pulisci = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);

    const radici = [document];
    const apriOmbre = (radice, p) => {
      if (p > 4) return;
      let nodi; try { nodi = radice.querySelectorAll('*'); } catch (_) { return; }
      for (const n of nodi) if (n.shadowRoot) { radici.push(n.shadowRoot); apriOmbre(n.shadowRoot, p + 1); }
    };
    apriOmbre(document, 0);

    const tutti = (sel) => {
      const out = [];
      for (const r of radici) { try { out.push(...r.querySelectorAll(sel)); } catch (_) { /* selettore rifiutato */ } }
      return out;
    };

    let el = null, come = '';

    // 1. L'id HTML: se c'e', e' la cosa piu' solida che esista.
    if (!el && ritrova.idHtml) {
      const c = tutti('#' + CSS.escape(ritrova.idHtml))[0];
      if (c && siVede(c)) { el = c; come = 'id'; }
    }
    // 2. Il nome del campo.
    if (!el && ritrova.nomeCampo) {
      const c = tutti(`[name="${CSS.escape(ritrova.nomeCampo)}"]`).filter(siVede);
      if (c.length === 1) { el = c[0]; come = 'nome del campo'; }
      else if (c.length > 1 && c[ritrova.quale]) { el = c[ritrova.quale]; come = 'nome del campo + posizione'; }
    }
    // 3. Il significato: ruolo + nome accessibile. È la strada che sopravvive
    //    alla riscrittura del CSS, ed è quella che usa una persona.
    if (!el && ritrova.nome) {
      const nomeDi = (x) => pulisci(
        x.getAttribute('aria-label') || x.getAttribute('placeholder')
        || x.getAttribute('title') || x.getAttribute('name') || x.innerText);
      const ruoloDi = (x) => {
        const d = x.getAttribute('role');
        if (d) return d.toLowerCase();
        const t = x.tagName.toLowerCase();
        if (t === 'a') return 'link';
        if (t === 'button') return 'button';
        if (t === 'select') return 'combobox';
        if (t === 'textarea') return 'textbox';
        if (t === 'input') {
          const ty = (x.getAttribute('type') || 'text').toLowerCase();
          if (ty === 'checkbox') return 'checkbox';
          if (ty === 'radio') return 'radio';
          if (ty === 'submit' || ty === 'button') return 'button';
          return 'textbox';
        }
        return 'generic';
      };
      const candidati = tutti('a,button,input,select,textarea,[role],[contenteditable="true"]')
        .filter(siVede)
        .filter(x => ruoloDi(x) === ritrova.ruolo && nomeDi(x) === ritrova.nome);
      if (candidati.length) { el = candidati[ritrova.quale] || candidati[0]; come = 'significato'; }
    }
    // 4. La posizione sullo schermo, come ultima spiaggia.
    if (!el && Array.isArray(area) && area[2] > 0) {
      const cx = area[0] + area[2] / 2, cy = area[1] + area[3] / 2;
      const sotto = document.elementFromPoint(cx, cy);
      if (sotto) {
        const vicino = sotto.closest('a,button,input,select,textarea,[role],[contenteditable="true"]') || sotto;
        if (siVede(vicino)) { el = vicino; come = 'posizione sullo schermo'; }
      }
    }

    if (!el) return { ok: false, motivo: `non ritrovo "${ritrova.nome || ritrova.ruolo}" nella pagina` };

    el.scrollIntoView({ block: 'center', behavior: 'instant' });

    if (cosaFare === 'guarda') {
      const r = el.getBoundingClientRect();
      return { ok: true, come, testo: pulisci(el.innerText), valore: el.value || '',
        area: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
    }

    if (cosaFare === 'clicca') {
      // I framework moderni non ascoltano `click`: ascoltano la sequenza del
      // puntatore. E' la stessa scoperta fatta su WhatsApp, dove `.click()`
      // non apriva la conversazione.
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const opt = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
      for (const tipo of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown',
                          'pointerup', 'mouseup', 'click']) {
        const E = tipo.startsWith('pointer') ? PointerEvent : MouseEvent;
        try { el.dispatchEvent(new E(tipo, opt)); } catch (_) { el.click(); break; }
      }
      return { ok: true, come, premuto: pulisci(el.innerText || el.getAttribute('aria-label')) };
    }

    if (cosaFare === 'scrivi') {
      const testo = String(valore == null ? '' : valore);
      if (el.tagName === 'SELECT') {
        const opzioni = [...el.options];
        const scelta = opzioni.find(o => pulisci(o.text).toLowerCase() === testo.toLowerCase())
          || opzioni.find(o => pulisci(o.text).toLowerCase().includes(testo.toLowerCase()))
          || opzioni.find(o => o.value === testo);
        if (!scelta) return { ok: false, motivo: `"${testo}" non è fra le opzioni`,
          opzioni: opzioni.map(o => pulisci(o.text)).slice(0, 20) };
        el.value = scelta.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, come, scelto: pulisci(scelta.text) };
      }
      if (el.type === 'checkbox' || el.type === 'radio') {
        const vuoi = testo === '' || /^(true|1|s[iì]|yes|on)$/i.test(testo);
        if (el.checked !== vuoi) el.click();
        return { ok: true, come, spuntato: el.checked };
      }

      el.focus();
      // Si svuota e si VERIFICA che sia vuoto: il difetto per cui "test cobra"
      // e' finito tre volte nella stessa casella nasce dal non averlo fatto.
      if (el.isContentEditable) {
        el.innerHTML = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        const setta = Object.getOwnPropertyDescriptor(
          el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
        if (setta) setta.call(el, ''); else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      const dentroOra = el.isContentEditable ? el.innerText : el.value;
      if (pulisci(dentroOra)) {
        return { ok: false, motivo: 'la casella non si e\' svuotata: non scrivo sopra a quello che c\'era' };
      }

      if (el.isContentEditable) {
        el.textContent = testo;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: testo }));
      } else {
        const setta = Object.getOwnPropertyDescriptor(
          el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
        if (setta) setta.call(el, testo); else el.value = testo;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Si RILEGGE. Quello che si riferisce e' cio' che c'e' nel campo, non
      // cio' che si e' provato a metterci.
      const dentro = pulisci(el.isContentEditable ? el.innerText : el.value);
      return {
        ok: dentro === pulisci(testo),
        come,
        scritto: dentro,
        motivo: dentro === pulisci(testo) ? undefined
          : `volevo scrivere "${pulisci(testo)}" ma nel campo c'e' "${dentro}"`,
      };
    }

    return { ok: false, motivo: `non so cosa vuol dire "${cosaFare}"` };
  }

  // ══════════════════════════════════════════════════════════════════
  // La parte che gira nel service worker
  // ══════════════════════════════════════════════════════════════════

  /** Guarda la pagina e restituisce l'elenco delle cose su cui si puo' agire. */
  async function guarda(tabId, opzioni = {}) {
    const r = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      args: [opzioni.ancheInvisibili !== true, Number(opzioni.quanti) || 120],
      func: _osserva,
    });
    const visto = r && r[0] && r[0].result;
    if (!visto || !visto.ok) return { ok: false, motivo: 'la pagina non ha risposto allo sguardo' };

    _ultimoSguardo.set(tabId, { quando: Date.now(), url: visto.url, elementi: visto.elementi });

    return {
      ok: true,
      url: visto.url,
      titolo: visto.titolo,
      diCosaParla: visto.diCosaParla,
      quanti: visto.quanti,
      quantiInTutto: visto.quantiInTutto,
      // Al modello si manda una riga per elemento, leggibile: costa poco e si
      // capisce senza documentazione.
      elementi: visto.elementi.map(e => ({
        id: e.id,
        cosa: e.ruolo,
        nome: e.nome,
        valore: e.valore || undefined,
        stato: e.stato.length ? e.stato : undefined,
        area: e.area,
      })),
    };
  }

  /** Agisce su un elemento nominato dallo sguardo precedente. */
  async function agisci(tabId, id, cosaFare, valore) {
    const sguardo = _ultimoSguardo.get(tabId);
    if (!sguardo) {
      return { ok: false, motivo: 'non ho ancora guardato questa pagina',
        cosaFare: 'Chiama prima "guarda", poi agisci su uno degli elementi che ti restituisce.' };
    }
    const voce = sguardo.elementi.find(e => e.id === String(id).toUpperCase());
    if (!voce) {
      return { ok: false, motivo: `"${id}" non e' fra gli elementi che ho visto`,
        disponibili: sguardo.elementi.slice(0, 20).map(e => `${e.id} ${e.ruolo} "${e.nome}"`) };
    }

    const r = await chrome.scripting.executeScript({
      target: { tabId },
      args: [voce.ritrova, voce.area, cosaFare, valore],
      func: _ritrova,
    });
    const esito = (r && r[0] && r[0].result) || { ok: false, motivo: 'la pagina non ha risposto' };
    return { ...esito, elemento: `${voce.id} ${voce.ruolo} "${voce.nome}"` };
  }

  /** Lo sguardo piu' recente su una scheda, senza riguardare. */
  function ultimoSguardo(tabId) { return _ultimoSguardo.get(tabId) || null; }

  /** Dopo una navigazione lo sguardo vecchio non vale piu': sono altre cose. */
  function dimentica(tabId) { _ultimoSguardo.delete(tabId); }

  globalThis.Sguardo = { guarda, agisci, ultimoSguardo, dimentica };
})();
