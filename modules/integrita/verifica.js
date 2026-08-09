// modules/integrita/verifica.js — Il cancello d'avvio.
//
// ══════════════════════════════════════════════════════════════════════
// PERCHE' ESISTE
//
// Otto volte in una settimana e' successa la stessa cosa: una capacita'
// esisteva in cinque registri su sei, COBRA partiva lo stesso, i test
// passavano lo stesso, e il guasto veniva scoperto in produzione giorni dopo.
//
// L'ultima, il 9 agosto: `guarda_pagina` dichiarato, con handler, con rischio,
// dentro tre ambiti — e per il modello non ha funzionato tre volte su tre.
// COBRA ci ha speso 121 secondi mentre Luca guardava sullo schermo la pagina
// che gli veniva detta illeggibile.
//
// Nessuna di quelle otto volte c'e' stato un momento in cui il programma
// avrebbe potuto accorgersene: nessuno confrontava i registri fra loro.
// Adesso quel momento c'e', ed e' l'avvio.
//
// ── PERCHE' NON BLOCCA L'AVVIO (quasi mai) ──
//
// La regola accademica direbbe: configurazione incoerente, boot failed. Qui
// no, e la ragione e' pratica: COBRA gira sul portatile di una persona sola,
// che lo riavvia a mano, a volte alle quattro di notte. Un cancello che
// impedisce l'accensione trasforma una capacita' rotta in "oggi COBRA non c'e'".
//
// La proprieta' che vogliamo — "una capacita' o esiste tutta, o COBRA lo sa
// prima di partire" — si ottiene meglio cosi':
//
//   capacita' incompleta e raggiungibile  →  NON viene consegnata al modello
//   capacita' incompleta gia' fuori uso   →  avviso, resta com'e'
//   manca un pezzo del NUCLEO             →  qui si', l'avvio si ferma
//
// Il danno vero non era che COBRA partisse: era che offrisse al modello uno
// strumento che non poteva funzionare. Quello adesso non succede piu'.
//
// ── LA VERIFICA CHE MANCAVA A TUTTI ──
//
// Le prime sei si fanno leggendo i file. La settima no: l'estensione manda
// gia' l'elenco di cosa sa fare quando si aggancia (`_bridgeCapabilities`) e
// nessuno l'ha mai confrontato con niente. E' l'unica verifica che avrebbe
// preso `guarda_pagina`, perche' li' il file c'era: era il worker in esecuzione
// a non averlo caricato. Si fa all'aggancio del ponte, non all'avvio.
// ══════════════════════════════════════════════════════════════════════

const { tuttiIRegistri } = require('./registri');

/** Senza questi COBRA non e' COBRA: qui l'avvio si ferma davvero. */
const NUCLEO = ['navigate', 'read_page', 'google_search'];

/**
 * Controlla la catena di ogni capacita'.
 *
 * @returns {{bloccanti, daDisabilitare, avvisi, ok, riepilogo}}
 *   daDisabilitare — i nomi da NON consegnare al modello
 */
