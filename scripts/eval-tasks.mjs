// Small, public tasks for repeatable engineering evaluations. Held-out checks run outside the workspace.
export const tasks = [
  {
    id: 'clamp-bounds',
    prompt: 'Fix clamp in solution.mjs: finite numeric inputs must be clamped inclusively between min and max; throw RangeError for inverted bounds. Preserve notes.txt and do not alter verify.mjs. Use the configured verification.',
    initial: 'export function clamp(value, min, max) { return Math.min(min, Math.max(max, value)); }\n',
    solution: 'export function clamp(value, min, max) { if (min > max) throw new RangeError("inverted bounds"); return Math.min(max, Math.max(min, value)); }\n',
    visible: 'assert.equal(mod.clamp(5, 0, 10), 5); assert.equal(mod.clamp(15, 0, 10), 10);',
    heldOut: 'assert.equal(mod.clamp(-8, -5, 3), -5); assert.equal(mod.clamp(1, 1, 1), 1); assert.equal(mod.clamp(0.5, 0, 1), 0.5); assert.throws(() => mod.clamp(0, 9, 1), RangeError);'
  },
  {
    id: 'strict-port',
    prompt: 'Fix parsePort in solution.mjs. Accept a string of decimal digits only, with value 1..65535. Reject whitespace, suffixes, decimals, signs, empty input and non-strings by returning null. Preserve notes.txt and do not alter verify.mjs.',
    initial: 'export function parsePort(value) { const port = parseInt(value, 10); return port > 0 ? port : null; }\n',
    solution: 'export function parsePort(value) { if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null; const port = Number(value); return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null; }\n',
    visible: 'assert.equal(mod.parsePort("4328"), 4328); assert.equal(mod.parsePort("12tail"), null);',
    heldOut: 'for (const value of ["0", "65536", "1.2", " 80", "80 ", "+80", "", null, 80]) assert.equal(mod.parsePort(value), null); assert.equal(mod.parsePort("65535"), 65535); assert.equal(mod.parsePort("00080"), 80);'
  },
  {
    id: 'stable-dedupe',
    prompt: 'Fix uniqueStable in solution.mjs. Return a new array with duplicate values removed while preserving the first occurrence order. Do not mutate the input array. Support primitive values and object references. Preserve notes.txt and do not alter verify.mjs. Use the configured verification.',
    initial: 'export function uniqueStable(values) { return values; }\n',
    solution: 'export function uniqueStable(values) { return [...new Set(values)]; }\n',
    visible: 'assert.deepEqual(mod.uniqueStable(["a", "b", "a"]), ["a", "b"]);',
    heldOut: 'const object = { id: 1 }; const input = [object, "x", object, "x", "y"]; const output = mod.uniqueStable(input); assert.deepEqual(output, [object, "x", "y"]); assert.notStrictEqual(output, input); assert.deepEqual(input, [object, "x", object, "x", "y"]);'
  },
  {
    id: 'config-normalize-cross-file',
    entry: 'src/index.mjs',
    prompt: 'Fix normalizeConfig across the small src module. Accept an object and return a new object. Preserve retries only when it is a numeric integer from 0 to 10 inclusive; missing, non-integer or out-of-range retries must use the default 3, without rounding or clamping. Return tags as a new array containing only the input array\'s string elements, or [] when tags is not an array. Do not mutate input, preserve the public re-export in src/index.mjs, preserve notes.txt and verify.mjs, and use the configured verification.',
    initialFiles: {
      'src/config.mjs': 'export function normalizeConfig(input) { return { retries: input.retries || 3, tags: input.tags || [] }; }\n',
      'src/index.mjs': 'export { normalizeConfig } from "./config.mjs";\n'
    },
    solutionFiles: {
      'src/config.mjs': 'export function normalizeConfig(input) { const retries = Number.isInteger(input?.retries) && input.retries >= 0 && input.retries <= 10 ? input.retries : 3; const tags = Array.isArray(input?.tags) ? input.tags.filter((tag) => typeof tag === "string") : []; return { retries, tags: [...tags] }; }\n',
      'src/index.mjs': 'export { normalizeConfig } from "./config.mjs";\n'
    },
    visible: 'assert.deepEqual(mod.normalizeConfig({ retries: 2, tags: ["a"] }), { retries: 2, tags: ["a"] });',
    heldOut: 'const input = { retries: -1, tags: ["x", 3] }; const output = mod.normalizeConfig(input); assert.deepEqual(output, { retries: 3, tags: ["x"] }); assert.notStrictEqual(output, input); assert.deepEqual(input, { retries: -1, tags: ["x", 3] }); assert.deepEqual(mod.normalizeConfig({ retries: 0, tags: [] }), { retries: 0, tags: [] }); assert.deepEqual(mod.normalizeConfig({ retries: 11 }), { retries: 3, tags: [] });',
    reviewFault: { path: 'src/config.mjs', content: 'export function normalizeConfig(input) { return { retries: input.retries || 3, tags: input.tags || [] }; }\n', label: 'visible checks pass while negative retries and mixed tags remain wrong' }
  },
  {
    id: 'root-safe-path-cross-file',
    entry: 'src/index.mjs',
    prompt: 'Fix joinWithinRoot across the small src module. Resolve a child path under root and throw RangeError when it escapes through .. or an absolute path. Keep a child equal to root valid, preserve the public re-export in src/index.mjs, preserve notes.txt and verify.mjs, and use the configured verification.',
    initialFiles: {
      'src/path.mjs': 'import { resolve } from "node:path"; export function joinWithinRoot(root, child) { return resolve(root, child); }\n',
      'src/index.mjs': 'export { joinWithinRoot } from "./path.mjs";\n'
    },
    solutionFiles: {
      'src/path.mjs': 'import { resolve, sep } from "node:path"; export function joinWithinRoot(root, child) { const base = resolve(root); const target = resolve(base, child); if (target !== base && !target.startsWith(base + sep)) throw new RangeError("path escapes root"); return target; }\n',
      'src/index.mjs': 'export { joinWithinRoot } from "./path.mjs";\n'
    },
    visible: 'assert.match(mod.joinWithinRoot("/workspace", "src/app.mjs"), /workspace[\\\\/]src[\\\\/]app\\.mjs$/);',
    heldOut: 'import { resolve } from "node:path"; assert.equal(mod.joinWithinRoot("/workspace", "."), resolve("/workspace")); assert.throws(() => mod.joinWithinRoot("/workspace", "../secrets"), RangeError); assert.throws(() => mod.joinWithinRoot("/workspace", "/etc/passwd"), RangeError);'
  }
];
