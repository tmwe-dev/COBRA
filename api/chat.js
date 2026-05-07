// api/chat.js — Vercel serverless: /api/chat
const { COBRA_CORE } = require('../modules/prompts/cobra-core');
const { ALWAYS_LOADED_KB } = require('../modules/prompts/kb-rules');
const { estimateTokens } = require('../modules/utils/tokens');
const { detectPromptInjection } = require('../modules/security/injection');
const { sanitizeForLog } = require('../modules/security/sanitize');

// AI provider calls
async function callOpenAI(systemPrompt, messages, tools) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const body = {
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    temperature: 0.4,
    max_tokens: 4096,
  };
  if (tools && tools.length > 0) body.tools = tools;
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content || '',
    provider: 'openai',
    model: data.model,
    toolCalls: choice?.message?.tool_calls || [],
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
  };
}

async function callAnthropic(systemPrompt, messages) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const body = {
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: systemPrompt,
    messages: messages.map(m => ({ role: m.role === 'system' ? 'user' : m.role, content: m.content })),
  };
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return {
    content: data.content?.[0]?.text || '',
    provider: 'anthropic',
    model: data.model,
    promptTokens: data.usage?.input_tokens || 0,
    completionTokens: data.usage?.output_tokens || 0,
  };
}

function assemblePrompt(message) {
  let prompt = COBRA_CORE;

  // KB rules (always_load only, budget 2000 tokens)
  const kbParts = [];
  for (const rule of ALWAYS_LOADED_KB) {
    if (rule.always_load) kbParts.push(`[${rule.title}] ${rule.content}`);
  }
  let kbText = kbParts.join('\n\n');
  if (estimateTokens(kbText) > 2000) kbText = kbText.substring(0, 8000);
  prompt += `\n\n<system_rules>\n${kbText}\n</system_rules>`;

  return prompt;
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, voiceMode } = req.body || {};
    if (!message) return res.status(400).json({ error: 'No message' });

    // Injection check
    const injection = detectPromptInjection(message);
    if (injection.detected && injection.score > 0.8) {
      return res.status(400).json({ error: 'Input rejected by security filter.' });
    }

    const systemPrompt = assemblePrompt(message);
    const msgs = [{ role: 'user', content: message }];

    // Cascade: OpenAI → Anthropic
    let result = null;
    try { result = await callOpenAI(systemPrompt, msgs); } catch (e) { console.error('OpenAI failed:', e.message); }
    if (!result) {
      try { result = await callAnthropic(systemPrompt, msgs); } catch (e) { console.error('Anthropic failed:', e.message); }
    }
    if (!result) return res.status(503).json({ error: 'Nessun provider AI disponibile. Configura le API keys.' });

    return res.status(200).json({
      content: result.content,
      provider: result.provider,
      model: result.model,
      intent: 'chat',
    });
  } catch (e) {
    console.error('Chat error:', e);
    return res.status(500).json({ content: 'Errore server: ' + e.message, provider: 'none' });
  }
};
