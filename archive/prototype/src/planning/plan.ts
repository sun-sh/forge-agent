import { z } from "zod";
import { schemaToJson } from "../schema/json-schema.js";
import type { JsonValue, ToolDefinition, ToolExecutionResult } from "../protocol.js";
import type { SessionStore } from "../storage/session.js";

const stepSchema = z.object({
  id: z.string().min(1).max(64),
  description: z.string().min(1).max(500),
  status: z.enum(["pending", "in_progress", "completed", "blocked"]).default("pending")
});

const planInput = z.object({
  goal: z.string().min(1).max(2000),
  constraints: z.array(z.string().max(500)).max(20).default([]),
  steps: z.array(stepSchema).min(1).max(30)
}).strict();

export type TaskPlan = z.infer<typeof planInput>;
export type TaskPlanStep = z.infer<typeof stepSchema>;

export interface TaskPlanState {
  goal: string;
  constraints: string[];
  steps: TaskPlanStep[];
  updatedAt: string;
}

function schemaOf<T>(schema: z.ZodType<T>): Record<string, JsonValue> {
  return schemaToJson(schema);
}

export class PlanState {
  constructor(private readonly session: SessionStore, private readonly sessionId: string) {}

  latest(): TaskPlanState | undefined {
    const entries = this.session.getBranch();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry?.type !== "event" || entry.event !== "task_plan") continue;
      try {
        const plan = planInput.parse(entry.data);
        return { ...plan, updatedAt: entry.timestamp };
      } catch { continue; }
    }
    return undefined;
  }

  set(plan: TaskPlan): TaskPlanState {
    const normalized = planInput.parse(plan);
    this.session.appendEvent("task_plan", normalized);
    return { ...normalized, updatedAt: new Date().toISOString() };
  }

  render(): string {
    const plan = this.latest();
    if (!plan) return "Task plan: not established yet.";
    const steps = plan.steps.map((step) => `- [${step.status === "completed" ? "x" : step.status === "in_progress" ? ">" : step.status === "blocked" ? "!" : " "}] ${step.id}: ${step.description}`).join("\n");
    const constraints = plan.constraints.length ? `\nConstraints:\n${plan.constraints.map((value) => `- ${value}`).join("\n")}` : "";
    return `<task_plan updated="${plan.updatedAt}">\nGoal: ${plan.goal}\n${constraints}\nSteps:\n${steps}\n</task_plan>`;
  }

  updateStep(id: string, status: TaskPlanStep["status"]): TaskPlanState {
    const current = this.latest();
    if (!current) throw new Error("No task plan exists. Create one before updating a step.");
    const steps = current.steps.map((step) => step.id === id ? { ...step, status } : step);
    if (!steps.some((step) => step.id === id)) throw new Error(`No task-plan step with id ${id}.`);
    return this.set({ goal: current.goal, constraints: current.constraints, steps });
  }
}

export function createPlanTools(session: SessionStore, sessionId: string): ToolDefinition[] {
  const state = new PlanState(session, sessionId);
  const plan: ToolDefinition<TaskPlan> = {
    name: "update_plan",
    description: "Create or replace the durable task plan. Use this for multi-step coding work. Keep steps concrete and update their status as work progresses. The plan survives context compaction and session resume.",
    effect: "write",
    parallelSafe: false,
    inputSchema: schemaOf(planInput),
    parse: (input) => planInput.parse(input),
    async execute(input): Promise<ToolExecutionResult> {
      const saved = state.set(input);
      return { content: [{ type: "text", text: `Plan updated with ${saved.steps.length} step(s).\n${state.render()}` }] };
    }
  };
  const step = z.object({ id: z.string().min(1).max(64), status: z.enum(["pending", "in_progress", "completed", "blocked"]) }).strict();
  const updateStep: ToolDefinition<z.infer<typeof step>> = {
    name: "update_plan_step",
    description: "Change the status of one durable task-plan step.",
    effect: "write",
    parallelSafe: false,
    inputSchema: schemaOf(step),
    parse: (input) => step.parse(input),
    async execute(input): Promise<ToolExecutionResult> {
      const saved = state.updateStep(input.id, input.status);
      return { content: [{ type: "text", text: `Plan step ${input.id} is now ${input.status}.\n${state.render()}` }] };
    }
  };
  return [plan, updateStep] as ToolDefinition[];
}
