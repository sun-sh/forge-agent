import { describe, expect, it } from 'vitest';
import { reviewCommandEvidence } from '../src/task/review-evidence.js';

const tools = new Set(['bash', 'powershell']);
const phase = (name: string, count = 3, id = 'task') => ({ type: 'custom', customType: 'pforge.task', data: { id, phase: name, phases: Array.from({ length: count }, () => ({})) } });
const command = (id: string, text = 'python bin/test tests/test_example.py', tool = 'bash') => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_THOUGHT' }, { type: 'text', text: 'PRIVATE_IMPLEMENTATION_PROSE' }, { type: 'toolCall', id, name: tool, arguments: { command: text } }] } });
const output = (id: string, text = '43 passed, 1 skipped, 2 expected to fail', tool = 'bash', isError = false) => ({ type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: tool, timestamp: 123, isError, content: [{ type: 'text', text }, { type: 'image', data: 'PRIVATE_IMAGE_DATA' }] } });

describe('independent review historical command evidence', () => {
  it('carries actual native test receipts without passing thinking or implementation prose', () => {
    const evidence = reviewCommandEvidence([phase('implement'), command('test'), output('test'), phase('verify', 4)], 'task', tools);
    expect(evidence).toMatchObject({ version: 1, scope: 'latest-implementation', freshness: 'historical-unattested', commands: [{ toolCallId: 'test', tool: 'bash', command: { text: 'python bin/test tests/test_example.py', truncated: false }, output: { text: '43 passed, 1 skipped, 2 expected to fail', truncated: false }, toolError: false, recordedAt: 123 }] });
    expect(evidence.commands[0]).toMatchObject({ kind: 'test', outcome: 'passed' });
    expect(evidence.classification).toBe('heuristic-not-verification');
    expect(evidence.summary).toEqual({ receipts: 1, retainedReceipts: 1, testReceipts: 1, failedReceipts: 0, zeroTestReceipts: 0, sourceTruncatedReceipts: 0 });
    expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE_/);
    expect(evidence.commands[0]).not.toHaveProperty('passed');
  });
  it('preserves failures and zero-test runs even when the shell pipeline exits successfully', () => {
    const evidence = reviewCommandEvidence([phase('implement'), command('fail'), output('fail', '2 failed, 121 passed', 'bash'), command('empty'), output('empty', '0 passed'), command('exit'), output('exit', 'No module named pytest', 'bash', true)], 'task', tools);
    expect(evidence.commands.map((entry) => entry.output.text)).toEqual(['2 failed, 121 passed', '0 passed', 'No module named pytest']);
    expect(evidence.commands[2]?.toolError).toBe(true);
    expect(evidence.summary).toMatchObject({ receipts: 3, testReceipts: 3, failedReceipts: 2, zeroTestReceipts: 1 });
    expect(evidence.commands.map((receipt) => receipt.outcome)).toEqual(['failed', 'zero_tests', 'failed']);
  });
  it.each([
    ['python -m pytest', '43 passed, 0 failures, 0 errors, 2 expected failures', 'test', 'passed'],
    ['python -m unittest', 'Ran 43 tests in 0.1s\n\nOK (expected failures=2)', 'test', 'passed'],
    ['node --test', '# tests 3\n# pass 3\n# fail 0', 'test', 'passed'],
    ['npm test', '\u001b[32mTests\u001b[39m  43 passed (43)', 'test', 'passed'],
    ['pytest', '0 passed, 3 failed', 'test', 'failed'],
    ['pytest', 'no tests ran in 0.01s', 'test', 'zero_tests'],
    ['python -m unittest', 'Ran 0 tests in 0.0s\n\nOK', 'test', 'zero_tests'],
    ['node --test', '# tests 0\n# pass 0\n# fail 0', 'test', 'zero_tests'],
    ['pytest', 'test_error_handling PASSED\ntest_failure_mode PASSED', 'test', 'unknown'],
    ['rg error tests', 'tests/test_failure.py: raises(ValueError)', 'command', 'unknown'],
    ['python -m compileall src', 'Compilation succeeded', 'command', 'unknown'],
    ['pytest', 'custom runner: success', 'test', 'unknown']
  ])('keeps runner hints conservative for %s / %s', (cmd, result, kind, outcome) => {
    const evidence = reviewCommandEvidence([phase('implement'), command('run', cmd), output('run', result)], 'task', tools);
    expect(evidence.commands[0]).toMatchObject({ kind, outcome });
    expect(evidence.commands[0]?.output.text).toBe(result);
  });
  it('preserves upstream Pi truncation without following its full-output file or passing arbitrary details', () => {
    const reply = { ...output('large', 'Pi tail excerpt'), message: { ...output('large', 'Pi tail excerpt').message, details: { truncation: { truncated: true }, fullOutputPath: '/private/transcript.txt', arbitrary: 'PRIVATE_DETAILS' } } };
    const evidence = reviewCommandEvidence([phase('implement'), command('large'), reply], 'task', tools);
    expect(evidence.commands[0]).toMatchObject({ sourceTruncation: 'reported', output: { text: 'Pi tail excerpt', truncated: false } });
    expect(evidence.summary.sourceTruncatedReceipts).toBe(1);
    expect(JSON.stringify(evidence)).not.toContain('/private/transcript'); expect(JSON.stringify(evidence)).not.toContain('PRIVATE_DETAILS');
  });
  it('keeps other tasks, inspection, prior repair attempts and unpaired results out', () => {
    const evidence = reviewCommandEvidence([phase('implement', 3, 'other'), command('other'), output('other'), phase('inspect', 1), command('inspect'), output('inspect'), phase('implement'), command('old'), output('old'), phase('verify', 4), phase('implement', 5), output('old'), command('new'), output('new'), output('new'), output('unpaired'), phase('verify', 6)], 'task', tools);
    expect(evidence.commands.map((entry) => entry.toolCallId)).toEqual(['new']);
    expect(evidence.summary).toMatchObject({ receipts: 1, retainedReceipts: 1, testReceipts: 1, failedReceipts: 0 });
  });
  it('clears failure and omission counts for a new implementation attempt but not a counter snapshot', () => {
    const evidence = reviewCommandEvidence([phase('implement'), command('secret', 'cat .env'), output('secret', 'PRIVATE_VALUE'), command('old'), output('old', '3 failed'),
      phase('verify', 4), phase('implement', 5), command('new'), phase('implement', 5), output('new')], 'task', tools);
    expect(evidence.commands.map((entry) => entry.toolCallId)).toEqual(['new']);
    expect(evidence.omitted).toBe(0);
    expect(evidence.summary).toEqual({ receipts: 1, retainedReceipts: 1, testReceipts: 1, failedReceipts: 0, zeroTestReceipts: 0, sourceTruncatedReceipts: 0 });
  });
  it('keeps test output when later shell inspection would otherwise evict it', () => {
    const later = Array.from({ length: 20 }, (_, n) => [command('ls' + n, 'ls src'), output('ls' + n, 'module.py')]).flat();
    const evidence = reviewCommandEvidence([phase('implement'), command('tests'), output('tests'), ...later], 'task', tools);
    expect(evidence.commands[0]).toMatchObject({ toolCallId: 'tests', kind: 'test', outcome: 'passed' });
    expect(evidence.commands).toHaveLength(12);
    expect(evidence.summary).toMatchObject({ receipts: 21, retainedReceipts: 12, testReceipts: 1 });
    expect(evidence.omitted).toBe(9);
  });
  it('retains failure totals when bounded test receipts must be omitted', () => {
    const later = Array.from({ length: 20 }, (_, n) => [command('test' + n), output('test' + n)]).flat();
    const evidence = reviewCommandEvidence([phase('implement'), command('failed'), output('failed', '2 failed'), ...later], 'task', tools);
    expect(evidence.commands).toHaveLength(12);
    expect(evidence.commands.filter((receipt) => receipt.outcome === 'failed')).toHaveLength(1);
    expect(evidence.commands.filter((receipt) => receipt.outcome === 'passed')).toHaveLength(11);
    expect(evidence.summary).toMatchObject({ receipts: 21, retainedReceipts: 12, testReceipts: 21, failedReceipts: 1 });
    expect(evidence.omitted).toBe(9);
  });
  it('does not give MCP/custom tools native receipt provenance or accept mismatched tools', () => {
    const entries = [phase('implement'), command('shell'), output('shell'), command('custom', 'tests', 'custom'), output('custom', 'passed', 'custom'), command('bad'), output('bad', 'passed', 'powershell')];
    expect(reviewCommandEvidence(entries, 'task', new Set()).commands).toEqual([]);
    expect(reviewCommandEvidence(entries, 'task', tools).commands.map((entry) => entry.toolCallId)).toEqual(['shell']);
  });
  it('omits apparent credentials and credential-file commands rather than sending their output', () => {
    const entries = [phase('implement'), command('key', 'echo API_KEY=private'), output('key', 'SENSITIVE_ONE'), command('auth'), output('auth', 'Authorization: Bearer SENSITIVE_TWO'), command('file', 'cat .env.production'), output('file', 'SENSITIVE_THREE'), command('plain'), output('plain', '43 passed')];
    const evidence = reviewCommandEvidence(entries, 'task', tools);
    expect(evidence.omitted).toBe(3); expect(evidence.commands).toHaveLength(1);
    expect(JSON.stringify(evidence)).not.toMatch(/SENSITIVE_|private/);
  });
  it('bounds scans, total evidence and individual excerpts without disguising truncation as a complete check', () => {
    const entries = [phase('inspect'), ...Array.from({ length: 5001 }, () => ({ type: 'label' })), phase('implement'), ...Array.from({ length: 40 }, (_, n) => [command('c' + n), output('c' + n, 'BEGIN ' + 'large-output '.repeat(500) + ' END')]).flat()];
    const evidence = reviewCommandEvidence(entries, 'task', tools);
    expect(evidence.scanTruncated).toBe(true); expect(evidence.omitted).toBeGreaterThan(0);
    expect(evidence.commands.length).toBeLessThanOrEqual(12); expect(JSON.stringify(evidence.commands).length).toBeLessThanOrEqual(24000);
    const excerpt = evidence.commands.at(-1)!.output;
    expect(excerpt).toMatchObject({ truncated: true, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(excerpt.text.length).toBeLessThanOrEqual(3000); expect(excerpt.text).toContain('not a complete check'); expect(excerpt.text.startsWith('BEGIN')).toBe(true); expect(excerpt.text.endsWith('END')).toBe(true);
    expect(reviewCommandEvidence([command('no-host-phase'), output('no-host-phase')], 'task', tools).commands).toEqual([]);
  });
});
