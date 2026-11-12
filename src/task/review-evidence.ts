import { createHash } from 'node:crypto';

interface Entry { type: string; id?: string; customType?: string; data?: unknown; message?: unknown; }
interface BoundedText { text: string; characters: number; sha256: string; truncated: boolean; }
export interface ReviewCommandEvidence {
  version: 1;
  source: 'pi-selected-branch';
  scope: 'latest-implementation';
  freshness: 'historical-unattested';
  commands: Array<{ toolCallId: string; tool: string; command: BoundedText; output: BoundedText; toolError: boolean; sourceTruncation?: 'reported' | 'not-reported'; recordedAt?: number }>;
  omitted: number;
  scanTruncated: boolean;
}
const MAX_SCAN = 5000, MAX_COMMANDS = 12, MAX_CHARACTERS = 24000;
const sensitive = (value: string) => /\b(?:api[_-]?key|authorization|access[_-]?token|password|secret)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]+)|https?:\/\/[^/\s]+:[^/\s]+@|(?:^|[\s/'"\\])(?:\.env(?:\.[\w-]+)?|auth\.json|credentials?\.json|secrets?\.json)(?=$|[\s/'"\\])/i.test(value);
function bounded(text: string, limit: number): BoundedText {
  const marker = '\n[historical output excerpt; not a complete check]\n';
  const head = Math.floor((limit - marker.length) / 2), tail = limit - marker.length - head;
  return { text: text.length <= limit ? text : text.slice(0, head) + marker + text.slice(-tail),
    characters: text.length, sha256: createHash('sha256').update(text).digest('hex'), truncated: text.length > limit };
}

/** Historical tool receipts, never a current-workspace attestation or a replacement verification gate. */
export function reviewCommandEvidence(entries: readonly Entry[], taskId: string, builtinTools: ReadonlySet<string>): ReviewCommandEvidence {
  const result: ReviewCommandEvidence = { version: 1, source: 'pi-selected-branch', scope: 'latest-implementation', freshness: 'historical-unattested', commands: [], omitted: 0, scanTruncated: entries.length > MAX_SCAN };
  let inImplementation = false, attempt = -1;
  const calls = new Map<string, { name: string; command: string }>();
  const seen = new Set<string>();
  for (const entry of entries.slice(-MAX_SCAN)) {
    if (entry.type === 'custom' && entry.customType === 'pforge.task') {
      const task = entry.data as { id?: string; phase?: string; phases?: unknown[] } | undefined;
      inImplementation = task?.id === taskId && task.phase === 'implement';
      if (inImplementation && task?.phases?.length !== attempt) {
        attempt = task?.phases?.length ?? 0; calls.clear(); seen.clear(); result.commands = []; result.omitted = 0;
      }
      continue;
    }
    if (!inImplementation || entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') continue;
    const message = entry.message as Record<string, any>;
    if (message['role'] === 'assistant' && Array.isArray(message['content'])) {
      for (const part of message['content']) {
        if (part?.type !== 'toolCall' || typeof part.id !== 'string' || part.id.length > 512 || !['bash', 'powershell'].includes(part.name) || !builtinTools.has(part.name) || typeof part.arguments?.command !== 'string') continue;
        if (!calls.has(part.id)) calls.set(part.id, { name: part.name, command: part.arguments.command });
      }
    } else if (message['role'] === 'toolResult' && typeof message['toolCallId'] === 'string') {
      const id = message['toolCallId'], call = calls.get(id);
      if (!call || seen.has(id) || message['toolName'] !== call.name) continue;
      seen.add(id);
      // No assistant prose, thinking, image data, custom tools or MCP output enters the reviewer.
      const output = Array.isArray(message['content']) ? message['content'].filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n') : '';
      if (!output || sensitive(call.command) || sensitive(output)) { result.omitted++; continue; }
      result.commands.push({ toolCallId: id, tool: call.name, command: bounded(call.command, 1000), output: bounded(output, 3000), toolError: message['isError'] === true, sourceTruncation: message['details']?.truncation?.truncated === true ? 'reported' : 'not-reported',
        ...(typeof message['timestamp'] === 'number' && Number.isFinite(message['timestamp']) ? { recordedAt: message['timestamp'] } : {}) });
      while (result.commands.length > MAX_COMMANDS || JSON.stringify(result.commands).length > MAX_CHARACTERS) { result.commands.shift(); result.omitted++; }
    }
  }
  return result;
}
