/**
 * GST-3107: a managed `gbrain sources refresh` derives links only for the pages it imported while it holds the worktree's
 * refresh lock, and drains the source's stale-link backlog after releasing it, with the same page cap and budget.
 *
 * Protects: a few-file refresh holds the lock for its own work only, so other refreshers of the worktree do not collide on
 * `refresh_in_progress` while a stale-link backlog drains; an uncontended run still drains as much backlog as before; two
 * backlog drains of one source never overlap (the second refresh skips its share and says so); a drain that fails leaves
 * the completed refresh completed; the result carries `phase_ms` and `lock_held_ms`.
 * Regression it catches: the sync tail deriving up to 1,000 backlog pages while the refresh lock is held (GST-3107: minutes
 * per tick on a large brain), or a split that drops the backlog drain on deployments where nothing else runs it.
 * Seams: `hooks.boundary('synced')` reads the backlog while the lock is held, `hooks.backlog` runs the second refresh during
 * the first one's drain; real git remotes, clones and engines otherwise.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { effectiveLinkExtractorWatermark } from '../src/core/link-extraction-watermark.ts';
import { LINK_EXTRACTION_GENERATION_KEY } from '../src/core/line-grammar.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { git, page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const BACKLOG_PAGES = 40;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});

const each = async (fn: (f: RefreshFixture) => Promise<void>) => { for (const engine of engines) await withRefreshFixture(engine, fn); };
const stale = async (f: RefreshFixture) => f.engine.countStalePagesForExtraction({ sourceId: f.alpha, versionTs: await effectiveLinkExtractorWatermark(f.engine), held: 'exclude' });

/** Imports BACKLOG_PAGES alpha pages, then moves the link-extraction generation so every page of the brain is stale again. */
async function withBacklog(f: RefreshFixture): Promise<void> {
  for (let i = 0; i < BACKLOG_PAGES; i++) {
    mkdirSync(join(f.upstream, 'alpha', 'notes'), { recursive: true });
    writeFileSync(join(f.upstream, 'alpha', 'notes', `n${i}.md`), page(`Note ${i}`, `Observation ${i} about acme-example.`));
  }
  git(f.upstream, 'add', '-A'); git(f.upstream, 'commit', '-qm', 'notes'); git(f.upstream, 'push', '-q', 'origin', 'main');
  expect((await refreshWorktree(f.engine, f.alpha)).status).toBe('completed');
  await new Promise(resolve => setTimeout(resolve, 50));
  await f.engine.setConfig(LINK_EXTRACTION_GENERATION_KEY, new Date().toISOString());
  expect(await stale(f)).toBe(BACKLOG_PAGES + 1);
}
/** Pushes a change to three alpha pages (they stay pages, so the import derives exactly three). */
function pushThree(f: RefreshFixture, round: number): void {
  for (let i = 0; i < 3; i++) writeFileSync(join(f.upstream, 'alpha', 'notes', `n${i}.md`), page(`Note ${i}`, `Round ${round} edit about acme-example.`));
  git(f.upstream, 'commit', '-qam', `round ${round}`); git(f.upstream, 'push', '-q', 'origin', 'main');
}

test('a 3-file refresh derives 3 pages under its lock and drains the backlog after releasing it', () => each(async f => {
  await withBacklog(f);
  pushThree(f, 1);
  let underLock = -1;
  const result = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => { if (point === 'synced') underLock = await stale(f); } } });
  expect(result.status).toBe('completed');
  // The lock held the import and its three pages' links only; master derived the whole backlog here (0 left).
  expect(underLock).toBe(BACKLOG_PAGES + 1 - 3);
  // After the lock: the same backlog an uncontended tick drained before the split.
  expect(await stale(f)).toBe(0);
  expect(result.link_backlog?.find(entry => entry.source_id === f.alpha)).toMatchObject({ outcome: 'drained', pages: BACKLOG_PAGES + 1 - 3, remaining: 0 });
  expect(Object.keys(result.phase_ms ?? {})).toEqual(expect.arrayContaining(['fetch', 'precheck', 'drain', 'merge', 'sync', 'tail', 'backlog']));
  expect(Object.values(result.phase_ms ?? {}).every(ms => Number.isInteger(ms) && ms >= 0)).toBe(true);
  expect(Number.isInteger(result.lock_held_ms)).toBe(true);
}), 240_000);

test('a refresh started during another refresh\'s backlog drain completes its import and skips its own drain', () => each(async f => {
  await withBacklog(f);
  pushThree(f, 1);
  let second: Awaited<ReturnType<typeof refreshWorktree>> | null = null;
  const first = await refreshWorktree(f.engine, f.alpha, { hooks: { backlog: async sourceId => {
    if (sourceId !== f.alpha || second) return;
    pushThree(f, 2);
    second = await refreshWorktree(f.engine, f.alpha);
  } } });
  expect(second).not.toBeNull();
  expect(second!.status).toBe('completed');
  expect(second!.target_head).toBe(f.head());
  expect(second!.link_backlog?.find(entry => entry.source_id === f.alpha)).toMatchObject({ outcome: 'skipped', pages: 0 });
  expect(first.status).toBe('completed');
  expect(first.link_backlog?.find(entry => entry.source_id === f.alpha)?.outcome).toBe('drained');
  expect(await stale(f)).toBe(0);
}), 240_000);

test('a backlog drain that fails leaves the completed refresh completed and names the failure', () => each(async f => {
  await withBacklog(f);
  pushThree(f, 1);
  const result = await refreshWorktree(f.engine, f.alpha, { hooks: { backlog: sourceId => { if (sourceId === f.alpha) throw new Error('backlog drain failed for the test'); } } });
  expect(result.status).toBe('completed');
  expect(await f.lastCommit(f.alpha)).toBe(f.head());
  expect(result.link_backlog?.find(entry => entry.source_id === f.alpha)).toMatchObject({ outcome: 'failed', pages: 0, message: 'backlog drain failed for the test' });
  expect(await stale(f)).toBe(BACKLOG_PAGES + 1 - 3);
}), 240_000);
