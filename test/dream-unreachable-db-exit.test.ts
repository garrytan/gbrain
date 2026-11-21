/**
 * Protects: `gbrain dream` on a configured brain whose database cannot be
 * reached is a failed run (exit 1, never "Brain is healthy"). A machine with no
 * gbrain config has no database to reach and keeps its exit-0 filesystem run.
 * Regression caught: dropping the exit status, so a scheduled run that skipped
 * every DB phase reports success.
 * Existing coverage: test/dream-failed-phase-exit.test.ts pins failed phases,
 * and a skipped phase is not a failed one. No production seam is added.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli/commands/dream.ts';
import type { CliDispatchContext } from '../src/cli/command-table.ts';
import { withEnv } from './helpers/with-env.ts';

let configured: string;
let unconfigured: string;
let dir: string;

const unreachable = {
  connectEngine: async () => { throw new Error('write CONNECT_TIMEOUT db.example.test:5432'); },
} as unknown as CliDispatchContext;

/** Runs the command; `exit` is what it passed to process.exit, null if it returned. */
async function dream(home: string, ...extra: string[]): Promise<{ printed: string; exit: number | null }> {
  let code: number | null = null;
  const exit = spyOn(process, 'exit').mockImplementation(((c?: number) => { code = c ?? 0; throw new Error('EXIT'); }) as never);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined }, () =>
      run(['--dir', dir, '--phase', 'lint', ...extra], unreachable)).catch((e: Error) => { if (e.message !== 'EXIT') throw e; });
    return { printed: log.mock.calls.map(c => String(c[0])).join('\n'), exit: code };
  } finally {
    exit.mockRestore();
    log.mockRestore();
    err.mockRestore();
    stderr.mockRestore();
  }
}

beforeAll(() => {
  configured = mkdtempSync(join(tmpdir(), 'gbrain-dream-db-home-'));
  unconfigured = mkdtempSync(join(tmpdir(), 'gbrain-dream-nodb-home-'));
  dir = mkdtempSync(join(tmpdir(), 'gbrain-dream-db-src-'));
  mkdirSync(join(configured, '.gbrain'), { recursive: true });
  writeFileSync(join(configured, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'postgres',
    database_url: 'postgresql://user:pass@db.example.test:5432/postgres',
  }));
});
afterAll(() => {
  for (const d of [configured, unconfigured, dir]) rmSync(d, { recursive: true, force: true });
});

test('a configured brain with an unreachable database exits 1', async () => {
  expect((await dream(configured)).exit).toBe(1);
}, 60_000);

test('no gbrain config keeps the filesystem-only cycle at exit 0', async () => {
  expect((await dream(unconfigured)).exit).toBeNull();
}, 60_000);

test('--json reports a failed cycle when the database is unreachable', async () => {
  const { printed, exit } = await dream(configured, '--json');
  const report = JSON.parse(printed.slice(printed.indexOf('{')));
  expect(report.status).toBe('failed');
  expect(report.reason).toBe('database_unreachable');
  expect(exit).toBe(1);
}, 60_000);

test('an unreachable database never prints Brain is healthy', async () => {
  expect((await dream(configured)).printed).not.toContain('Brain is healthy');
}, 60_000);
