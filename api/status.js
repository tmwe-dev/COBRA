// api/status.js — Vercel serverless: /api/status
module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    status: 'online',
    version: '10.2',
    build: 'vercel',
    mode: 'cloud',
    hasKeys: !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY),
    providers: {
      openai: !!process.env.OPENAI_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
    },
  });
};
