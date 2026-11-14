/** Scripted protocol fixture only: native Pi shell plumbing, never model quality. */
import { randomUUID } from 'node:crypto';
const text = (message) => typeof message.content === 'string' ? message.content : (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
export function fixturePhase(input) {
  const systems = (input.messages ?? []).filter(message => ['system', 'developer'].includes(message.role));
  const current = [...JSON.stringify(systems).matchAll(/PFORGE TASK PHASE: (\w+)/g)].at(-1)?.[1];
  if (current) return current;
  return JSON.stringify(systems).includes('delegated reviewer') ? [...JSON.stringify(input.messages ?? []).matchAll(/PFORGE TASK PHASE: (\w+)/g)].at(-1)?.[1] : undefined;
}
export function respondBehaviorFixture(input, response, options = {}) {
  const messages = input.messages ?? [], phase = fixturePhase(input);
  if (!['behavior_plan', 'check'].includes(phase)) return false;
  let delta;
  if (phase === 'behavior_plan') {
    const line = messages.map(text).join('\n').split('\n').findLast((line) => line.startsWith('{"originalRequest":'));
    const request = JSON.parse(line).originalRequest;
    const shell = JSON.parse(line).requiredShell;
    const plan = { version: 1, status: 'ready', summary: 'Scripted plumbing fixture, not behavioral acceptance', assumptions: [], unresolved: [], checks: [
      { id: 'B1', kind: 'reproduction', requestQuote: request.slice(0, 120), expectation: 'Exercise native assertion command plumbing', shell, timeoutSeconds: 30, command: options.fail ? 'node -e "require(\'node:assert/strict\').equal(2+2,5)"' : 'node -e "require(\'node:assert/strict\').equal(2+2,4)"' },
      { id: 'B2', kind: 'boundary', requestQuote: request.slice(0, 120), expectation: 'Exercise a second independent receipt', shell, timeoutSeconds: 30, command: 'node -e "require(\'node:assert/strict\').equal(3*3,9)"' }
    ] };
    delta = { role: 'assistant', content: JSON.stringify(plan) };
  } else {
    const index = messages.findLastIndex((message) => text(message).includes('PFORGE TASK PHASE: check'));
    const line = messages.slice(index).map(text).join('\n').split('\n').findLast((line) => line.startsWith('{"runId":'));
    const { plan } = JSON.parse(line);
    const calls = messages.slice(index).flatMap((message) => message.tool_calls ?? []);
    const completed = new Set(messages.slice(index).filter((message) => message.role === 'tool').map((message) => message.tool_call_id));
    const done = new Set(calls.filter((call) => completed.has(call.id)).map((call) => JSON.parse(call.function.arguments).command));
    const next = plan.checks.find((check) => !done.has(check.command));
    delta = next && !options.skip ? { role: 'assistant', tool_calls: [{ index: 0, id: 'behavior-fixture-' + randomUUID(), type: 'function', function: { name: next.shell, arguments: JSON.stringify({ command: next.command, timeout: next.timeoutSeconds }) } }] } : { role: 'assistant', content: 'Native fixture check commands finished; no model quality measured.' };
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write('data: ' + JSON.stringify({ id: 'behavior-fixture', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\n');
  response.end('data: [DONE]\n\n');
  return true;
}
