/**
 * D6 e2e: takes WRITE ops through the OP layer against real Postgres.
 *
 * Scope: the src/core/ops/takes.ts handlers (takes_add / takes_update /
 * takes_resolve / takes_supersede) — the fence-first write journey, the
 * withPageLock serialization contract, and the mirror-availability envelope.
 * The engine-level Postgres bind shapes (addTakesBatch unnest, supersedeTake
 * transaction, resolveTake immutability at the ENGINE layer) are pinned by
 * test/e2e/takes-postgres.test.ts; nothing here duplicates them.
 *
 * Contracts pinned (read from the code, not assumed):
 *  - opBrainDir (ops/takes.ts): sync.repo_path unset OR pointing at a missing
 *    directory → OperationError code 'unavailable' with detail
 *    'takes_mirror_unavailable' (same envelope over MCP dispatch).
 *  - takes_add success: markdown fence is written FIRST (md-canonical), then
 *    the DB row is mirrored via addTakesBatch; result shape
 *    { slug, row_num, holder, mirror_written: true } with NO mirror_warning.
 *  - Two concurrent takes_add on one slug serialize under withPageLock
 *    (OP_LOCK_TIMEOUT_MS = 2000ms; the loser polls at 200ms while the
 *    winner's critical section is a few DB roundtrips), so BOTH succeed with
 *    distinct fence-derived row_nums. The retryable envelope only appears
 *    when a holder outlives the 2s budget — pinned separately by holding the
 *    page lock externally: TakesWriteError 'page_locked' maps to
 *    OperationError 'unavailable' with detail 'retryable'.
 *  - Resolved rows are immutable through the ops: takes_update and
 *    takes_supersede both map TakesWriteError 'already_resolved' →
 *    OperationError 'invalid_params' (suggestion 'Supersede instead.' from
 *    update; 'Add a new take instead.' from supersede).
 *  - takes_supersede closes + links: old row active=false with
 *    superseded_by=<new_row>; new row appended active at the next fence row
 *    number; the fence shows the old claim ~~struck through~~.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { operations, OperationError, type OperationContext } from '../../src/core/operations.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { acquirePageLock } from '../../src/core/page-lock.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

// Page locks live under the REAL ~/.gbrain/page-locks (keyed by slug hash)
// and survive test runs — a crashed prior run's lock file younger than the
// 5-min TTL would block this run. Unique-per-run slugs sidestep that.
const TAG = Date.now().toString(36);
const ALICE_SLUG = `people/takes-ops-alice-${TAG}`;
const LOCK_SLUG = `people/takes-ops-lock-${TAG}`;
const LOCK_HELD_SLUG = `people/takes-ops-lockheld-${TAG}`;
const RESOLVED_SLUG = `companies/takes-ops-resolved-${TAG}`;
const SUPERSEDE_SLUG = `companies/takes-ops-supersede-${TAG}`;

let repoDir: string;
let alicePageId: number;
let resolvedPageId: number;
let supersedePageId: number;

function opByName(name: string) {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(`operation not found in canonical array: ${name}`);
  return op;
}

/** Ctx factory (copied from test/operations-source-isolation-matrix.test.ts;
 * sourceId is REQUIRED on the type). remote:false = trusted local caller —
 * takesWriteAllowList(ctx) returns null, so the holder fence is off and the
 * tests exercise the write journey itself. */
function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: getEngine() as any,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}

async function expectOpError(p: Promise<unknown>): Promise<OperationError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OperationError);
    return e as OperationError;
  }
  throw new Error('expected the op to throw an OperationError, but it succeeded');
}

function pageFile(slug: string): string {
  // Default source, no sources.local_path, DB-born page (no recorded
  // source_path) → resolveTakesFilePath falls back to <brainDir>/<slug>.md.
  return join(repoDir, `${slug}.md`);
}

