#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error('Missing value: ' + name);
  return value;
};

const configHome = resolve(option('--config-home'));
const modelName = option('--model');
const timeoutMs = Number(option('--timeout-ms', '45000'));
if (!modelName?.includes('/')) throw new Error('Use --model provider/model');
if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 120_000) throw new Error('Invalid --timeout-ms');

function redact(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('<redacted>');
  text = text.replace(/https?:\/\/[^\s)]+/g, '<endpoint>');
  return text.slice(0, 2000);
}

try {
  const runtime = await ModelRuntime.create({
    modelsPath: join(configHome, 'models.json'),
    authPath: join(configHome, 'auth.json'),
    refreshOnCreate: false,
  });
  const slash = modelName.indexOf('/');
  const provider = modelName.slice(0, slash);
  const modelId = modelName.slice(slash + 1);
  const model = (await runtime.getAvailable()).find((candidate) => candidate.provider === provider && candidate.id === modelId);
  if (!model) throw new Error('Selected model is unavailable: ' + modelName);
  const resolved = await runtime.getAuth(model);
  if (!resolved) throw new Error('Provider authentication could not be resolved for ' + provider);
  const secrets = [resolved.auth?.apiKey, ...(resolved.auth?.headers ? Object.values(resolved.auth.headers) : [])];
  const response = await runtime.completeSimple(model, {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly OK.' }], timestamp: Date.now() }],
  }, {
    signal: AbortSignal.timeout(timeoutMs),
    reasoning: 'off',
    maxTokens: 16,
    cacheRetention: 'none',
  });
  if (response.stopReason === 'error' || response.stopReason === 'aborted') throw new Error('Provider returned stop reason: ' + response.stopReason);
  const text = response.content.filter((part) => part.type === 'text').map((part) => part.text).join('').trim();
  console.log(JSON.stringify({ ok: true, model: modelName, api: model.api, stopReason: response.stopReason, responseTextLength: text.length }));
} catch (error) {
  const config = await readFile(join(configHome, 'models.json'), 'utf8').catch(() => '');
  const keyMatches = [...config.matchAll(/"apiKey"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
  console.error('Provider preflight failed: ' + redact(error instanceof Error ? error.message : error, keyMatches));
  process.exitCode = 1;
}
