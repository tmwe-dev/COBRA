// modules/routes/tts.js — /api/tts, /api/tts/voices
// Source: server.js lines 8350-8440

const { COBRA_DEFAULTS } = require('../config');

function register(router, ctx) {
  // ── /api/tts — ElevenLabs TTS ──
  router.post('/api/tts', async (body, res) => {
    try {
      const { text } = JSON.parse(body);
      if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: 'No text' })); return; }
      if (!ctx.aiKeys.elevenlabsKey) { res.writeHead(400); res.end(JSON.stringify({ error: 'ElevenLabs API key non configurata' })); return; }

      const _ttsStart = Date.now();
      const voiceId = ctx.aiKeys.elevenlabsVoiceId || COBRA_DEFAULTS.ELEVENLABS_VOICE_ID;
      const modelId = ctx.aiKeys.elevenlabsModel || COBRA_DEFAULTS.ELEVENLABS_MODEL;

      ctx.log(`[TTS] Generating speech (${text.length} chars, voice: ${voiceId})...`);
      const ttsResp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': ctx.aiKeys.elevenlabsKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.substring(0, 5000), model_id: modelId, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true }, language_code: 'it' }),
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ voices, current: ctx.aiKeys.elevenlabsVoiceId }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

module.exports = { register };