beforeAll(async () => {
  if (!RUN) return;
  const engine = await setupDB();
  repoDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-ops-'));
  await engine.setConfig('sync.repo_path', repoDir);
  const alice = await engine.putPage(ALICE_SLUG, {
    title: 'Alice', type: 'person', compiled_truth: '## Takes\n',
  });
  alicePageId = alice.id;
  await engine.putPage(LOCK_SLUG, {
    title: 'Lock journey', type: 'person', compiled_truth: '## Takes\n',
  });
  await engine.putPage(LOCK_HELD_SLUG, {
    title: 'Lock held', type: 'person', compiled_truth: '## Takes\n',
  });
  const resolved = await engine.putPage(RESOLVED_SLUG, {
    title: 'Resolved fixture', type: 'company', compiled_truth: '## Takes\n',
  });
  resolvedPageId = resolved.id;
  const sup = await engine.putPage(SUPERSEDE_SLUG, {
    title: 'Supersede fixture', type: 'company', compiled_truth: '## Takes\n',
  });
  supersedePageId = sup.id;
});

afterAll(async () => {
  if (!RUN) return;
  await teardownDB();
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

d('takes_add mirror availability — both arms of opBrainDir', () => {
  test('sync.repo_path unset → unavailable + takes_mirror_unavailable (handler throw AND MCP envelope)', async () => {
    const engine = getEngine();
    await engine.unsetConfig('sync.repo_path');
    try {
      // Direct handler: typed OperationError.
      const err = await expectOpError(
        opByName('takes_add').handler(ctxOf(), {
          slug: ALICE_SLUG, claim: 'Never lands', kind: 'take', holder: 'garry',
        }),
      );
      expect(err.code).toBe('unavailable');
      expect(err.detail).toBe('takes_mirror_unavailable');
      expect(err.suggestion).toContain('sync.repo_path');

      // Same contract over MCP dispatch: the error envelope.
      const result = await dispatchToolCall(engine, 'takes_add', {
        slug: ALICE_SLUG, claim: 'Never lands', kind: 'take', holder: 'world',
      }, { remote: true, transport: 'stdio', sourceId: 'default' });
      expect(result.isError).toBe(true);
      const envelope = JSON.parse(result.content[0].text);
      expect(envelope.error).toBe('unavailable');
      expect(envelope.detail).toBe('takes_mirror_unavailable');

      // Nothing was written: no markdown twin, no DB row.
      expect(existsSync(pageFile(ALICE_SLUG))).toBe(false);
      expect(await engine.listTakes({ page_id: alicePageId })).toHaveLength(0);
    } finally {
      await engine.setConfig('sync.repo_path', repoDir);
    }
  });

  test('sync.repo_path set but the directory is missing on disk → same envelope', async () => {
    const engine = getEngine();
    await engine.setConfig('sync.repo_path', join(repoDir, 'does-not-exist'));
    try {
      const err = await expectOpError(
        opByName('takes_add').handler(ctxOf(), {
          slug: ALICE_SLUG, claim: 'Never lands either', kind: 'take', holder: 'garry',
        }),
      );
      expect(err.code).toBe('unavailable');
      expect(err.detail).toBe('takes_mirror_unavailable');
    } finally {
      await engine.setConfig('sync.repo_path', repoDir);
    }
  });
});

d('takes_add fence-first journey — op handler on real Postgres', () => {
  test('markdown fence row lands + DB mirror row lands; success shape pinned', async () => {
    const engine = getEngine();
    const result = await opByName('takes_add').handler(ctxOf(), {
      slug: ALICE_SLUG,
      claim: 'Ships weekly at demo day',
      kind: 'take',
      holder: 'garry',
      weight: 0.8,
      source: 'oh-notes',
      since: '2026-08',
    }) as { slug: string; row_num: number; holder: unknown; mirror_written: boolean; mirror_warning?: string };

    expect(result.slug).toBe(ALICE_SLUG);
    expect(result.row_num).toBe(1);
    expect(result.holder).toBe('garry');
    expect(result.mirror_written).toBe(true);
    // A healthy PG mirror produces NO warning (mirror_warning is the
    // md-written-but-DB-deferred signal; its presence here would mean the
    // real addTakesBatch bind path failed).
    expect(result.mirror_warning).toBeUndefined();

    // Markdown (canonical) — file created, fence present, exact rendered row.
    const md = readFileSync(pageFile(ALICE_SLUG), 'utf-8');
    expect(md).toContain(TAKES_FENCE_BEGIN);
    expect(md).toContain(TAKES_FENCE_END);
    expect(md).toContain('| 1 | Ships weekly at demo day | take | garry | 0.8 | 2026-08 | oh-notes |');

    // DB mirror — read back through the engine.
    const takes = await engine.listTakes({ page_id: alicePageId });
    expect(takes).toHaveLength(1);
    expect(takes[0].row_num).toBe(1);
    expect(takes[0].claim).toBe('Ships weekly at demo day');
    expect(takes[0].kind).toBe('take');
    expect(takes[0].holder).toBe('garry');
    expect(takes[0].weight).toBeCloseTo(0.8, 5);
    expect(takes[0].source).toBe('oh-notes');
    expect(takes[0].active).toBe(true);
  });
});

d('withPageLock serialization — the lock journey', () => {
  test('two concurrent takes_add for the same slug BOTH succeed, serialized to distinct row_nums', async () => {
    const engine = getEngine();
    const add = opByName('takes_add');
    // Fire both without awaiting: the loser's acquirePageLock polls (200ms)
    // inside the 2000ms op budget while the winner finishes its critical
    // section, so the real contract is both-succeed, never a retryable error.
    const [r1, r2] = await Promise.all([
      add.handler(ctxOf(), { slug: LOCK_SLUG, claim: 'concurrent claim alpha', kind: 'take', holder: 'garry' }),
      add.handler(ctxOf(), { slug: LOCK_SLUG, claim: 'concurrent claim beta', kind: 'take', holder: 'garry' }),
    ]) as Array<{ row_num: number; mirror_written: boolean; mirror_warning?: string }>;

    expect(r1.mirror_written).toBe(true);
    expect(r2.mirror_written).toBe(true);
    expect(r1.mirror_warning).toBeUndefined();
    expect(r2.mirror_warning).toBeUndefined();
    // Fence-derived row numbers: the second writer re-reads the fence AFTER
    // the first released the lock, so the rows are dense and distinct.
    expect([r1.row_num, r2.row_num].sort()).toEqual([1, 2]);

    // Both claims durable in the DB mirror...
    const page = await engine.getPage(LOCK_SLUG, { sourceId: 'default' });
    const takes = await engine.listTakes({ page_id: page!.id });
    expect(takes).toHaveLength(2);
    expect(new Set(takes.map(t => t.claim)))
      .toEqual(new Set(['concurrent claim alpha', 'concurrent claim beta']));

    // ...and in the markdown, with exactly ONE fence (no torn/duplicated
    // fence from an unserialized read-modify-write).
    const md = readFileSync(pageFile(LOCK_SLUG), 'utf-8');
    expect(md).toContain('concurrent claim alpha');
    expect(md).toContain('concurrent claim beta');
    expect(md.split(TAKES_FENCE_BEGIN).length - 1).toBe(1);
  }, 30_000);

  test('a lock held past the 2s op budget → unavailable + detail retryable (page_locked)', async () => {
    // Hold the REAL lock (same default lock root the op resolves) so the
    // op's 2000ms acquire budget deterministically expires.
    const held = await acquirePageLock(LOCK_HELD_SLUG, { timeoutMs: 0 });
    expect(held).not.toBeNull();
    try {
      const err = await expectOpError(
        opByName('takes_add').handler(ctxOf(), {
          slug: LOCK_HELD_SLUG, claim: 'blocked by holder', kind: 'take', holder: 'garry',
        }),
      );
      expect(err.code).toBe('unavailable');
      expect(err.detail).toBe('retryable');
      expect(err.message).toContain('page lock');
      expect(err.suggestion).toBe('Retry shortly.');
    } finally {
      await held!.release();
    }
    // No row leaked through while the lock was held.
    const engine = getEngine();
    const page = await engine.getPage(LOCK_HELD_SLUG, { sourceId: 'default' });
    expect(await engine.listTakes({ page_id: page!.id })).toHaveLength(0);
  }, 30_000);
});

d('resolved takes are immutable through the ops', () => {
  test('takes_resolve lands the resolution in fence + DB (resolved_by honored for local callers)', async () => {
    const engine = getEngine();
    const added = await opByName('takes_add').handler(ctxOf(), {
      slug: RESOLVED_SLUG, claim: 'Will close the round by Q4', kind: 'bet', holder: 'garry', weight: 0.6,
    }) as { row_num: number };
    expect(added.row_num).toBe(1);

    const result = await opByName('takes_resolve').handler(ctxOf(), {
      slug: RESOLVED_SLUG, row_num: 1, quality: 'correct',
      evidence: 'round closed', value: 25, unit: 'usd', resolved_by: 'garry',
    }) as { slug: string; row_num: number; quality: string; resolved_by: string; mirror_warning?: string };
    expect(result.row_num).toBe(1);
    expect(result.quality).toBe('correct');
    expect(result.resolved_by).toBe('garry');
    expect(result.mirror_warning).toBeUndefined();

    // Fence widened to the 13-column resolved shape.
    const md = readFileSync(pageFile(RESOLVED_SLUG), 'utf-8');
    expect(md).toContain('| correct |');
    expect(md).toContain('round closed');

    // DB mirror carries the full resolution tuple.
    const [row] = await engine.listTakes({ page_id: resolvedPageId, resolved: true });
    expect(row.row_num).toBe(1);
    expect(row.resolved_quality).toBe('correct');
    expect(row.resolved_outcome).toBe(true);
    expect(row.resolved_by).toBe('garry');
    expect(row.resolved_value).toBe(25);
    expect(row.resolved_at).not.toBeNull();
  });

  test('takes_update on a resolved row → invalid_params, suggestion "Supersede instead."', async () => {
    const err = await expectOpError(
      opByName('takes_update').handler(ctxOf(), {
        slug: RESOLVED_SLUG, row_num: 1, weight: 0.9,
      }),
    );
    expect(err.code).toBe('invalid_params');
    expect(err.message).toContain('resolved');
    expect(err.suggestion).toBe('Supersede instead.');
  });

  test('takes_supersede on a resolved row → invalid_params, suggestion "Add a new take instead."', async () => {
    const err = await expectOpError(
      opByName('takes_supersede').handler(ctxOf(), {
        slug: RESOLVED_SLUG, row_num: 1, claim: 'revised claim that must be refused',
      }),
    );
    expect(err.code).toBe('invalid_params');
    expect(err.message).toContain('resolved');
    expect(err.suggestion).toBe('Add a new take instead.');

    // The refusals left the page untouched: still exactly one take row.
    const engine = getEngine();
    const takes = await engine.listTakes({ page_id: resolvedPageId, active: true });
    expect(takes).toHaveLength(1);
    expect(takes[0].weight).toBeCloseTo(0.6, 5);
  });
});

d('takes_supersede closes the old row and links the new one', () => {
  test('old row → active=false + superseded_by pointer; new row appended active; fence struck through', async () => {
    const engine = getEngine();
    const added = await opByName('takes_add').handler(ctxOf(), {
      slug: SUPERSEDE_SLUG, claim: 'Will hit 10M ARR by Q4', kind: 'bet', holder: 'garry', weight: 0.6,
    }) as { row_num: number };
    expect(added.row_num).toBe(1);

    // No kind/holder/weight overrides: kind+holder inherit, weight decays 0.1.
    const result = await opByName('takes_supersede').handler(ctxOf(), {
      slug: SUPERSEDE_SLUG, row_num: 1, claim: 'Will hit 8M ARR by Q4 (revised)',
    }) as { slug: string; old_row: number; new_row: number; mirror_warning?: string };
    expect(result.old_row).toBe(1);
    expect(result.new_row).toBe(2);
    expect(result.mirror_warning).toBeUndefined();

    // DB: the real columns. Old row closed + linked, new row active.
    const inactive = await engine.listTakes({ page_id: supersedePageId, active: false });
    expect(inactive).toHaveLength(1);
    expect(inactive[0].row_num).toBe(1);
    expect(inactive[0].active).toBe(false);
    expect(inactive[0].superseded_by).toBe(2);
    expect(inactive[0].claim).toBe('Will hit 10M ARR by Q4');

    const active = await engine.listTakes({ page_id: supersedePageId, active: true });
    expect(active).toHaveLength(1);
    expect(active[0].row_num).toBe(2);
    expect(active[0].claim).toBe('Will hit 8M ARR by Q4 (revised)');
    expect(active[0].kind).toBe('bet');       // inherited
    expect(active[0].holder).toBe('garry');   // inherited
    expect(active[0].weight).toBeCloseTo(0.5, 2); // 0.6 decayed by 0.1
    expect(active[0].superseded_by).toBeNull();

    // Markdown archaeology: old claim struck through, replacement active.
    const md = readFileSync(pageFile(SUPERSEDE_SLUG), 'utf-8');
    expect(md).toContain('~~Will hit 10M ARR by Q4~~');
    expect(md).toContain('| 2 | Will hit 8M ARR by Q4 (revised) |');
  });
});
