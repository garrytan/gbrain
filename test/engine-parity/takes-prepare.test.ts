/**
 * BrainEngine parity — whole takes writes (operations takes_add, takes_resolve, takes_supersede, takes_remove), the takes
 * publication's prepare step end to end (src/core/persistence/takes-prepare.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: takes_add on an existing page publishes the row (row 1, then row 2) into the page's takes fence and the
 *    takes table, with the request's holders recorded; takes_resolve grades a row and keeps the requested resolution date;
 *    takes_supersede strikes the old row and adds its replacement; takes_remove drops a row from the fence and the table.
 *    The answers and the stored rows are equal on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust
 *    arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: the prepare step read and wrote takes and the request's holders with caller raw SQL (seven statements),
 *    which a Rust brain refuses, so every takes write parked there. They now run through the typed members findTakeId,
 *    readTakeTrustRow, recordTakeHoldersUsed, deleteTakeRows and stampTakeResolvedAt, and the recreated fence's hold is
 *    cleared through clearFenceHoldRows (generations/fence.ts).
 *  - Why existing coverage misses it: test/takes-write-ops.test.ts runs on PGLite only, and test/engine-parity/takes.test.ts
 *    drives the takes members one by one, never the publication.
 *  - Seam: none. The handlers run whole on the arm's engine with the persistence consumer they start; rows are read back
 *    with typed reads (listTakes, getPage, readWriteRequest). Ids and times differ between arms, so they are folded out.
 *    Each case asserts its rows on every arm, then runs the write's page projection rebuild to the end. On the Rust arm
 *    that rebuild stops on a typed refusal (page-state/projections.ts selects queued jobs with `executeRaw`), so the Rust
 *    arm ends there, after the takes rows have been checked; the rows themselves land on every arm.
 */
