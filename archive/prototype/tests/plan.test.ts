import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlanState, createPlanTools } from "../src/planning/plan.js";
import { SessionStore } from "../src/storage/session.js";
import type { ToolDefinition, ToolExecutionContext } from "../src/protocol.js";

function context(root: string): ToolExecutionContext {
  return { cwd: root, signal: new AbortController().signal, callId: "plan-test", sessionId: "test", approve: async () => ({ type: "allow" }), emit: () => {} };
}

async function session() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pforge-plan-")));
  const store = SessionStore.create(root, root);
  return { root, store };
}

function tool<T>(tools: ToolDefinition[], name: string): ToolDefinition<T> {
  return tools.find((candidate) => candidate.name === name) as ToolDefinition<T>;
}

describe("durable task plan", () => {
  it("persists a plan and step updates in the session", async () => {
    const { root, store } = await session();
    const state = new PlanState(store, store.id);
    const tools = createPlanTools(store, store.id);
    await tool<{ goal: string; constraints: string[]; steps: Array<{ id: string; description: string; status: string }> }>(tools, "update_plan").execute({
      goal: "Fix the failing parser test",
      constraints: ["Do not change public APIs"],
      steps: [
        { id: "1", description: "Reproduce failure", status: "pending" },
        { id: "2", description: "Implement fix", status: "pending" }
      ]
    }, context(root));
    await tool<{ id: string; status: string }>(tools, "update_plan_step").execute({ id: "1", status: "completed" }, context(root));
    const reopened = SessionStore.open(store.sessionPath);
    const restored = new PlanState(reopened, reopened.id).latest();
    expect(restored?.goal).toBe("Fix the failing parser test");
    expect(restored?.steps[0]).toMatchObject({ id: "1", status: "completed" });
    expect(state.render()).toContain("Do not change public APIs");
  });

  it("rejects updates when no plan exists", async () => {
    const { root, store } = await session();
    const tools = createPlanTools(store, store.id);
    await expect(tool<{ id: string; status: string }>(tools, "update_plan_step").execute({ id: "1", status: "completed" }, context(root))).rejects.toThrow(/No task plan/);
  });
});
