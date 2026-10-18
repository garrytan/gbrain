/**
 * #6803 C1: `gbrain sync --status› is the status read, never a sync.
 *
 * Before, the strict flag validator accepted `--status› (sync's generated legal set is the union of its
 * modules' flags), nothing downstream read it, and `runSingleSourceSync› ran: a full sync under the
 * 3600 s watchdog that imported the source. Now one classifier (`syncOperatorVerb›) routes it to
 * `gbrain sync status› in the CLI preflight (no watchdog, no owner delegation) and in `runSyncInner›,
 * with one stderr hint. `--preview›, which no sync path reads, refuses `invalid_params›; `--dry-run› is
 * unchanged and still consumed by the direct parse and both owner delegation parsers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseSyncFlags } from '../src/commands/sync/args.ts';
import { syncOperatorVerb } from '../src/commands/sync/operator.ts';
import { parsePersistenceSyncArgs } from '../src/commands/sync-persistence-delegate.ts';
import { parseDelegatedSyncArgs } from '../src/commands/sync-delegate.ts';
import { runCli } from './helpers/cli-spawn.ts';

const HINT = 'sync --status is the status read';

describe('gbrain sync --status (real CLI)', () => {
  let home: string;
  let notes: string;
  const dbPath = () => join(home, '.gbrain', 'brain.pglite');

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-6803-sync-status-'));
    notes = join(home, 'notes');
    mkdirSync(notes, { recursive: true });
    for (const n of ['alpha', 'beta', 'gamma']) writeFileSync(join(notes, `${n}.md`), `---\ntitle: ${n}\n---\n\n# ${n}\n\nA note about acme-example.\n`);
    const init = await runCli(['init', '--pglite', '--no-embedding', '--non-interactive'], { home, timeoutMs: 120_000 });
    expect(init.exitCode, init.stderr).toBe(0);
    const add = await runCli(['sources', 'add', 'notes', '--path', notes, '--force'], { home, timeoutMs: 60_000 });
    expect(add.exitCode, add.stderr).toBe(0);
  }, 200_000);
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const pageCount = async () => {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dbPath() });
    try { return (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages'))[0]!.n; } finally { await engine.disconnect(); }
  };

  test('prints the sync status envelope and syncs nothing', async () => {
    const run = await runCli(['sync', '--status', '--source', 'notes', '--json'], { home, timeoutMs: 60_000 });
    expect(run.exitCode, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(out).not.toHaveProperty('sync_status');
    expect(out).toMatchObject({ source_id: 'notes', cursor: null });
    expect(out).toHaveProperty('holds');
    expect(run.stderr.split(HINT).length - 1).toBe(1);
    expect(run.stderr).not.toContain('[sync-watchdog]');
    expect(await pageCount()).toBe(0);
  }, 90_000);

  test('under a resident owner it gets exactly what `sync status` gets: no watchdog, no owner hand-off', async () => {
    const resident = new PGLiteEngine();
    await resident.connect({ database_path: dbPath() });
    try {
      const [plain, flag] = await Promise.all([
        runCli(['sync', 'status', '--source', 'notes', '--json'], { home, timeoutMs: 60_000 }),
        runCli(['sync', '--status', '--source', 'notes', '--json'], { home, timeoutMs: 60_000 }),
      ]);
      expect(flag.exitCode).toBe(plain.exitCode);
      expect(flag.stdout).toBe(plain.stdout);
      for (const marker of ['[sync-watchdog]', 'Delegating to the registered PGLite owner', 'owner-delegated', 'Delegating to the running serve']) {
        expect(flag.stderr).not.toContain(marker);
      }
    } finally {
      await resident.disconnect();
    }
    expect(await pageCount()).toBe(0);
  }, 120_000);

  test('--preview, which sync never reads, refuses with invalid_params and runs nothing', async () => {
    const run = await runCli(['sync', '--preview', '--source', 'notes', '--json'], { home, timeoutMs: 60_000 });
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout + run.stderr).toContain('invalid_params');
    expect(run.stdout + run.stderr).toContain('does not read --preview');
    expect(run.stdout + run.stderr).toContain('--dry-run');
    expect(await pageCount()).toBe(0);
  }, 90_000);
});

test('--dry-run is still consumed by the direct parse and by both owner delegation parsers', async () => {
  expect(syncOperatorVerb(['--dry-run', '--source', 'notes'])).toBeNull();
  expect(syncOperatorVerb(['status', '--source', 'notes'])).toBe('status');
  expect(syncOperatorVerb(['--status', '--source', 'notes'])).toBe('status');
  expect(() => syncOperatorVerb(['--check'])).toThrow(/does not read --check/);
  expect(parseSyncFlags(['--dry-run']).dryRun).toBe(true);
  expect((await parsePersistenceSyncArgs(['--dry-run', '--source', 'notes'])).options.dryRun).toBe(true);
  const delegated = parseDelegatedSyncArgs(['--dry-run', '--source', 'notes']);
  expect(delegated.ok && delegated.options.dryRun).toBe(true);
});
