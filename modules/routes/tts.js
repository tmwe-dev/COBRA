// modules/routes/tts.js — /api/tts, /api/tts/voices
// Source: server.js lines 8350-8440

const { COBRA_DEFAULTS } = require('../config');

function register(router, ctx) {
  // ── /api/tts — ElevenLabs TTS ──
  router.post('/api/tts', async (body, res) => {
    try {
      const richiesta = JSON.parse(body);
      const { text } = richiesta;
      if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: 'No text' })); return; }
      if (!ctx.aiKeys.elevenlabsKey) { res.writeHead(400); res.end(JSON.stringify({ error: 'ElevenLabs API key non configurata' })); return; }

      const _ttsStart = Date.now();

      // La lingua era inchiodata a 'it' e la voce veniva solo dalla
      // configurazione: se il Collega rispondeva in inglese a un fornitore
      // vietnamita, la voce leggeva l'inglese con la fonetica italiana.
      // Adesso chi scrive la frase decide anche come va detta; se non lo
      // dichiara, valgono le impostazioni di sempre.
      const vociNote = ctx.session.vociDisponibili || null;
      // ── La voce e' SEMPRE quella di un agente ──
      //
      // Prima: `ctx.aiKeys.elevenlabsVoiceId || COBRA_DEFAULTS.ELEVENLABS_VOICE_ID`.
      // Il primo e' sempre stato vuoto (nessuno lo riempie), quindi valeva la
      // costante — uScy1bXtKz8vPzfdFsFw, che non e' la voce di nessuno dei
      // quattro agenti. COBRA parlava con la voce di uno sconosciuto, sempre.
      //
      // Adesso il punto di partenza e' l'agente predefinito, cioe' COBRA.
      // Nessuna voce senza un nome dietro.
      const { quello, predefinito } = require('../config/agenti');
      let voiceId = quello(ctx._agenteScelto).voce || ctx.aiKeys.elevenlabsVoiceId
        || predefinito().voce || COBRA_DEFAULTS.ELEVENLABS_VOICE_ID;

      // ── L'agente scelto nel menu in alto ──
      //
      // Mancava, ed era il motivo per cui scegliere COBRA ES non cambiava
      // niente: il menu scriveva la scelta in ctx._agenteScelto e l'unico a
      // rileggerla era l'endpoint che la ristampava. Voce e lingua restavano
      // quelle di sempre. Avevo costruito il selettore e non l'avevo collegato
      // a nulla.
      //
      // Sta prima della voce esplicita: se chi scrive la frase dichiara una
      // voce, quella vince: e' una scelta piu' vicina al singolo messaggio.
      // La lingua segue l'agente, scelto o predefinito che sia.
      try {
        const ag = quello(ctx._agenteScelto);
        if (ag && ag.lingua && !richiesta.lingua) richiesta.lingua = ag.lingua;
      } catch (_) { /* senza elenco agenti si resta sulla lingua della richiesta */ }

      if (richiesta.voce && /^[A-Za-z0-9]{8,40}$/.test(String(richiesta.voce))) {
        // Se conosciamo l'elenco delle voci dell'account, si accetta solo una
        // di quelle: un identificativo inventato produrrebbe un errore HTTP
        // opaco proprio mentre l'utente aspetta di sentire una risposta.
        if (!vociNote || vociNote.includes(String(richiesta.voce))) voiceId = String(richiesta.voce);
        else ctx.log(`[TTS] Voce "${richiesta.voce}" non presente nell'account: uso quella predefinita`);
      }

      // ISO 639-1: due lettere. Tutto il resto si ignora invece di far fallire
      // la sintesi.
      let lingua = 'it';
      if (richiesta.lingua && /^[a-z]{2}$/i.test(String(richiesta.lingua))) {
        lingua = String(richiesta.lingua).toLowerCase();
      }

      const modelId = ctx.aiKeys.elevenlabsModel || COBRA_DEFAULTS.ELEVENLABS_MODEL;

      ctx.log(`[TTS] Sintesi (${text.length} caratteri, voce ${voiceId}, lingua ${lingua})...`);
      const ttsResp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': ctx.aiKeys.elevenlabsKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.substring(0, 5000), model_id: modelId, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true }, language_code: lingua }),
      });

      if (!ttsResp.ok) {
        const err = await ttsResp.text().catch(() => '');
        ctx.log(`[TTS] Error: HTTP ${ttsResp.status}`);
        res.writeHead(ttsResp.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `ElevenLabs HTTP ${ttsResp.status}` }));
        return;
      }

      const audioBuffer = Buffer.from(await ttsResp.arrayBuffer());
      ctx.log(`[TTS] OK — ${audioBuffer.length} bytes`);
      ctx.ResponseRecorder.recordTTS({ text, voiceId, model: modelId, durationMs: Date.now() - _ttsStart, charCount: text.length, success: true });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audioBuffer.length });
      res.end(audioBuffer);
    } catch (e) {
      ctx.log('[TTS] Error: ' + e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // ── /api/tts/voices ──
  router.get('/api/tts/voices', async (body, res) => {
    try {
      if (!ctx.aiKeys.elevenlabsKey) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ voices: [], error: 'No ElevenLabs key' }));
        return;
      }
      const vResp = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': ctx.aiKeys.elevenlabsKey } });
      if (!vResp.ok) throw new Error(`HTTP ${vResp.status}`);
      const data = await vResp.json();
      const voices = (data.voices || []).map(v => ({ id: v.voice_id, name: v.name, language: v.labels?.language, gender: v.labels?.gender }));
      // Si tiene l'elenco per poter rifiutare a monte una voce inesistente
      ctx.session.vociDisponibili = voices.map(v => v.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ voices, current: ctx.aiKeys.elevenlabsVoiceId }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

module.exports = { register };
