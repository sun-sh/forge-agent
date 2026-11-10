import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

export const DEFAULT_SHELL_TIMEOUT_SECONDS = 120;

/** Pi still executes commands and kills their process trees. Only fill an absent timeout. */
export const shellTimeoutExtension: ExtensionFactory = (pi) => {
  pi.on('tool_call', (event) => {
    if (!['bash', 'powershell'].includes(event.toolName)) return;
    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    const input = event.input as Record<string, unknown>;
    if (tool?.sourceInfo.source !== 'builtin' || input['timeout'] !== undefined) return;
    input['timeout'] = DEFAULT_SHELL_TIMEOUT_SECONDS;
  });
  pi.on('before_agent_start', (event) => {
    event.systemPromptOptions.sections['forge_shell_timeout'] = 'Built-in bash/powershell calls default to a 120-second command timeout when omitted. Provide an explicit longer timeout for expected long builds/tests; the shared task budget still applies. A command timeout is a tool failure to diagnose, not a reason to abandon the user task. On Windows prefer powershell for Python and native commands; avoid nested/fallback heredocs that can wait for input. Do not start an interactive server in a foreground tool call when a one-shot check will do.';
  });
};
