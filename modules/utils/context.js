// Utils - Context assembly and digestion
function digestToolResult(toolName, rawResult) {
  if (!rawResult) return '';
  let result = rawResult;
  try {
    const parsed = JSON.parse(result);
    if (parsed.error) {
      return `[ERRORE]: ${parsed.error}`;
    }
    if (typeof parsed === 'string') return parsed;
    if (parsed.text) return parsed.text;
    if (parsed.content) return parsed.content;
    return JSON.stringify(parsed).substring(0, 2000);
  } catch (e) {
    // Not JSON, return as-is
    if (result.length > 3000) return result.substring(0, 3000) + '...';
    return result;
  }
}

function assembleContextWithBudget(promptContext, budget = 4000) {
  if (!promptContext) return '';
  const charBudget = budget * 4;
  let assembled = '';

  if (promptContext.liveMessages && promptContext.liveMessages.length > 0) {
    for (const msg of promptContext.liveMessages) {
      const line = `[${msg.role}]: ${msg.content}\n`;
      if (assembled.length + line.length > charBudget) break;
      assembled += line;
    }
  }

  if (promptContext.rollingSummary) {
    const summaryLine = `[SUMMARY]: ${promptContext.rollingSummary}\n`;
    if (assembled.length + summaryLine.length <= charBudget) {
      assembled = summaryLine + assembled;
    }
  }

  return assembled;
}

module.exports = {
  digestToolResult,
  assembleContextWithBudget,
};
