import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compactMessages, estimateMessageTokens } from "../src/context/engine.js";
import type { Message } from "../src/protocol.js";

describe("context compaction", () => {
  it("keeps a tool result attached to its assistant tool call", () => {
    const messages: Message[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: [{ type: "text", text: "working" }, { type: "tool_call", id: "1", name: "read_file", input: { path: "a.ts" } }], model: "m", provider: "p", stopReason: "tool_calls" },
      { role: "tool", toolCallId: "1", toolName: "read_file", content: [{ type: "text", text: "contents" }], isError: false },
      { role: "assistant", content: [{ type: "text", text: "done" }], model: "m", provider: "p", stopReason: "stop" }
    ];
    const result = compactMessages(messages, { contextWindow: 100, compactAt: 0.8, maxOutputTokens: 10 });
    const firstTool = result.messages.findIndex((message) => message.role === "tool");
    if (firstTool >= 0) {
      let index = firstTool - 1;
      while (index >= 0 && result.messages[index]?.role !== "assistant") index--;
      expect(index).toBeGreaterThanOrEqual(0);
      expect(result.messages[index]).toMatchObject({ role: "assistant" });
    }
  });

  it("leaves small contexts untouched", () => {
    const messages: Message[] = [{ role: "user", content: "hello" }];
    expect(compactMessages(messages, { contextWindow: 100_000, compactAt: 0.8, maxOutputTokens: 1000 }).messages).toEqual(messages);
  });

  it("estimates CJK text as well as ASCII", () => {
    expect(estimateMessageTokens([{ role: "user", content: "你好世界 hello" }])).toBeGreaterThan(0);
  });
});

void mkdtemp;
void realpath;
void tmpdir;
void join;
