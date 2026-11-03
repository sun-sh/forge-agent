# Forge Agent

**Forge Agent** is a local coding agent with a Web client and CLI, built on [Pi Coding Agent](https://github.com/earendil-works/pi) 1.4.0.
It deliberately keeps Pi as the runtime: authentication, model selection, the interactive TUI,
sessions, compaction, built-in tools, MCP, skills, extensions, and prompt templates come from Pi.
forge-agent adds a local Web client, a branded entry point, isolated `FORGE_AGENT_HOME` data,
and a project verification gate. See [architecture and current scope](docs/architecture.md)
for the boundary between forge-agent and Pi, including differences between CLI and Web support.

**Status:** early `0.1.0`. The Pi delegation and verification paths are tested locally. This is not
a claim of benchmark parity with Codex or Claude Code, and it is not an OS-level sandbox.

## Install

Requires Node.js `>=22.19.0`.

```powershell
npm install
npm run build
npm link
```

Then start it:

```powershell
forge-agent
```

For the Web client, run `forge-agent web`; it starts the local gateway and automatically opens the client in your default browser. No startup link needs to be copied. Select a project, working mode, model and thinking level below the prompt. Configure provider connections in Settings when needed. The model selector uses Pi's catalog, groups available models by provider, and retains the current conversation's selection when services are edited. Conversations are grouped by project in the left sidebar and can be reopened; the same project-session history is stored under `FORGE_AGENT_HOME/sessions`. Use `/help` for Pi's commands in the TUI. The
interactive screen and `~/.pi` helper downloads are supplied by Pi Core; the command itself is
`forge-agent`, while advanced TUI branding would require maintaining a Pi source fork.

Each conversation is bound to its project. Idle conversations can be opened from another project's
history; creating a conversation in a different folder starts with New conversation. Restoring a
session checks its recorded working directory. The composer exposes the project, model, and thinking level below the prompt; those
choices are persisted through Pi's `SettingsManager` and can also be changed for the current
session. The Settings drawer also shows Provider authentication state, refreshes Pi's model catalog,
stores API keys through Pi's `ModelRuntime`, exposes the project trust decision, and shows the
verification configuration without printing credentials.

Settings has Service, Model, Project, and About tabs. The model browser filters by
provider, supports search and pagination, and shows available model capabilities. Choose the current
model in the composer; choosing one for a new conversation also remembers that preference through Pi.
Authentication is labeled as configured, rather than as a successful connection test.

Add a third-party service from **Settings → Service → Add service**. Enter its name, Base URL,
API protocol and API key, then fetch the model list and open the searchable checkbox dropdown.
Select or clear the filtered results and confirm the batch before saving. Selections survive search
changes, and existing manual IDs and model parameters are preserved. You can also
enter model IDs manually when the service has no model-list endpoint. The editor supports OpenAI
Chat Completions, OpenAI Responses and Anthropic Messages compatible APIs. Local servers such as
Ollama or LM Studio can use the explicit no-key option. Optional model details include context and
output limits, reasoning and image input. Keep these values consistent with your service's model.

**Test model invocation** sends a short request through Pi using the first model and reports success
only when it receives text; fetching a model list alone is not a successful inference test. Save
the service to make its models immediately available without restarting; select one below the composer.
Saving a service does not replace the active conversation's model. Saved services can be
edited, and an empty Key field keeps an existing key when the destination is unchanged. Changing
the endpoint or protocol requires an explicit new key or the no-key option.

The editor writes Pi's `FORGE_AGENT_HOME/models.json` and stores literal keys through Pi's authentication
API. Keys are never returned by the editor or stored in browser storage. Writes preserve other
providers, comments and advanced fields; malformed files and stale concurrent edits are rejected.
Advanced custom headers, OAuth flows and provider extensions remain managed through Pi.

The composer offers three working modes, with **Shift+Tab** to cycle while the prompt has focus:

| Mode | Behavior |
| --- | --- |
| Agent | Uses Pi's configured tools to implement changes and runs configured project verification. |
| Plan | Reads and searches the codebase, then proposes an implementation plan. Switch to Agent and send an execution instruction to implement it. |
| Ask | Reads and searches the codebase to answer questions and explain code. |

Plan and Ask permit only Pi's built-in `read`, `grep`, `find`, and `ls` tools. The Pi extension checks
actual tool calls, including nested calls and tools that reuse a reader's name. Shell, editing,
MCP/custom tools, slash-command dispatch and automatic project verification are disabled in these
modes. A skipped verification is never reported as a pass. The mode is saved as a Pi custom session
entry and restored with history, including history opened without available model credentials.
Mode changes are blocked during a run; restoring a session cannot silently switch it into Agent.
Switching modes keeps the model and unsent draft. These controls restrict model-driven actions;
trusted extensions and Pi still run with the launching user's OS permissions. This is not an OS sandbox.

`forge-agent web` hands the startup credential to the browser automatically and prints a plain local
address. The browser retains an HttpOnly, SameSite=Strict cookie; the credential disappears from
the address bar when the page starts.
Afterward, new tabs can open the same local address without a token in the URL. The gateway access
key is persisted at `FORGE_AGENT_HOME/web/access-token`, so restarting on the same address does not
invalidate existing browser authorization. A tab without authorization waits for the browser
bootstrap and reconnects automatically when the same browser receives it. The connection dialog
has no link or credential input. Recovery retains the active session pointer and unsent text.
Restart recovery reopens saved Pi history and never automatically resends a task.
Opening an unauthenticated page does not grant API access. Host, Origin, and cross-site fetch checks
protect the local gateway. This browser authorization is separate from Pi's model-provider credentials.

For integrations that manage the browser separately, `forge-agent web --no-open` prints the startup
address with its credential and does not launch a browser. This is optional; normal use needs only
`forge-agent web`.

The client renders Markdown, code, reasoning, tool output, and verification reports. Stream
reconnections use event cursors and current snapshots, and refreshing the page restores the active
conversation. Historical sessions remain readable without model credentials; selecting an available
model allows the conversation to continue. Project history can be collapsed and searched. Revoking
project trust unloads the runtime and its project extensions before another prompt can run.

The Web SDK adapter installs Pi's built-in MCP, codemode, and tool-search factories, preserving
Pi's disabled/replacement semantics and project trust. Configure servers through Pi's `mcp.json`;
only trusted project MCP configuration is loaded. Skills and compatible extensions also use
Pi's resource discovery; terminal-specific custom extension UI remains a TUI capability.

The Web client currently supports API-key setup directly. OAuth providers retain Pi's complete
authentication flow and can be configured from the local TUI with `forge-agent` followed by `/login`;
once stored, the Web client will use the resulting Pi credential without copying or displaying it.
The Web client includes a Git changes panel for staged, unstaged and untracked files, with bounded
diff previews and labels for edits that predated a planned task. Session archive/fork/export and
attachment input are not yet exposed. See the [product audit](docs/product-audit.md)
for remaining gaps and priorities.

Agent engineering details are documented in [architecture](docs/architecture.md),
and reproducible task evaluation commands and limits in [evaluation](docs/evaluation.md).

For complex coding work, select **计划并执行** below the composer. forge-agent coordinates research,
planning, implementation, programmatic verification and a read-only model review above Pi's
execution engine. Phase state, verification evidence and review are stored in the Pi session
branch. Configured verification failure, missing verification or unresolved review issues do not
produce a completed task. Direct conversation remains available for simple questions and edits.
Stopping a task prevents later phases. After a service restart, an interrupted task waits for the
explicit **重新检查并继续** action and re-inspects the current workspace rather than replaying tools.
The model review is a second pass, not an independent proof of code correctness.

## Use

```powershell
forge-agent web                              # start and open the local Web client
forge-agent web --no-open                    # browser managed by another tool
forge-agent                                  # interactive TUI
forge-agent -p "Fix the failing test"        # one-shot
forge-agent -C path/to/repo                  # choose a workspace
forge-agent -c                               # continue latest session
forge-agent -r                               # choose a session
forge-agent --model provider/model           # select a model
forge-agent --offline                        # disable startup network work
```

Inspect local setup without printing credentials:

```powershell
forge-agent doctor
```

`doctor` reports credentials as configured/not configured but never prints a key. A missing
credential makes the command exit nonzero until `/login` or a provider environment variable is configured.

List and run verification directly:

```powershell
forge-agent check
```

## Verification gate

Create `forge-agent.json` in the project root (or supply `forge-agent.yaml` / `forge-agent.yml`):

```json
{
  "verify": [
    { "name": "typecheck", "command": "npm run typecheck", "timeoutMs": 120000 },
    { "name": "test", "command": "npm test", "timeoutMs": 300000 }
  ],
  "verifyRetries": 2
}
```

The file is intentionally strict: only `verify` and `verifyRetries` are accepted. Unknown keys are
configuration errors; they are never silently ignored.

When verification is configured, forge-agent runs the commands before a completed agent run settles.
On failure, the exact command output is returned to the model and the model gets `verifyRetries`
repair attempts. If checks still fail, the process exits `1`. The built-in `run_verification` tool
and `/verify` command are also available. Latest reports are stored under
`FORGE_AGENT_HOME/verification/<workspace-hash>/latest.json`; run-specific evidence files are retained
alongside it and the outcome is appended to the Pi session branch. Planned tasks run the same
verification gate between implementation and review with the same bounded repair budget.

Verification commands come from project configuration, so forge-agent refuses to execute them when Pi
has not trusted the project. Use Pi's trust flow or `--approve` for a deliberate one-time approval.

## Configuration and data

- Pi configuration and credentials: `FORGE_AGENT_HOME` (default `~/.forge-agent`)
- Pi sessions: `FORGE_AGENT_HOME/sessions`
- Local Web gateway key: `FORGE_AGENT_HOME/web/access-token`
- Project verification: `forge-agent.json`, `forge-agent.yaml`, or `forge-agent.yml`
- Verification reports: `FORGE_AGENT_HOME/verification`

Existing installations keep their configuration and history: `PFORGE_HOME` remains an alias,
and the default reuses `~/.pforge` when `~/.forge-agent` does not exist. Set `FORGE_AGENT_HOME`
to choose a directory explicitly. Legacy `pforge.json`, `pforge.yaml` and `pforge.yml` files
remain supported; the new `forge-agent.*` files take precedence in the same directory.
Saved session entry names and browser storage identifiers stay compatible across this rename.

Because forge-agent sets `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`, model/auth/session
data lives under `FORGE_AGENT_HOME` rather than Pi's default `~/.pi/agent`. Pi may still install its own
helper binaries (for example `fd`) under its default directory; those are runtime tooling, not
forge-agent sessions or credentials.

MCP, skills, extensions, prompt templates, providers, models, and session controls are configured
through Pi, subject to the Web integration limits described above. See Pi's `configuration.md`, `models.md`, `mcp.md`, `skills.md`, and
`extensions.md` documentation in the installed package.

## Development

```powershell
npm run typecheck
npm test
npm run build
npm run check
npm run test:web
npm audit --json
```

`test:web` requires a Chromium browser (Edge/Chrome are discovered on Windows; set
`FORGE_AGENT_TEST_BROWSER` to another executable). It uses a temporary browser profile, project, Pi home,
and local mock model. It exercises automatic cross-tab recovery, browser cookie authorization, plain-URL
navigation, service restart without task replay, adding a third-party service from an empty configuration,
model discovery, Pi inference testing, immediate model selection, settings, folders, streaming, verification, history recovery, and
the narrow layout. Screenshots and a result manifest are written to `.forge-agent/web-audit/`. This check
does not use personal browser profiles, saved credentials, or a remote model service.

The active product entry points are `src/pi-cli.ts` and `src/web/server.ts`; Web assets live in
`src/web/ui/`. The forge-agent-specific verification layer is `src/config.ts`, `src/verification/`, and
`src/tools/command.ts`. Earlier self-built agent/runtime modules remain in the repository as legacy
code and are excluded from the active build and tests. The Web gateway uses Pi sessions and tools.

## Security boundary

Like Pi, forge-agent runs with the permissions of the user who starts it. Project trust is not an OS
sandbox: generated tool calls can access files and processes available to that user. For untrusted
repositories, use a container, VM, or restricted account. Review the project before using
`--approve`; extensions and project configuration can execute code inside the agent process.

## License

MIT
