import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/storage/session.js";
import { CheckpointManager } from "../src/storage/checkpoint.js";

describe("SessionStore", () => {
  it("persists and reloads message history", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-session-")));
    const store = SessionStore.create(root, root);
    store.appendMessage({ role: "user", content: "hello" });
    store.appendEvent("test", { ok: true });
    store.appendMessage({ role: "assistant", content: [{ type: "text", text: "world" }], model: "m", provider: "p", stopReason: "stop" });
    const reopened = SessionStore.open(store.sessionPath);
    expect(reopened.id).toBe(store.id);
    expect(reopened.messages()).toHaveLength(2);
    expect(reopened.messages()[0]).toMatchObject({ role: "user", content: "hello" });
  });

  it("lists sessions by workspace", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-session-")));
    SessionStore.create(root, root, "one");
    SessionStore.create(root, root, "two");
    const listed = SessionStore.list(root, root);
    expect(listed).toHaveLength(2);
    expect(listed.map((entry) => entry.title).sort()).toEqual(["one", "two"]);
  });

  it("applies summary compaction to visible history", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-session-")));
    const store = SessionStore.create(root, root);
    store.appendMessage({ role: "user", content: "old" });
    store.appendSummary("old work summary", null);
    store.appendMessage({ role: "user", content: "new" });
    expect(store.messages().map((message) => message.role === "user" ? message.content : null)).toEqual(["[Earlier work summary]\nold work summary", "new"]);
  });
});

describe("CheckpointManager", () => {
  it("snapshots and restores workspace files", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-checkpoint-")));
    await writeFile(join(root, "a.txt"), "before\n");
    const session = SessionStore.create(root, root);
    const manager = new CheckpointManager(root, session);
    const manifest = await manager.create("test");
    await writeFile(join(root, "a.txt"), "after\n");
    await CheckpointManager.restore(session.lastCheckpoint()!.manifestPath);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before\n");
    expect(manifest.files.some((file) => file.path === "a.txt")).toBe(true);
  });
});
