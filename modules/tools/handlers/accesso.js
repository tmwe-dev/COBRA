// modules/tools/handlers/accesso.js — Entrare in un sistema chiuso.
//
// Il modello chiama accedi("ups.com"). Da qui in poi la password la maneggia
// SOLO il codice: esce dall'archivio cifrato, va all'estensione, l'estensione
// riempie i campi. Non torna indietro nella risposta, non entra nel prompt,
// non finisce nel log.
//
// Quello che il modello riceve indietro è: fatto, oppure non fatto e perché.

const { Credenziali, dominioDi } = require('../../security/credenziali');
const { RegoleInvio, pausaProssima, certezzaDestinatario, eUnNumero } = require('../../security/regole-invio');

function archivio(ctx) {
  if (!ctx._credenziali) {
    ctx._credenziali = new Credenziali(ctx.dataDir, process.env.COBRA_CREDENZIALI_CHIAVE);
  }
  return ctx._credenziali;
}

// ── I siti che non hanno una password ──
//
// WhatsApp Web non chiede credenziali: si aggancia al telefono e la sessione
// resta nel profilo di Chrome. Chiedere "utente e password" per WhatsApp e'
// una domanda senza risposta, e un campo che la chiede e' un campo che fa
// perdere tempo.
//
// Qui la domanda giusta e' un'altra: sono gia' dentro, o serve che Luca
// inquadri il QR una volta? Il resto lo fa la sessione del browser.
const A_SESSIONE = {
  'web.whatsapp.com': {
    nome: 'WhatsApp Web',
    comando: 'whatsapp_sessione',
    comeSiEntra: 'WhatsApp sul telefono > Dispositivi collegati > Collega un dispositivo',
  },
};

function aSessione(dove) {
  const d = dominioDi(dove);
  if (A_SESSIONE[d]) return A_SESSIONE[d];
  return Object.entries(A_SESSIONE).find(([k]) => d.endsWith('.' + k))?.[1] || null;
}

/**
 * I siti dove non c'è niente da compilare: si guarda solo se la sessione è viva.
 *
 * Chi risponde è `verifySession` dell'estensione WhatsApp del Navigator, copiata
 * dentro la nostra. Non è una scelta di comodo: quella funzione sa cose che a
 * tavolino non si deducono — che una scheda in secondo piano va resa visibile un
 * istante o WhatsApp non disegna niente, che va guardata più volte a distanza
 * crescente, e che il popup "WhatsApp è aperto in un altro browser" va chiuso
 * cliccando "Usa qui" invece di leggerlo come sessione morta.
 *
 * Un rilevamento scritto da capo avrebbe sbagliato tutti e tre i casi.
 */
async function entraConSessione(sito, ctx) {
  if (!ctx.isBridgeReady()) {
    return JSON.stringify({ error: 'Serve il browser collegato.' });
  }
  ctx.emitReasoning(`Guardo se la sessione di ${sito.nome} è aperta`, '📱');

  let st;
  try {
    const r = await ctx.bridgeCommand(sito.comando, {});
    st = r?.result || r;
  } catch (e) {
    return JSON.stringify({ ok: false, motivo: `non riesco a interrogare ${sito.nome}: ${e.message}` });
  }

  if (st?.authenticated) {
    ctx.emitReasoning(`${sito.nome} è aperto`, '✅');
    return JSON.stringify({ ok: true, dominio: dominioDi('web.whatsapp.com'), sessione: true,
      nota: `${sito.nome} è aperto e la sessione è viva. Puoi lavorarci.`,
      come: st.method || null });
  }

  if (st?.reason === 'qr_required') {
    return JSON.stringify({ ok: false, serveUmano: true,
      motivo: `${sito.nome} mostra il codice QR: la sessione è scaduta.`,
      cosaFare: 'Non posso entrare io — su WhatsApp non esiste nessuna password. '
        + `Dillo a Luca: la scheda è già aperta, deve solo inquadrare il QR da ${sito.comeSiEntra}. `
        + 'Poi la sessione resta buona per settimane.' });
  }

  return JSON.stringify({ ok: false,
    motivo: `${sito.nome} non risulta aperto${st?.reason ? ` (${st.reason})` : ''}`,
    dettaglio: st?.message || null,
    cosaFare: 'Guarda la pagina prima di dare per buono che sei dentro.' });
}

