/**
 * #5032 — colon slugs (`calendar:abc`) are writable again (PR #5044's grammar,
 * pinned in test/file-upload-security.test.ts), and on Windows, where `:` in a
 * file name names an alternate data stream, gbrain refuses rather than mangles:
 *
 *   - a put_page whose canonical file name would contain `:` refuses before
 *     admission with `colon_slug_windows_write_through`, naming the slug;
 *   - the same slug written database-only (no repo configured) succeeds;
 *   - the publication step refuses the same target (a write admitted on another
 *     host and published by a Windows owner);
 *   - managed sync skips each committed colon file with a named refusal and
 *     imports the rest instead of failing the run;
 *   - macOS and Linux are unchanged: the colon file is written.
 *
 * Off Windows the Windows cases run with `process.platform` forced to win32;
 * on the `windows-latest` security-regressions job they run natively.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { prepareFileTarget } from '../src/core/persistence/page-prepare.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { drainManagedSync } from '../src/core/persistence/sync-drain.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { nativeLockCapability } from '../src/core/persistence/native-lock.ts';
import { printManagedSyncNotes } from '../src/commands/sync-diagnostics.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import type { SyncResult } from '../src/commands/sync.ts';
import { loadSyncFailures } from '../src/core/sync-failure-ledger.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const NATIVE_WINDOWS = process.platform === 'win32';
// The Windows runner's TEMP is an 8.3 short path (RUNNER~1); git reports the long
// form, so the fixture starts from the native realpath to keep the two comparable.
const home = mkdtempSync(join(realpathSync.native(tmpdir()), 'gbrain-5032-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const putPage = operations.find((op) => op.name === 'put_page')!;
const CONTENT = '---\ntitle: Calendar event\ntype: note\n---\n\nA calendar event.\n';

async function asWindows<T>(fn: () => Promise<T>): Promise<T> {
  if (NATIVE_WINDOWS) return fn();
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', original); }
}

function ctxOf(engine: BrainEngine, sourceId: string): OperationContext {
  return {
    engine, config: { engine: engine.kind } as OperationContext['config'],
    logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: false, sourceId,
  };
}

async function addSource(engine: BrainEngine, root: string | null): Promise<string> {
  const id = `c${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  return id;
}

/** A sync result with its reason and the source's write requests, so a failed status assertion shows why. */
async function syncState(engine: BrainEngine, sourceId: string, result: SyncResult) {
  const requests = await engine.executeRaw<{ slug: string; state: string; blocked_reason: string | null }>(
    'SELECT slug,state,blocked_reason FROM persistence_requests WHERE source_id=$1 ORDER BY created_at', [sourceId]);
  return { status: result.status, reason: result.reason, drain: result.drain, requests };
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.protectNTFS=false', '-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

beforeAll(async () => {
  // Load the native writer-lock addon for the real platform before any test
  // forces win32 (the binding is chosen by process.platform and cached).
  await nativeLockCapability();
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);

afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

describe('#5032 put_page with a colon slug', () => {
  test('Windows: a write-through write refuses before admission with colon_slug_windows_write_through', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const engine = engines[0];
    const root = join(home, `wt-${randomUUID()}`); mkdirSync(root);
    const sourceId = await addSource(engine, root);
    const error = await asWindows(() => putPage.handler(ctxOf(engine, sourceId), { slug: 'calendar:abc', content: CONTENT }))
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).toJSON()).toMatchObject({
      error: 'colon_slug_windows_write_through',
      message: "Page calendar:abc has a ':' in its file name, which Windows cannot store.",
      suggestion: `Use a slug without ':' (for example calendar-abc), or write calendar:abc from a macOS or Linux host that owns source ${sourceId}.`,
      docs: 'docs/guides/write-refusals.md#colon_slug_windows_write_through',
    });
    expect(await engine.getPage('calendar:abc', { sourceId })).toBeNull();
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [sourceId])).toEqual([]);
  }), 60_000);

  test('Windows: a database-only write of the same slug succeeds', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const engine = engines[0];
    const sourceId = await addSource(engine, null);
    await asWindows(() => putPage.handler(ctxOf(engine, sourceId), { slug: 'calendar:abc', content: CONTENT }));
    expect((await engine.getPage('calendar:abc', { sourceId }))?.compiled_truth).toContain('A calendar event.');
  }), 60_000);

  test('Windows: a live database-only page (derive-phase path, no file) keeps updating', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const engine = engines[0];
    const root = join(home, `dbonly-${randomUUID()}`); mkdirSync(root);
    const sourceId = await addSource(engine, root);
    const seeded = await importFromContent(engine, 'atoms/cal:abc', CONTENT, { sourceId, noEmbed: true });
    expect(seeded.status).toBe('imported');
    await asWindows(() => putPage.handler(ctxOf(engine, sourceId), {
      slug: 'atoms/cal:abc', content: CONTENT.replace('A calendar event.', 'An updated event.'), force: true,
    }));
    expect((await engine.getPage('atoms/cal:abc', { sourceId }))?.compiled_truth).toContain('An updated event.');
  }), 60_000);

  test('Windows: a read-only mirror source stores a colon slug database-only instead of refusing (#5409)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const engine = engines[0];
    const root = join(home, `mirror-${randomUUID()}`); mkdirSync(root);
    const sourceId = await addSource(engine, root);
    await claimWorktree(engine, sourceId, root);
    await engine.executeRaw(`UPDATE sources SET config = config || '{"mirror_read_only":true}'::jsonb WHERE id=$1`, [sourceId]);
    await asWindows(() => putPage.handler(ctxOf(engine, sourceId), { slug: 'calendar:abc', content: CONTENT }));
    expect((await engine.getPage('calendar:abc', { sourceId }))?.compiled_truth).toContain('A calendar event.');
    await engine.executeRaw(`UPDATE sources SET config = config || '{"mirror_read_only":false}'::jsonb WHERE id=$1`, [sourceId]);
    await asWindows(() => putPage.handler(ctxOf(engine, sourceId), {
      slug: 'calendar:abc', content: CONTENT.replace('A calendar event.', 'An updated event.'), force: true,
    }));
    expect((await engine.getPage('calendar:abc', { sourceId }))?.compiled_truth).toContain('An updated event.');
  }), 60_000);

  test('Windows: publication refuses a colon file target admitted elsewhere', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const engine = engines[0];
    const root = join(home, `pub-${randomUUID()}`); mkdirSync(root);
    const sourceId = await addSource(engine, root);
    const binding = await claimWorktree(engine, sourceId, root);
    const row = { source_id: sourceId, worktree_id: binding.worktree_id, slug: 'calendar:abc' };
    await expect(asWindows(() => prepareFileTarget(engine, row, null, CONTENT))).rejects.toMatchObject({
      code: 'colon_slug_windows_write_through',
    });
    expect(await prepareFileTarget(engine, { ...row, slug: 'calendar-abc' }, null, CONTENT)).toBeDefined();
  }), 60_000);

  test.skipIf(NATIVE_WINDOWS)('macOS and Linux: the colon slug is written through to its file, unchanged', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const engine = engines[0];
    const root = join(home, `nix-${randomUUID()}`); mkdirSync(root);
    const sourceId = await addSource(engine, root);
    await putPage.handler(ctxOf(engine, sourceId), { slug: 'calendar:abc', content: CONTENT });
    expect(await engine.getPage('calendar:abc', { sourceId })).not.toBeNull();
    expect(existsSync(join(root, 'calendar:abc.md'))).toBe(true);
  }), 60_000);
});

