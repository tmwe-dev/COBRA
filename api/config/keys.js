// api/config/keys.js — Vercel serverless: /api/config/keys
module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      hasKeys: !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY),
      providers: {
        openai: !!process.env.OPENAI_API_KEY,
        anthropic: !!process.env.ANTHROPIC_API_KEY,
      },
      note: 'Le API keys sono configurate come Environment Variables su Vercel.',
    });
  }

  // POST — in Vercel le chiavi si configurano via dashboard, non via API
  return res.status(200).json({
    ok: true,
    note: 'In modalità cloud, configura le API keys nelle Environment Variables di Vercel.',
  });
};
