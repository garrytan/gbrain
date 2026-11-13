/**
 * #9213 sweep, over the 24 MiB single-string ceiling: on a page that size only the writes that edit its body whole
 * refuse, and the retention purge of an over-ceiling shared-origin tombstone removes it.
 *
 * 1. Protects: on a page over the ceiling every op of PAGE_OPS (test/helpers/segmented-write-sweep.ts) that does not
 *    rewrite the body whole lands; the ops in OVER_CEILING_REFUSALS refuse page_body_segmented by the route listed
 *    there ('ceiling': a refusal that names the ceiling; 'getter': a whole-body rewrite that reads the body through the
 *    page's guarded getter), and a dispatched refusal never hands back the get_page read fix, which cannot help a write.
 *    An expired tombstone of a segmented page over the ceiling whose file another page records (shared origin) is
 *    purged by the retention purge, which reads no body.
 * 2. Fails when: a label or bookkeeping path reads the body of an over-ceiling page (a new getter refusal), a listed
 *    refusal starts landing or changes route without the list changing, or the shared-origin retention purge copies
 *    the page with its body getters again (managed_purge_failed, rowToPage.compiled_truth).
 * 3. Existing coverage: segmented-write-sweep.test.ts is the same sweep below the ceiling;
 *    test/purge-shared-origin-tombstone-7311.test.ts pins the shared-origin retention purge on small pages.
 * 4. Real seams: MCP dispatch with real OAuth tokens, a repo-less brain, the streamed import of an over-ceiling page, a
 *    managed brain with a git worktree, the coordinated purge, PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { purgeDeletedPagesCoordinated } from '../../src/core/persistence/purge-deleted.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { dropOriginIndex } from '../helpers/origin-index.ts';
import { PAGE_OPS, SRC, openSweepBrain, outcome, pageBody, type Outcome, type SweepBrain, type Who } from '../helpers/segmented-write-sweep.ts';

const SWEEP_MS = 1_800_000;
const PURGE_MS = 600_000;
/** Lines of a note over the 24 MiB ceiling (a type with no derived aliases and no fences, which its streamed import refuses). */
const OVER_CEILING_LINES = 350_000;
const OVER_CEILING_BINDINGS: readonly Who[] = ['local', 'plain', 'owner'];
/** Retention window of the purge, in hours, and the age a tombstone is given past it. */
const RETENTION_HOURS = 72;
const EXPIRED_AGE = '73 hours';

/** Ops that refuse a page over the ceiling, with why and by which route. */
const OVER_CEILING_REFUSALS: Record<string, { why: string; via: 'ceiling' | 'getter' }> = {
  remember: { via: 'ceiling', why: 'adds a row to the facts fence, read whole (segmentedRememberRefusal; its fix saves the claim unattributed)' },
  add_timeline_entry: { via: 'ceiling', why: 'splices the timeline, read whole' },
  takes_add: { via: 'ceiling', why: 'edits the takes fence, read whole' },
  revert_version: { via: 'ceiling', why: 'reverting a segmented page is refused at any size (segmented_revert)' },
  put_page: { via: 'getter', why: 'whole-body rewrite: the local put reads the old body for its non-empty check (remote puts refuse page_shrink_refused first)' },
  capture: { via: 'getter', why: 'whole-body rewrite of the page' },
  begin_page_upload: { via: 'getter', why: 'whole-body replace upload (remote uploads refuse page_shrink_refused first)' },
  confirm_memory: { via: 'getter', why: 'rewrites the body whole to drop the unconfirmed marker' },
  extraction_review: { via: 'getter', why: 'records the review by editing the body as one string' },
};

describe('the over-ceiling list names page ops the sweep runs', () => {
  test('every listed op is in PAGE_OPS and runs over the ceiling', () => {
    expect(Object.keys(OVER_CEILING_REFUSALS).filter(name => !(name in PAGE_OPS) || PAGE_OPS[name]!.skipOver)).toEqual([]);
  });
});

