export function classifyAgentError(error: unknown): import("../protocol.js").AgentErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  if (/\(401\)|invalid api key|authentication|unauthorized|permission denied/i.test(message)) return "authentication";
  if (/\(429\)|rate.?limit|quota exceeded/i.test(message)) return "rate_limit";
  if (/context (?:window|length)|too many tokens|maximum context/i.test(message)) return "context_overflow";
  if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|fetch failed|network|socket hang up/i.test(message)) return "network";
  if (/verification/i.test(message)) return "verification";
  if (/tool|patch|file|path|command/i.test(message)) return "tool";
  if (/Model request failed|provider/i.test(message)) return "provider";
  return "internal";
}

export function describeAgentError(error: unknown): string {
  const kind = classifyAgentError(error);
  const message = error instanceof Error ? error.message : String(error);
  switch (kind) {
    case "authentication": return `Authentication failed. Check the provider API key and model access. ${message}`;
    case "rate_limit": return `Provider rate limit exceeded after retries. ${message}`;
    case "context_overflow": return `The request exceeded the model context window. Reduce context or increase compaction. ${message}`;
    case "network": return `Network failure while contacting the provider. ${message}`;
    case "verification": return `Automatic verification failed. ${message}`;
    case "tool": return `Tool execution failed. ${message}`;
    case "provider": return `Provider request failed. ${message}`;
    default: return message;
  }
}
