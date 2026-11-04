# MCP management

Forge Agent adds a Web management workflow above Pi 1.4.0. It uses Pi's MCP
implementation for connections and tools, and keeps `forge-agent.json` limited to
verification settings.

## Responsibilities

| Forge Agent | Pi |
| --- | --- |
| Web forms, JSON import and scope filtering | MCP configuration validation |
| Redacted edits and conflict detection | stdio and Streamable HTTP transports |
| Global/project configuration persistence | Tool/resource discovery and invocation |
| Connection tests, per-tool editor and session status | OAuth credentials and sign-in protocol |
| Browser authorization jobs, links and cancellation | PKCE, metadata discovery and loopback callbacks |
| Applying changes to idle sessions | Agent turns, extensions and session reload |

The implementation uses public package exports. Validation runs an isolated inline
extension with `registerMcpServer` and reads normalized registrations after the
factory commits. It does not import Pi's internal config parser or maintain a
second MCP client. Small file-editing code is necessary because Pi's file editing
helpers are not part of its public SDK exports.

## Configuration and trust

- Global: `<FORGE_AGENT_HOME>/mcp.json`.
- Project: `<project>/.pi/mcp.json`.
- Both use `{ "mcpServers": { "name": { ... } } }`.
- A trusted project can replace the global entry with the same name. A partial
  project override may contain only `enabled`, `exposure` and `toolExposure`.
- A project cannot choose an `auth.provider`. A partial override inherits a
  global entry's credentials without writing them to the project file.
- Untrusted project configuration is visible for editing but is not loaded or
  testable. Adding project MCP configuration may cause a previously implicit
  trust decision to require explicit confirmation; trust is recalculated before
  reloading sessions.

Environment/header values and `oauth.clientSecret` do not appear in snapshots.
The editor uses key rows with blank secret values. Blank retains a saved value;
removing a row deletes it. OAuth objects replace optional OAuth fields while
retaining an omitted or blank client secret; explicit `null` removes that secret.
Optional fields such as timeout or provider auth accept `null` to clear them.

Changes to a command, arguments, working directory or URL cannot silently retain
secret rows. Re-enter or remove the credentials before saving or testing the new
target. Other fields such as arguments and URLs remain editable text, so inline
credentials there are not protected secret storage; use dedicated secret fields.

Writes use a file lock, a same-directory temporary file, atomic rename, and a
revision per entry. A stale revision or externally changed file is rejected.
Unrelated JSON fields and indentation are retained. Malformed files remain intact;
JSON parser snippets and raw server stderr are not returned as diagnostics.

## Connection tests and lifecycle

A probe creates a temporary in-memory Pi session with file-based extensions,
skills, context and built-in tools disabled. It installs only Pi's MCP extension,
scoped to one server. The local `/mcp` command waits for connection status; no model
request or tool invocation is made. The probe supports services with resources
and no tools. Disabled entries are explicitly enabled for the test alone.

The status adapter targets the pinned Pi 1.4.0 command output. An upstream SDK
status API would be preferable if it becomes public. Tests cover connected,
failed, resource-only and cancelled connections. Probes have a 15-second status
window, bounded concurrency and retained results; shutdown closes their sessions
and transports. Reported status is the last independent test, not a live view of
every resident chat session. Result cleanup may extend past the status window.

Configuration changes are serialized. Provider mutations, trust changes and
configuration writes are blocked while a probe is active. A configuration write
requires idle sessions and prevents new prompts, model changes and session
creation while applying. Global changes reload all resident sessions; project
changes reload that project's sessions through Pi's `AgentSession.reload()`.
The existing mode policy is reapplied. The direct-tool baseline is persisted while
read-only, so returning to Agent restores newly direct tools without re-enabling
previously inactive tools. A reload failure retains the transcript
and makes the session read-only until a model is reattached. Shutdown finishes an
in-flight reload before disposing sessions, so fresh transports cannot outlive
the gateway.

## Browser authorization and session status