describe('#5032 managed sync of committed colon files on Windows', () => {
  test('each colon file gets a named refusal; the rest import and the run completes', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const root = join(home, `sync-${randomUUID()}`); mkdirSync(join(root, 'notes'), { recursive: true });
      git(root, 'init', '-q');
      writeFileSync(join(root, 'notes', 'plain.md'), '---\ntitle: Plain\n---\nAn ordinary note.\n');
      git(root, 'add', '-A');
      // Commit the colon file through the index only: Windows cannot create it
      // in a checkout, and the Windows clone this models never has it on disk.
      const blob = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: CONTENT, encoding: 'utf8' }).trim();
      git(root, 'update-index', '--add', '--cacheinfo', `100644,${blob},notes/calendar:abc.md`);
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'colon');
      git(root, 'update-index', '--skip-worktree', 'notes/calendar:abc.md');
      const head = git(root, 'rev-parse', 'HEAD');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const sourceId = await addSource(engine, root);
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

      // A single managed pass returns partial/writer_pending when a page's write outlives its wait; the CLI drains.
      const result = await asWindows(() => drainManagedSync(engine, { sourceId, noPull: true }, false));
      expect(await syncState(engine, sourceId, result)).toMatchObject({ status: 'first_sync' });
      expect(result.fileRefusals).toEqual([{
        path: 'notes/calendar:abc.md', code: 'colon_slug_windows_write_through',
        message: "notes/calendar:abc.md has a ':' in its name, which Windows cannot store; sync skipped it.",
        suggestion: `Rename it without ':' on a macOS or Linux checkout and commit, then run gbrain sync --source ${sourceId} --no-pull.`,
        docs: 'docs/guides/write-refusals.md#colon_slug_windows_write_through',
      }]);
      expect(await engine.getPage('notes/plain', { sourceId })).not.toBeNull();
      const [source] = await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [sourceId]);
      expect(source.last_commit).toBe(head);
      const lines: string[] = [];
      printManagedSyncNotes(result, (line) => lines.push(line));
      expect(lines).toContain(`  Refused colon_slug_windows_write_through: ${result.fileRefusals![0].message} ${result.fileRefusals![0].suggestion} (docs/guides/write-refusals.md#colon_slug_windows_write_through)`);
    }
  }), 180_000);
});

