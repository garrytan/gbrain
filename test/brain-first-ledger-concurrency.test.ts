/** #8484: real installers must retain every ownership record under contention.
 * Existing setup tests run sequentially and cannot detect a lost ledger update.
 * A child-only atomic-write wrapper pauses after the ledger snapshot, without
 * adding a production seam or mocking filesystem state in the test process.
 */
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { keylessBrainEnv } from './helpers/provider-env.ts';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const child = resolve(import.meta.dir, 'fixtures/brain-first-ledger-worker.ts');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-ledger-race-'));
  roots.push(root);
  const home = join(root, 'home'); mkdirSync(home);

  const env = keylessBrainEnv(process.env, home, { GBRAIN_CI_DISABLE_TEST_ENV_FILE: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_AGENT_INSTRUCTIONS: undefined });
  const spawn = (mode: string, harness: string, path: string, pause = '', release = '') => Bun.spawn([process.execPath, '--no-env-file', child, mode, harness, path, pause, release], { env, stdout: 'pipe', stderr: 'pipe' });
  const entries = () => JSON.parse(readFileSync(join(home, '.gbrain/agent-instructions.json'), 'utf8')).entries as { harness: string; path: string; created_file: boolean; status: string }[];
  return { root, home, spawn, entries };
}
async function waitFor(path: string) {
  const deadline = Date.now() + 10000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`child never reached ${path}`);
    await delay(10);
  }
}
type Child = ReturnType<ReturnType<typeof fixture>['spawn']>;
async function result(child: Child) {
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stderr).toBe(''); expect(code).toBe(0);
  return JSON.parse(stdout);
}

for (const secondMode of ['install', 'remove'] as const) {
  test(`concurrent ledger ${secondMode} cannot overwrite another harness ownership`, async () => {
    const f = fixture();
    const a = join(f.home, 'CLAUDE.md'); const b = join(f.home, 'AGENTS.md');
    if (secondMode === 'remove') expect((await result(f.spawn('install', 'codex', b))).action).toBe('write');
    const pause = join(f.root, 'paused'); const release = join(f.root, 'release');
    const first = f.spawn('install', 'claude-code', a, pause, release);
    let second: Child | undefined;
    try {
      await waitFor(pause);
      second = f.spawn(secondMode, 'codex', b);
      await waitFor(b + '.started');
      // Give the competing transaction a chance to finish on the unlocked
      // implementation. Under the fix it waits for the retained OS lock.
      await Promise.race([second.exited, delay(1000)]);
    } finally { writeFileSync(release, 'go'); }
    expect((await result(first)).action).toBe('write');
    expect(second).toBeDefined();
    expect((await result(second!)).action).toBe(secondMode === 'install' ? 'write' : 'remove');
    expect(f.entries().map(e => e.harness).sort()).toEqual(secondMode === 'install' ? ['claude-code', 'codex'] : ['claude-code']);
    expect(f.entries().find(e => e.harness === 'claude-code')?.created_file).toBe(true);
    expect((await result(f.spawn('remove', 'claude-code', a))).action).toBe('remove');
    expect(existsSync(a)).toBe(false);
    if (secondMode === 'install') {
      await result(f.spawn('remove', 'codex', b)); expect(existsSync(b)).toBe(false);
    }
    expect(f.entries()).toEqual([]);
  }, 30000);
}

test('same-surface competing installs preserve created_file for uninstall', async () => {
  const f = fixture(); const path = join(f.home, 'CLAUDE.md');
  const pause = join(f.root, 'paused'); const release = join(f.root, 'release');
  const first = f.spawn('install', 'claude-code', path, pause, release);
  let second: Child | undefined;
  try {
    await waitFor(pause);
    second = f.spawn('install', 'claude-code', path);
    await Promise.race([second.exited, delay(1000)]);
  } finally { writeFileSync(release, 'go'); }
  expect((await result(first)).action).toBe('write');
  expect((await result(second!)).action).toBe('keep');
  expect(f.entries()).toEqual([expect.objectContaining({ created_file: true })]);
  await result(f.spawn('remove', 'claude-code', path));
  expect(existsSync(path)).toBe(false);
}, 30000);

test('opt-out clears every old user-global surface without recursive install', async () => {
  const f = fixture(); const a = join(f.home, 'AGENTS.md'); const b = join(f.home, 'AGENTS.override.md');
  await result(f.spawn('install', 'codex', a)); await result(f.spawn('install', 'codex', b));
  expect((await result(f.spawn('decline', 'codex', b))).action).toBe('remove');
  expect(existsSync(a)).toBe(false); expect(existsSync(b)).toBe(false);
  expect(f.entries().map(e => e.status)).toEqual(['declined', 'declined']);
}, 30000);

test('an implicit decision made before a competing opt-out cannot resurrect instructions', async () => {
  const f = fixture(); const path = join(f.home, 'CLAUDE.md');
  await result(f.spawn('install', 'claude-code', path));
  const pause = join(f.root, 'paused'); const release = join(f.root, 'release');
  const stale = f.spawn('stale', 'claude-code', path, pause, release);
  try {
    await waitFor(pause);
    expect((await result(f.spawn('decline', 'claude-code', path))).action).toBe('remove');
  } finally { writeFileSync(release, 'go'); }
  expect(await result(stale)).toMatchObject({ action: 'skip', decision: { value: 'declined', source: 'prior' } });
  expect(existsSync(path)).toBe(false);
  expect(f.entries()).toEqual([expect.objectContaining({ status: 'declined' })]);
}, 30000);

test('a busy ledger refuses install and removal without changing bytes; dry-run stays read-only', async () => {
  const f = fixture(); const path = join(f.home, 'CLAUDE.md');
  await result(f.spawn('install', 'claude-code', path));
  const ledger = join(f.home, '.gbrain/agent-instructions.json');
  const before = [readFileSync(path, 'utf8'), readFileSync(ledger, 'utf8')];
  const pause = join(f.root, 'paused'); const release = join(f.root, 'release');
  const holder = f.spawn('hold', 'claude-code', path, pause, release);
  try {
    await waitFor(pause);
    for (const mode of ['install', 'remove']) {
      const outcome = await result(f.spawn(mode, 'claude-code', path));
      expect(outcome.action).toBe('preserve');
      expect(outcome.detail).toContain('another installer holds');
      expect([readFileSync(path, 'utf8'), readFileSync(ledger, 'utf8')]).toEqual(before);
    }
    expect((await result(f.spawn('dry', 'codex', join(f.home, 'AGENTS.md')))).action).toBe('write');
    expect(existsSync(join(f.home, 'AGENTS.md'))).toBe(false);
  } finally { writeFileSync(release, 'go'); await result(holder); }
  expect((await result(f.spawn('remove', 'claude-code', path))).action).toBe('remove');
  const fresh = fixture();
  expect((await result(fresh.spawn('dry', 'codex', join(fresh.home, 'AGENTS.md')))).action).toBe('write');
  expect(existsSync(join(fresh.home, '.gbrain'))).toBe(false);
}, 30000);