async function accedi(args, ctx) {
  const dove = String(args.sito || args.url || '').trim();
  if (!dove) return JSON.stringify({ error: 'Serve il sito su cui entrare.' });

  // Prima di cercare una password: su questo sito ne esiste una?
  const sessione = aSessione(dove);
  if (sessione) return entraConSessione(sessione, ctx);

  const A = archivio(ctx);
  if (!A.attiva) {
    return JSON.stringify({ error: 'L\'archivio degli accessi non è configurato. '
      + 'Luca deve mettere COBRA_CREDENZIALI_CHIAVE nel file .env e aggiungere l\'accesso dalle impostazioni.' });
  }

  const c = A.per(dove);
  if (!c) {
    return JSON.stringify({
      error: `Per ${dove} non ho un accesso salvato.`,
      cosaFare: 'Dillo a Luca: può aggiungerlo dalle impostazioni, sezione Accessi. '
        + 'Nel frattempo prova a lavorare sulle pagine pubbliche del sito.',
      sitiChePosso: A.elenco().map(v => v.dominio),
    });
  }

  if (!ctx.isBridgeReady()) {
    return JSON.stringify({ error: 'Serve il browser collegato per entrare in un sito.' });
  }

  ctx.emitReasoning(`Entro su ${c.dominio} come ${c.utente}`, '🔑');
  ctx.log(`[Accesso] ${c.dominio} — utente ${c.utente}`);   // la password NON si registra

  try {
    // La password attraversa solo il ponte fino all'estensione, che la scrive
    // nel campo. Non torna in nessuna risposta.
    const r = await ctx.bridgeCommand('compila_accesso', {
      url: c.url, utente: c.utente, password: c.password,
    });
    const esito = r?.result || r;

    if (esito?.ok) {
      ctx.emitReasoning(`Sono dentro su ${c.dominio}`, '✅');
      return JSON.stringify({ ok: true, dominio: c.dominio, utente: c.utente,
        nota: 'Accesso fatto. Adesso puoi lavorare sulle pagine riservate di questo sito.' });
    }
    return JSON.stringify({ ok: false, dominio: c.dominio,
      motivo: esito?.motivo || 'l\'accesso non è andato a buon fine',
      cosaFare: esito?.serveUmano
        ? 'Il sito chiede una verifica che non posso fare io (codice, doppia autenticazione). Chiedi a Luca di entrare lui.'
        : 'Riferisci a Luca cosa è successo: forse la password è cambiata.' });
  } catch (e) {
    return JSON.stringify({ ok: false, motivo: `non sono riuscito a entrare: ${e.message}` });
  }
}

/** Su quali sistemi chiusi COBRA può entrare. Nessuna password, solo i nomi. */
async function sitiConAccesso(args, ctx) {
  const A = archivio(ctx);
  if (!A.attiva) return JSON.stringify({ ok: true, siti: [], nota: 'archivio non configurato' });
  return JSON.stringify({ ok: true, siti: A.elenco().map(v => ({ dominio: v.dominio, utente: v.utente, note: v.note })) });
}

module.exports = { accedi, siti_con_accesso: sitiConAccesso, whatsapp_scrivi, linkedin_scrivi, conto_invii, A_SESSIONE };


