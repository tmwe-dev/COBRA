// tests/test-diario.js — Il diario dice sempre perche'.
//
// I casi qui sotto non sono inventati: sono le frasi VERE con cui gli handler
// di COBRA hanno fallito, prese dal registro di produzione e dalle prove del
// 7, 8 e 9 agosto. Se la tassonomia non le riconosce, non serve a niente:
// classificare fallimenti immaginari e' facile, sono quelli veri che contano.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { classifica, FAMIGLIE } = require('../modules/diario/tassonomia');
const { Giornale, potaArgomenti } = require('../modules/diario/giornale');

let passati = 0;
const fallimenti = [];
function prova(nome, fn) {
  try { fn(); passati++; }
  catch (e) { fallimenti.push(`${nome}: ${e.message}`); }
}

// ── I fallimenti veri, con la famiglia che devono avere ──────────────────

const VERI = [
  // 9 agosto, prova skyscanner
  ['{"ok":false,"motivo":"non ho ancora guardato questa pagina","cosaFare":"Chiama guarda_pagina"}',
    'PREREQUISITO_MANCANTE', 'DEPENDENCY'],
  // 7 agosto, invio a Brandon
  ['{"error":"linkedin_scrivi: Extension timeout (25s)"}', 'TEMPO_SCADUTO', 'TRANSIENT'],
  // 9 agosto, whatsapp per numero
  ['{"ok":false,"motivo":"non ti ha mai scritto e non risulta in rubrica"}',
    'DESTINATARIO_NON_SICURO', 'PERMISSION'],
  // 5 agosto, ricerche voli
  ['{"ok":false,"motivo":"Google Voli carica i prezzi con javascript e non riesco a leggerli"}',
    'PAGINA_VUOTA', 'STRATEGY'],
  ['{"ok":false,"motivo":"probabile blocco anti-bot"}', 'BLOCCO_ANTI_ROBOT', 'STRATEGY'],
  // 7 agosto, report Emirates
  ['{"ok":false,"motivo":"non ho trovato almeno due risultati concreti sui prezzi"}',
    'DATO_ASSENTE', 'STRATEGY'],
  // ponte
  ['{"ok":false,"motivo":"il browser non e\' collegato","cosaFare":"Apri COBRA nel browser"}',
    'PONTE_ASSENTE', 'DEPENDENCY'],
  ['{"error":"Bridge not ready"}', 'PONTE_ASSENTE', 'DEPENDENCY'],
  // guardia della sicurezza
  ['{"status":"pending_confirmation","pending_action_id":"x"}', 'CONFERMA_RICHIESTA', 'PERMISSION'],
  ['{"error":"Azione rifiutata: dominio non in whitelist","rejected":true}',
    'AZIONE_RIFIUTATA', 'PERMISSION'],
  // rete
  ['{"error":"gemini: fetch failed"}', 'RETE_CADUTA', 'TRANSIENT'],

  // ── Trovati dal diario stesso, alla sua prima ora di vita ──
  //
  // Erano finiti tutti e tre in SCONOSCIUTO: cercavo le parole che avrei
  // scritto io, non quelle che gli handler scrivono davvero. Il conteggio
  // degli SCONOSCIUTO serve esattamente a questo, e ha funzionato subito.
  ['{"ok":false,"motivo":"Nessuna pagina caricata. Usa navigate prima."}',
    'PREREQUISITO_MANCANTE', 'DEPENDENCY'],
  ['{"ok":false,"motivo":"Nessuna pagina attiva. Usa navigate prima."}',
    'PREREQUISITO_MANCANTE', 'DEPENDENCY'],
  ['{"ok":false,"motivo":"URL bloccato: Hostname o protocollo non consentito"}',
    'AZIONE_RIFIUTATA', 'PERMISSION'],

  // ── Prova voli del 9 agosto, dopo il diario ──
  //
  // Erano finiti in SCONOSCIUTO. Sono due messaggi che portano gia' la
  // soluzione con se': dirli "sconosciuti" sprecava un suggerimento scritto.
  ['{"ok":false,"motivo":"inspect_dom_js è read-only. Per modifiche usa mutate_dom_js."}',
    'STRUMENTO_SBAGLIATO', 'STRATEGY'],
  ['{"ok":false,"motivo":"\\"E7\\" non e\' fra gli elementi che ho visto"}',
    'ELEMENTO_NON_VISTO', 'STRATEGY'],
];

prova('i fallimenti veri sono tutti riconosciuti', () => {
  for (const [grezzo, code, famiglia] of VERI) {
    const r = classifica(grezzo);
    assert.strictEqual(r.ok, false, `doveva essere un fallimento: ${grezzo}`);
    assert.strictEqual(r.code, code, `${grezzo}\n  atteso ${code}, ottenuto ${r.code}`);
    assert.strictEqual(r.famiglia, famiglia, `${code}: famiglia ${r.famiglia} invece di ${famiglia}`);
  }
});

prova('nessun fallimento vero finisce in SCONOSCIUTO', () => {
  const ciechi = VERI.filter(([g]) => classifica(g).code === 'SCONOSCIUTO');
  assert.strictEqual(ciechi.length, 0, `${ciechi.length} fallimenti veri non riconosciuti`);
});

prova('ogni fallimento ha sempre un motivo, anche quando non ha un codice', () => {
  const r = classifica('{"ok":false}');
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason && r.reason.length > 0, 'un fallimento senza motivo non e\' ammesso');
  assert.ok(r.suggested_next && r.suggested_next.length > 0, 'deve dire cosa fare dopo');
});