function verificaCapacita(reg = tuttiIRegistri()) {
  const bloccanti = [];
  const daDisabilitare = [];
  const avvisi = [];

  const haHandler = (n) => { try { return reg.handler.has(n); } catch (_) { return false; } };

  // ── 1. Nomi doppi: due schemi con lo stesso nome ──
  // Vince l'ultimo, in silenzio. Il modello legge la descrizione di uno e
  // chiama l'altro.
  for (const n of reg.schemiDoppi) {
    bloccanti.push({ capacita: n, guasto: 'NOME_DOPPIO',
      dice: 'dichiarato due volte in schemas.js: il modello legge una descrizione e ne chiama un\'altra' });
  }

  // ── 2. Da schema a implementazione ──
  for (const n of reg.schemi) {
    const manca = [];
    if (!haHandler(n)) manca.push('handler');
    if (!reg.rischi.has(n)) manca.push('voce di rischio');
    const inAmbito = !!reg.ambiti[n];
    if (!inAmbito && !reg.gemelliPerdenti.has(n)) manca.push('ambito');

    if (!manca.length) continue;

    if (NUCLEO.includes(n)) {
      bloccanti.push({ capacita: n, guasto: 'NUCLEO_INCOMPLETO', manca,
        dice: `senza ${n} COBRA non sa fare niente: manca ${manca.join(', ')}` });
    } else if (inAmbito) {
      // Raggiungibile dal modello e rotta: e' il caso che fa perdere i minuti.
      daDisabilitare.push({ capacita: n, guasto: 'INCOMPLETA_MA_RAGGIUNGIBILE', manca,
        dice: `manca ${manca.join(', ')}: non la consegno al modello` });
    } else {
      avvisi.push({ capacita: n, guasto: 'INCOMPLETA_E_IRRAGGIUNGIBILE', manca,
        dice: `manca ${manca.join(', ')}, ma non e' in nessun ambito: nessuno la puo' chiamare` });
    }
  }

  // ── 3. Da implementazione a schema ──
  // Un handler senza schema o e' una porta chiusa apposta, o e' codice morto
  // che un giorno qualcuno ricollega senza sapere cosa fa.
  for (const n of reg.handler) {
    if (reg.schemi.includes(n)) continue;
    if (reg.SENZA_SCHEMA_APPOSTA[n]) continue;
    avvisi.push({ capacita: n, guasto: 'HANDLER_ORFANO',
      dice: 'handler senza schema e non dichiarato fra quelli chiusi apposta: o si dichiara, o si toglie' });
  }

  // ── 4. Dal ponte all'estensione ──
  // Un handler che chiede un comando che l'estensione non espone fallisce
  // sempre, e fallisce dicendo poco.
  for (const c of reg.comandiChiesti) {
    if (reg.comandiEstensione.has(c)) continue;
    bloccanti.push({ capacita: c, guasto: 'COMANDO_INESISTENTE',
      dice: `un handler chiede al ponte "${c}", che l'estensione non espone: fallira' sempre` });
  }

  // ── 5. I comandi dell'estensione che nessuno chiama ──
  // Non e' un guasto, e' zavorra: 76 su 115 al 9 agosto. Si conta e basta,
  // perche' la potatura e' un lavoro suo, non una cosa da fare all'avvio.
  const senzaChiamante = [...reg.comandiEstensione].filter((c) => !reg.comandiChiesti.has(c));

  return {
    bloccanti,
    daDisabilitare,
    avvisi,
    ok: bloccanti.length === 0,
    riepilogo: {
      capacita: reg.schemi.length,
      handler: (() => { try { return reg.handler.size; } catch (_) { return 0; } })(),
      comandiEstensione: reg.comandiEstensione.size,
      comandiSenzaChiamante: senzaChiamante.length,
      bloccanti: bloccanti.length,
      disabilitate: daDisabilitare.length,
      avvisi: avvisi.length,
    },
  };
}

/**
 * Il confronto con l'estensione VIVA, all'aggancio del ponte.
 *
 * E' la verifica che avrebbe preso `guarda_pagina`: il file c'era sul disco,
 * ma il service worker in esecuzione non l'aveva caricato. Nessuna lettura dei
 * sorgenti puo' saperlo — solo chiedere a chi sta girando.
 *
 * @param {string[]} capacitaVive  quello che l'estensione dichiara all'aggancio
 * @returns {{ok, mancanti, dice}}
 */
function verificaPonte(capacitaVive, reg = tuttiIRegistri()) {
  const vive = new Set(capacitaVive || []);
  // Se l'estensione non dichiara niente non si puo' concludere niente: e' una
  // versione vecchia del protocollo, non un'estensione rotta.
  if (!vive.size) {
    return { ok: true, mancanti: [], dice: 'l\'estensione non dichiara le sue capacita\': non posso confrontare' };
  }
  const mancanti = [...reg.comandiChiesti].filter((c) => !vive.has(c));
  return {
    ok: mancanti.length === 0,
    mancanti,
    dice: mancanti.length
      ? `l'estensione che gira non sa fare: ${mancanti.join(', ')}. `
        + 'Se questi file esistono sul disco, va ricaricata da chrome://extensions.'
      : 'l\'estensione sa fare tutto quello che gli handler le chiedono',
  };
}

/** Le righe da stampare all'avvio. Poche, e solo se c'e' qualcosa da dire. */
function righeDaStampare(esito) {
  const L = [];
  for (const b of esito.bloccanti) L.push(`[Integrità] ✗ ${b.capacita}: ${b.dice}`);
  for (const d of esito.daDisabilitare) L.push(`[Integrità] ⊘ ${d.capacita} DISABILITATA — ${d.dice}`);
  for (const a of esito.avvisi) L.push(`[Integrità] ! ${a.capacita}: ${a.dice}`);
  const r = esito.riepilogo;
  L.push(`[Integrità] ${r.capacita} capacità · ${r.disabilitate} disabilitate · ${r.avvisi} avvisi`
    + (r.comandiSenzaChiamante ? ` · ${r.comandiSenzaChiamante} comandi estensione senza chiamante` : ''));
  return L;
}

module.exports = { verificaCapacita, verificaPonte, righeDaStampare, NUCLEO };
