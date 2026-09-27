#!/usr/bin/env bun
/** Native addon packaging and two-process exclusion in a real compiled binary. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeLockCapability } from '../../src/core/persistence/native-lock.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-native-compiled-'));
const arg = process.argv.indexOf('--binary');
const binary = join(root, process.platform === 'win32' ? 'probe.exe' : 'probe');
const { target } = await nativeLockCapability();
const lockPath = join(root, 'writer.lock'), ready = join(root, 'ready');
const children: Bun.Subprocess[] = [];
const env = { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1', HOME: root, GBRAIN_HOME: root };
try {
  if (arg >= 0) {
    // This is a packaging assertion, not a substitute for a CLI operation
    // test: the exact production addon must be embedded in the release file.
    const release = readFileSync(resolve(process.argv[arg + 1]));
    const addon = readFileSync(resolve(import.meta.dir, `../../native/locks/prebuilds/${target}.node`));
    if (!release.includes(addon)) throw new Error(`Release executable omitted native payload ${target}`);
  }
  execFileSync(process.execPath, ['build', '--compile', '--no-compile-autoload-bunfig', '--outfile', binary,
    resolve(import.meta.dir, 'compiled-probe.ts')], { stdio: 'inherit' });
  const holder = Bun.spawn([binary, lockPath, ready, 'hold'], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  children.push(holder);
  const deadline = performance.now() + 15000;
  while (!existsSync(ready) && holder.exitCode === null && performance.now() < deadline) await delay(10);
  if (!existsSync(ready)) {
    if (holder.exitCode === null) { holder.kill(9); await holder.exited; }
    throw new Error(`Compiled lock holder did not acquire: ${await new Response(holder.stderr).text()}`);
  }
  const probe = () => JSON.parse(execFileSync(binary, [lockPath, ready, 'probe'], { env, encoding: 'utf8', timeout: 15000 }));
  if (probe().acquired !== false) throw new Error('Compiled writers both acquired one lock');
  holder.kill(9);
  await holder.exited;
  if (probe().acquired !== true) throw new Error('Compiled writer lock survived process death');
  if (!existsSync(lockPath)) throw new Error('Compiled locking unlinked its stable lock file');
  console.log(`Compiled native lock smoke passed: ${target}`);
} finally {
  for (const child of children) { if (child.exitCode === null) child.kill(9); await child.exited; }
  rmSync(root, { recursive: true, force: true });
}
