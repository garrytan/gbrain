/**
 * The SQL the fact purge's derivation sweep (page-body/segment-derive.ts `continueDerivationPurges`) sends to PGLite and Postgres
 * is pinned byte for byte: every statement the sweep sends, in the order a run first sends it, with its parameter count, against
 * test/fixtures/goldens/derivation-sweep-sql.json. The sweep became a typed engine member (`continueDerivationSweep`) so the Rust
 * engine can serve it; the SQL engines keep this SQL as it was, and this pin fails if one statement changes by a character.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: six runs on PGLite drive every statement of the sweep: a full walk to the record's deletion; a walk whose end finds
 *    noted pages and checks them again; a walk whose end cannot take the scope lock (for good, and once); a batch that outruns its budget (halved, then
 *    one row deleted unread, a paid row stalling the record, an unread delete that outruns it too); and a retry of a stalled record.
 *  - Regression: moving the walk behind the engine member rewrote a statement, so the Postgres arm ran SQL the PGLite arm did not.
 *  - Why existing coverage misses it: the large-page sweep suites check what the sweep does to rows, not what it sends.
 *  - Seam: the engine handed to `continueDerivationPurges` is wrapped to record `executeRaw` text (and the transactions' handles);
 *    the fault points `purge:derivation_batch`, `purge:derivation_unread` and `purge:derivation_scope_lock` model the budget and
 *    the lock. Regenerate with GBRAIN_TEST_UPDATE_GOLDENS=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { DERIVATION_SWEEP_LIMITS, recordDerivationPurge, runDerivationSweep } from '../src/core/page-body/segment-derive.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { publishSegmentedPage, segmentText } from './helpers/page-body-fixtures.ts';

const GOLDEN = join(import.meta.dir, 'fixtures/goldens/derivation-sweep-sql.json');
const CLAIM = 'Alice likes tea';
const RAW = ['executeRaw', 'executeRawDirect'];
const timeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
const lockBusy = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

/** Every statement text (with its parameter count) the sweep sent, first occurrence only, in the order sent. */
const sent = new Map<string, true>();
function recording<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        if (RAW.includes(prop)) sent.set(`${(args[1] as unknown[] | undefined)?.length ?? 0}\u0000${String(args[0])}`, true);
        if ((prop === 'transaction' || prop === 'transactionDirect') && typeof args[0] === 'function') {
          const fn = args[0] as (tx: object) => unknown;
          args = [(tx: object) => fn(recording(tx)), ...args.slice(1)];
        }
        return (value as (...a: unknown[]) => unknown).apply(obj, args);
      };
    },
  });
}

let sequence = 0;
const request = () => `e0000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

/** A page of three segments with derivation rows: two unpaid rows and a paid one that hold the claim, and a harmless one. */
async function seed(slug: string, extra: { paid?: boolean } = {}): Promise<{ pageId: number }> {
  const texts = [segmentText(`# ${slug} one\nfirst\n`), segmentText(`## ${slug} two\nsecond\n`), segmentText(`## ${slug} three\nthird\n`)];
  const page = await publishSegmentedPage(engine, slug, texts);
  const row = (kind: 'links' | 'timeline' | 'synopsis', at: number, output: unknown) =>
    ({ pageId: page.pageId, kind, occurrenceId: page.occurrences[at]!, version: 1, segmentSha256: texts[at]!.sha256, contextHash: new Uint8Array(32).fill(at + 1), state: 'done' as const, output, receipt: {} });
  await engine.upsertSegmentDerivations([
    row('links', 0, { excerpt: 'Alice likes tea' }), row('links', 1, { excerpt: 'unrelated' }), row('timeline', 0, { excerpt: 'Alice likes tea' }),
    ...(extra.paid ? [row('synopsis', 2, { text: 'Alice likes tea' })] : []),
  ]);
  return { pageId: page.pageId };
}
const begin = async (id: string, pageId: number) => { await engine.transaction(tx => recordDerivationPurge(tx, id, 'default', [pageId], [CLAIM])); };
const remaining = async (id: string) => (await engine.executeRaw('SELECT 1 FROM page_segment_derivation_purges WHERE request_id=$1::uuid', [id])).length;
let limits: { -readonly [K in keyof typeof DERIVATION_SWEEP_LIMITS]: number } = { ...DERIVATION_SWEEP_LIMITS };
let afterBatch: (() => Promise<void>) | undefined;
const bound = (change: Partial<typeof limits>) => { limits = { ...DERIVATION_SWEEP_LIMITS, ...change }; };
/** The SQL engines' sweep, run on the recording engine (the engine member calls it with itself). */
const sweep = (opts: { first?: string; retry?: string } = {}) => runDerivationSweep(recording(engine) as BrainEngine, 'default', opts, limits, { afterBatch });