// ── Scrivere su WhatsApp ──
//
// Il modello NON manda messaggi. Chiede di mandarli, e qui si decide.
//
// Le regole sono in modules/security/regole-invio.js e stanno nel CODICE, non
// nel prompt. Un limite scritto nel prompt e' un consiglio: il modello lo legge,
// lo capisce, e in un turno affollato lo dimentica. Un limite scritto qui e' un
// muro, e non dipende da quanto il modello e' attento oggi.
//
// Il conto degli invii sta su disco, quindi un riavvio non lo azzera. Nel
// Navigator i contatori erano in memoria: un limite giornaliero che si azzera
// a ogni riavvio non e' un limite giornaliero.
async function whatsapp_scrivi(args, ctx) {
  const a = String(args.a || args.numero || '').trim();
  const testo = String(args.testo || args.messaggio || '');
  let conosciuto = args.conosciuto === true;

  // ── Prima di tutto: sono sicuro di CHI ──
  //
  // Regola di Luca, 7 agosto: non si manda a una persona di cui non si e'
  // certi senza che sia lui a confermare.
  //
  // Con un numero non c'e' ambiguita'. Con un nome si va a guardare l'elenco
  // chat vero: se corrisponde a uno solo si procede, altrimenti ci si ferma.
  // Non si sceglie il primo della lista — un messaggio mandato alla persona
  // sbagliata non si richiama.
  let destinatario = a;

  // ── Prima la rubrica ──
  //
  // Chi ha gia' scritto a Luca e' stato annotato durante le letture. Guardare
  // qui costa niente e risolve il caso normale: se fra tutti i "Jose" ce n'e'
  // uno solo che ha davvero scambiato messaggi, e' lui. Prima si leggevano
  // ogni volta duecento chat per finire in venti omonimi e fermarsi.
  //
  // Non salta nessun controllo: e' lo STESSO controllo, fatto su un fatto
  // registrato invece che su una scansione ripetuta da capo.
  let _rubrica = null;
  if (!args.confermato && !eUnNumero(a)) {
    try {
      const { Rubrica } = require('../../security/rubrica');
      _rubrica = new Rubrica(ctx.DATA_DIR || ctx.dataDir || './data');
      const d = _rubrica.destinatario(a, 'whatsapp');
      if (d.trovato) {
        destinatario = d.voce.numero || d.voce.nome;
        args.confermato = true;                  // gia' verificato, qui sopra
        if (d.voce.haScrittoLui) conosciuto = true;   // e' un fatto, non una stima
        ctx.emitReasoning(`"${a}" e' ${d.voce.nome} — ${d.come}`, '📇');
      }
    } catch (_) { /* senza rubrica si prosegue come prima */ }
  }

  if (!args.confermato) {
    let candidati = null;
    if (!eUnNumero(a) && ctx.isBridgeReady()) {
      try {
        const el = await ctx.bridgeCommand('whatsapp_elenco_chat', { quante: 200 });
        const dati = el?.result || el;
        if (dati?.ok && Array.isArray(dati.chat)) {
          candidati = dati.chat.map(c => c.nome);

          // ── Gia' che le ho lette, me le ricordo ──
          //
          // Verificato il 7 agosto a fine giornata: 64 chat lette e ZERO
          // contatti WhatsApp in rubrica. La rubrica si riempiva solo dalle
          // letture dei messaggi, e l'elenco chat — che e' la fonte piu' ricca
          // che esista, con tutti i nomi in un colpo — passava di qui e veniva
          // buttato.
          //
          // Una chat nell'elenco significa che quella conversazione esiste ed
          // e' stata usata: e' esattamente l'informazione che serve la volta
          // dopo per non dover rileggere duecento righe.
          try {
            const { Rubrica } = require('../../security/rubrica');
            const R = _rubrica || new Rubrica(ctx.DATA_DIR || ctx.dataDir || './data');
            const n = R.daLettura(dati.chat.map(c => ({ ...c, haScritto: true })), 'whatsapp');
            if (n) ctx.emitReasoning(`Segnati ${n} contatti WhatsApp in rubrica`, '📇');
          } catch (_) { /* la rubrica e' una comodita', non una condizione */ }
        }
      } catch (_) { /* senza elenco resta "non certo", che e' il default giusto */ }
    }
    const certezza = certezzaDestinatario(a, candidati);
    if (!certezza.certo) {
      ctx.emitReasoning(`Non sono sicuro di chi sia "${a}"`, '🤔');
      return JSON.stringify({
        ok: false,
        serveConferma: true,
        motivo: certezza.perche,
        candidati: certezza.candidati || null,
        cosaFare: certezza.cosaFare,
        nota: 'NON e\' un rifiuto e NON serve un numero di telefono: serve solo '
          + 'sapere QUALE dei contatti qui sopra e\'. Elenca a Luca i nomi in '
          + '"candidati", chiedigli quale, e appena risponde richiama '
          + 'whatsapp_scrivi con quel nome esatto e conosciuto=true. '
          + 'Non dire mai "non posso inviare messaggi WhatsApp": puoi, '
          + 'ti manca solo il destinatario.',
      });
    }
    destinatario = certezza.destinatario;
    ctx.emitReasoning(`Destinatario sicuro: ${destinatario} (${certezza.come})`, '🎯');
  }

  // ── Chi sta guidando? ──
  //
  // Se questo turno e' partito da un compito programmato, il programma lavora
  // da solo e valgono tutte le regole. Se e' partito perche' Luca ha scritto
  // nella chat, l'orario non conta: c'e' una persona che sta lavorando.
  //
  // Nel dubbio si sceglie 'automatico', perche' sbagliare da quella parte
  // costa un'attesa mentre sbagliare dall'altra puo' costare l'account.
  const modo = ctx.session?.automatico === true ? 'automatico' : 'diretto';

  const R = ctx._regoleWa || (ctx._regoleWa = new RegoleInvio(ctx.dataDir, 'whatsapp'));
  const verdetto = R.puoScrivere({ a: destinatario, testo, conosciuto, modo });

  if (!verdetto.si) {
    ctx.emitReasoning(`Non mando: ${verdetto.motivo}`, '🛑');
    ctx.log(`[Regole] invio bloccato — ${verdetto.motivo}`);
    return JSON.stringify({
      ok: false,
      bloccato: true,
      motivo: verdetto.motivo,
      cosaFare: verdetto.cosaFare,
      nota: 'Questa e\' una regola del programma, non una mia esitazione. '
        + 'Se vuoi mandarlo lo stesso, mandalo tu da WhatsApp.',
    });
  }

  if (!ctx.isBridgeReady()) {
    return JSON.stringify({ ok: false, motivo: 'il browser non e\' collegato' });
  }

  // La pausa: non si scrive raffica. Chi manda venti messaggi in venti secondi
  // non sembra una persona, e non viene trattato come una persona.
  const pausa = pausaProssima('whatsapp', modo);
  ctx.emitReasoning(`Aspetto ${pausa}s prima di scrivere a ${destinatario}`, '⏳');
  await new Promise(r => setTimeout(r, pausa * 1000));

  try {
    // ── Con un numero la strada vecchia, con un nome la nuova ──
    //
    // Rileggendo il codice a fine giornata ho trovato l'asimmetria: LinkedIn
    // passa da Pagine, che verifica di essere sulla scheda giusta e con dentro
    // la roba; WhatsApp passava da sendWhatsAppMessage del Navigator, che
    // prende `existingTabs[0]` — la PRIMA scheda che trova. Luca ne ha due
    // aperte, e se la prima e' ferma sul QR o svuotata da Chrome l'invio
    // fallisce, oppure scrive nella conversazione sbagliata.
    //
    // Su una lettura un difetto cosi' costa un errore. Su un invio costa un
    // messaggio mandato alla persona sbagliata, e quello non si richiama.
    //
    // Con un NUMERO la strada del Navigator resta la migliore: /send?phone=
    // apre la chat esatta, senza ambiguita' possibile. Con un NOME si passa da
    // whatsapp_rispondi, che apre la chat, CONTROLLA il titolo in cima e solo
    // allora scrive.
    const r = eUnNumero(destinatario)
      ? await ctx.bridgeCommand('whatsapp_scrivi', { a: destinatario, testo, modo })
      : await ctx.bridgeCommand('whatsapp_rispondi', { nome: destinatario, testo });
    const esito = r?.result || r;

    // Il nome corrisponde a piu' chat: non si sceglie, si chiede.
    if (esito && esito.ambiguo) {
      return JSON.stringify({
        ok: false, serveConferma: true,
        motivo: esito.motivo, candidati: esito.candidati,
        cosaFare: 'Elenca i nomi a Luca, chiedi quale, e richiama con quel nome esatto.',
      });
    }

    if (esito?.success || esito?.ok) {
      R.registra({ a: destinatario, testo });   // si registra SOLO se e' partito davvero
      const conto = R.riepilogo(new Date(), modo);
      ctx.emitReasoning(`Mandato a ${destinatario} (${conto.oggi}/${conto.limiteGiorno} oggi)`, '✅');
      return JSON.stringify({ ok: true, a: destinatario, oggi: conto.oggi, limite: conto.limiteGiorno });
    }
    // ── Un fallimento che non inviti a fare danni ──
    //
    // Il 7 agosto, quando questo strumento non riusciva, il modello "rimediava"
    // da solo: navigava su linkedin.com, chiudeva banner, lanciava
    // linkedin_search, apriva la ricerca profili — e poi richiamava lo
    // strumento, che ora non trovava piu' la messaggistica perche' la scheda
    // era finita sulla ricerca. Un giro chiuso, tre volte di fila, e il
    // messaggio mai partito.
    //
    // Non era disobbedienza: era un messaggio d'errore che diceva "non ci sono
    // riuscito" senza dire cosa NON fare. Un modello che vuole aiutare, davanti
    // a un buco, lo riempie con quello che ha — e aveva navigate e
    // linkedin_search a portata di mano.
    return JSON.stringify({
      ok: false,
      motivo: esito?.error || esito?.motivo || 'non e\' partito',
      // ── Non "fermati": "fallo come lo faresti su qualsiasi altro sito" ──
      //
      // La prima versione di questo messaggio diceva NON navigare, NON cercare,
      // riferisci e basta. Serviva a spezzare un giro senza uscita, e in quello
      // funzionava — ma era la cura sbagliata, perche' toglieva l'unica cosa
      // che rende COBRA utile: sa guardare una pagina e capirla.
      //
      // Su Google Voli compila un'interfaccia che nessuno gli ha descritto.
      // Quella capacita' non sparisce perche' il sito e' LinkedIn. La
      // scorciatoia che ha appena fallito era solo una scorciatoia.
      cosaFare: 'Questa era la strada veloce, e non ha funzionato. NON e\' finita: '
        + 'adesso fai quello che faresti su un sito qualsiasi. Vai sulla pagina dove '
        + 'si scrive, guardala con get_page_snapshot, trova la casella di scrittura '
        + '(un campo di testo in fondo alla conversazione) e il pulsante Invia, '
        + 'scrivi con type_human, e VERIFICA che il messaggio sia comparso prima di '
        + 'dire che e\' partito. Il manuale "scrivere-ovunque" ha il metodo completo.',
      NON_FARE: 'Non cercare profili e non girovagare per il sito sperando di '
        + 'arrivarci: vai dritto alla pagina dei messaggi. E non aggirare le regole '
        + 'di invio passando dai comandi generici — destinatario, limiti e ritmo '
        + 'restano decisi dal programma anche quando scrivi a mano.',
    });
  } catch (e) {
    return JSON.stringify({ ok: false, motivo: e.message,
      NON_FARE: 'NON navigare e NON cercare profili: riferisci il motivo a Luca.' });
  }
}