describe('#5032 managed sync of a rename away from a colon file on Windows', () => {
  // The colon page was imported by a macOS or Linux owner; that first sync
  // cannot run on a native Windows runner, so this case is POSIX-only.
  test.skipIf(NATIVE_WINDOWS)('both sides are refused and the page keeps its identity; no duplicate page appears', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const root = join(home, `rename-${randomUUID()}`); mkdirSync(join(root, 'notes'), { recursive: true });
      git(root, 'init', '-q');
      writeFileSync(join(root, 'notes', 'calendar:abc.md'), CONTENT);
      git(root, 'add', '-A');
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'colon');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const sourceId = await addSource(engine, root);
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      expect(await syncState(engine, sourceId, await drainManagedSync(engine, { sourceId, noPull: true }, false))).toMatchObject({ status: 'first_sync' });
      const [before] = await engine.executeRaw<{ id: number; slug: string }>(
        "SELECT id,slug FROM pages WHERE source_id=$1 AND source_path='notes/calendar:abc.md' AND deleted_at IS NULL", [sourceId]);
      expect(before).toBeDefined();

      git(root, 'mv', 'notes/calendar:abc.md', 'notes/calendar-abc.md');
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'rename');
      const result = await asWindows(() => performManagedSync(engine, { sourceId, noPull: true }));
      expect(result.fileRefusals?.map((refusal) => refusal.path).sort()).toEqual(['notes/calendar-abc.md', 'notes/calendar:abc.md']);
      const live = await engine.executeRaw<{ id: number; slug: string }>('SELECT id,slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [sourceId]);
      expect(live).toEqual([{ id: before.id, slug: before.slug }]);
    }
  }), 180_000);
});

describe('#5032 unmanaged incremental sync of a committed colon file on Windows', () => {
  test('the colon file is a named per-file failure; the other files import', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    const engine = engines[0];
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try {
      const root = join(home, `legacy-${randomUUID()}`); mkdirSync(join(root, 'notes'), { recursive: true });
      git(root, 'init', '-q');
      writeFileSync(join(root, 'notes', 'first.md'), '---\ntitle: First\n---\nThe first note.\n');
      git(root, 'add', '-A');
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'first');
      const sourceId = await addSource(engine, root);
      expect((await performSync(engine, { repoPath: root, sourceId, noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');

      writeFileSync(join(root, 'notes', 'second.md'), '---\ntitle: Second\n---\nThe second note.\n');
      git(root, 'add', '-A');
      const blob = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: CONTENT, encoding: 'utf8' }).trim();
      git(root, 'update-index', '--add', '--cacheinfo', `100644,${blob},notes/calendar:abc.md`);
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'colon');
      git(root, 'update-index', '--skip-worktree', 'notes/calendar:abc.md');

      const result = await asWindows(() => performSync(engine, { repoPath: root, sourceId, noPull: true, noEmbed: true, noExtract: true }));
      expect(result.status).toBe('blocked_by_failures');
      expect(result.failedFiles).toBe(1);
      expect(await engine.getPage('notes/second', { sourceId })).not.toBeNull();
      const failure = loadSyncFailures().find((row) => row.path === 'notes/calendar:abc.md');
      expect(failure?.error).toStartWith("colon_slug_windows_write_through: notes/calendar:abc.md has a ':' in its name");
      expect(failure?.code).toBe('COLON_SLUG_WINDOWS_WRITE_THROUGH');
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  }), 120_000);
});
