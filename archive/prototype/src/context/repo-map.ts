import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import fg from "fast-glob";
import ignore, { type Ignore } from "ignore";
import { estimateTokens } from "../protocol.js";

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
  ".java", ".kt", ".kts", ".cs", ".rb", ".php", ".swift", ".scala", ".lua"
]);
const SKIPPED_PARTS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".pforge", ".next", ".nuxt",
  ".turbo", "target", "vendor", "venv", ".venv", "__pycache__", ".idea"
]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 8_000;
const CACHE_TTL_MS = 750;

export interface RepoMapSymbol {
  name: string;
  kind: string;
  line: number;
  signature: string;
}

export interface RepoMapFile {
  path: string;
  symbols: RepoMapSymbol[];
  imports: string[];
  identifiers: Set<string>;
  bytes: number;
  mtimeMs: number;
}

export interface RepoMapRenderOptions {
  budgetTokens?: number;
  query?: string;
  seedFiles?: string[];
  seedIdentifiers?: string[];
}

export interface RepoMapResult {
  text: string;
  files: number;
  symbols: number;
  estimatedTokens: number;
  rankedFiles: string[];
}

interface RepoMapCache {
  loadedAt: number;
  files: RepoMapFile[];
  edges: Map<string, Map<string, number>>;
  definitions: Map<string, Set<string>>;
  references: Map<string, number>;
}

interface SymbolRule {
  kind: string;
  pattern: RegExp;
}

