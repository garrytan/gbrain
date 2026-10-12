/**
 * `gbrain repair <kind> --apply` and a per-item refusal (PR #6459): an item
 * whose apply raises `invalid_params` (a page whose slug the grammar no longer
 * accepts) or `source_changed` (file/database drift, neither copy overwritten)
 * used to abort the whole run, and because the cursor is written only after a
 * successful item, every rerun stopped at the same item.
 *
 * Now the item is recorded in `failed[]` (and as a `failed` outcome), left
 * exactly as it was, and the loop continues. The retry story is the one
 * `revision_conflict` already has: no cursor is written for the failed item,
 * but a later success writes a higher cursor, so a resumed run does NOT retry
 * it; the next full scan (a run that starts with no stored cursor, which every
 * completed run leaves behind) does. The human output and the JSON say so,
 * `gbrain repair` exits 1, and no `RepairResult` consumer (`doctor
 * --remediate`, the content lane, the cycle phases) reads a run with failures
 * as an all-clear.
 *
 * PGLite, stub handler (projection kind: no admission, no page writes); the
 * stub keeps its own per-item store so "bytes untouched" is asserted directly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { afterCursor, resolveRepairScope, runRepair, type RepairCursor, type RepairHandler, type RepairItem, type RepairKind, type RepairResult } from '../src/core/repair/core.ts';
import type { RepairKindSpec } from '../src/core/repair/registry.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { renderRepairResult, repairExitVerdict } from '../src/commands/repair.ts';
import { runRepairSteps, type RepairPlanStep } from '../src/core/remediation/repairs.ts';
import { runContentLane } from '../src/core/repair/content-lane.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

const ctx = () => ({ engine, sourceId: 'default', remote: false as const, config: { engine: 'pglite', embedding_disabled: true }, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } }) as never;

type Failure = { code: 'invalid_params' | 'source_changed'; message: string };

interface Stub {
  spec: RepairKindSpec;
  handler: RepairHandler;
  /** What each item holds; a repaired item is rewritten, a failed one must keep its original bytes. */
  store: Map<number, string>;
  attempts: number[];
  failures: Map<number, Failure>;
}

function stubKind(kind: RepairKind, count: number, failures: Record<number, Failure>): Stub {
  const store = new Map(Array.from({ length: count }, (_, id) => [id, `original bytes of item ${id}`]));
  const stub: Stub = { store, attempts: [], failures: new Map(Object.entries(failures).map(([k, v]) => [Number(k), v])), spec: undefined as never, handler: undefined as never };
  const item = (id: number): RepairItem => ({ cursor: { phase: 0, id }, source_id: 'default', slug: `notes/item-${id}`, chars: 10, action: 'repair' });
  stub.handler = {
    kind, publication: 'projection', embeds: false,
    async plan(_engine, _scope, after: RepairCursor | null) {
      const items = [...store.entries()].filter(([, body]) => body.startsWith('original')).map(([id]) => item(id)).filter(i => afterCursor(i.cursor, after));
      return { items, residuals: {} };
    },
    async apply(_ctx, it) {
      stub.attempts.push(it.cursor.id);
      const failure = stub.failures.get(it.cursor.id);
      if (failure) throw new OperationError(failure.code, failure.message, 'fix the page and rerun the repair');
      store.set(it.cursor.id, `repaired item ${it.cursor.id}`);
      return { applied: true, outcome: 'repaired' };
    },
  };
  stub.spec = { kind, handler: stub.handler, summary: 'stub', embeds: 'none', checks: [], consent: 'safe' } as unknown as RepairKindSpec;
  return stub;
}

const FAILURES: Record<number, Failure> = {
  1: { code: 'invalid_params', message: "Slug 'notes/item-1' is not a valid slug any more: postgres://user:secret@db.example/brain" },
  3: { code: 'source_changed', message: 'file_database_drift: notes/item-3.md differs from the database copy; neither was overwritten' },
};

const cursorRows = () => engine.executeRaw<{ completed_keys: unknown }>("SELECT completed_keys FROM op_checkpoints WHERE op='repair'");

