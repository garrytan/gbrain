/**
 * BrainEngine parity — trust family: the write gate's receipts (`write_gate_receipts`) and holds (`write_gate_holds`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: recording a receipt on a row or a live page, clearing a page's stale receipts, listing one row's
 *    receipts, pruning old receipts, recording a hold, listing and reading holds, and deciding a hold return the same
 *    observable result on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that adds a second receipt or hold where the old one must be updated, that forgets the
 *    seen count or reopens a decided hold wrongly, that lists receipts or holds in another order, that ignores a
 *    filter, or that prunes the receipt of a row still held: `gbrain quarantine list` and `gbrain trust explain`
 *    would show wrong or missing records, and a release could act on a hold twice.
 *  - Why existing coverage misses it: the write gate tests drive these statements through `executeRaw` on PGLite
 *    alone; no case compares engines.
 *  - The allow-rule case: the fresh-brain case lists no allow rule through `listTrustAllowRuleRows` on every arm. The case that adds
 *    rules through `trust allow` (trust/allow-rules.ts) is not in this cut: its caller still runs its own SQL, so the member would not be called.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18). Ids differ between arms, so each case
 *    returns ids as positions in the list of ids it created, and times only as their shape.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { listTrustAllowRules } from '../../src/core/trust/allow-rules.ts';
import { waitFor } from '../helpers/wait-for.ts';
import type { WriteGateHoldRow, WriteGateReceiptFields, WriteGateReceiptRow } from '../../src/core/engine-sql/trust-write-gate.ts';

const { parityTest } = parityArms(testBackends());

/**
 * PGLite's now() moves in whole milliseconds, so two quick writes can share a last_seen_at and fall back to the id
 * order. Waiting for the clock to move first makes "newest first" mean the same on every arm.
 */
const nextMillisecond = async () => {
  const t = Date.now();
  await waitFor(() => Date.now() > t + 1, { intervalMs: 1, label: 'the clock moved' });
};

const PAGE = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, timeline: '' });

const fields = (hash: string, over: Partial<WriteGateReceiptFields> = {}): WriteGateReceiptFields => ({
  content_hash: hash, tier: 'agent_written', detector_version: 1, verdict: 'flag', reason_families: ['standing_instruction'],
  reasons: ['looks like a standing instruction'], detector_error: false, request_id: null, ...over,
});

/** Ids as positions in `ids`, so arms with different sequences compare equal. */
const labeler = (ids: number[]) => (id: number | null) => (id === null ? null : ids.indexOf(id) >= 0 ? ids.indexOf(id) : (ids.push(id), ids.length - 1));

const receiptView = (label: ReturnType<typeof labeler>) => (r: WriteGateReceiptRow) => ({
  id: label(r.id), verdict: r.verdict, reason_families: r.reason_families, detector_version: r.detector_version, tier: r.tier,
  dates: r.created_at instanceof Date && r.last_seen_at instanceof Date && r.last_seen_at.getTime() >= r.created_at.getTime(),
});

const holdView = (label: ReturnType<typeof labeler>) => (h: WriteGateHoldRow) => ({
  ...h, id: label(h.id), created_at: h.created_at instanceof Date, last_seen_at: h.last_seen_at instanceof Date && h.last_seen_at >= h.created_at,
  decided_at: h.decided_at === null ? null : h.decided_at instanceof Date,
});

const hold = (over: Record<string, unknown> = {}) => ({
  kind: 'fact' as 'fact' | 'take', source_id: 'default', slug: 'people/alice-example', fingerprint: 'fp-1', detector_version: 1,
  tier: 'agent_written', reason_families: ['prompt_injection'], reasons: ['ignore previous instructions'], detector_error: false,
  payload: { fact: 'Alice likes tea', kind: 'preference' } as Record<string, unknown>, write_origin: { agent: 'agent-fork' } as Record<string, unknown> | null,
  request_id: 'req-1' as string | null, ...over,
});