const SYMBOL_RULES: SymbolRule[] = [
  { kind: "class", pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:final\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "interface", pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "type", pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
  { kind: "enum", pattern: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  { kind: "function", pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: "const", pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/ },
  { kind: "def", pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
  { kind: "class", pattern: /^\s*class\s+([A-Za-z_]\w*)/ },
  { kind: "fn", pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
  { kind: "struct", pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/ },
  { kind: "trait", pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/ },
  { kind: "enum", pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/ },
  { kind: "func", pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
  { kind: "record", pattern: /^\s*(?:public\s+)?(?:record|data class)\s+([A-Za-z_]\w*)/ },
  { kind: "class", pattern: /^\s*(?:public\s+|protected\s+|private\s+)?(?:static\s+)?(?:final\s+)?class\s+([A-Za-z_]\w*)/ }
];

const IMPORT_PATTERNS = [
  /^\s*import\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gm,
  /^\s*export\s+[^"']*?\s+from\s+["']([^"']+)["']/gm,
  /\brequire\(\s*["']([^"']+)["']\s*\)/gm,
  /\bimport\(\s*["']([^"']+)["']\s*\)/gm,
  /^\s*from\s+([\w.]+)\s+import\b/gm,
  /^\s*import\s+([\w.]+)/gm,
  /^\s*use\s+([\w:]+)/gm,
  /^\s*import\s+([\w.]+)\s*;/gm
];

const IDENTIFIER_PATTERN = /\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/g;
const NON_IDENTIFIERS = new Set([
  "const", "let", "var", "function", "return", "import", "export", "default", "async",
  "await", "class", "interface", "type", "enum", "public", "private", "protected", "static",
  "true", "false", "null", "undefined", "string", "number", "boolean", "void", "this",
  "from", "with", "then", "catch", "throw", "new", "for", "while", "if", "else", "switch",
  "case", "break", "continue", "def", "self", "cls", "package", "module", "struct", "trait"
]);

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase());
}

function symbolRule(line: string): SymbolRule | undefined {
  return SYMBOL_RULES.find((rule) => rule.pattern.test(line));
}

function signatureOf(line: string): string {
  return line.trim().replace(/\s*\{\s*$/, "").slice(0, 220);
}

function extractImports(source: string): string[] {
  const result = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      if (match[1]) result.add(match[1]);
    }
  }
  return [...result];
}

function parseFile(root: string, path: string): RepoMapFile | undefined {
  const absolute = resolve(root, path);
  try {
    const info = statSync(absolute);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
    const source = readFileSync(absolute, "utf8");
    const symbols: RepoMapSymbol[] = [];
    const lines = source.replace(/\r\n/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (line.length > 500) continue;
      const rule = symbolRule(line);
      if (!rule) continue;
      const match = line.match(rule.pattern);
      const name = match?.[1];
      if (!name || NON_IDENTIFIERS.has(name)) continue;
      symbols.push({ name, kind: rule.kind, line: index + 1, signature: signatureOf(line) });
      if (symbols.length >= 120) break;
    }
    const identifiers = new Set<string>();
    for (const match of source.matchAll(IDENTIFIER_PATTERN)) {
      const value = match[0];
      if (!NON_IDENTIFIERS.has(value)) identifiers.add(value);
    }
    return {
      path: normalizePath(relative(root, absolute)),
      symbols,
      imports: extractImports(source),
      identifiers,
      bytes: info.size,
      mtimeMs: info.mtimeMs
    };
  } catch {
    return undefined;
  }
}

async function loadIgnore(root: string, extra: string[]): Promise<Ignore> {
  const matcher = ignore();
  for (const name of [".gitignore", ".ignore"]) {
    const path = resolve(root, name);
    if (existsSync(path)) {
      try { matcher.add(await readFile(path, "utf8")); } catch { /* best effort */ }
    }
  }
  matcher.add(["node_modules/", ".git/", "dist/", "build/", "coverage/", ".pforge/", "target/", "vendor/"]);
  matcher.add(extra);
  return matcher;
}

function moduleCandidates(fromPath: string, specifier: string): string[] {
  if (!specifier.startsWith(".")) return [];
  const base = normalizePath(resolve(dirname(fromPath), specifier));
  const candidates = [base];
  const extension = extname(base);
  if (!extension) {
    for (const ext of CODE_EXTENSIONS) candidates.push(`${base}${ext}`);
    for (const ext of CODE_EXTENSIONS) candidates.push(`${base}/index${ext}`);
  }
  return candidates.map((value) => normalizePath(value));
}

function buildGraph(files: RepoMapFile[]): Pick<RepoMapCache, "edges" | "definitions" | "references"> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const definitions = new Map<string, Set<string>>();
  const references = new Map<string, number>();
  for (const file of files) {
    for (const symbol of file.symbols) {
      const holders = definitions.get(symbol.name) ?? new Set<string>();
      holders.add(file.path);
      definitions.set(symbol.name, holders);
    }
    for (const identifier of file.identifiers) references.set(identifier, (references.get(identifier) ?? 0) + 1);
  }
  const edges = new Map<string, Map<string, number>>();
  for (const file of files) {
    const targets = new Map<string, number>();
    for (const specifier of file.imports) {
      for (const candidate of moduleCandidates(file.path, specifier)) {
        if (byPath.has(candidate)) {
          targets.set(candidate, (targets.get(candidate) ?? 0) + 4);
          break;
        }
      }
    }
    for (const identifier of file.identifiers) {
      for (const holder of definitions.get(identifier) ?? []) {
        if (holder !== file.path) targets.set(holder, (targets.get(holder) ?? 0) + Math.min(2, 0.25 + Math.log2(1 + (references.get(identifier) ?? 1)) * 0.2));
      }
    }
    edges.set(file.path, targets);
  }
  return { edges, definitions, references };
}

function tokenizeQuery(query: string | undefined): string[] {
  if (!query) return [];
  return [...new Set(query.match(IDENTIFIER_PATTERN) ?? [])];
}

function extractSeeds(files: RepoMapFile[], roots: string[], identifiers: string[]): Map<string, number> {
  const seeds = new Map<string, number>();
  const add = (path: string, weight: number): void => {
    const found = files.find((file) => file.path === path || file.path.endsWith(`/${path}`));
    if (found) seeds.set(found.path, Math.max(seeds.get(found.path) ?? 0, weight));
  };
  for (const path of roots) add(normalizePath(path), 1.5);
  for (const identifier of identifiers) {
    for (const path of extractDefinitionPaths(files, identifier)) add(path, 2);
  }
  return seeds;
}

function extractDefinitionPaths(files: RepoMapFile[], identifier: string): string[] {
  return files.filter((file) => file.symbols.some((symbol) => symbol.name === identifier)).map((file) => file.path);
}

function personalizedRanks(cache: RepoMapCache, seeds: Map<string, number>): Map<string, number> {
  const files = cache.files;
  const incoming = new Map<string, string[]>();
  for (const file of files) incoming.set(file.path, []);
  for (const [source, targets] of cache.edges) {
    for (const target of targets.keys()) incoming.get(target)?.push(source);
  }
  const base = new Map(files.map((file) => [file.path, (seeds.get(file.path) ?? 0) > 0 ? seeds.get(file.path)! : 0.05]));
  const baseTotal = [...base.values()].reduce((sum, value) => sum + value, 0) || 1;
  for (const [path, value] of base) base.set(path, value / baseTotal);
  let ranks = new Map(base);
  const damping = 0.85;
  for (let iteration = 0; iteration < 24; iteration++) {
    const next = new Map<string, number>();
    for (const file of files) next.set(file.path, (1 - damping) * (base.get(file.path) ?? 0));
    for (const [source, targets] of cache.edges) {
      const total = [...targets.values()].reduce((sum, value) => sum + value, 0);
      if (total <= 0) continue;
      const sourceRank = ranks.get(source) ?? 0;
      for (const [target, weight] of targets) next.set(target, (next.get(target) ?? 0) + damping * sourceRank * weight / total);
    }
    ranks = next;
  }
  return ranks;
}

function filePriority(file: RepoMapFile, rank: number, cache: RepoMapCache, seeds: Map<string, number>): number {
  const symbolWeight = file.symbols.reduce((sum, symbol) => sum + Math.log2(2 + (cache.references.get(symbol.name) ?? 0)), 0);
  const entryBoost = /(^|\/)(index|main|app|server|cli|entry)\.(ts|tsx|js|jsx|py|go|rs|java)$/i.test(file.path) ? 2.5 : 0;
  const seedBoost = seeds.has(file.path) ? 3 : 0;
  return rank * 100 + symbolWeight * 0.7 + entryBoost + seedBoost;
}

export class RepoMap {
  private cache: RepoMapCache | undefined;
  constructor(private readonly root: string, private readonly extraIgnores: string[] = []) {}

  async refresh(force = false): Promise<void> {
    if (!force && this.cache && Date.now() - this.cache.loadedAt < CACHE_TTL_MS) return;
    const matcher = await loadIgnore(this.root, this.extraIgnores);
    const entries = await fg("**/*", {
      cwd: this.root,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      unique: true,
      ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", "coverage/**", ".pforge/**", "target/**", "vendor/**", ...this.extraIgnores]
    });
    const paths = entries
      .filter((path) => isCodeFile(path))
      .filter((path) => !matcher.ignores(normalizePath(path)))
      .slice(0, MAX_FILES);
    const files = paths.map((path) => parseFile(this.root, path)).filter((file): file is RepoMapFile => Boolean(file));
    this.cache = { loadedAt: Date.now(), files, ...buildGraph(files) };
  }

  async render(options: RepoMapRenderOptions = {}): Promise<RepoMapResult> {
    await this.refresh();
    const cache = this.cache;
    if (!cache) throw new Error("Repo map is unavailable");
    const budgetTokens = Math.max(200, Math.min(options.budgetTokens ?? 1_500, 12_000));
    const seedIdentifiers = [...new Set([...(options.seedIdentifiers ?? []), ...tokenizeQuery(options.query)])];
    const seeds = extractSeeds(cache.files, options.seedFiles ?? [], seedIdentifiers);
    const ranks = personalizedRanks(cache, seeds);
    const ranked = [...cache.files].sort((a, b) => filePriority(b, ranks.get(b.path) ?? 0, cache, seeds) - filePriority(a, ranks.get(a.path) ?? 0, cache, seeds));
    const lines: string[] = ["<repo_map>"];
    let symbols = 0;
    let usedTokens = estimateTokens(lines[0]!);
    for (const file of ranked) {
      if (file.symbols.length === 0 && !seeds.has(file.path)) continue;
      const header = `${file.path}:`;
      const headerTokens = estimateTokens(header);
      if (usedTokens + headerTokens > budgetTokens) break;
      lines.push(header);
      usedTokens += headerTokens;
      const fileSymbols = [...file.symbols]
        .sort((a, b) => (cache.references.get(b.name) ?? 0) - (cache.references.get(a.name) ?? 0) || a.line - b.line)
        .slice(0, seeds.has(file.path) ? 24 : 8);
      for (const symbol of fileSymbols) {
        const rendered = `  ${symbol.kind} ${symbol.signature.replace(/^\s*(?:export\s+)?(?:default\s+)?/, "")} [L${symbol.line}]`;
        const cost = estimateTokens(rendered);
        if (usedTokens + cost > budgetTokens) break;
        lines.push(rendered);
        usedTokens += cost;
        symbols++;
      }
      lines.push("");
    }
    lines.push("</repo_map>");
    const text = lines.join("\n");
    return { text, files: ranked.length, symbols, estimatedTokens: estimateTokens(text), rankedFiles: ranked.map((file) => file.path) };
  }

  async focused(query: string, budgetTokens = 2_000): Promise<RepoMapResult> {
    return this.render({ query, budgetTokens, seedIdentifiers: tokenizeQuery(query) });
  }
}

export function extractRepoMapSeeds(messages: Array<{ role: string; content: unknown }>): { seedFiles: string[]; seedIdentifiers: string[] } {
  const files = new Set<string>();
  const identifiers = new Set<string>();
  const scan = (value: string): void => {
    for (const match of value.matchAll(/(?:^|[\s`"'(])([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|rb|php|swift|scala|lua))/g)) {
      if (match[1]) files.add(normalizePath(match[1]));
    }
    for (const match of value.matchAll(/\b[A-Z][A-Za-z0-9_$]{2,}\b/g)) identifiers.add(match[0]);
  };
  for (const message of messages.slice(-16)) {
    if (typeof message.content === "string") scan(message.content);
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") scan(part.text);
        if (part && typeof part === "object" && "input" in part) scan(JSON.stringify(part.input));
      }
    }
  }
  return { seedFiles: [...files].slice(0, 24), seedIdentifiers: [...identifiers].slice(0, 32) };
}

export function isWorkspaceCodePath(root: string, path: string): boolean {
  const absolute = resolve(root, path);
  return isCodeFile(absolute) && !normalizePath(relative(root, absolute)).split("/").some((part) => SKIPPED_PARTS.has(part));
}

void basename;
void sep;
