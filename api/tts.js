// api/tts.js — Vercel serverless: /api/tts (ElevenLabs proxy)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return res.status(503).json({ error: 'ElevenLabs API key non configurata.' });

  try {
    const { text, voice_id } = req.body || {};
    if (!text) return res.status(400).json({ error: 'No text' });

    const voiceId = voice_id || process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': key },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!resp.ok) return res.status(resp.status).json({ error: `ElevenLabs error: ${resp.status}` });

    const buffer = Buffer.from(await resp.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    return res.status(200).send(buffer);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
