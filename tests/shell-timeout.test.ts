import { describe, expect, it } from 'vitest';
import { createBashToolDefinition, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { shellTimeoutExtension } from '../src/task/shell-timeout.js';

describe('native shell timeout policy', () => {
  it('fills omitted native timeouts while preserving explicit limits and project tool inputs', async () => {
    const hooks: Record<string, Function> = {};
    shellTimeoutExtension({ on: (name: string, handler: Function) => { hooks[name] = handler; }, getAllTools: () => [{ name: 'bash', sourceInfo: { source: 'builtin' } }, { name: 'powershell', sourceInfo: { source: 'local' } }] } as unknown as ExtensionAPI);
    const missing={ toolName:'bash',input:{command:'build'} }; hooks['tool_call']!(missing); expect(missing.input).toMatchObject({timeout:120});
    const explicit={toolName:'bash',input:{command:'long build',timeout:1800}};hooks['tool_call']!(explicit);expect(explicit.input.timeout).toBe(1800);
    const project={toolName:'powershell',input:{command:'custom'}};hooks['tool_call']!(project);expect(project.input).not.toHaveProperty('timeout');
    let received: unknown;
    const definition=createBashToolDefinition(process.cwd(),{operations:{async exec(_command,_cwd,options){received=options.timeout;return {exitCode:0};}}});
    await definition.execute('native-test',missing.input,undefined,undefined,undefined as never);
    expect(received).toBe(120);
  });
});
