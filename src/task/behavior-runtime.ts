import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { behaviorHash, behaviorReceiptSchema, type BehaviorReceipt, type BehaviorState } from './behavior.js';
import { classifyCommandReceipt, sensitiveCommandEvidence } from './review-evidence.js';

/** Observe native Pi results; never spawn a model-proposed command outside Pi. */
export function behaviorExecutionExtension(options: {
  active(): boolean; state(): BehaviorState | undefined; trusted(): boolean; record(receipt: BehaviorReceipt): void;
}): ExtensionFactory {
  return (pi) => {
    let previousTools: string[] | undefined;
    const pending = new Map<string, { runId: string; checkId: string; command: string; tool: 'bash' | 'powershell' }>();
    const tools = () => pi.getAllTools().filter((tool) => tool.sourceInfo.source === 'builtin' && ['read', 'grep', 'find', 'ls', 'bash', 'powershell'].includes(tool.name)).map((tool) => tool.name);
    pi.on('before_agent_start', (event) => {
      if (!options.active()) {
        pending.clear();
        if (previousTools) { pi.setActiveTools(previousTools); previousTools = undefined; }
        return;
      }
      previousTools ??= pi.getActiveTools();
      pi.setActiveTools(tools()); event.systemPromptOptions.selectedTools = tools();
      event.systemPromptOptions.sections['forge_behavior'] = 'CHECK ONLY. Use built-in readers and the exact frozen shell commands. No mutation tools, MCP, network, delegation or substitute commands. Commands still run with launching-user permissions; tool scope is not an OS sandbox.';
    });
    pi.on('tool_call', (event) => {
      if (!options.active()) return;
      const state = options.state();
      if (!options.trusted() || !state?.runId || state.status !== 'running' || !tools().includes(event.toolName)) return { block: true, terminate: true, reason: '行为检查仅限受信任项目中的宿主冻结检查；没有扩大工具权限。' };
      if (!['bash', 'powershell'].includes(event.toolName)) return;
      const input = event.input as Record<string, unknown>;
      const check = state.plan?.checks.find((item) => item.shell === event.toolName && item.command === input['command']);
      if (!check || state.receipts.some((item) => item.checkId === check.id && item.runId === state.runId) || [...pending.values()].some((item) => item.checkId === check.id)) return { block: true, terminate: true, reason: '命令不匹配冻结检查或已有执行回执；未执行替换/重复命令。' };
      const timeout = input['timeout'];
      input['timeout'] = typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, check.timeoutSeconds) : check.timeoutSeconds;
      pending.set(event.toolCallId, { runId: state.runId, checkId: check.id, command: check.command, tool: check.shell });
    });
    pi.on('tool_result', (event) => {
      const call = pending.get(event.toolCallId); pending.delete(event.toolCallId);
      const state = options.state();
      if (!call || !options.active() || call.runId !== state?.runId || event.toolName !== call.tool) return;
      const result = event.structuredContent as { output?: unknown; exit_code?: unknown; truncated?: unknown } | undefined;
      const output = typeof result?.output === 'string' ? result.output : event.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      const exitCode = typeof result?.exit_code === 'number' && Number.isInteger(result.exit_code) ? result.exit_code : null;
      const truncated = result?.truncated === true || output.length > 6000;
      const classification = classifyCommandReceipt(call.command, output, event.isError);
      const sensitive = sensitiveCommandEvidence(output);
      const exactInput = event.input['command'] === call.command;
      const passed = exactInput && !sensitive && exitCode === 0 && !event.isError && !truncated && classification.outcome !== 'failed' && classification.outcome !== 'zero_tests';
      const failed = exactInput && exitCode !== null && exitCode !== 0;
      options.record(behaviorReceiptSchema.parse({ version: 1, runId: call.runId, checkId: call.checkId, toolCallId: event.toolCallId,
        tool: call.tool, commandSha256: behaviorHash(call.command), source: 'pi-builtin-shell', exitCode,
        status: passed ? 'passed' : failed ? 'failed' : 'unconfirmed', output: sensitive ? '[Sensitive output omitted]' : output.slice(0, 6000), outputSha256: behaviorHash(output), outputCharacters: output.length, truncated,
        reason: passed ? undefined : !exactInput ? '执行输入在准入后变化，未将结果归因于冻结命令。' : sensitive ? '敏感输出已省略，未将其作为可共享的通过证据。' : exitCode === null ? '原生退出码不可用；未从模型文字推断通过。' : classification.outcome === 'zero_tests' ? '观察到零测试执行，不能确认检查覆盖。' : truncated ? '执行输出不完整；保留命令结果但未确认行为证据。' : '原生命令未通过；这本身不区分代码缺陷与环境问题。', recordedAt: new Date().toISOString() }));
    });
  };
}
