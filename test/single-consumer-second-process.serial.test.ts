/**
 * `persistence.single_consumer=true` with a resident process that consumes and a second resident process
 * (`gbrain jobs work`) started beside it, on PGLite, Postgres and the Rust engine.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: one full persistence consumer per brain while the setting is on. The first resident is the one each
 *    engine's model has consume: a `gbrain serve` that owns the PGLite or Rust brain, and on Postgres a
 *    `gbrain jobs work` (it starts its consumer at boot, where a serve starts one at its first write). Postgres: the
 *    second worker finds that live consumer row and defers (`reason=waiter_only`). PGLite: the second worker cannot
 *    open the brain beside the serve (`pglite_busy`). Rust: the second worker reaches the serve's store over the owner
 *    socket, so it defers too (`reason=waiter_only`) and never runs a consumer of its own. On every engine a write
 *    from a third process commits.
 * 2. Fails when: the second process runs a consumer of its own. On the Rust engine that consumer could not publish
 *    (transactions do not cross the owner socket) and logged `engine_capability_missing` on every claim: the setting
 *    was ignored without a word.
 * 3. Existing coverage: test/persistence-consumer-election tests run the election in process; none has a second
 *    process, and none runs on the Rust engine.
 * 4. Seams: none. Real CLI processes. The Rust arm needs the addon `bun run rust:build` writes and skips without it
 *    (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error); the Postgres arm runs with DATABASE_URL, in a scratch
 *    database it drops.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TARGET = detectAddonTarget();
const ADDON = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!ADDON && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 and the Rust addon ${ADDON} does not exist; run bun run rust:build`);
const DATABASE_URL = process.env.DATABASE_URL;

const scratch = mkdtempSync(join(tmpdir(), 'gbrain-single-consumer-'));
const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

function env(home: string): Record<string, string> {
  const out: Record<string, string> = { ...process.env as Record<string, string>, HOME: home, GBRAIN_HOME: '' };
  delete out.DATABASE_URL;
  delete out.GBRAIN_DATABASE_URL;
  delete out.GBRAIN_SINGLE_CONSUMER;
  if (HAVE_ADDON) out.GBRAIN_RUST_ENGINE_ADDON = ADDON;
  return out;
}
function gbrain(home: string, args: string[], stdin?: string): { code: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(['bun', '--no-env-file', CLI, ...args], { cwd: home, env: env(home), stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
  return { code: run.exitCode ?? -1, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}
/** A long-running gbrain process; its stderr is collected and it is killed at the end of the file. */
function resident(home: string, args: string[]) {
  const errFile = join(home, `${args[0]}-${randomUUID().slice(0, 8)}.err`);
  const proc = Bun.spawn(['bun', '--no-env-file', CLI, ...args], { cwd: home, env: env(home), stdin: 'pipe', stdout: 'ignore', stderr: Bun.file(errFile) });
  cleanups.push(() => { try { proc.kill(); } catch { /* gone */ } });
  return { proc, stderr: () => existsSync(errFile) ? readFileSync(errFile, 'utf8') : '' };
}
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await Bun.sleep(250); }
  return check();
}
async function scratchPostgres(): Promise<string> {
  assertSafeE2eDatabaseUrl(DATABASE_URL!);
  const database = `gbrain_test_single_consumer_${randomUUID().replace(/-/g, '')}`;
  const admin = postgres(DATABASE_URL!, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${database}`);
  cleanups.push(async () => { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end(); });
  const url = new URL(DATABASE_URL!);
  url.pathname = `/${database}`;
  return url.toString();
}

const PAGE = '---\ntype: note\ntitle: Probe\n---\nA probe page written beside two resident processes.\n';
/** The consumer line a second process logs when it runs a consumer it cannot use on the Rust engine. */
const SERVE_READY = /\[serve-sync\]/;
const WORKER_READY = /\[notifier:jobs-worker\]/;
const CLIENT_CONSUMER_FAILED = /phase=execution reason=engine_capability_missing message="transaction\w* cannot run from a second process/;

async function scenario(engineArgs: string[], firstArgs: string[], ready: RegExp) {
  const home = mkdtempSync(join(scratch, 'brain-'));
  const init = gbrain(home, ['init', ...engineArgs]);
  expect({ code: init.code, stderr: init.code === 0 ? '' : init.stderr.slice(-2000) }).toEqual({ code: 0, stderr: '' });
  expect(gbrain(home, ['config', 'set', 'persistence.single_consumer', 'true']).code).toBe(0);
  const first = resident(home, firstArgs);
  expect(await until(() => ready.test(first.stderr()), 30_000)).toBe(true);
  await Bun.sleep(1500);
  const worker = resident(home, ['jobs', 'work']);
  await until(() => /pglite_busy|reason=waiter_only|reason=engine_capability_missing|\[notifier:jobs-worker\]/.test(worker.stderr()), 30_000);
  const put = gbrain(home, ['put', 'notes/probe', '--json'], PAGE);
  const get = gbrain(home, ['get', 'notes/probe', '--json']);
  await Bun.sleep(1500);
  return { first: first.stderr(), worker: worker.stderr(), put, get };
}

describe('persistence.single_consumer=true with a consuming resident and a second resident process', () => {
  test('pglite: the second process cannot open the brain beside the serve; the write commits', async () => {
    const out = await scenario(['--pglite', '--db-only'], ['serve'], SERVE_READY);
    expect(out.worker).toContain('pglite_busy');
    expect(out.put.code).toBe(0);
    expect(out.get.code).toBe(0);
  }, 120_000);

  test.skipIf(!DATABASE_URL)('postgres: the second process defers to the first one\'s consumer; the write commits', async () => {
    const url = await scratchPostgres();
    const out = await scenario(['--url', url, '--db-only', '--non-interactive'], ['jobs', 'work'], WORKER_READY);
    expect(out.worker).toContain('reason=waiter_only');
    expect(out.worker).not.toMatch(CLIENT_CONSUMER_FAILED);
    expect(out.put.code).toBe(0);
    expect(out.get.code).toBe(0);
  }, 120_000);

  test.skipIf(!HAVE_ADDON)('rust: the second process defers to the serve\'s consumer and runs none of its own; the write commits', async () => {
    const out = await scenario(['--rust'], ['serve'], SERVE_READY);
    expect(out.worker).not.toMatch(CLIENT_CONSUMER_FAILED);
    expect(out.worker).toContain('reason=waiter_only');
    expect(out.put.code).toBe(0);
    expect(out.get.code).toBe(0);
  }, 120_000);
});