async function runAll(): Promise<void> {
  sent.clear();
  try {
    // 1. A full walk in batches of two rows: pick, batch, cursor, the move to the verify walk, the lock, the end of the record.
    bound({ batchRows: 2 });
    const walk = request();
    await begin(walk, (await seed('notes/pin-walk', { paid: true })).pageId);
    await sweep({ first: walk });
    expect(await remaining(walk)).toBe(0);

    // 2. A note of a page that entered the scope during the verify walk: the end finds it and checks its page again.
    bound({ batchRows: 1 });
    const noted = request();
    const { pageId } = await seed('notes/pin-noted');
    await begin(noted, pageId);
    let noteWritten = false;
    afterBatch = async () => {
      const [state] = await engine.executeRaw<{ phase: string }>('SELECT phase FROM page_segment_derivation_purges WHERE request_id=$1::uuid', [noted]);
      if (state?.phase === 'verify' && !noteWritten) {
        noteWritten = true;
        await engine.executeRaw('INSERT INTO page_segment_derivation_purge_pages (request_id, page_id) VALUES ($1::uuid, $2)', [noted, pageId]);
      }
    };
    await sweep({ first: noted });
    afterBatch = undefined;
    expect(noteWritten).toBe(true);
    expect(await remaining(noted)).toBe(0);

    // 3. The end of a walk cannot take the scope lock: the record waits at the end of its walk, marked busy, and a later call ends it.
    bound({ batchRows: 10, totalMs: 0 });
    const busy = request();
    await begin(busy, (await seed('notes/pin-busy')).pageId);
    installFaultHook(point => { if (point === 'purge:derivation_scope_lock') throw lockBusy(); });
    try { for (let call = 0; call < 4; call++) await sweep({ first: busy }); } finally { installFaultHook(undefined); }
    expect(await remaining(busy)).toBe(1);
    for (let call = 0; call < 6 && await remaining(busy); call++) await sweep({ first: busy });
    expect(await remaining(busy)).toBe(0);

    // ... and when the lock is free by the time the record waits for it: the record is read again under it and the walk ends there.
    bound({ batchRows: 10, totalMs: 60_000 });
    const freed = request();
    await begin(freed, (await seed('notes/pin-freed')).pageId);
    let tries = 0;
    installFaultHook(point => { if (point === 'purge:derivation_scope_lock' && tries++ === 0) throw lockBusy(); });
    try { await sweep({ first: freed }); } finally { installFaultHook(undefined); }
    expect(await remaining(freed)).toBe(0);

    // 4. A batch that outruns its budget: halved to one row, then the row deleted unread, a paid row stalling the record.
    bound({ batchRows: 4, totalMs: 60_000 });
    const paid = request();
    await begin(paid, (await seed('notes/pin-paid', { paid: true })).pageId);
    installFaultHook(point => { if (point === 'purge:derivation_batch') throw timeout(); });
    try { await sweep({ first: paid }); } finally { installFaultHook(undefined); }
    const [stalled] = await engine.executeRaw<{ stalled_reason: string }>('SELECT stalled_reason FROM page_segment_derivation_purges WHERE request_id=$1::uuid', [paid]);
    expect(stalled?.stalled_reason).toBe('paid_row_unreadable');
    // ... and a retry of the stalled record clears the stall (the walk stalls again on the same row).
    installFaultHook(point => { if (point === 'purge:derivation_batch') throw timeout(); });
    try { await sweep({ first: paid, retry: paid }); } finally { installFaultHook(undefined); }

    // 5. The unread delete outruns the budget too: the record stalls on the statement timeout.
    bound({ batchRows: 1, totalMs: 60_000 });
    const slow = request();
    await begin(slow, (await seed('notes/pin-slow')).pageId);
    installFaultHook(point => { if (point === 'purge:derivation_batch' || point === 'purge:derivation_unread') throw timeout(); });
    try { await sweep({ first: slow }); } finally { installFaultHook(undefined); }
    const [slowed] = await engine.executeRaw<{ stalled_reason: string }>('SELECT stalled_reason FROM page_segment_derivation_purges WHERE request_id=$1::uuid', [slow]);
    expect(slowed?.stalled_reason).toBe('statement_timeout');
  } finally {
    installFaultHook(undefined);
    afterBatch = undefined;
    bound({});
  }
}

describe('the derivation sweep sends the SQL it always sent', () => {
  test('every statement of the sweep is pinned byte for byte', async () => {
    await runAll();
    const statements = [...sent.keys()].map(key => { const at = key.indexOf('\u0000'); return { params: Number(key.slice(0, at)), text: key.slice(at + 1) }; });
    expect(statements.length).toBeGreaterThan(20);
    if (process.env.GBRAIN_TEST_UPDATE_GOLDENS === '1' || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, `${JSON.stringify({ statements }, null, 2)}\n`);
      return;
    }
    const pinned = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { statements: Array<{ params: number; text: string }> };
    expect(statements).toEqual(pinned.statements);
  }, 300_000);
});
