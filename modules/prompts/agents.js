// modules/prompts/agents.js — Single fallback agent prompt
// Diet: 6 agents → 1 fallback. Specifici caricati da KB se disponibile.

const AGENT_PROMPTS = {
  full: `# AGENT: Operativo
Per ogni task: classifica (obiettivo, output, dati) → esegui (usa tool, produci risultato) → chiudi (risultato + da verificare + prossima azione).
Navigazione: navigate → read_page → screenshot → scrape_url. Almeno 3 tool prima di dichiarare fallimento.
DOM interattivo SOLO su domini whitelistati. Altri siti: SOLO lettura.
Anti-loop: scroll max 3x senza leggere, stesso dominio max 4x, paywall → fermati.
Non spiegare — produci la prima versione utilizzabile.`,
};

// Alias per retrocompatibilità — tutti puntano a 'full'
AGENT_PROMPTS.searcher = AGENT_PROMPTS.full;
AGENT_PROMPTS.navigator = AGENT_PROMPTS.full;
AGENT_PROMPTS.communicator = AGENT_PROMPTS.full;
AGENT_PROMPTS.admin = AGENT_PROMPTS.full;
AGENT_PROMPTS.scout = AGENT_PROMPTS.full;

module.exports = { AGENT_PROMPTS };
