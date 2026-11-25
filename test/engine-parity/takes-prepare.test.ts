/**
 * BrainEngine parity — whole takes writes through MCP (takes_add, takes_update, takes_resolve, takes_supersede,
 * takes_remove): the takes publication's prepare step end to end (src/core/persistence/takes-prepare.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: over the MCP dispatcher (stdio transport, a registered local writer), takes_add publishes rows 1, 2 and
 *    3 into the page's takes fence and the takes table and records the request's holders; takes_update changes a
 *    row's weight; takes_resolve grades a row and stores today's date as its resolution date; takes_supersede strikes the old row and
 *    adds its replacement; takes_remove drops a row from the fence and the table. The MCP answers, the stored rows, the
 *    fence and the recorded holders are equal on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust
 *    arm with GBRAIN_TEST_RUST_ARM=1), with only the per-write revision ids folded out.
 *  - Regression: the prepare step checked the allocated row, recorded the request's holders, deleted the removed row
 *    and stamped resolved_at with caller raw SQL, which a Rust brain refuses, so every takes write stopped there. They
 *    now run through the typed members findTakeId, recordTakeHoldersUsed, deleteTakeRows and stampTakeResolvedAt
 *    (carried from 098c048ad6, rust-engine/takes-prepare-rust). A remote takes_update, takes_resolve or takes_supersede
 *    also read the named rows' holders with raw SQL in its authority check (persistence/authority.ts), so on Rust it
 *    stayed queued; that read is now listTakeHoldersAtRows.
 *  - Why existing coverage misses it: test/takes-write-ops.test.ts runs on PGLite only, and
 *    test/engine-parity/takes.test.ts drives the takes members one by one, never the publication.
 *  - Seam: none. The real MCP dispatcher, the persistence consumer it starts, and typed reads back (listTakes,
 *    getPage, readWriteRequest).
 */
