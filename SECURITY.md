# Security notes

## Supported implementation

This document covers `src/pi-cli.ts`, `src/web/`, and the active forge-agent verification
extension. Pi Coding Agent 1.4.0 supplies the agent session, tools, provider
authentication, resource loading, and project trust. The excluded self-built
runtime under `archive/prototype/` is legacy code. Its command policy, path guard, checkpoints,
and trace redaction are not security guarantees of the supported product.

## Threat model

forge-agent is a local workstation coding agent. Treat repository content, model
output, tool results, and project instructions as untrusted input. Trusted
extensions and commands run with the permissions of the launching user.
Prompt injection can influence a model's decisions; project trust does not
make arbitrary repository content safe.

## Active controls

- The Web gateway binds to `127.0.0.1` by default. API access requires the
  existing local access credential or its HttpOnly, SameSite=Strict cookie.
  Serving the public page or health endpoint does not grant API access.
- Host, Origin, and cross-site fetch checks protect local API requests. The
  browser bootstrap removes its credential from the address bar. Local gateway
  authorization is separate from model-provider authentication.
- Provider keys are saved through Pi's authentication API and are not returned
  to the model editor or saved in browser storage. Third-party discovery and
  invocation tests do not follow redirects with supplied credentials. Review
  the configured service destination before entering a key.
- Project trust is resolved through Pi. The Web gateway unloads project
  resources when trust is revoked. Configured verification commands are refused
  when the project is not trusted.
- Plan and Ask restrict model-driven tool calls to Pi's built-in read/search
  tools. Shell, editing, MCP/custom tools, slash-command dispatch, and automatic
  project verification are unavailable in these modes. This does not restrict
  arbitrary code inside an already trusted extension.
- History opening checks that session files resolve inside forge-agent's session
  directory and that the recorded project matches the requested project.
- Web extension confirmations validate their response types and allowed
  options. Expiration, abort, and server shutdown clear pending interactions.
- The verification completion gate preserves command output, bounds repair
  attempts, enforces command timeouts, and terminates verification child process
  trees. Configured verification failure is not a successful CLI completion.
- Markdown output is sanitized; raw HTML is shown as source rather than
  interpreted as application UI.
- Planned tasks restrict research, planning and review to built-in readers,
  and the host controls phase transitions and final completion. Restarted work
  requires an explicit user action; prior side effects are not replayed.
- Git previews use argument arrays rather than shell interpolation, disable
  external diff/textconv helpers, limit preview size, reject path traversal and
  symlink escapes, and exclude known credential filenames. This is a preview
  boundary, not a filesystem sandbox for the agent.

## Limits

The process is not an OS sandbox. The selected project is not a filesystem or
network isolation boundary. Agent commands and trusted extensions can access
resources available to the user who starts forge-agent. Use a container, VM, or
restricted account for untrusted repositories.

Local data in `FORGE_AGENT_HOME` can contain credentials, source excerpts, tool
output, and conversation history. Verification output is deliberately preserved
verbatim and can contain sensitive data. Review and redact logs, reports,
screenshots, and sessions before sharing them; do not assume universal secret
redaction. Keep these local files out of Git.

The Web SDK adapter installs Pi's built-in MCP, codemode and tool-search
factories, preserving Pi trust and disabled/replacement semantics. MCP servers
and trusted extensions have the launching user's permissions. See
[architecture](docs/architecture.md) and the [product audit](docs/product-audit.md).

## Reporting

Do not put credentials, local gateway access tokens, or private repository
content in public reports. Provide a minimal reproduction, the forge-agent and Pi
versions, and relevant output with secrets removed. No private security-reporting
channel has been configured for this repository yet; establish one before
inviting vulnerability reports through a public issue tracker.