Sign In starts a temporary Pi session containing just the selected enabled HTTP
service. The adapter invokes the built-in extension's public registered command
with its RPC command context; it does not submit a prompt or dispatch arbitrary
extension commands. Pi performs metadata discovery, client registration, PKCE,
callback validation, token storage and reconnection. Forge forwards the authorization
URL to a browser window, with an explicit link when popups are blocked. A pasted
redirect is handed back to Pi for validation. Only HTTPS and loopback HTTP
authorization URLs can be opened.

Jobs can be cancelled, expire after five minutes, and are aborted on gateway
shutdown. Authorization URLs are removed from completed jobs; tokens, verifiers,
callback codes and server error text are not returned by the status API. Mutating
configuration, provider credentials or trust is blocked while authorization is in
flight. Prompts can continue; successful login/logout refreshes idle sessions and
marks running sessions for reload after their current task ends. Sign Out removes
local credentials through Pi; it does not promise remote grant revocation.

The runtime adapter captures only the built-in MCP factory's public command and
tool registrations. It preserves original tool names from the registered labels,
including names that need sanitizing in model-facing identifiers. If the built-in
extension is disabled or its command is replaced, the adapter reports it as
unavailable instead of invoking the replacement command.

While the MCP panel is visible, the browser polls loaded sessions every three
seconds. The adapter reads each session's own Pi RPC status without creating a
probe, changing its working mode, invoking tools or making model requests. These
snapshots include connection state, tool count and last observation time. A session
whose connections are still starting reports that the observation is pending.
Idle sessions can reconnect through the same built-in command. Closing settings
stops the browser polling. Editors and pasted redirect drafts survive updates.

Tool Settings edits exact original tool names and wildcard `toolExposure` rules.
Clearing a selection removes that override and restores Pi's matching/default
behavior. Project partial overrides retain inherited rules when first edited,
without copying global credentials. The same revision, file locking and session
reload rules apply as for service edits. Hidden tools remain unavailable to Pi;
Plan and Ask still block all MCP execution.

## API surface

All routes require the existing local Web authorization and origin checks.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/mcp?project=...` | Redacted configuration and latest probe results |
| POST | `/api/mcp/servers` | Add or edit one server; revision required when editing |
| POST | `/api/mcp/servers/:name/toggle` | Change enabled state with revision |
| POST | `/api/mcp/servers/:name/test` | Test a saved service or an unsaved draft |
| POST | `/api/mcp/servers/:name/tools` | Edit or clear exact/wildcard tool exposure rules |
| POST | `/api/mcp/servers/:name/login` or `/logout` | Start a Pi-managed authorization job |
| GET | `/api/mcp/auth/:id` | Read authorization progress and pending browser URL |
| POST | `/api/mcp/auth/:id/cancel` or `/redirect` | Cancel or submit a redirect to Pi |
| GET | `/api/mcp/runtime?project=...` | Actual loaded session connection snapshots |
| POST | `/api/mcp/sessions/:id/servers/:name/reconnect` | Reconnect one idle session's service |
| DELETE | `/api/mcp/servers/:name?project=...&scope=...&revision=...` | Delete one scoped entry |

Connection failures return a structured result (`failed`, `needs-auth` or
`timeout`) with HTTP 200. Invalid configuration, stale edits, trust failures and
busy operations return ordinary HTTP errors. The UI preserves rejected drafts.
Saving emits a configuration-changed event; it does not rebuild open editors or
discard another tab's unsaved changes.

## Compatibility limits

The status/command adapter targets the pinned Pi 1.4.0 output and registered tool
labels; it has regression coverage and needs review when upgrading Pi. A public
structured status API would remove this formatting dependency. Browser OAuth is
tested against a local authorization server, including real PKCE and callbacks;
that does not establish compatibility with every external vendor. Provider-token
authentication still uses the provider's own login flow. Server marketplace and
arbitrary terminal custom UI are outside this change.

Regression coverage lives in `tests/web-mcp.test.ts`, `tests/web-modes.test.ts`
and `tests/web-ui.test.js`. `npm run test:web` exercises the real Edge/Chromium
flow in an isolated project and home, including desktop and narrow layouts.
