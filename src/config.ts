import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { pforgeHome } from "./pforge-home.js";

const commandSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(3_600_000).optional()
});

const configSchema = z.object({
  verify: z.array(commandSchema).default([]),
  verifyRetries: z.number().int().min(0).max(5).default(2)
}).strict();

export type AgentConfig = z.infer<typeof configSchema>;
export type VerifyCommand = z.infer<typeof commandSchema>;


export interface LoadedConfig {
  config: AgentConfig;
  sources: string[];
  warnings: string[];
}

const DEFAULTS: AgentConfig = configSchema.parse({});
const CONFIG_NAMES = ["pforge.json", "pforge.yaml", "pforge.yml", "forge-agent.json", "forge-agent.yaml", "forge-agent.yml"] as const;

function readConfigFile(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  if (path.endsWith(".json")) return JSON.parse(raw);
  return parseYaml(raw);
}

function shallowMerge(base: AgentConfig, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return { ...base, ...(value as Record<string, unknown>) };
}

export function findProjectRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export function loadConfig(cwd = process.cwd(), overrides: Partial<AgentConfig> = {}): LoadedConfig {
  const sources: string[] = [];
  const warnings: string[] = [];
  let value: unknown = DEFAULTS;
  const projectRoot = findProjectRoot(cwd);
  const home = pforgeHome();
  const candidates = [
    join(home, "config.yaml"),
    join(home, "config.yml"),
    join(home, "config.json"),
    ...CONFIG_NAMES.map((name) => join(projectRoot, name)),
    ...CONFIG_NAMES.map((name) => join(cwd, name))
  ];
  for (const path of [...new Set(candidates)]) {
    if (!existsSync(path)) continue;
    try {
      value = shallowMerge(DEFAULTS, shallowMerge(value as AgentConfig, readConfigFile(path)));
      sources.push(path);
    } catch (error) {
      warnings.push(`Could not load ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  value = shallowMerge(value as AgentConfig, overrides);
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid Forge Agent configuration:\n${parsed.error.issues.map((issue) => `- ${issue.path.join(".")}: ${issue.message}`).join("\n")}`);
  }
  return { config: parsed.data, sources, warnings };
}
