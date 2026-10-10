/**
 * A queued automatic freshness sync honours `syncEnabled:false` set after it was enqueued (#4399 window).
 *
 * Protects: `autopilot_freshness` jobs re-read the source when they run and skip a disabled source;
 * explicitly requested sync jobs still run; a failed source lookup falls through to syncing.
 * Diagnosis and case matrix contributed by @Masashi-Ono0611 (PR #6407).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeSyncHandler } from '../src/core/minions/handlers/sync.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const workdir = mkdtempSync(join(tmpdir(), 'gbrain-sync-enabled-'));
const brain = join(workdir, 'brain');
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  mkdirSync(brain, { recursive: true });
  const repo = await makeGitFixture(brain);
  writeFileSync(join(brain, 'note.md'), '---\ntitle: Note\ntype: note\n---\n\nA short note.\n');
  repo.commitAll('add note');
}, 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(workdir, { recursive: true, force: true }); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw("UPDATE sources SET local_path=$1, config=jsonb_set(COALESCE(config,'{}'::jsonb),'{syncEnabled}','false'::jsonb) WHERE id='default'", [brain]);
});

const job = (data: Record<string, unknown>) => ({ id: 1, name: 'sync', data, signal: new AbortController().signal } as unknown as MinionJobContext);
const freshness = { sourceId: 'default', repoPath: brain, pull: false, auto_embed_backfill: false, embed_reason: 'autopilot_freshness' };
const pages = async () => (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE slug='note'"))[0].n;

test('a queued freshness sync of a source disabled after enqueue is skipped and imports nothing', async () => {
  const result = await makeSyncHandler(engine)(job(freshness));
  expect(result).toMatchObject({ skipped: true, reason: 'sync_disabled', source_id: 'default' });
  expect(await pages()).toBe(0);
});

test('a freshness job that names only repoPath resolves the source and is skipped too', async () => {
  const { sourceId: _omit, ...byPath } = freshness;
  expect(await makeSyncHandler(engine)(job(byPath))).toMatchObject({ skipped: true, reason: 'sync_disabled', source_id: 'default' });
});

test('an explicit sync job of a disabled source still runs', async () => {
  const { embed_reason: _omit, ...explicit } = freshness;
  const result = await makeSyncHandler(engine)(job(explicit));
  expect(result).not.toMatchObject({ skipped: true });
  expect(await pages()).toBe(1);
});

test('an enabled source still syncs on a freshness job', async () => {
  await engine.executeRaw("UPDATE sources SET config=config - 'syncEnabled' WHERE id='default'");
  await makeSyncHandler(engine)(job(freshness));
  expect(await pages()).toBe(1);
});

test('a failed source lookup falls through to syncing', async () => {
  const original = engine.executeRaw.bind(engine);
  const failing = Object.create(engine) as PGLiteEngine;
  failing.executeRaw = (async (sql: string, params?: unknown[]) => {
    if (/FROM sources WHERE id = \$1/.test(sql) && /config/.test(sql)) throw new Error('lookup failed');
    return original(sql, params);
  }) as PGLiteEngine['executeRaw'];
  const result = await makeSyncHandler(failing)(job(freshness)).catch((error: unknown) => ({ threw: String(error) }));
  expect(result).not.toMatchObject({ skipped: true, reason: 'sync_disabled' });
});
