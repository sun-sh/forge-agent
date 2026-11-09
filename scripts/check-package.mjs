#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, mkdir, symlink, rm, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile), root = process.cwd(), temporary = await mkdtemp(join(tmpdir(), 'forge-package-'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check through npm run pack:check');
try {
  const packed = await execute(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { cwd: root, windowsHide: true, maxBuffer: 4_000_000 });
  const [metadata] = JSON.parse(packed.stdout), paths = metadata.files.map((file) => file.path);
  const required = ['dist/pi-cli.js', 'dist/web/server.js', 'dist/web/ui/index.html', 'dist/web/ui/lifecycle.js', 'dist/task/checkpoints.js', 'dist/task/queue.js', 'dist/task/plan.js', 'dist/task/context.js', 'dist/task/lifecycle.js', 'dist/task/timeline.js', 'dist/task/git.js', 'dist/task/review.js', 'dist/verification/evidence.js', 'dist/verification/protected.js', 'README.md', 'README.en.md', 'CHANGELOG.md', 'SECURITY.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/operations.md', 'docs/architecture-deep-dive.md', 'docs/execution-records.md', 'docs/evaluation.md', 'LICENSE', 'forge-agent.schema.json'];
  for (const path of required) if (!paths.includes(path)) throw new Error('Missing package asset: ' + path);
  if (paths.some((path) => /(^|\/)(?:auth\.json|models\.json|\.env|node_modules|\.git|\.forge-agent|tests|archive)(\/|$)/.test(path))) throw new Error('Unexpected private/development file in npm package');
  const tarball = join(temporary, metadata.filename);
  const unpacked = join(temporary, 'unpacked'); await mkdir(unpacked);
  await execute('tar', ['-xzf', tarball, '-C', unpacked], { windowsHide: true });
  const packageRoot = join(unpacked, 'package');
  if (process.argv.includes('--install')) {
    // Release CI verifies a clean dependency install from the actual tarball.
    const installRoot = join(temporary, 'installed'); await mkdir(installRoot);
    await execute(process.execPath, [npmCli, 'install', '--prefix', installRoot, '--no-audit', '--no-fund', tarball], { windowsHide: true, timeout: 300000, maxBuffer: 2_000_000 });
    const output = await execute(process.execPath, [join(installRoot, 'node_modules', 'forge-agent', 'dist', 'pi-cli.js'), '--version'], { windowsHide: true });
    if (!output.stdout.includes('forge-agent ' + metadata.version)) throw new Error('Installed CLI did not start');
  } else {
    // Fast local check: tarball assets + executable, reusing already installed dependencies.
    await symlink(join(root, 'node_modules'), join(packageRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const output = await execute(process.execPath, [join(packageRoot, 'dist', 'pi-cli.js'), '--version'], { windowsHide: true });
    if (!output.stdout.includes('forge-agent ' + metadata.version)) throw new Error('Packed CLI did not start');
  }
  const outputDirectory = resolve('.forge-agent/packages'); await mkdir(outputDirectory, { recursive: true });
  await copyFile(tarball, join(outputDirectory, metadata.filename));
  const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
  await writeFile(join(outputDirectory, metadata.filename + '.sha256'), sha256 + '  ' + metadata.filename + '\n');
  console.log('PASS package assets, CLI and ' + (process.argv.includes('--install') ? 'clean dependency installation' : 'installed local dependencies'));
  console.log(join(outputDirectory, metadata.filename));
} finally { await rm(temporary, { recursive: true, force: true }); }
