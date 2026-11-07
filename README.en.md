# Forge Agent

**Connect your chosen model to understand, change, and check local projects from your browser.**

[简体中文](README.md) · English

[![CI](https://github.com/sun-sh/forge-agent/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/sun-sh/forge-agent/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19.0-43853d)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Forge Agent is an open-source coding agent for local projects, with a Web workspace as its primary interface: projects and conversations on the left, chat in the center, and Git diffs, project files, and terminal output on the right. Connect compatible third-party or local model services, manage MCP, Skills, and scoped memory, or use the optional terminal client.

Built on the complete [Pi Coding Agent](https://github.com/earendil-works/pi) **1.4.0** runtime, Forge focuses on **task orchestration, tool policies, verification gates, reviewable changes and memory, background execution, and recovery**. Version **0.2.0** is intended for local development and early feedback, with source installation, package checks, and a GitHub tag release workflow.

[Quick start](#quick-start) · [Design and ownership](#design-and-ownership) · [User guide](docs/usage.en.md) · [Architecture](docs/architecture.md) · [Evaluation](docs/evaluation.md)

## Quick start

Install Git and **Node.js >= 22.19.0**, and have access to a model service.

```bash
git clone https://github.com/sun-sh/forge-agent.git
cd forge-agent
npm ci
npm run build
npm start
```

`npm start` launches the local gateway and opens your default browser on port `4317`. Normal startup handles browser authorization automatically. Use `npm start -- --port 4328` for another port.

1. Open **Settings → Service → Add service** (`设置 → 服务 → 添加服务`). Enter a Base URL, protocol, and API key, or explicitly select the no-key option for a compatible local service. Discover and select models, or enter their IDs manually; test an actual invocation and save.
2. Choose the model, reasoning effort, and working mode below the composer. A first-time user does not need to choose a folder: sending the first message creates an independent project under `FORGE_AGENT_HOME/projects`. The project picker can also create one explicitly or open an existing folder elsewhere on the computer.
3. Describe the task, for example: **“Fix the failing login tests, preserve the existing API, and run project verification.”** Configure `forge-agent.json` below if you want automatic project checks. Use the paperclip next to Send to select images, UTF-8 text, and source files; drag and drop and pasted images also work.

The provider editor supports APIs compatible with **OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages**. Local services such as Ollama and LM Studio need to expose a compatible endpoint. Reasoning options follow the model's capabilities; changes selected during a run apply to the next message. The Web interface is currently in Chinese.

The Web model picker offers providers with credentials or configuration saved in the Forge data directory. Credentials inherited from the launching application do not automatically add models. Explicit environment references in `models.json` remain supported.

## Workspace and capabilities

| Scenario | Current support |
| --- | --- |
| **Work by project** | Forge-managed projects and explicitly opened local folders share one project list, with removal and recovery by reopening the folder; project conversations, search, rename, pin, archive, trash, and restore; message-edit forks and Markdown / JSON export. |
| **Inspect changes** | Right-side Git diffs, files and terminal; review execution checkpoints and undo selected files while preserving earlier dirty work and refusing conflicts. |
| **Provide context** | Project text references, uploaded images and UTF-8 source/text files, user-maintained global/project/session memory, and composer-level context and Pi compaction controls. |
| **Connect models and tools** | Provider setup, model discovery and multi-select; MCP configuration, probes, browser OAuth and tool settings; Skills preview, toggles and local-directory imports. |
| **Track and recover tasks** | Phases, verification, budgets and a durable index; `/queue` queues subsequent text tasks; a detached local service survives its launching terminal without replaying started tasks after a crash. |
| **Delegate subtasks** | Exploration, review and implementation in independent worktrees; inspect and selectively apply child changes in the right panel, with conflict checks against the main project. |

File references and previews check paths, known sensitive filenames, symlinks, and size; images also have format and aggregate limits. These checks bound the Web feature's access and do not provide process isolation.

### Working modes

| Mode | Behavior |
| --- | --- |
| **Agent** | Use Pi's tools to change code and execute commands; adaptive execution is the default. |
| **Plan** | Investigate with read-only tools and propose a plan; the user switches to Agent to implement it. |
| **Ask** | Read code and answer questions. |

Plan / Ask restrictions apply to actual tool calls, including dynamic and nested calls. Built-in readers and search remain available; writes, shell, MCP/custom tools, and automatic project verification are blocked. Trusted extension code still has the launching user's permissions.

### Workflows

**Adaptive execution is the default**: Pi runs model/tool turns, the model chooses its steps, and Forge enforces verification when checks are configured.

The host controls stages only after you explicitly select **Plan and execute** (`规划并执行`) in Agent's secondary menu. Code-changing requests follow this flow:

```mermaid
flowchart LR
    Inspect --> Plan
    Plan --> Implement
    Implement --> Verify
    Verify --> Review
    Review --> Complete
    Verify -->|Failure with repairs remaining| Implement
```

Completion requires passing configured checks, a structured `ready` model review with no unresolved issues, and no detected changes during review within the available Git evidence. Missing checks, invalid review, or stale evidence leave the task needing attention. Questions and verification-only requests take shorter paths.

This makes execution inspectable; the benefit of extra planning and model self-review still needs measurement. Verification repairs and per-execution time, model-turn, tool-call, token, and cost limits are bounded. An exhausted budget becomes a recoverable `budget_exceeded` task state.

### Subagents

The parent can use `subagent` to delegate up to three parallel tasks. `explorer` and `reviewer` are read-only; `worker` uses built-in readers, search, write and edit in a detached Git worktree seeded with eligible current working files. Children cannot write the main project, run shell commands, call MCP, load external extensions, or delegate further. Each child has an independent Pi context and inherits the model and reasoning effort at delegation. The planned-workflow self-review remains a separate gate.

A compact header control shows state, duration and tokens; the right panel exposes records and Stop. Review a worker's file diffs and explicitly apply selected changes to the main project, then run verification through the parent. Conflicting later edits are refused, and application creates an undo checkpoint. Cleaning a worktree preserves its sealed proposal and transcript. Read-only children support parent follow-ups; writable tasks require new delegation. Child sessions stay out of ordinary history, and parent cancellation drains active children. Separate child model settings and direct child-panel messages remain unsupported.

### Checkpoints and background operation

Agent executions in trusted Git repository roots capture working-file checkpoints. Open **Changes → Execution checkpoints** to select an execution, preview files, and undo selected changes. Recovery restores pre-execution content without resetting Git. HEAD/index changes, later file edits, links, or stale revisions prevent unsafe recovery. Ignored files, known sensitive paths, links and oversized files are excluded. Each snapshot is bounded to 1,500 files, 32 MB total and 2 MB per file.

To continue after closing the launching terminal, first stop the foreground gateway, then run:

```bash
node dist/pi-cli.js service start
node dist/pi-cli.js service status
node dist/pi-cli.js service stop
```

After completing the first conversation turn, use **`/queue task text`** for subsequent text tasks. The task center can inspect, cancel, open, and explicitly requeue jobs. Model, effort and workflow are frozen at admission; trust and session state are checked again at execution. Browser closure does not stop work. After process exit, queued jobs remain queued, while started jobs become interrupted and require explicit retry with fresh inspection. The detached process is not registered as an OS startup service. See [operations and upgrades](docs/operations.md).

### Execution budgets

**Settings → About → Execution budget** controls each Agent execution, including adaptive and planned workflows. The defaults are 15 minutes, 50 model turns, 300 tool calls, 750,000 tokens, and 25 USD. Budget snapshots are stored with the session and task record; after changing the limits, an interrupted or budget-exhausted task can be rechecked. Provider usage is usually observable at the end of a response, so one response may slightly cross a threshold; this is an execution guard, not a billing-level isolation boundary.

Child turns, tools and usage also count toward the parent's aggregate budget. Each child activation additionally has limits of three minutes, 12 model turns, 60 tool calls, 120,000 tokens and 2 USD, capped by the corresponding parent limits. One user request can delegate at most 12 activations, including follow-ups.

## Design and ownership

Forge implements product and control behavior above Pi sessions and reuses Pi's model/tool loop instead of reimplementing a second runtime.

| Forge implementation | Problem it addresses | Code |
| --- | --- | --- |
| **Task state and recovery** | Phase transitions, stopping, bounded repairs, task discovery and explicit re-inspection; Pi sessions retain the conversation and task records. | [Controller](src/task/controller.ts), [task index](src/task/registry.ts) |
| **Execution ownership and budgets** | One Web owner per home; Agent, terminal and project-trust changes share a canonical project lock; every execution has time, turn, tool, token and cost limits. | [Home lease](src/task/registry.ts), [project execution](src/web/executions.ts), [budget](src/task/budget.ts) |
| **Child lifecycle** | Independent Pi contexts, restricted tools, reserved capacity, aggregate budgets, result collection, cancellation and ownership checks. | [Subagent manager](src/web/subagents.ts), [design](docs/subagents.md) |
| **Verification and execution evidence** | Exact failed output, bounded repairs, timeouts and child-process tree termination; failed verification cannot count as successful completion. | [Verification extension](src/verification/pi-extension.ts), [command executor](src/tools/command.ts) |
| **Tool policies** | Enforce read-only modes during execution rather than relying on hidden UI controls. | [Mode policy](src/web/modes.ts) |
| **Change and context adapters** | Git evidence, snapshots, conflict detection and controlled recovery; scoped memory, reviewed candidates and provenance. | [Checkpoints](src/task/checkpoints.ts), [worktrees](src/task/worktrees.ts), [memory](src/web/memory.ts) |
| **Background tasks** | A detached process, durable FIFO, frozen job settings and explicit crash recovery. | [Queue](src/task/queue.ts), [service](src/web/service.ts) |
| **Web product layer** | Streaming, event reconnection, history forks, model/MCP/Skills management and execution-result presentation. | [Web gateway and UI](src/web/) |

**Pi owns** the agent loop, model calls and authentication, built-in tools, session trees, compaction, project trust, MCP protocol and execution, Skills, extensions, and resource discovery. Forge's MCP management reuses Pi's protocol and authorization capabilities. Pi also supplies the terminal interface.

Memory is injected by scope, with canonical project identity and validated legacy migration. Models can use `memory_proposal` to suggest project/session memory; candidates become active only after acceptance in **Settings → Memory**. Rejection, duplicate detection, provenance, explicit replacement and optimistic revision checks are supported. Forks do not inherit ownership of pending candidates. Pi owns automatic compaction. Vector retrieval and measured memory-quality gains remain future work. Earlier code under `archive/prototype/` is outside the supported build.

## Configure verification

Create `forge-agent.json` in the target project root; YAML is also supported. Replace these commands with your project's actual checks:

```json
{
  "verify": [
    { "name": "typecheck", "command": "npm run typecheck", "timeoutMs": 120000 },
    { "name": "test", "command": "npm test", "timeoutMs": 300000 }
  ],
  "verifyRetries": 2
}
```

Only `verify` and `verifyRetries` are accepted; unknown fields are errors. Checks require Pi project trust. Exact failed output is returned to the model, and internal continuations do not reset the repair count. Persistent failures produce a nonzero CLI exit status. Outcomes are recorded in the Pi session branch; raw output and reports live under `FORGE_AGENT_HOME/verification`.

See the [JSON Schema](forge-agent.schema.json). For terminal entry points, run `npm link`, then use `forge-agent`, `forge-agent check`, or `forge-agent -p "task"`.

## Development and evaluation

| Command | Purpose |
| --- | --- |
| `npm run check` | Types, active regression tests, build and CLI/bin checks. |
| `npm run test:web` | Web interaction acceptance in real Edge / Chrome / Chromium, using a local fixture model. |
| `npm run eval:smoke` | Scripted solutions exercise tools, workflows and evaluation plumbing. |
| `npm run eval:agent -- --model provider/model --workflow direct` | Run the fixed task suite against a real model; startup checks availability and copies the model catalog and credentials into an isolated evaluation home. |
| `npm run eval:agent -- --model provider/model --workflow planned` | Run the same suite through planned execution for comparison. |
| `npm run eval:agent -- --model provider/model --workflow both --repeat 3` | Repeat both workflows with fixed model settings and compare pass rate, latency, repairs, tokens, and cost. |
| `npm run eval:repo -- --suite path/to/suite.json --prepare` | Inspect pinned repository commits, commands and an independent oracle fingerprint without calling a model or running repository code. |
| `npm run eval:repo -- --suite path/to/suite.json --model provider/model --workflow both --repeat 3 --trust-suite` | Clone pinned repositories into isolated workspaces, enforce protected files and verification, and record independent results and false completions. Review and trust the suite before execution. |
| `npm run pack:check` | Check tarball assets, excluded private files and the packaged CLI. Release CI adds `--install` for a clean dependency installation. |

Evaluations use an isolated temporary Forge home and workspace, copying only the selected source's model and authentication configuration. The small public suite provides quick regressions. Repository evaluations require a pinned commit and a standalone Node oracle outside the workspace, and check protected files, verification gates and completion state. Reports record suite and oracle fingerprints, model, workflow, false completions, latency, budgets, tokens and cost. `--trust-suite` confirms that you have reviewed and authorized the repository resources, setup commands and oracle code. Passing regressions, scripted models or evaluation infrastructure does not establish real coding performance; no real-model comparison on complex repositories has been published. See [evaluation methods](docs/evaluation.md).

## Current scope

- **Runtime and delivery:** local Web and optional terminal clients; the Web UI is Chinese. A detached service, package checks and tag release workflow are implemented; npm publication and desktop installers are not claimed.
- **Concurrency and recovery:** one Web owner per `FORGE_AGENT_HOME`. Agent, terminal, trust changes, checkpoint recovery and proposal application share project ownership. The durable queue runs one job at a time and never automatically retries an interrupted execution.
- **Compatibility:** providers offer an optional three-request check for streaming text, tool-call arguments and tool-result continuation. This checks the selected endpoint/model; real OAuth, enterprise proxy, rate-limit and vendor-specific compatibility still require service acceptance.
- **Evidence still needed:** larger real-model repository comparisons and measured memory/planning gains. The pinned-repository evaluator provides the infrastructure; fixture tests do not establish coding quality or frontier performance.

Reproduced issues, impact, and acceptance criteria are recorded in the [product review](docs/product-audit.md) (Chinese).

## Data and security

Local data defaults to `~/.forge-agent`, overridden by `FORGE_AGENT_HOME`. Legacy `PFORGE_HOME`, `~/.pforge`, and `pforge.json/yaml/yml` remain compatible. The gateway does not automatically treat its launch directory as the first project.

Forge-managed projects live under `FORGE_AGENT_HOME/projects`, with the project index at `FORGE_AGENT_HOME/web/projects.json`. When you open an external folder, Forge stores its canonical path and works in place; it does not move or copy that project. A project directory is created lazily when the first message is sent without a selected project. Pi sessions remain centralized under `FORGE_AGENT_HOME/sessions`, so projects, conversations, and forks can be managed together on the local machine.

The gateway binds to `127.0.0.1` by default and uses a local credential, an HttpOnly / SameSite cookie, and Host / Origin checks. Model keys are saved through Pi's authentication API, never returned to the editor or stored in browser storage.

Local operation describes the client and execution process. A remote model still receives relevant content. Agent tools, MCP, trusted extensions, and verification commands have the launching user's OS permissions; project trust is not an OS sandbox. Review sessions and logs for sensitive content before sharing. See [security notes](SECURITY.md).

## Documentation and contributions

- [User guide](docs/usage.en.md): modes, commands, context, memory, Skills, MCP, sessions, and local data.
- [Architecture and ownership](docs/architecture.md): responsibilities of Pi and Forge.
- [MCP management](docs/mcp-management.md) · [Evaluation](docs/evaluation.md) · [Product review](docs/product-audit.md).
- [Contributor rules](AGENTS.md): completion, retries, trust, persistence, and security changes require regression tests.

Report issues with sanitized reproduction steps through [Issues](https://github.com/sun-sh/forge-agent/issues), or contribute within these boundaries.

## License and acknowledgments

[MIT License](LICENSE). Thanks to [Pi](https://github.com/earendil-works/pi) and the project's open-source dependencies.
