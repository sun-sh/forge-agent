import { describe, expect, it } from 'vitest';
import type { BeforeAgentStartEvent, ContextWithSystemEvent, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createForgeIdentityExtension } from '../src/identity.js';

type Handler = (event: any) => any;
function identityHooks(surface: 'web' | 'cli') {
  const handlers = new Map<string, Handler>();
  createForgeIdentityExtension(surface)({ on(name: string, handler: Handler) { handlers.set(name, handler); return () => {}; } } as unknown as ExtensionAPI);
  return handlers;
}

describe('Forge identity and interface context', () => {
  it.each(['web', 'cli'] as const)('provides accurate %s context without replacing mode or verification policy', (surface) => {
    const sections = { pforge_mode: 'ASK MODE: read-only', verification: 'Require trusted project' };
    const options = { sections, customPrompt: 'user system prompt', selectedTools: ['read'] };
    const hooks = identityHooks(surface);
    hooks.get('before_agent_start')!({ messageType: 'user', systemPromptOptions: options } as unknown as BeforeAgentStartEvent);
    expect(options).toMatchObject({ customPrompt: 'user system prompt', selectedTools: ['read'], sections });
    expect(sections).toMatchObject({ pforge_mode: 'ASK MODE: read-only', verification: 'Require trusted project' });
    const identity = (sections as Record<string, string>)['forge_identity'];
    expect(identity).toContain('You are Forge Agent');
    expect(identity).toContain('Pi Coding Agent runtime');
    expect(identity).toContain('Do not insert this architecture overview into ordinary greetings or capability introductions');
    expect(identity).toContain(surface === 'web' ? 'in the user\'s browser' : 'terminal client (interactive TUI or single-shot CLI)');
  });

  it('projects only the SDK default preamble while preserving instructions, tool updates and stored messages', () => {
    const preamble = 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.';
    const messages = [
      { role: 'system', content: '', timestamp: 1, sections: { preamble, rules: 'tool safety rules', project_context: 'Repository describes a CLI', pforge_mode: 'ASK MODE' }, toolsAdded: [{ name: 'read', description: 'Read files', parameters: { type: 'object', properties: {} } }] },
      { role: 'user', content: 'Who are you?', timestamp: 2 },
      { role: 'system', content: '', timestamp: 3, sections: { rules: 'updated read-only rules', pforge_mode: null }, toolsRemoved: ['write'] }
    ] as ContextWithSystemEvent['messages'];
    const before = structuredClone(messages);
    const result = identityHooks('web').get('context_with_system')!({ type: 'context_with_system', messages });
    expect(result.messages[0].sections.preamble).toMatch(/^You are Forge Agent/);
    expect(result.messages[0].sections.preamble).toContain('local Web client');
    expect(result.messages).toEqual([
      { ...before[0], sections: { ...(before[0] as any).sections, preamble: result.messages[0].sections.preamble } },
      before[1], before[2]
    ]);
    expect(messages).toEqual(before);
  });

  it('preserves custom and opaque prompts and does not rewrite quoted runtime text in conversation or tool output', () => {
    const messages = [
      { role: 'system', content: '', timestamp: 1, sections: { preamble: 'User-authored system prompt', rules: 'Keep these instructions' } },
      { role: 'system', content: 'Exact custom prompt mentioning pi and CLI', timestamp: 2 },
      { role: 'user', content: 'Explain the Pi CLI', timestamp: 3 },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier introduction: Pi coding-agent CLI' }], timestamp: 4 },
      { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: [{ type: 'text', text: 'Repository describes a CLI based on Pi' }], isError: false, timestamp: 5 }
    ] as ContextWithSystemEvent['messages'];
    const result = identityHooks('web').get('context_with_system')!({ type: 'context_with_system', messages });
    expect(result.messages).toEqual(messages);
    for (const [index, message] of messages.entries()) expect(result.messages[index]).toBe(message);
  });
});