import { afterEach, describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { readLocalWriter } from '../../src/core/persistence/identity.ts';
import { rebuildPendingPageProjections } from '../../src/core/page-state/projections.ts';
import { parseTakesFence } from '../../src/core/takes-fence.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const SRC = 'default';
const SLUG = 'people/alice-example';
const opened: BrainEngine[] = [];

afterEach(async () => {
  for (const engine of opened.splice(0)) await disposePersistenceConsumer(engine).catch(() => undefined);
});

type R = Record<string, unknown>;

/** One whole takes write: the fields the caller reads, or the refusal's code and first message line. */
async function write(ctx: OperationContext, op: string, params: R): Promise<R> {
  try {
    const request_id = randomUUID();
    const r = await operationsByName[op]!.handler(ctx, { slug: SLUG, request_id, ...params }) as R;
    const { slug, row_num, old_row, new_row, removed, quality, holder } = r;
    return { slug, row_num, old_row, new_row, removed, quality, holder, request_id };
  } catch (e) {
    const err = e as { code?: string; message: string; reason?: unknown };
    // An engine refusal reaches the caller with its frozen wire code; turn it back into the typed refusal so the
    // harness counts the case as stopped there.
    if (err.reason !== undefined && err.code !== 'invalid_params') {
      throw Object.assign(new Error(err.message), { code: 'engine_capability_missing', reason: err.reason });
    }
    return { refused: err.code ?? null, message: err.message.split('\n')[0] };
  }
}

/** A write's answer without its request id, and without the fields it does not carry. */
function answer(w: R): R {
  const { request_id: _id, ...rest } = w;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
}
/** One active, unresolved stored take by `world`. */
function take(row_num: number, claim: string) {
  return { row_num, claim, holder: 'world', active: true, superseded_by: null, quality: null, resolved_on: null };
}
/** The holders the prepare step recorded on the write's request (`authority.takeHoldersUsed`). */
async function holdersUsed(engine: BrainEngine, requestId: string) {
  return (await engine.readWriteRequest('local_cli', (await readLocalWriter(engine, 'cli')).id, requestId))?.authority.takeHoldersUsed ?? null;
}
/**
 * The write's page projection rebuild, run to the end. The persistence consumer starts it after the commit and logs a
 * failure; driving it here lets a stop surface. On the Rust arm it stops on a typed refusal: page-state/projections.ts
 * selects queued jobs with caller raw SQL (`executeRaw`), which that engine does not serve.
 */
async function projectionsSettle(engine: BrainEngine) {
  await rebuildPendingPageProjections(engine, 20, { pages: { sourceId: SRC, slugs: [SLUG] } });
}

/** The page's stored takes, by row, without ids and times. */
async function stored(engine: BrainEngine) {
  const page = (await engine.getPage(SLUG, { sourceId: SRC }))!;
  const rows = [...await engine.listTakes({ page_id: page.id, active: true, limit: 50 }), ...await engine.listTakes({ page_id: page.id, active: false, limit: 50 })];
  return rows.map((t) => ({ row_num: t.row_num, claim: t.claim, holder: t.holder, active: t.active, superseded_by: t.superseded_by ?? null,
    quality: t.resolved_quality ?? null, resolved_on: t.resolved_at ? new Date(t.resolved_at).toISOString().slice(0, 10) : null }))
    .sort((a, b) => a.row_num - b.row_num);
}
/** The page's takes fence rows, without the fence's dates. */
async function fence(engine: BrainEngine) {
  const page = (await engine.getPage(SLUG, { sourceId: SRC }))!;
  return parseTakesFence(page.compiled_truth).takes.map((t) => ({ row_num: t.rowNum, claim: t.claim, active: t.active, quality: t.resolvedQuality ?? null }));
}

async function ctxFor(engine: BrainEngine): Promise<OperationContext> {
  await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example body.' }, { sourceId: SRC });
  return { engine, config: { engine: engine.kind, embedding_disabled: true }, logger: quiet, dryRun: false, remote: false, sourceId: SRC } as unknown as OperationContext;
}

describe('engine parity: whole takes writes through the takes prepare step', () => {
  parityTest('takes_add publishes the row into the fence and the takes table', {
    methods: ['findTakeId', 'readTakeTrustRow', 'recordTakeHoldersUsed', 'clearFenceHoldRows', 'addTakesBatch', 'listTakes', 'readWriteRequest', 'getPage'],
    timeout: 180_000,
  }, async (engine) => {
    opened.push(engine);
    const ctx = await ctxFor(engine);
    const first = await write(ctx, 'takes_add', { claim: 'Ships weekly', kind: 'take', holder: 'world', weight: 0.7 });
    const second = await write(ctx, 'takes_add', { claim: 'Prefers small teams', kind: 'take', holder: 'world', weight: 0.6 });
    const holders = await Promise.all([first, second].map((w) => holdersUsed(engine, w.request_id as string)));
    const out = { first: answer(first), second: answer(second), holders, rows: await stored(engine), fence: await fence(engine) };
    expect(out).toEqual({
      first: { slug: SLUG, row_num: 1, holder: 'world' }, second: { slug: SLUG, row_num: 2, holder: 'world' }, holders: [['world'], ['world']],
      rows: [take(1, 'Ships weekly'), take(2, 'Prefers small teams')],
      fence: [{ row_num: 1, claim: 'Ships weekly', active: true, quality: null }, { row_num: 2, claim: 'Prefers small teams', active: true, quality: null }],
    });
    await projectionsSettle(engine);
    return out;
  });

  parityTest('takes_resolve, takes_supersede and takes_remove change the rows they name', {
    methods: ['findTakeId', 'readTakeTrustRow', 'resolveTake', 'stampTakeResolvedAt', 'deleteTakeRows', 'listTakes', 'getPage'],
    timeout: 180_000,
  }, async (engine) => {
    opened.push(engine);
    const ctx = await ctxFor(engine);
    for (const claim of ['Ships weekly', 'Prefers small teams', 'Hires slowly']) await write(ctx, 'takes_add', { claim, kind: 'take', holder: 'world' });
    const resolved = await write(ctx, 'takes_resolve', { row_num: 1, quality: 'correct', evidence: 'parity notes 2026-11-20' });
    const superseded = await write(ctx, 'takes_supersede', { row_num: 2, claim: 'Prefers teams under ten' });
    const removed = await write(ctx, 'takes_remove', { row_num: 3 });
    expect(removed).toMatchObject({ row_num: 3, removed: true });
    const rows = await stored(engine);
    const today = new Date().toISOString().slice(0, 10);
    const out = { resolved: answer(resolved), superseded: answer(superseded), removed: answer(removed), rows, fence: await fence(engine) };
    expect(out).toEqual({
      resolved: { slug: SLUG, row_num: 1, quality: 'correct' }, superseded: { slug: SLUG, old_row: 2, new_row: 4 },
      removed: { slug: SLUG, row_num: 3, removed: true },
      rows: [{ ...take(1, 'Ships weekly'), quality: 'correct', resolved_on: today }, { ...take(2, 'Prefers small teams'), active: false, superseded_by: 4 },
        take(4, 'Prefers teams under ten')],
      fence: [{ row_num: 1, claim: 'Ships weekly', active: true, quality: 'correct' }, { row_num: 2, claim: 'Prefers small teams', active: false, quality: null },
        { row_num: 4, claim: 'Prefers teams under ten', active: true, quality: null }],
    });
    await projectionsSettle(engine);
    return out;
  });
});