/** Com'e' messo il conto degli invii — senza che Luca lo debba chiedere. */
async function conto_invii(args, ctx) {
  const modo = ctx.session?.automatico === true ? 'automatico' : 'diretto';
  const R = ctx._regoleWa || (ctx._regoleWa = new RegoleInvio(ctx.dataDir, 'whatsapp'));
  return JSON.stringify(R.riepilogo(new Date(), modo));
}


// ── Scrivere su LinkedIn ──
//
// Stessa impalcatura di WhatsApp, numeri diversi: 50 al giorno ma solo 3
// all'ora, 300 caratteri, finestra 9-19. Vengono dalla "REGOLA TASSATIVA"
// scritta in send-linkedin/index.ts:1-13 del Navigator — quella pero' e' vera:
// e' l'unica policy che la' e' scritta E applicata, anche se il conteggio
// giornaliero legge una tabella vuota e quindi non scatta mai.
//
// La differenza di fondo con WhatsApp: su LinkedIn scrivere a chi non ti
// conosce e' normale, il rischio e' la frequenza. Su WhatsApp e' l'opposto.
// Per questo `soloSeConosciuto` e' false qui e true la'.
//
// ── Anche il nome va bene, e non e' un cedimento ──
//
// Qui si pretendeva un linkedin.com/in/qualcuno, e la motivazione scritta era
// "con un nome soltanto rischierei la persona sbagliata". Ragionevole in
// astratto, sbagliata nei fatti: il 7 agosto ho aperto la messaggistica di
// Luca e ho cercato i link ai profili. Sono zero. LinkedIn non li mette da
// nessuna parte in quella pagina — c'e' solo il numero della conversazione,
// e compare nell'indirizzo dopo averla aperta.
//
// Cioe': COBRA poteva leggere i messaggi ma non rispondere a nessuno, perche'
// chiedeva un dato che la pagina non produce. Due meta' che non si toccavano.
//
// Adesso si accetta il nome, e la verifica di CHI sia si fa come su WhatsApp:
// prima la rubrica, poi l'elenco delle conversazioni. Un profilo, se c'e',
// resta la strada piu' sicura e passa diretto.
async function linkedin_scrivi(args, ctx) {
  let url = String(args.url || args.profilo || args.a || args.nome || '').trim();
  const testo = String(args.testo || args.messaggio || '');
  const eUnProfilo = /^https?:\/\/([\w-]+\.)?linkedin\.com\/(in|pub)\//i.test(url);

  if (!url) {
    return JSON.stringify({ ok: false, motivo: 'non mi hai detto a chi scrivere' });
  }

  if (!eUnProfilo && !args.confermato) {
    // 1. La rubrica: chi ha gia' scritto a Luca su LinkedIn.
    let risolto = null;
    try {
      const { Rubrica } = require('../../security/rubrica');
      const R = new Rubrica(ctx.DATA_DIR || ctx.dataDir || './data');
      const d = R.destinatario(url, 'linkedin');
      if (d.trovato) { risolto = d.voce.url || d.voce.nome; ctx.emitReasoning(`"${url}" e' ${d.voce.nome} — ${d.come}`, '📇'); }
    } catch (_) { /* si prosegue leggendo la pagina */ }

    // 2. Altrimenti l'elenco vero delle conversazioni.
    if (!risolto && ctx.isBridgeReady()) {
      let candidati = null;
      try {
        const el = await ctx.bridgeCommand('linkedin_elenco_chat', { quante: 100 });
        const dati = el?.result || el;
        if (dati?.ok && Array.isArray(dati.chat)) candidati = dati.chat.map(c => c.nome);
      } catch (_) { /* senza elenco resta "non certo", che e' il default giusto */ }

      const certezza = certezzaDestinatario(url, candidati);
      if (!certezza.certo) {
        ctx.emitReasoning(`Non sono sicuro di chi sia "${url}" su LinkedIn`, '🤔');
        return JSON.stringify({
          ok: false, serveConferma: true,
          motivo: certezza.perche,
          candidati: certezza.candidati || null,
          cosaFare: certezza.cosaFare,
          nota: 'NON e\' un rifiuto e NON serve l\'indirizzo di un profilo: la '
            + 'messaggistica di LinkedIn non lo espone. Serve solo sapere QUALE '
            + 'delle conversazioni e\'. Elenca i nomi a Luca, chiedi quale, e '
            + 'richiama linkedin_scrivi con quel nome esatto e confermato=true.',
        });
      }
      risolto = certezza.destinatario;
    }

    if (risolto) url = risolto;
  }

  const modo = ctx.session?.automatico === true ? 'automatico' : 'diretto';
  const R = ctx._regoleLi || (ctx._regoleLi = new RegoleInvio(ctx.dataDir, 'linkedin'));
  const verdetto = R.puoScrivere({ a: url, testo, conosciuto: true, modo });
  if (!verdetto.si) {
    ctx.emitReasoning(`Non mando: ${verdetto.motivo}`, '🛑');
    ctx.log(`[Regole] LinkedIn bloccato — ${verdetto.motivo}`);
    return JSON.stringify({ ok: false, bloccato: true, motivo: verdetto.motivo, cosaFare: verdetto.cosaFare });
  }

  if (!ctx.isBridgeReady()) return JSON.stringify({ ok: false, motivo: 'il browser non e\' collegato' });

  const pausa = pausaProssima('linkedin', modo);
  ctx.emitReasoning(`Aspetto ${pausa}s prima di scrivere su LinkedIn`, '⏳');
  await new Promise(r => setTimeout(r, pausa * 1000));

  try {
    // ── Con un nome si scrive nella conversazione, non si cerca il profilo ──
    //
    // Qui c'era una sola strada: il comando `linkedin_scrivi` del Navigator,
    // che pretende l'indirizzo di un profilo, e se non ce l'ha va sul feed a
    // cercarlo. Il 7 agosto Luca me l'ha visto fare: la rubrica aveva gia'
    // risolto "Samuel Chen", e COBRA invece di scrivergli si e' messo a
    // navigare su linkedin.com, togliere banner e lanciare linkedin_search.
    //
    // Il messaggio non e' mai partito, e non poteva: la messaggistica di
    // LinkedIn non espone i profili, quindi quella strada e' senza uscita per
    // definizione. Avevo scritto `linkedin_rispondi` nell'estensione — apre la
    // conversazione per nome e scrive nella casella — e non l'avevo mai
    // collegato qui. Costruire una strada e lasciare il traffico sull'altra.
    //
    // Adesso: se il destinatario e' un nome si usa la conversazione; se e' un
    // profilo vero resta la strada vecchia, che li' ha senso.
    // ── Anche con un indirizzo di profilo si passa di qui ──
    //
    // C'era un bivio: nome → linkedin_rispondi (che apre la conversazione,
    // LEGGE il nome in cima e se non riesce a leggerlo NON scrive), indirizzo
    // di profilo → linkedin_scrivi, il comando vendorizzato. Quella seconda
    // strada non ha ritmo umano e non passa dalla mappa dei selettori.
    //
    // Cioe': bastava che il modello scrivesse l'indirizzo invece del nome —
    // ed e' la cosa piu' naturale quando l'indirizzo ce l'ha — per uscire dal
    // percorso controllato senza che nessuno se ne accorgesse. Una porta di
    // servizio aperta dal formato di un argomento.
    //
    // Adesso la strada e' una. Se arriva un indirizzo, linkedin_rispondi lo
    // riceve come `url`: apre il profilo, verifica lo slug, e scrive.
    const eUnProfiloVero = /^https?:\/\/([\w-]+\.)?linkedin\.com\/(in|pub)\//i.test(url);
    const r = eUnProfiloVero
      ? await ctx.bridgeCommand('linkedin_rispondi', { url, testo })
      : await ctx.bridgeCommand('linkedin_rispondi', { nome: url, testo });
    const esito = r?.result || r;

    // Il nome corrisponde a piu' conversazioni: non si sceglie, si chiede.
    if (esito && esito.ambiguo) {
      return JSON.stringify({
        ok: false, serveConferma: true,
        motivo: esito.motivo, candidati: esito.candidati,
        cosaFare: 'Elenca i nomi a Luca, chiedi quale, e richiama con quel nome esatto.',
      });
    }
    if (esito?.success || esito?.ok) {
      R.registra({ a: url, testo });
      const conto = R.riepilogo(new Date(), modo);
      ctx.emitReasoning(`Mandato (${conto.oggi}/${conto.limiteGiorno} oggi)`, '✅');
      return JSON.stringify({ ok: true, a: url, oggi: conto.oggi, limite: conto.limiteGiorno });
    }
    return JSON.stringify({ ok: false, motivo: esito?.error || esito?.motivo || 'non e\' partito' });
  } catch (e) {
    return JSON.stringify({ ok: false, motivo: e.message });
  }
}