for (const kind of testBackends()) {
  describe('writes on a segmented page over the ceiling (' + kind + ', repo-less, #9213 sweep)', () => {
    let brain: SweepBrain;
    let dir: string;
    beforeAll(async () => {
      brain = await openSweepBrain(kind);
      dir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-9213-'));
      const text = pageBody(OVER_CEILING_LINES, 'Acme Example', 'note');
      expect(Buffer.byteLength(text)).toBeGreaterThan(PAGE_MAX_BYTES);
      writeFileSync(join(dir, 'page.md'), text);
    }, SWEEP_MS);
    afterAll(async () => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      await brain?.close();
    }, SWEEP_MS);

    /** A live page over the ceiling stored in segments at slug: imported again only when it no longer is one. */
    async function overCeilingPage(slug: string): Promise<void> {
      const usable = (row: Awaited<ReturnType<SweepBrain['storage']>>) => row && !row.deleted && row.body_storage === 'segmented' && row.body_bytes > PAGE_MAX_BYTES;
      const row = await brain.storage(slug);
      if (usable(row)) return;
      if (row?.deleted) {
        expect(await brain.call('local', 'restore_page', { slug, expected_revision: await brain.revision(slug) })).toMatchObject({ isError: false });
        if (usable(await brain.storage(slug))) return;
      }
      expect(await importFromFile(brain.engine, join(dir, 'page.md'), slug + '.md', { noEmbed: true, sourceId: SRC, bodyPolicy: await readPageBodyPolicy(brain.engine) })).toMatchObject({ status: 'imported' });
      const after = await brain.storage(slug);
      expect({ slug, storage: after?.body_storage, deleted: after?.deleted, over: (after?.body_bytes ?? 0) > PAGE_MAX_BYTES }).toEqual({ slug, storage: 'segmented', deleted: false, over: true });
    }

    test('only the listed whole-body writes refuse, each by its listed route', async () => {
      const outcomes: Outcome[] = [];
      for (const [name, c] of Object.entries(PAGE_OPS).filter(([, c]) => !c.skipOver)) {
        const who = c.who.filter(w => OVER_CEILING_BINDINGS.includes(w));
        const slug = c.replaces ? 'notes/sweep-over-ceiling-' + name.replace(/_/g, '-') : 'notes/sweep-over-ceiling';
        for (const w of who.length ? who : c.who) {
          await overCeilingPage(slug);
          outcomes.push(outcome(name, w, await c.run(brain, slug, w)));
        }
      }
      console.log('[sweep over ceiling] refusals ' + JSON.stringify(outcomes.filter(o => o.error).map(o => [o.op, o.who, o.error, o.getter ? 'getter' : o.ceiling ? 'ceiling' : '-'])));
      const route = (o: Outcome) => (o.getter ? 'getter' : o.ceiling ? 'ceiling' : 'other');
      expect(outcomes.filter(o => o.segmented && OVER_CEILING_REFUSALS[o.op]?.via !== route(o))).toEqual([]);
      expect(outcomes.filter(o => o.getter && !o.segmented)).toEqual([]);
      const refused = new Set(outcomes.filter(o => o.segmented).map(o => o.op));
      expect(Object.keys(OVER_CEILING_REFUSALS).filter(name => !refused.has(name))).toEqual([]);
      expect(outcomes.filter(o => o.segmented && o.dispatched && o.readFix)).toEqual([]);
    }, SWEEP_MS);
  });
}

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const SMALL_FILE = 'notes/x-example.md', BIG_FILE = 'notes/big-example.md', BIG = 'notes/big-example';
/** A fixture write as legacy data left it: managed persistence off around the statement. */
async function raw<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<T> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { return await fn(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, SMALL_FILE), '---\ntype: note\ntitle: X Example\n---\n\nSmall.\n');
  writeFileSync(join(root, BIG_FILE), pageBody(OVER_CEILING_LINES, 'Big Example', 'note'));
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
};

for (const kind of testBackends()) {
  const databaseUrl = kind === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe('retention purge of an over-ceiling shared-origin tombstone (' + kind + ', #9213 sweep)', () => {
    test('the expired tombstone is purged; nothing is blocked page_body_segmented', () => managedBrain(async ({ engine, ctx }) => {
      expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
      const [big] = await engine.executeRaw<{ body_storage: string; body_bytes: string }>("SELECT body_storage, body_bytes::text AS body_bytes FROM pages WHERE source_id='default' AND slug=$1", [BIG]);
      expect({ storage: big?.body_storage, over: Number(big?.body_bytes) > PAGE_MAX_BYTES }).toEqual({ storage: 'segmented', over: true });
      await dropOriginIndex(engine);
      await raw(engine, () => engine.executeRaw("UPDATE pages SET source_path=$1 WHERE source_id='default' AND slug=$2", [SMALL_FILE, BIG]));
      const [row] = await engine.executeRaw<{ revision: string }>("SELECT knowledge_revision::text AS revision FROM pages WHERE source_id='default' AND slug=$1", [BIG]);
      const deleted = await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: BIG, expected_revision: row!.revision, request_id: randomUUID() } });
      expect(deleted).toMatchObject({ status: 'soft_deleted', write_through: { skipped: 'shared_origin', written: false } });
      await raw(engine, () => engine.executeRaw("UPDATE pages SET deleted_at = now() - $1::interval WHERE source_id='default' AND deleted_at IS NOT NULL", [EXPIRED_AGE]));
      const out = await purgeDeletedPagesCoordinated(engine, RETENTION_HOURS, { automatic: true });
      expect({ count: out.count, blocked: out.blocked, error: out.error ?? null }).toEqual({ count: 1, blocked: [], error: null });
      expect(await engine.executeRaw("SELECT slug FROM pages WHERE source_id='default' AND slug=$1", [BIG])).toEqual([]);
    }, { setup, databaseUrl }), PURGE_MS);
  });
}
