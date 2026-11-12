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
    expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE_/);
    expect(evidence.commands[0]).not.toHaveProperty('passed');
  });
  it('preserves failures and zero-test runs even when the shell pipeline exits successfully', () => {
    const evidence = reviewCommandEvidence([phase('implement'), command('fail'), output('fail', '2 failed, 121 passed', 'bash'), command('empty'), output('empty', '0 passed'), command('exit'), output('exit', 'No module named pytest', 'bash', true)], 'task', tools);
    expect(evidence.commands.map((entry) => entry.output.text)).toEqual(['2 failed, 121 passed', '0 passed', 'No module named pytest']);
    expect(evidence.commands[2]?.toolError).toBe(true);
  });
  it('preserves upstream Pi truncation without following its full-output file or passing arbitrary details', () => {
    const reply = { ...output('large', 'Pi tail excerpt'), message: { ...output('large', 'Pi tail excerpt').message, details: { truncation: { truncated: true }, fullOutputPath: '/private/transcript.txt', arbitrary: 'PRIVATE_DETAILS' } } };
    const evidence = reviewCommandEvidence([phase('implement'), command('large'), reply], 'task', tools);
    expect(evidence.commands[0]).toMatchObject({ sourceTruncation: 'reported', output: { text: 'Pi tail excerpt', truncated: false } });
    expect(JSON.stringify(evidence)).not.toContain('/private/transcript'); expect(JSON.stringify(evidence)).not.toContain('PRIVATE_DETAILS');
  });
  it('keeps other tasks, inspection, prior repair attempts and unpaired results out', () => {
    const evidence = reviewCommandEvidence([phase('implement', 3, 'other'), command('other'), output('other'), phase('inspect', 1), command('inspect'), output('inspect'), phase('implement'), command('old'), output('old'), phase('verify', 4), phase('implement', 5), output('old'), command('new'), output('new'), output('new'), output('unpaired'), phase('verify', 6)], 'task', tools);
    expect(evidence.commands.map((entry) => entry.toolCallId)).toEqual(['new']);
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