describe('repair --apply continues past a per-item invalid_params / source_changed refusal (PR #6459)', () => {
  test('items after a failed one are applied, failed[] names each with its reason, bytes stay untouched, and the next full scan retries them', async () => {
    const stub = stubKind('timeline', 5, FAILURES);
    const scope = await resolveRepairScope(engine);
    const result = await runRepair(ctx(), stub.handler, scope, { apply: true, spec: stub.spec });
    expect(stub.attempts).toEqual([0, 1, 2, 3, 4]);
    expect(result).toMatchObject({ applied: 3, skipped: 0, complete: true });
    expect(result.stopped).toBeUndefined();
    expect(result.failed).toEqual([
      { item: 'default:notes/item-1', source_id: 'default', slug: 'notes/item-1', reason: 'invalid_params', message: expect.stringContaining('not a valid slug'), retry: 'next_full_scan' },
      { item: 'default:notes/item-3', source_id: 'default', slug: 'notes/item-3', reason: 'source_changed', message: expect.stringContaining('file_database_drift'), retry: 'next_full_scan' },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.outcomes).toEqual({ repaired: 3, failed: 2 });
    expect(result.outcome_items?.filter(o => o.outcome === 'failed').map(o => [o.item, o.reason])).toEqual([['default:notes/item-1', 'invalid_params'], ['default:notes/item-3', 'source_changed']]);
    expect(stub.store.get(1)).toBe('original bytes of item 1');
    expect(stub.store.get(3)).toBe('original bytes of item 3');
    expect([0, 2, 4].map(id => stub.store.get(id))).toEqual(['repaired item 0', 'repaired item 2', 'repaired item 4']);
    // A completed run clears its cursor: the next apply is a full scan and retries exactly the failed items.
    expect(await cursorRows()).toEqual([]);
    stub.failures.clear();
    stub.attempts.length = 0;
    const rerun = await runRepair(ctx(), stub.handler, scope, { apply: true, spec: stub.spec });
    expect(stub.attempts).toEqual([1, 3]);
    expect(rerun).toMatchObject({ applied: 2, failed: [], complete: true });
    expect(stub.store.get(1)).toBe('repaired item 1');
  });

  test('failure → later success → interruption → resume: the resumed run does not retry the failed item; the next full scan does', async () => {
    const stub = stubKind('timeline', 5, { 1: FAILURES[1]! });
    const scope = await resolveRepairScope(engine);
    let clock = 1_000;
    const now = () => clock;
    // Items 0 (ok), 1 (fails), 2 (ok) run; the deadline then stops the run before item 3.
    const originalApply = stub.handler.apply.bind(stub.handler);
    stub.handler.apply = async (c, it, o) => { const out = await originalApply(c, it, o); if (it.cursor.id === 2) clock = 10_000; return out; };
    const first = await runRepair(ctx(), stub.handler, scope, { apply: true, spec: stub.spec, deadline: 5_000, now });
    expect(stub.attempts).toEqual([0, 1, 2]);
    expect(first).toMatchObject({ applied: 2, complete: false, stopped: { reason: 'time_budget' } });
    expect(first.failed.map(f => f.slug)).toEqual(['notes/item-1']);
    expect(stub.store.get(1)).toBe('original bytes of item 1');
    // The stored cursor is after item 2 (the later success), past the failed item.
    const [row] = await cursorRows();
    expect((row!.completed_keys as Array<{ cursor: RepairCursor }>)[0]!.cursor).toEqual({ phase: 0, id: 2 });
    expect(String(first.stopped!.message)).toContain('resume');
    // Resume: items 3 and 4 only; item 1 is not retried and still reported as left for the full scan.
    stub.attempts.length = 0;
    clock = 1_000;
    const resumed = await runRepair(ctx(), stub.handler, scope, { apply: true, spec: stub.spec, deadline: 50_000, now });
    expect(stub.attempts).toEqual([3, 4]);
    expect(resumed).toMatchObject({ applied: 2, failed: [], complete: true, resumed_from: { phase: 0, id: 2 } });
    expect(stub.store.get(1)).toBe('original bytes of item 1');
    expect(await cursorRows()).toEqual([]);
    // Full scan: the failed item comes back as pending and is retried.
    stub.attempts.length = 0;
    stub.failures.clear();
    const full = await runRepair(ctx(), stub.handler, scope, { apply: true, spec: stub.spec });
    expect(stub.attempts).toEqual([1]);
    expect(full).toMatchObject({ applied: 1, complete: true, resumed_from: null });
    expect(stub.store.get(1)).toBe('repaired item 1');
  });

  test('other refusals still stop the run as before (write_pending stops; an unexpected error rethrows)', async () => {
    const stub = stubKind('timeline', 3, {});
    stub.handler.apply = async (_c, it) => {
      stub.attempts.push(it.cursor.id);
      if (it.cursor.id === 1) throw new OperationError('write_pending', 'accepted, pending publication', 'rerun');
      return { applied: true, outcome: 'repaired' };
    };
    const scope = await resolveRepairScope(engine);
    const pending = await runRepair(ctx(), stub.handler, scope, { apply: true, spec: stub.spec });
    expect(stub.attempts).toEqual([0, 1]);
    expect(pending).toMatchObject({ applied: 1, failed: [], stopped: { reason: 'write_pending' }, complete: false });
    await resetPgliteState(engine);
    const boom = stubKind('timeline', 3, {});
    boom.handler.apply = async (_c, it) => { if (it.cursor.id === 0) throw new Error('disk on fire'); return { applied: true, outcome: 'repaired' }; };
    await expect(runRepair(ctx(), boom.handler, await resolveRepairScope(engine), { apply: true, spec: boom.spec })).rejects.toThrow('disk on fire');
  });

  test('the human output counts the failures, names the slug and the full-scan command; the command exits 1', async () => {
    const stub = stubKind('timeline', 5, FAILURES);
    const result = await runRepair(ctx(), stub.handler, await resolveRepairScope(engine), { apply: true, spec: stub.spec });
    const text = renderRepairResult(result);
    expect(text).toContain('applied 3, skipped 0, failed 2, complete');
    expect(text).toContain('FAILED default:notes/item-1 (invalid_params)');
    expect(text).toContain('FAILED default:notes/item-3 (source_changed)');
    expect(text).toMatch(/left unchanged.*next full scan.*gbrain repair timeline --apply/);
    expect(text).not.toContain('secret');
    expect(repairExitVerdict([result])).toBe(1);
    expect(repairExitVerdict([{ ...result, failed: [] }])).toBe(0);
    expect(repairExitVerdict([{ ...result, failed: [], stopped: { reason: 'capacity', message: 'x' } }])).toBe(1);
  });

  test('doctor --remediate reports a step with failures as failed, never completed', async () => {
    const stub = stubKind('timeline', 5, FAILURES);
    const step: RepairPlanStep = { step: 1, id: 'repair:timeline', kind: 'timeline', affected: 5, command: 'gbrain repair timeline --apply', requires_user_agreement: true, protected: true,
      paid: false, embeds: 'none', est_usd_cost: 0, lifetime_ids: 0, checks: [], rationale: 'stub' };
    const [stepResult] = await runRepairSteps(engine, [step], { remote: false, remainingUsd: () => undefined, registry: [stub.spec] });
    expect(stepResult).toMatchObject({ kind: 'timeline', status: 'failed', applied: 3, skipped: 0, failed: 2 });
    expect(String(stepResult!.message)).toContain('notes/item-1');
    expect(String(stepResult!.message)).toContain('next full scan');
    const clean = stubKind('timeline', 2, {});
    const [ok] = await runRepairSteps(engine, [step], { remote: false, remainingUsd: () => undefined, registry: [clean.spec] });
    expect(ok).toMatchObject({ status: 'completed', applied: 2, failed: 0 });
  });

  test('the content lane carries each kind\'s failures and names them in its stopped-or-failed summary', async () => {
    const stub = stubKind('fences', 5, FAILURES);
    const lane = await runContentLane(engine, await resolveRepairScope(engine), { apply: true, kinds: ['fences'], registry: [stub.spec] });
    const [result] = lane.results as RepairResult[];
    expect(result!.failed.map(f => f.slug)).toEqual(['notes/item-1', 'notes/item-3']);
    expect(lane.failed).toEqual([{ kind: 'fences', item: 'default:notes/item-1', source_id: 'default', slug: 'notes/item-1', reason: 'invalid_params', message: expect.any(String), retry: 'next_full_scan' },
      { kind: 'fences', item: 'default:notes/item-3', source_id: 'default', slug: 'notes/item-3', reason: 'source_changed', message: expect.any(String), retry: 'next_full_scan' }]);
    expect(lane.stopped).toEqual([]);
  });
});