import { afterEach, describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { readLocalWriter, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { parseTakesFence } from '../../src/core/takes-fence.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());
const SRC = 'default';
const SLUG = 'people/alice-example';
const opened: BrainEngine[] = [];

afterEach(async () => {
  for (const engine of opened.splice(0)) await disposePersistenceConsumer(engine).catch(() => undefined);
});

type R = Record<string, unknown>;

/** The answer as the MCP caller reads it, with the per-write revision and request ids and the row times folded out. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as R).filter(([k]) => !['revision', 'request_id', 'created_at', 'updated_at'].includes(k)).map(([k, v]) => [k, stable(v)]));
  }
  return value;
}

/** Request ids, fixed per write so each arm sends the same ones. */
const ids = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** One MCP takes write: the parsed answer, or the refusal's code (an engine refusal is rethrown typed). */
async function write(engine: BrainEngine, op: string, n: number, params: R): Promise<unknown> {
  const result = await dispatchToolCall(engine, op, { slug: SLUG, request_id: ids(n), ...params }, { remote: true, transport: 'stdio', sourceId: SRC } as never);
  const text = result.content.map(part => (part as { text?: string }).text ?? '').join('');
  const body = JSON.parse(text) as R;
  if (result.isError) {
    if (body.code === 'engine_capability_missing') throw Object.assign(new Error(String(body.message)), { code: 'engine_capability_missing', reason: body.reason ?? body.detail });
    return { refused: body.code, message: String(body.message).split('\n')[0] };
  }
  return stable(body);
}

/** The holders the prepare step recorded on a request (`authority.takeHoldersUsed`). */
async function holdersUsed(engine: BrainEngine, n: number) {
  return (await engine.readWriteRequest('local_stdio', (await readLocalWriter(engine, 'stdio')).id, ids(n)))?.authority.takeHoldersUsed ?? null;
}

/** The page's stored takes, by row, without ids and times (the resolution date kept). */
async function stored(engine: BrainEngine) {
  const page = (await engine.getPage(SLUG, { sourceId: SRC }))!;
  const rows = [...await engine.listTakes({ page_id: page.id, active: true, limit: 50 }), ...await engine.listTakes({ page_id: page.id, active: false, limit: 50 })];
  return rows.map(t => ({ row_num: t.row_num, claim: t.claim, holder: t.holder, weight: t.weight, active: t.active, superseded_by: t.superseded_by ?? null,
    quality: t.resolved_quality ?? null, resolved_on: t.resolved_at ? new Date(t.resolved_at).toISOString().slice(0, 10) : null }))
    .sort((a, b) => a.row_num - b.row_num);
}

/** The page's takes fence rows, without the fence's dates. */
async function fence(engine: BrainEngine) {
  const page = (await engine.getPage(SLUG, { sourceId: SRC }))!;
  return parseTakesFence(page.compiled_truth).takes.map(t => ({ row_num: t.rowNum, claim: t.claim, weight: t.weight, active: t.active, quality: t.resolvedQuality ?? null }));
}

/** A registered stdio writer and the page, then takes_add of `claims` (request ids 1..n) with holder `world`. */
async function seed(engine: BrainEngine, claims: string[]): Promise<unknown[]> {
  opened.push(engine);
  await registerLocalWriter(engine, 'cli');
  await registerLocalWriter(engine, 'stdio');
  await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example body.' }, { sourceId: SRC });
  const added: unknown[] = [];
  for (const [i, claim] of claims.entries()) added.push(await write(engine, 'takes_add', i + 1, { claim, kind: 'take', holder: 'world', weight: 0.7 }));
  return added;
}

const pick = (a: unknown, keys: string[]) => Object.fromEntries(keys.map(k => [k, (a as R)[k]]));
const row = (row_num: number, claim: string, extra: Partial<Awaited<ReturnType<typeof stored>>[number]> = {}) =>
  ({ row_num, claim, holder: 'world', weight: 0.7, active: true, superseded_by: null, quality: null, resolved_on: null, ...extra });

describe('engine parity: whole takes writes through MCP and the takes prepare step', () => {
  parityTest('takes_add publishes rows 1 and 2 into the fence and the table, with the holders recorded',
    { methods: ['findTakeId', 'recordTakeHoldersUsed', 'addTakesBatch', 'listTakes', 'getPage', 'readWriteRequest'], timeout: 120_000 }, async (engine) => {
    const added = await seed(engine, ['Ships weekly', 'Prefers small teams']);
    const out = { added, holders: [await holdersUsed(engine, 1), await holdersUsed(engine, 2)], rows: await stored(engine), fence: await fence(engine) };
    expect({ added: added.map(a => pick(a, ['row_num', 'holder'])), holders: out.holders, rows: out.rows }).toEqual({
      added: [{ row_num: 1, holder: 'world' }, { row_num: 2, holder: 'world' }], holders: [['world'], ['world']],
      rows: [row(1, 'Ships weekly'), row(2, 'Prefers small teams')],
    });
    return out;
  });

  parityTest('takes_update changes the row\'s weight',
    { methods: ['findTakeId', 'recordTakeHoldersUsed', 'addTakesBatch', 'listTakes', 'getPage', 'readWriteRequest', 'listTakeHoldersAtRows'], timeout: 120_000 }, async (engine) => {
    await seed(engine, ['Ships weekly']);
    const updated = await write(engine, 'takes_update', 10, { row_num: 1, weight: 0.4 });
    const out = { updated, holders: await holdersUsed(engine, 10), rows: await stored(engine), fence: await fence(engine) };
    expect({ updated: pick(updated, ['row_num']), holders: out.holders, rows: out.rows }).toEqual({ updated: { row_num: 1 }, holders: ['world'], rows: [row(1, 'Ships weekly', { weight: 0.4 })] });
    return out;
  });

  parityTest('takes_resolve grades the row and stores today as its resolution date',
    { methods: ['findTakeId', 'recordTakeHoldersUsed', 'addTakesBatch', 'listTakes', 'getPage', 'resolveTake', 'stampTakeResolvedAt', 'listTakeHoldersAtRows'], timeout: 120_000 }, async (engine) => {
    await seed(engine, ['Ships weekly']);
    const resolved = await write(engine, 'takes_resolve', 10, { row_num: 1, quality: 'correct', evidence: 'parity notes' });
    // takes_resolve stamps today's date (UTC).
    const today = new Date().toISOString().slice(0, 10);
    const out = { resolved, rows: await stored(engine), fence: await fence(engine) };
    expect({ resolved: pick(resolved, ['row_num', 'quality']), rows: out.rows }).toEqual({
      resolved: { row_num: 1, quality: 'correct' }, rows: [row(1, 'Ships weekly', { quality: 'correct', resolved_on: today })] });
    return out;
  });

  parityTest('takes_supersede strikes the old row and adds its replacement',
    { methods: ['findTakeId', 'recordTakeHoldersUsed', 'addTakesBatch', 'listTakes', 'getPage', 'listTakeHoldersAtRows'], timeout: 120_000 }, async (engine) => {
    await seed(engine, ['Prefers small teams']);
    const superseded = await write(engine, 'takes_supersede', 10, { row_num: 1, claim: 'Prefers teams under ten' });
    const out = { superseded, rows: await stored(engine), fence: await fence(engine) };
    expect({ superseded: pick(superseded, ['old_row', 'new_row']), rows: out.rows }).toEqual({
      superseded: { old_row: 1, new_row: 2 },
      rows: [row(1, 'Prefers small teams', { active: false, superseded_by: 2 }), row(2, 'Prefers teams under ten', { weight: 0.6 })] });
    return out;
  });

  parityTest('takes_remove drops the row from the fence and the table',
    { methods: ['findTakeId', 'recordTakeHoldersUsed', 'addTakesBatch', 'listTakes', 'getPage', 'deleteTakeRows'], timeout: 120_000 }, async (engine) => {
    await seed(engine, ['Ships weekly', 'Hires slowly']);
    const removed = await write(engine, 'takes_remove', 10, { row_num: 2 });
    const out = { removed, rows: await stored(engine), fence: await fence(engine) };
    expect({ removed: pick(removed, ['row_num', 'removed']), rows: out.rows, fence: out.fence.map(f => f.row_num) }).toEqual({
      removed: { row_num: 2, removed: true }, rows: [row(1, 'Ships weekly')], fence: [1] });
    return out;
  });
});
