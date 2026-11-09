# Forge Agent

**Code locally, with inspectable changes, verification and interruption recovery.**

[Simplified Chinese](README.md) · English

[![CI](https://github.com/sun-sh/forge-agent/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/sun-sh/forge-agent/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Forge is a local coding agent with a Web workspace. Connect a model you configure, open a project, and chat, edit files, run tools and inspect Git changes.

Forge concentrates on the delivery boundary: did passing tests hide edits to the tests themselves? Can interrupted work retain its goal and plan? Does “complete” have evidence for the current workspace? These controls sit above **Pi Coding Agent 1.4.0** sessions; Pi continues to own the model and tool loop.

![Forge Web workspace](docs/assets/workspace.png)

*Actual Edge acceptance screenshot using an isolated local fixture service, with the temporary path header removed. It demonstrates the UI, not model coding quality. [30-second screenshot walkthrough](docs/assets/walkthrough.gif).*

## Start locally

Prepare Git, Node.js **>= 22.19.0**, and an available model service:

```bash
git clone https://github.com/sun-sh/forge-agent.git
cd forge-agent
npm ci
npm run build
npm start
```

Startup opens the default browser. The default local address is `http://127.0.0.1:4317/`.

1. Open **Settings → Services → Add service** (`设置 → 服务 → 添加服务`). Enter the protocol, Base URL and key, fetch and select models or enter an ID, test and save. Keyless local services can be explicitly configured.
2. Choose a model, reasoning effort and **Agent / Plan / Ask** under the composer. Agent defaults to adaptive execution; only the secondary “Plan and execute” choice enables staged orchestration.
3. Open a project or send the first message to create a managed project folder. The paperclip, drag-and-drop and pasted images supply attachments.

The editor supports OpenAI Chat Completions, Responses and Anthropic Messages interfaces. The current Web UI is Chinese. See the [user guide](docs/usage.en.md) for setup and protocol boundaries. Pi supplies the optional terminal client; run `npm link` from source to use `forge-agent`.

## Core behavior

| Need | Forge behavior |
| --- | --- |
| **Check delivery** | Verification binds to workspace and configuration fingerprints. Changed protected files fail delivery even when tests pass. Historical passes remain distinct from current evidence. |
| **Opt into planning** | Inspect → Plan → Implement → Verify → independent read-only Review; structured constraints and acceptance survive phases, with bounded shared repairs. |
| **Continue interrupted work** | Reuse the Pi conversation and files at a valid saved phase, without appending the original request or replaying tools. Interrupted verify/review begins with fresh verification. |
| **Keep the UI focused** | Project-based conversations and forks, right-aligned user messages and folded process output. Changes, files, terminal and execution records live on the right; pause reasons appear beside the composer. |
| **Bound parallel work** | Queue up to three different projects. Subagents explore/review with readers; workers propose changes in isolated worktrees for user-reviewed application and main-project verification. |

The UI manages models, MCP, Skills, context compaction and scoped reference memory. Ordinary workers have no shell, MCP or nested delegation and suit bounded file tasks. See [subagent design](docs/subagents.md) for permissions, budgets and proposal limits.

## Configure verification and protected paths

Create `forge-agent.json` in the target project root; YAML is also supported:

```json
{
  "verify": [
    { "name": "typecheck", "command": "npm run typecheck", "timeoutMs": 120000 },
    { "name": "test", "command": "npm test", "timeoutMs": 300000 }
  ],
  "verifyRetries": 2,
  "protect": ["tests", "package-lock.json"]
}
```

Only `verify`, `verifyRetries` and `protect` are accepted; unknown fields fail. Commands require project trust. Exact failure output returns to the model and cannot produce a successful exit. `protect` accepts literal project-relative files/directories; pre-existing dirty content becomes the baseline, and changes or incomplete observations block delivery. See the [schema](forge-agent.schema.json) and [user guide](docs/usage.en.md).

Missing checks never imply verified success. Planned implementation still requires current verification evidence; adaptive execution explicitly reports whether checks ran.

The Web host detects a single-response output-limit stop, including reasoning-only output with no text or tool calls. It requests at most two continuations through Pi settlement under the same task budget; repeated failure stops implementation with its actual cause. Continuing a legacy record returns to incomplete implementation instead of verifying an empty result.

## Long tasks and local data

New installations allow 90 minutes, 240 model turns, 500 tool calls and 300,000 generated tokens per segment, with cumulative request tokens measured by default and a $40 cost ceiling. **Settings → About → Execution budget** provides a four-hour preset that preserves the cost ceiling. Saving affects the next execution or continuation; existing saved limits remain unchanged.

Reaching a limit preserves state and explains why execution stopped. Continue starts a new bounded usage segment while retaining requirements, the protection baseline and consumed repair count. See [operations and recovery](docs/operations.md) for detached execution.

Data defaults to `~/.forge-agent`, with `FORGE_AGENT_HOME` and legacy `PFORGE_HOME` / `~/.pforge` support. Managed projects are centralized; external folders stay in place. Remote models still receive relevant content. Tools, MCP, extensions and commands have the launching user's OS permissions; trust and worktrees are not OS sandboxes. See [SECURITY.md](SECURITY.md).

## Ownership and evidence

**Pi owns** model/tool loops, authentication, built-in tools, session trees, compaction, MCP protocols, Skills, extensions and discovery. **Forge owns** task state and handoffs, delivery/protection gates, budgets and execution ownership, recovery, child lifecycle and the Web product layer. The archived prototype is outside the active build.

[Architecture Deep Dive](docs/architecture-deep-dive.md) explains tradeoffs and limits. [Evaluation methods and real failures](docs/evaluation.md) separate regressions, fixture services and real-model runs. The evaluator supports pinned baseline/reference validation and `direct / planned / planned-no-review` ablation. Review disabling is confined to isolated evaluation; production requests cannot bypass the gate. Current samples do not establish general planning, review or memory gains.

```bash
npm run check
npm run test:web
npm run pack:check
npm run eval:smoke -- --workflow ablation
```

Source execution and tarball checks are available. npm registry publication and desktop installers are not released; see [operations](docs/operations.md). Sanitized reproduction cases and [contributions](CONTRIBUTING.md) are welcome.

[MIT License](LICENSE). Thanks to [Pi](https://github.com/earendil-works/pi) and the project's open-source dependencies.
