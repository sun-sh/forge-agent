import { createHash } from 'node:crypto';

interface Entry { type: string; id?: string; customType?: string; data?: unknown; message?: unknown; }
interface BoundedText { text: string; characters: number; sha256: string; truncated: boolean; }
type ReceiptOutcome = 'passed' | 'failed' | 'zero_tests' | 'unknown';
export interface ReviewCommandEvidence {
  version: 1;
  source: 'pi-selected-branch';
  scope: 'latest-implementation';
  freshness: 'historical-unattested';
  classification: 'heuristic-not-verification';
  commands: Array<{ toolCallId: string; tool: string; command: BoundedText; output: BoundedText; toolError: boolean; sourceTruncation?: 'reported' | 'not-reported'; kind: 'test' | 'command'; outcome: ReceiptOutcome; recordedAt?: number }>;
  omitted: number;
  scanTruncated: boolean;
  /** Counts cover eligible observations in this attempt, including receipts omitted for size. */
  summary: { receipts: number; retainedReceipts: number; testReceipts: number; failedReceipts: number; zeroTestReceipts: number; sourceTruncatedReceipts: number };
}
const MAX_SCAN = 5000, MAX_COMMANDS = 12, MAX_CHARACTERS = 24000;
const sensitive = (value: string) => /\b(?:api[_-]?key|authorization|access[_-]?token|password|secret)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]+)|https?:\/\/[^/\s]+:[^/\s]+@|(?:^|[\s/'"\\])(?:\.env(?:\.[\w-]+)?|auth\.json|credentials?\.json|secrets?\.json)(?=$|[\s/'"\\])/i.test(value);
function bounded(text: string, limit: number): BoundedText {
  const marker = '\n[historical output excerpt; not a complete check]\n';
  const head = Math.floor((limit - marker.length) / 2), tail = limit - marker.length - head;
  return { text: text.length <= limit ? text : text.slice(0, head) + marker + text.slice(-tail),
    characters: text.length, sha256: createHash('sha256').update(text).digest('hex'), truncated: text.length > limit };
}

function classify(command: string, output: string, toolError: boolean): { kind: 'test' | 'command'; outcome: ReceiptOutcome } {
  // Navigation hints only. Preserve the original output even when a runner's
  // summary is unfamiliar; an error word in a test name is not a failed test.
  const plain = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const test = /(?:\b(?:pytest|py\.test|unittest|vitest|jest|mocha|tox)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\b[^\n]*\s--test\b|\bbin[\\/]test\b)/i.test(command)
    || /\b[1-9]\d*\s+passed\b|^Ran\s+\d+\s+tests?\b|^# tests\s+\d+\b/im.test(plain);
  const kind = test ? 'test' : 'command';
  // Test runners commonly report expected failures separately. They are
  // evidence about the suite, but not a failed command unless the runner
  // itself reports a non-zero failure/error count.
  const observed = plain.replace(/\bexpected\s+(?:failures?|errors?)\s*(?:[=:]\s*|\s+)\d+\b/gi, '');
  const failed = /\b[1-9]\d*\s+(?:failed|failures?|errors?)\b|^(?:FAILED|FAILURES|ERRORS)(?:\s|:|$)|^# fail\s+[1-9]\d*\b|\b(?:failures|errors)\s*[=:]\s*[1-9]\d*\b|^Traceback \(most recent call last\):|\b(?:ModuleNotFoundError|ImportError):|\bNo module named\b|\b(?:command exited|exit(?:ed)?\s+(?:with\s+)?(?:code\s+)?)\s*[1-9]\d*\b/im.test(observed);
  if (toolError || failed) return { kind, outcome: 'failed' };
  if (test && /\bno tests? (?:ran|collected|found)\b|\bcollected\s+0\s+(?:items?|tests?)\b|^Ran\s+0\s+tests?\b|^# tests\s+0\b|^\s*(?:=+\s*)?0 passed\s*(?:=+)?\s*$/im.test(plain)) return { kind, outcome: 'zero_tests' };
  if (test && (/\b[1-9]\d*\s+passed\b/i.test(plain) || /^Ran\s+[1-9]\d*\s+tests?\b/im.test(plain) && /^OK(?:\s|$)/m.test(plain)
    || /^# tests\s+[1-9]\d*\b/m.test(plain) && /^# fail\s+0\b/m.test(plain))) return { kind, outcome: 'passed' };
  return { kind, outcome: 'unknown' };
}

const emptySummary = (): ReviewCommandEvidence['summary'] => ({ receipts: 0, retainedReceipts: 0, testReceipts: 0, failedReceipts: 0, zeroTestReceipts: 0, sourceTruncatedReceipts: 0 });
const priority = (receipt: ReviewCommandEvidence['commands'][number]) => receipt.outcome === 'failed' || receipt.outcome === 'zero_tests' ? 3 : receipt.kind === 'test' ? 2 : 0;

/** Historical tool receipts, never a current-workspace attestation or a replacement verification gate. */
export function reviewCommandEvidence(entries: readonly Entry[], taskId: string, builtinTools: ReadonlySet<string>): ReviewCommandEvidence {
  const result: ReviewCommandEvidence = { version: 1, source: 'pi-selected-branch', scope: 'latest-implementation', freshness: 'historical-unattested', classification: 'heuristic-not-verification', commands: [], omitted: 0, scanTruncated: entries.length > MAX_SCAN, summary: emptySummary() };
  let inImplementation = false, attempt = -1;
  const calls = new Map<string, { name: string; command: string }>();
  const seen = new Set<string>();
  for (const entry of entries.slice(-MAX_SCAN)) {
    if (entry.type === 'custom' && entry.customType === 'pforge.task') {
      const task = entry.data as { id?: string; phase?: string; phases?: unknown[] } | undefined;
      inImplementation = task?.id === taskId && task.phase === 'implement';
      if (inImplementation && task?.phases?.length !== attempt) {
        attempt = task?.phases?.length ?? 0; calls.clear(); seen.clear(); result.commands = []; result.omitted = 0; result.summary = emptySummary();
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
      const toolError = message['isError'] === true, classification = classify(call.command, output, toolError), sourceTruncation = message['details']?.truncation?.truncated === true ? 'reported' as const : 'not-reported' as const;
      result.commands.push({ toolCallId: id, tool: call.name, command: bounded(call.command, 1000), output: bounded(output, 3000), toolError, sourceTruncation, kind: classification.kind, outcome: classification.outcome,
        ...(typeof message['timestamp'] === 'number' && Number.isFinite(message['timestamp']) ? { recordedAt: message['timestamp'] } : {}) });
      result.summary.receipts++;
      if (classification.kind === 'test') result.summary.testReceipts++;
      if (classification.outcome === 'failed') result.summary.failedReceipts++;
      if (classification.outcome === 'zero_tests') result.summary.zeroTestReceipts++;
      if (sourceTruncation === 'reported') result.summary.sourceTruncatedReceipts++;
      // Keep test receipts ahead of later inspection noise, preserving order
      // within each priority. Any dropped failures remain in summary counts.
      while (result.commands.length > MAX_COMMANDS || JSON.stringify(result.commands).length > MAX_CHARACTERS) {
        const lowest = Math.min(...result.commands.map(priority));
        result.commands.splice(result.commands.findIndex((receipt) => priority(receipt) === lowest), 1); result.omitted++;
      }
    }
  }
  result.summary.retainedReceipts = result.commands.length;
  return result;
}