describe('engine parity: write gate receipts and holds', () => {
  parityTest(
    'upsertWriteGateReceipt updates the receipt with the same key and listWriteGateReceiptsFor lists newest first',
    { methods: ['upsertWriteGateReceipt', 'listWriteGateReceiptsFor'] },
    async (engine) => {
      const ids: number[] = [];
      const label = labeler(ids);
      const put = async (targetId: string, f: WriteGateReceiptFields) => {
        await nextMillisecond();
        return engine.upsertWriteGateReceipt({ target_table: 'facts', target_id: targetId, source_id: 'default', ...f });
      };
      const a = label(await put('7', fields('h1', { request_id: 'req-a' })));
      const b = label(await put('7', fields('h2', { verdict: 'quarantine', reason_families: ['prompt_injection'] })));
      const c = label(await put('7', fields('h1', { detector_version: 2 })));
      label(await put('8', fields('h1')));
      // Same key as `a`: the same id, the new verdict and reasons, and it becomes the newest.
      const again = label(await put('7', fields('h1', { verdict: 'quarantine', tier: 'external_untrusted', reason_families: ['secret'] })));
      const list = (await engine.listWriteGateReceiptsFor('facts', '7', 10)).map(receiptView(label));
      const top = (await engine.listWriteGateReceiptsFor('facts', '7', 1)).map(receiptView(label));
      expect(again).toBe(a);
      // Absolute answers, so an engine that is wrong the same way on every arm still fails: newest first, the updated row on top.
      expect(list.map(r => r.id)).toEqual([a, c, b]);
      expect(top.map(r => r.id)).toEqual([a]);
      expect(list[0]).toMatchObject({ verdict: 'quarantine', tier: 'external_untrusted', reason_families: ['secret'] });
      return { a, b, c, again, list, top, other: (await engine.listWriteGateReceiptsFor('takes', '7', 10)).length };
    },
  );

  parityTest(
    'upsertPageWriteGateReceipt records on a live page only and deleteStalePageWriteGateReceipts keeps the current hash',
    { methods: ['putPage', 'getPage', 'softDeletePage', 'upsertPageWriteGateReceipt', 'deleteStalePageWriteGateReceipts', 'listWriteGateReceiptsFor'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      await engine.putPage('notes/live', PAGE('Live', 'a body'));
      await engine.putPage('notes/gone', PAGE('Gone', 'a body'));
      const live = String((await engine.getPage('notes/live'))!.id);
      const gone = String((await engine.getPage('notes/gone'))!.id);
      const ids: number[] = [];
      const label = labeler(ids);
      const first = label(await engine.upsertPageWriteGateReceipt('default', 'notes/live', fields('h1')));
      await nextMillisecond();
      const second = label(await engine.upsertPageWriteGateReceipt('default', 'notes/live', fields('h2')));
      await nextMillisecond();
      const repeat = label(await engine.upsertPageWriteGateReceipt('default', 'notes/live', fields('h1', { verdict: 'quarantine' })));
      label(await engine.upsertPageWriteGateReceipt('default', 'notes/gone', fields('h1')));
      const missing = await engine.upsertPageWriteGateReceipt('default', 'notes/missing', fields('h1'));
      const otherSource = await engine.upsertPageWriteGateReceipt('work', 'notes/live', fields('h1'));
      await engine.softDeletePage('notes/gone');
      const deleted = await engine.upsertPageWriteGateReceipt('default', 'notes/gone', fields('h9'));
      const rows = async (pageId: string) => (await engine.listWriteGateReceiptsFor('pages', pageId, 10)).map(receiptView(label));
      const before = await rows(live);
      await engine.deleteStalePageWriteGateReceipts('default', 'notes/live', 'h2');
      const afterKeep = await rows(live);
      // A soft-deleted page still has its stale receipts cleared; a null hash clears every receipt.
      await engine.deleteStalePageWriteGateReceipts('default', 'notes/gone', null);
      await engine.deleteStalePageWriteGateReceipts('work', 'notes/live', null);
      expect({ missing, otherSource, deleted }).toEqual({ missing: null, otherSource: null, deleted: null });
      expect(before.map(r => r.id)).toEqual([first, second]);
      expect(afterKeep.map(r => r.id)).toEqual([second]);
      return { first, second, repeat, missing, otherSource, deleted, before, afterKeep, gone: await rows(gone), liveAfter: await rows(live) };
    },
  );

  parityTest(
    'deleteStaleWriteGateReceipts deletes old receipts but keeps the receipts of held holds',
    { methods: ['upsertWriteGateReceipt', 'upsertWriteGateHold', 'decideWriteGateHold', 'deleteStaleWriteGateReceipts', 'listWriteGateReceiptsFor'] },
    async (engine) => {
      const held = await engine.upsertWriteGateHold(hold());
      const dropped = await engine.upsertWriteGateHold(hold({ fingerprint: 'fp-2' }));
      expect(await engine.decideWriteGateHold(dropped, 'dropped', 'owner')).toBe(true);
      const receipt = (table: 'facts' | 'write_gate_holds', id: string) => engine.upsertWriteGateReceipt({ target_table: table, target_id: id, source_id: 'default', ...fields('h1') });
      await receipt('facts', '1');
      await receipt('write_gate_holds', String(held));
      await receipt('write_gate_holds', String(dropped));
      const count = async (table: string, id: string) => (await engine.listWriteGateReceiptsFor(table, id, 10)).length;
      const none = await engine.deleteStaleWriteGateReceipts(36500);
      const all = await engine.deleteStaleWriteGateReceipts(-1);
      const out = {
        none, all, again: await engine.deleteStaleWriteGateReceipts(-1),
        fact: await count('facts', '1'), held: await count('write_gate_holds', String(held)), dropped: await count('write_gate_holds', String(dropped)),
      };
      expect(out).toEqual({ none: 0, all: 2, again: 0, fact: 0, held: 1, dropped: 0 });
      return out;
    },
  );

  parityTest(
    'upsertWriteGateHold reopens the hold with the same key; get, list filters and decide agree',
    { methods: ['upsertWriteGateHold', 'getWriteGateHoldRow', 'listWriteGateHoldRows', 'decideWriteGateHold'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const ids: number[] = [];
      const label = labeler(ids);
      const a = await engine.upsertWriteGateHold(hold());
      const b = await engine.upsertWriteGateHold(hold({ kind: 'take', fingerprint: 'fp-take', payload: { claim: 'A take' }, write_origin: null, request_id: null }));
      const c = await engine.upsertWriteGateHold(hold({ source_id: 'work', slug: '', fingerprint: 'fp-work' }));
      const d = await engine.upsertWriteGateHold(hold({ detector_version: 2 }));
      label(a); label(b); label(c); label(d);
      // Same key as `a`: the same id, seen twice, kind kept, the new tier, payload and reasons; a null request id keeps the old one.
      const a2 = await engine.upsertWriteGateHold(hold({ kind: 'take', tier: 'external_untrusted', payload: { fact: 'Alice likes coffee' }, reasons: ['other'], request_id: null }));
      const reopened = await engine.getWriteGateHoldRow(a2);
      const decided = {
        release: await engine.decideWriteGateHold(a, 'released', 'owner'),
        twice: await engine.decideWriteGateHold(a, 'dropped', 'owner'),
        missing: await engine.decideWriteGateHold(Math.max(a, b, c, d) + 1000, 'dropped', 'owner'),
        drop: await engine.decideWriteGateHold(b, 'dropped', 'agent'),
      };
      const released = await engine.getWriteGateHoldRow(a);
      // Seen again after release: held again, decision cleared, seen three times.
      await engine.upsertWriteGateHold(hold({ request_id: 'req-3' }));
      const view = holdView(label);
      expect(view(reopened!)).toMatchObject({ id: 0, seen_count: 2, status: 'held' });
      expect(view((await engine.getWriteGateHoldRow(a))!)).toMatchObject({ id: 0, seen_count: 3, status: 'held', decided_at: null });
      expect(await engine.getWriteGateHoldRow(Math.max(a, b, c, d) + 1000)).toBeNull();
      const list = async (opts: Parameters<typeof engine.listWriteGateHoldRows>[0]) => (await engine.listWriteGateHoldRows(opts)).map(h => label(h.id));
      expect(await list({ status: 'all', limit: 100 })).toEqual([3, 2, 1, 0]); // newest id first
      expect(await list({ status: 'held', limit: 100 })).toEqual([3, 2, 0]);
      return {
        same: label(a2) === label(a),
        reopened: reopened && view(reopened), released: released && view(released), after: view((await engine.getWriteGateHoldRow(a))!),
        missing: await engine.getWriteGateHoldRow(Math.max(a, b, c, d) + 1000),
        decided,
        held: await list({ status: 'held', limit: 100 }),
        all: await list({ status: 'all', limit: 100 }),
        dropped: await list({ status: 'dropped', limit: 100 }),
        takes: await list({ status: 'all', kind: 'take', limit: 100 }),
        work: await list({ status: 'all', sourceId: 'work', limit: 100 }),
        sourceIds: await list({ status: 'all', sourceIds: ['default'], sourceId: 'work', limit: 100 }),
        before: await list({ status: 'all', beforeId: c, limit: 100 }),
        limited: await list({ status: 'all', limit: 2 }),
        rows: (await engine.listWriteGateHoldRows({ status: 'all', limit: 100 })).map(view),
      };
    },
  );

  parityTest('listTrustAllowRuleRows lists no allow rule on a fresh brain, removed ones included', { methods: ['listTrustAllowRuleRows'] }, async (engine) => {
    const out = { active: await listTrustAllowRules(engine), withRemoved: await listTrustAllowRules(engine, { includeRemoved: true }),
      source: await listTrustAllowRules(engine, { sourceIds: ['default'] }), rows: await engine.listTrustAllowRuleRows() };
    expect(out).toEqual({ active: [], withRemoved: [], source: [], rows: [] });
    return out;
  });
});
