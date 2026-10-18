/**
 * #6517 (GBRA-79 wave 16, G3.3 [R7]): one origin rule for every origin guard.
 * `selectOriginClaimant` decides which page an origin file identifies when
 * several pages of the source record it: a live page wins over tombstones,
 * several live pages refuse, a single tombstone may be reused (resurrection),
 * several tombstones stay ambiguous. `assertSyncPageOrigin` (preparation and
 * publication) applies it: master selected every page recording the origin,
 * tombstones included, and refused `pages.length > 1`, so a soft-deleted twin
 * kept the survivor's imports refusing `page_identity_changed` (the Eng P1
 * probe). The accepted-`pageId` and `requireOrigin` checks are unchanged.
 * PGLite and, with DATABASE_URL, Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { assertSyncPageOrigin, selectOriginClaimant, sharedOriginExit } from '../src/core/persistence/sync-origin.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { dropOriginIndex } from './helpers/origin-index.ts';

describe('#6517 selectOriginClaimant, the one origin rule', () => {
  const live = (id: number) => ({ id, deleted_at: null });
  const gone = (id: number) => ({ id, deleted_at: '2026-01-01T00:00:00Z' });
  test('no claimant', () => expect(selectOriginClaimant([])).toEqual({ winner: null, ambiguous: null }));
  test('one live page wins', () => expect(selectOriginClaimant([live(1)])).toEqual({ winner: live(1), ambiguous: null }));
  test('a live page wins over any number of tombstones', () => {
    expect(selectOriginClaimant([gone(1), live(2), gone(3)])).toEqual({ winner: live(2), ambiguous: null });
    expect(selectOriginClaimant([live(2), gone(1)])).toEqual({ winner: live(2), ambiguous: null });
  });
  test('several live pages refuse, whatever the tombstones', () => {
    expect(selectOriginClaimant([live(1), live(2)])).toEqual({ winner: null, ambiguous: 'several_live' });
    expect(selectOriginClaimant([gone(3), live(1), live(2)])).toEqual({ winner: null, ambiguous: 'several_live' });
  });
  test('a single tombstone may be reused', () => expect(selectOriginClaimant([gone(1)])).toEqual({ winner: gone(1), ambiguous: null }));
  test('several tombstones stay ambiguous', () => expect(selectOriginClaimant([gone(1), gone(2)])).toEqual({ winner: null, ambiguous: 'several_tombstones' }));
  test('the exit text names the soft delete and the kept file, never a purge', () => {
    const text = sharedOriginExit('src-example', ['a', 'b']);
    expect(text).toContain('gbrain delete <slug> --source-id src-example --expected-revision <rev>');
    expect(text).toContain('one of a, b');
    expect(text).toContain('hidden without touching the file');
    expect(text).not.toContain('--purge');
  });
});

for (const backend of testBackends()) describe(`[${backend}] #6517 assertSyncPageOrigin applies the rule`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const sourceId = 'default';
  let n = 0;
  async function pages(origin: string, states: Array<'live' | 'gone'>): Promise<number[]> {
    const ids: number[] = [];
    for (const state of states) {
      const slug = `origin-rule/${++n}`;
      await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
        await tx.putPage(slug, { type: 'note', title: slug, compiled_truth: `Page ${n}.`, timeline: '', frontmatter: {}, content_hash: `h-${n}` }, { sourceId });
        // #6948: a second live claimant only exists as legacy data now, so the origin is set directly.
        await tx.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [sourceId, slug, origin]);
        if (state === 'gone') await tx.executeRaw('UPDATE pages SET deleted_at=now() WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      }, TEST_WRITE_ATTRIBUTION));
      ids.push(Number((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]!.id));
    }
    return ids;
  }
  const refuses = (promise: Promise<void>) => promise.then(() => 'accepted', error => error instanceof OperationError ? `${error.code}` : `other:${String(error)}`);

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
    await dropOriginIndex(engine);
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); await closePostgres?.(); }, 60_000);

  test('one live page plus a tombstone: the origin identifies the live page (master refused page_identity_changed)', async () => {
    const origin = `twins/${randomUUID().slice(0, 8)}.md`;
    const [liveId, tombstoneId] = await pages(origin, ['live', 'gone']);
    await assertSyncPageOrigin(engine, sourceId, origin, liveId!);
    await assertSyncPageOrigin(engine, sourceId, origin, liveId!, true);
    // The tombstone is not the page the origin identifies any more.
    expect(await refuses(assertSyncPageOrigin(engine, sourceId, origin, tombstoneId!))).toBe('page_identity_changed');
    // An import that accepted no page for an origin a live page records is refused, as before.
    expect(await refuses(assertSyncPageOrigin(engine, sourceId, origin, null))).toBe('page_identity_changed');
  });

  test('two live pages refuse, and the refusal names the soft-delete exit with both slugs', async () => {
    const origin = `twins/${randomUUID().slice(0, 8)}.md`;
    const [a, b] = await pages(origin, ['live', 'live']);
    for (const id of [a!, b!, null]) {
      let error: OperationError | undefined;
      try { await assertSyncPageOrigin(engine, sourceId, origin, id); } catch (e) { error = e as OperationError; }
      expect(error?.code).toBe('page_identity_changed');
      expect(error?.suggestion).toContain('Soft-delete the page that should not own the file');
      expect(error?.suggestion).toContain(`origin-rule/${n - 1}`);
      expect(error?.suggestion).toContain(`origin-rule/${n}`);
    }
  });

  test('a single tombstone is still reusable (resurrection), two tombstones still refuse', async () => {
    const one = `twins/${randomUUID().slice(0, 8)}.md`;
    const [tombstone] = await pages(one, ['gone']);
    await assertSyncPageOrigin(engine, sourceId, one, tombstone!);
    await assertSyncPageOrigin(engine, sourceId, one, tombstone!, true);
    expect(await refuses(assertSyncPageOrigin(engine, sourceId, one, null))).toBe('page_identity_changed');
    const two = `twins/${randomUUID().slice(0, 8)}.md`;
    const [x, y] = await pages(two, ['gone', 'gone']);
    for (const id of [x!, y!, null]) expect(await refuses(assertSyncPageOrigin(engine, sourceId, two, id))).toBe('page_identity_changed');
  });

  test('requireOrigin: an accepted page whose origin no page records refuses; no page accepted and none recorded is fine', async () => {
    const origin = `twins/${randomUUID().slice(0, 8)}.md`;
    await assertSyncPageOrigin(engine, sourceId, origin, null, true);
    expect(await refuses(assertSyncPageOrigin(engine, sourceId, origin, 123456789, true))).toBe('page_identity_changed');
  });
});
