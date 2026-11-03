import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Message, Usage } from "../protocol.js";
import { createId } from "../protocol.js";

export interface SessionHeader {
  type: "session";
  version: 2;
  id: string;
  createdAt: string;
  cwd: string;
  title?: string;
}

export interface SessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  message: Message;
}

export interface EventEntry extends SessionEntryBase {
  type: "event";
  event: string;
  data?: unknown;
}

export interface CheckpointEntry extends SessionEntryBase {
  type: "checkpoint";
  label: string;
  manifestPath: string;
}

export interface SummaryEntry extends SessionEntryBase {
  type: "summary";
  summary: string;
  keptFrom: string | null;
}

export interface UsageEntry extends SessionEntryBase {
  type: "usage";
  usage: Usage;
  model: string;
  provider: string;
}

export type SessionEntry = MessageEntry | EventEntry | CheckpointEntry | SummaryEntry | UsageEntry;
export type FileEntry = SessionHeader | SessionEntry;

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  messages: number;
  title?: string;
}

export class SessionStore {
  readonly dir: string;
  readonly path: string;
  private entries: FileEntry[];
  private readonly header: SessionHeader;
  private leafId: string | null;

  private constructor(dir: string, path: string, header: SessionHeader, entries: FileEntry[]) {
    this.dir = dir;
    this.path = path;
    this.header = header;
    this.entries = entries;
    const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
    this.leafId = sessionEntries.at(-1)?.id ?? null;
  }

  static create(cwd: string, root: string, title?: string): SessionStore {
    const dir = join(root, "sessions", safePath(cwd));
    mkdirSync(dir, { recursive: true });
    const id = createId("session");
    const path = join(dir, `${id}.jsonl`);
    const header: SessionHeader = { type: "session", version: 2, id, createdAt: new Date().toISOString(), cwd: resolve(cwd), ...(title ? { title } : {}) };
    const store = new SessionStore(dir, path, header, [header]);
    appendFileSync(path, `${JSON.stringify(header)}\n`, "utf8");
    return store;
  }

  static open(path: string): SessionStore {
    const entries = parseSession(path);
    const header = entries[0];
    if (!header || header.type !== "session") throw new Error(`Not a pforge session: ${path}`);
    return new SessionStore(resolve(path, ".."), resolve(path), header, entries);
  }

  static list(cwd: string, root: string): SessionInfo[] {
    const dir = join(root, "sessions", safePath(cwd));
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).flatMap((name) => {
      const path = join(dir, name);
      try {
        const entries = parseSession(path);
        const header = entries[0];
        if (!header || header.type !== "session") return [];
        const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
        return [{
          id: header.id,
          path,
          cwd: header.cwd,
          createdAt: header.createdAt,
          updatedAt: sessionEntries.at(-1)?.timestamp ?? header.createdAt,
          messages: sessionEntries.filter((entry): entry is MessageEntry => entry.type === "message").length,
          ...(header.title ? { title: header.title } : {})
        }];
      } catch { return []; }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get id(): string { return this.header.id; }
  get cwd(): string { return this.header.cwd; }
  get sessionPath(): string { return this.path; }

  appendMessage(message: Message): string {
    const entryId = this.append({ type: "message", message });
    if (message.role === "assistant" && message.usage) {
      this.append({ type: "usage", usage: message.usage, model: message.model, provider: message.provider });
    }
    return entryId;
  }

  appendEvent(event: string, data?: unknown): string {
    return this.append({ type: "event", event, ...(data === undefined ? {} : { data }) });
  }

  appendCheckpoint(label: string, manifestPath: string): void {
    this.append({ type: "checkpoint", label, manifestPath });
  }

  appendSummary(summary: string, keptFrom: string | null): void {
    this.append({ type: "summary", summary, keptFrom });
  }

  getEntries(): FileEntry[] { return structuredClone(this.entries); }

  getBranch(leafId = this.leafId): SessionEntry[] {
    const byId = new Map(this.entries.filter((entry): entry is SessionEntry => entry.type !== "session").map((entry) => [entry.id, entry]));
    const branch: SessionEntry[] = [];
    let current = leafId ? byId.get(leafId) : undefined;
    while (current) {
      branch.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return branch.reverse();
  }

  messages(): Message[] {
    const branch = this.getBranch();
    let summaryIndex = -1;
    for (let index = branch.length - 1; index >= 0; index--) {
      if (branch[index]?.type === "summary") { summaryIndex = index; break; }
    }
    const visible = summaryIndex >= 0 ? branch.slice(summaryIndex) : branch;
    const result: Message[] = [];
    for (const entry of visible) {
      if (entry.type === "summary") result.push({ role: "user", content: `[Earlier work summary]\n${entry.summary}` });
      else if (entry.type === "message") result.push(entry.message);
    }
    return result;
  }

  usage(): { input: number; output: number; cacheRead: number; cacheWrite: number } {
    const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const entry of this.getBranch()) {
      if (entry.type !== "usage") continue;
      total.input += entry.usage.inputTokens;
      total.output += entry.usage.outputTokens;
      total.cacheRead += entry.usage.cacheReadTokens ?? 0;
      total.cacheWrite += entry.usage.cacheWriteTokens ?? 0;
    }
    return total;
  }

  lastCheckpoint(): CheckpointEntry | undefined {
    return [...this.getBranch()].reverse().find((entry): entry is CheckpointEntry => entry.type === "checkpoint");
  }

  appendBranchSummary(summary: string): void {
    this.appendEvent("branch_summary", { summary });
  }

  private append(draft:
    | Omit<MessageEntry, "id" | "parentId" | "timestamp">
    | Omit<EventEntry, "id" | "parentId" | "timestamp">
    | Omit<CheckpointEntry, "id" | "parentId" | "timestamp">
    | Omit<SummaryEntry, "id" | "parentId" | "timestamp">
    | Omit<UsageEntry, "id" | "parentId" | "timestamp">
  ): string {
    const id = createId("entry");
    const entry = { ...draft, id, parentId: this.leafId, timestamp: new Date().toISOString() } as SessionEntry;
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    this.entries.push(entry);
    this.leafId = entry.id;
    return id;
  }
}

function safePath(cwd: string): string {
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
}

export function parseSession(path: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line) as FileEntry); } catch { /* ignore malformed trailing line */ }
  }
  if (!entries.length) throw new Error(`Empty session: ${path}`);
  const header = entries[0];
  if (!header || header.type !== "session") throw new Error(`Invalid session header: ${path}`);
  return entries;
}
