#!/usr/bin/env node
import { resolve } from "node:path";
import { runEvalSuite, loadEvalSuite, type EvalSuite } from "./runner.js";

const [suiteArg, templateArg, reportArg] = process.argv.slice(2);
if (!suiteArg || !templateArg) {
  process.stderr.write("Usage: node dist/eval/cli.js <suite.json> <workspace-template-dir> [report-dir]\n");
  process.exit(2);
}
const suitePath = resolve(suiteArg);
const template = resolve(templateArg);
const reportDir = resolve(reportArg ?? ".pforge/evals");
const suite: EvalSuite = loadEvalSuite(suitePath);
const report = await runEvalSuite({ suite, projectRoot: process.cwd(), workspaceTemplate: template, reportDir });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.passed !== report.total) process.exitCode = 1;
