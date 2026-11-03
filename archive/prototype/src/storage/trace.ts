import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeEvent } from "../protocol.js";
import { redactSecrets } from "../security/command-policy.js";

export interface TraceRecord {
  timestamp: string;
  sessionId: string;
  sequence: number;
  event: RuntimeEvent;
}

export class TraceWriter {
  private sequence = 0;
  private readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly root: string, private readonly sessionId: string) {
    this.path = join(root, "traces", `${sessionId}.jsonl`);
  }

  record(event: RuntimeEvent): Promise<void> {
    const record: TraceRecord = { timestamp: new Date().toISOString(), sessionId: this.sessionId, sequence: this.sequence++, event: redactEvent(event) };
    const line = `${JSON.stringify(record)}\n`;
    this.queue = this.queue.then(async () => {
      await mkdir(join(this.root, "traces"), { recursive: true });
      await appendFile(this.path, line, "utf8");
    });
    return this.queue;
  }

  async flush(): Promise<void> { await this.queue; }
  get tracePath(): string { return this.path; }
}

function redactEvent(event: RuntimeEvent): RuntimeEvent {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
      return { ...event, text: redactSecrets(event.text) };
    case "status":
    case "warning":
      return { ...event, message: redactSecrets(event.message) };
    case "approval_request":
      return { ...event, request: { ...event.request, summary: redactSecrets(event.request.summary), detail: redactSecrets(event.request.detail) } };
    case "tool_call_start":
      return { ...event, input: redactSecrets(JSON.stringify(event.input)).slice(0, 20_000) };
    case "tool_call_end":
      return { ...event, result: { ...event.result, content: event.result.content.map((part) => part.type === "text" ? { ...part, text: redactSecrets(part.text) } : part) } };
    case "run_end":
      return { ...event, ...(event.error ? { error: redactSecrets(event.error) } : {}) };
    default:
      return event;
  }
}

export async function readTrace(path: string): Promise<TraceRecord[]> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as TraceRecord);
}
