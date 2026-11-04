import { createMcpExtension, type AgentSession, type ExtensionCommandContext, type ExtensionFactory, type ExtensionUIContext, type McpExtensionOptions, type RegisteredCommand } from '@earendil-works/pi-coding-agent';

export interface McpToolView { name: string; rawName: string; server: string; description: string; exposure: string; }
export interface McpLiveServer { name: string; state: string; toolCount: number; }

/** Adapts the public built-in extension API. It never submits a model prompt. */
export class McpRuntimeView {
  private agent?: AgentSession;
  private command?: Omit<RegisteredCommand, 'name' | 'sourceInfo'>;
  private generation = 0;
  private pending?: Promise<void>;
  private servers: McpLiveServer[] = [];
  private checkedAt?: string;
  private tools = new Map<string, McpToolView>();

  factory(options: McpExtensionOptions = {}): ExtensionFactory {
    return async (pi) => {
      this.generation++; this.command = undefined; this.pending = undefined; this.servers = []; this.tools.clear(); this.checkedAt = undefined;
      await createMcpExtension(options)({ ...pi,
        registerCommand: (name, command) => { pi.registerCommand(name, command); if (name === 'mcp') this.command = command; },
        registerTool: (tool) => {
          pi.registerTool(tool);
          const separator = tool.label.indexOf('/');
          if (tool.name.startsWith('mcp__') && separator > 0) this.tools.set(tool.name, {
            name: tool.name, server: tool.label.slice(0, separator), rawName: tool.label.slice(separator + 1),
            description: tool.description, exposure: tool.exposure ?? 'direct'
          });
        }
      });
      pi.on('session_shutdown', () => { this.generation++; this.command = undefined; this.pending = undefined; this.servers = []; this.tools.clear(); });
    };
  }

  bind(agent: AgentSession, refresh = true) { this.agent = agent; if (refresh) this.refresh(); }
  available() { try { return !!this.agent && !!this.command && this.agent.extensionRunner.getCommand('mcp')?.handler === this.command.handler; } catch { return false; } }
  catalog() { return [...this.tools.values()].slice(0, 500); }

  async run(args: string, ui: Partial<ExtensionUIContext> = {}) {
    if (!this.available()) throw new Error('内置 MCP 扩展不可用，可能已被禁用或替换');
    const runner = this.agent!.extensionRunner;
    // Preserve Pi's guarded context getters across reloads.
    const context = Object.defineProperties({}, Object.getOwnPropertyDescriptors(runner.createCommandContext())) as ExtensionCommandContext;
    Object.defineProperty(context, 'ui', { value: { ...runner.getUIContext(), ...ui }, configurable: true });
    await this.command!.handler(args, context);
  }

  refresh() {
    if (!this.available() || this.pending) return;
    const generation = this.generation;
    const work = this.run('', { notify: (report) => {
      if (generation !== this.generation) return;
      this.servers = report.split('\n').flatMap((line) => {
        const match = /^([A-Za-z0-9_-]+): (connected|connecting|starting|disabled|disconnected|needs sign-in|failed|closed)(?:, (\d+) tools)?/.exec(line);
        return match ? [{ name: match[1]!, state: match[2] === 'needs sign-in' ? 'needs-auth' : match[2]!, toolCount: Number(match[3] ?? 0) }] : [];
      });
      this.checkedAt = new Date().toISOString();
    } }).catch(() => { /* The previous runner can become stale on reload/shutdown. */ });
    this.pending = work;
    void work.finally(() => { if (generation === this.generation) this.pending = undefined; });
  }

  snapshot() {
    this.refresh();
    return { supported: this.available(), checkedAt: this.checkedAt, refreshing: !!this.pending, servers: this.servers, tools: this.catalog() };
  }
}