prova('un successo resta un successo', () => {
  for (const buono of ['{"ok":true,"quanti":40}', '{"elementi":[]}', 'testo semplice', '']) {
    assert.strictEqual(classifica(buono).ok, true, `${buono} non doveva essere un fallimento`);
  }
});

prova('ok:false non passa mai per successo', () => {
  assert.strictEqual(classifica('{"ok":false,"motivo":"x"}').ok, false);
});

prova('un handler che dichiara il codice vince sulla deduzione', () => {
  // "timeout" nel testo direbbe TEMPO_SCADUTO, ma l'handler sa meglio.
  const r = classifica('{"ok":false,"code":"BLOCCO_ANTI_ROBOT","motivo":"timeout dopo il captcha"}');
  assert.strictEqual(r.code, 'BLOCCO_ANTI_ROBOT');
  assert.strictEqual(r.dichiarato, true);
});

prova('ogni famiglia dice chi deve fare la prossima mossa', () => {
  for (const [nome, f] of Object.entries(FAMIGLIE)) {
    assert.ok(f.chiFa, `${nome} non dice chi fa`);
    assert.ok(typeof f.riprovabile === 'boolean', `${nome} non dice se si riprova`);
  }
});

prova('PERMISSION e IMPOSSIBLE non si riprovano mai da soli', () => {
  assert.strictEqual(FAMIGLIE.PERMISSION.riprovabile, false);
  assert.strictEqual(FAMIGLIE.IMPOSSIBLE.riprovabile, false);
});

// ── La potatura: il diario non contiene segreti ──────────────────────────

prova('password, chiavi e gettoni non entrano nel diario', () => {
  const p = potaArgomenti({ password: 'segreta123', api_key: 'sk-abc', token: 'xyz', url: 'https://x.it' });
  for (const k of ['password', 'api_key', 'token']) {
    assert.strictEqual(p[k], '‹nascosto›', `${k} e' finito nel diario in chiaro`);
  }
  assert.strictEqual(p.url, 'https://x.it', 'l\'url invece serve');
});

prova('del testo di un messaggio si tiene la misura, non le parole', () => {
  const p = potaArgomenti({ testo: 'Ciao Andrea, auguri di Natale dal presidente', a: 'Andrea Anastasi' });
  assert.ok(/caratteri/.test(p.testo), 'il testo del messaggio non deve comparire');
  assert.ok(!/Natale/.test(JSON.stringify(p)), 'il contenuto e\' trapelato');
  assert.strictEqual(p.a, 'Andrea Anastasi', 'il destinatario invece serve per capire');
});

// ── Il registro su disco ─────────────────────────────────────────────────

prova('scrive, rilegge e riassume', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diario-'));
  const g = new Giornale(dir);

  g.registra({ capacita: 'navigate', argomenti: { url: 'https://a.it' },
    esito: classifica('{"ok":true}'), durataMs: 120 });
  g.registra({ capacita: 'guarda_pagina', argomenti: { quanti: 50 },
    esito: classifica('{"ok":false,"motivo":"il browser non e\' collegato"}'), durataMs: 900 });
  g.registra({ capacita: 'guarda_pagina', argomenti: { quanti: 50 },
    esito: classifica('{"ok":false,"motivo":"il browser non e\' collegato"}'), durataMs: 800 });

  const righe = g.leggi();
  assert.strictEqual(righe.length, 3);
  assert.strictEqual(righe[1].code, 'PONTE_ASSENTE');
  assert.ok(righe[1].motivo, 'la riga deve portarsi dietro il motivo');
  assert.ok(righe[1].prossimaMossa, 'e cosa fare dopo');

  const r = g.riepilogo(24);
  assert.strictEqual(r.righe, 3);
  assert.strictEqual(r.falliti, 2);
  assert.strictEqual(r.sconosciuti, 0);
  assert.strictEqual(r.peggiori[0].nome, 'guarda_pagina');
  assert.strictEqual(r.peggiori[0].falliti, 2);
  assert.strictEqual(r.codici[0].code, 'PONTE_ASSENTE');

  fs.rmSync(dir, { recursive: true, force: true });
});

prova('se il disco non collabora, il lavoro continua', () => {
  const g = new Giornale('/percorso/che/non/esiste/e/non/si/puo/creare\0');
  g.registra({ capacita: 'x', esito: classifica('{"ok":false}'), durataMs: 1 });
  assert.strictEqual(g._rotto, true, 'doveva arrendersi senza lanciare');
});

prova('il diario e\' agganciato all\'esecutore, non ai singoli handler', () => {
  const t = fs.readFileSync(path.join(__dirname, '../modules/tools/executor.js'), 'utf8');
  assert.ok(/ctx\.giornale/.test(t), 'executor.js non scrive nel diario');
  assert.ok(/classificaEsito/.test(t), 'executor.js non classifica l\'esito');
  // Il punto: UNO solo. Se qualcuno lo copia negli handler, torniamo a 91 posti.
  const negliHandler = fs.readdirSync(path.join(__dirname, '../modules/tools/handlers'))
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /ctx\.giornale\.registra/.test(fs.readFileSync(path.join(__dirname, '../modules/tools/handlers', f), 'utf8')));
  assert.strictEqual(negliHandler.length, 0,
    `il diario va scritto solo dall'esecutore, invece lo scrivono anche: ${negliHandler.join(', ')}`);
});

// ── Esito ────────────────────────────────────────────────────────────────

if (fallimenti.length) {
  console.log(`\n✗ diario: ${passati} passati, ${fallimenti.length} falliti`);
  for (const f of fallimenti) console.log('   ' + f);
  process.exitCode = 1;
} else {
  console.log(`✓ diario: ${passati} prove passate`);
}

module.exports = { passati, fallimenti };
