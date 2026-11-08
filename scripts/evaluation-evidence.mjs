import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function saveHarnessEvidence(output, sources) {
  const directory = join(output, 'harness'), fingerprint = createHash('sha256');
  await mkdir(directory, { recursive: true });
  for (const source of sources) {
    const name = basename(source.pathname), bytes = await readFile(source);
    fingerprint.update(name).update(bytes);
    await writeFile(join(directory, name), bytes, { mode: 0o600 });
  }
  return fingerprint.digest('hex');
}

// Local diagnostic artifacts only. Do not copy auth/model configuration into
// reports; transcripts and command output still need review before sharing.
export async function saveEvaluationEvidence(output, id, project, snapshot) {
  const directory = join(output, 'evidence', id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'snapshot.json'), JSON.stringify(snapshot ?? null, null, 2), { mode: 0o600 });
  const evidence = { snapshot: 'evidence/' + id + '/snapshot.json' };
  try {
    const diff = await execute('git', ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--binary'], { cwd: project, windowsHide: true, timeout: 10000, maxBuffer: 8_000_000 });
    await writeFile(join(directory, 'changes.patch'), diff.stdout, { mode: 0o600 });
    evidence.diff = 'evidence/' + id + '/changes.patch';
  } catch { evidence.diagnostic = 'Git diff unavailable; retained the final session snapshot.'; }
  return evidence;
}

export function modelEvaluationMetadata(model) {
  const cost = model.cost;
  return {
    provider: model.provider, id: model.id, api: model.api, contextWindow: model.contextWindow,
    pricingKnown: Boolean(cost && Object.values(cost).some((value) => typeof value === 'number' && value > 0)),
    configuredPrices: cost
  };
}
