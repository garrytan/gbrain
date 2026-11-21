/**
 * BrainEngine parity — the page embedding ledger on the paid path (engine-sql/page-embedding-budget.ts): the hold and
 * ledger read, the hold record, the approval that opens a hold, the grant and the settle by reservation window.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readPageEmbeddingBudget, recordPageEmbeddingHold, openPageEmbeddingHold, reservePageEmbedding and
 *    settlePageEmbeddingReservation return the same answer, and leave the same ledger row, on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts).
 *  - Regression: an engine that grants a held page, grants past a page's cap, or settles outside the grant's window
 *    spends money PGLite refuses (`embed.max_usd_per_page`, the owner's approval holds); the Rust engine has no SQL, so
 *    the ledger has to exist as typed members.
 *  - Why existing coverage misses it: planPageEmbedding (page-embedding-budget.ts) sent these statements through
 *    `executeRaw` and `transaction`, which the parity cases cannot call (D18).
 *  - Seam: none. Money values are binary-exact (sums of powers of two) so every arm books the same float; a
 *    reservation window is compared by presence, and reused only as the arm returned it.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = { type: 'note' as const, title: 'Budget note', compiled_truth: 'A budget example.', timeline: '' };
const OPEN = { approved: false, approvedCapUsd: null, configuredCapUsd: 2, signature: 'model-a:1536', junk: { reason: null } };
const CHUNKS = [{ chunkIndex: 2, costUsd: 0.25 }, { chunkIndex: 0, costUsd: 0.5 }, { chunkIndex: 1, costUsd: 0.125 }];

async function idOf(engine: BrainEngine, slug: string): Promise<number> {
  const page = await engine.getPage(slug);
  expect(page).not.toBeNull();
  return Number(page!.id);
}

/** The ledger row with its window as presence. */
async function ledger(engine: BrainEngine, pageId: number) {
  const { reservation_window, ...row } = await engine.readPageEmbeddingBudget(pageId);
  return { ...row, window: reservation_window !== null };
}

/** A reservation with its window as presence. */
function view(reservation: Awaited<ReturnType<BrainEngine['reservePageEmbedding']>>) {
  if (reservation.kind !== 'grant') return reservation;
  const { window, ...rest } = reservation;
  return { ...rest, window: window !== null };
}

const ROW = { marker: null, state: 'open', reason: null, embedding_signature: 'model-a:1536', spent_usd: 0, reserved_usd: 0, cap_usd: null, unpriced_calls: 0, window: false };

describe('engine parity: page embedding ledger', () => {
  parityTest('a held page refuses with no spend until it is approved, and a missing page reads as no row', {
    methods: ['putPage', 'getPage', 'readPageEmbeddingBudget', 'recordPageEmbeddingHold', 'reservePageEmbedding', 'openPageEmbeddingHold'],
  }, async (engine) => {
    await engine.putPage('calls/held', { ...NOTE, frontmatter: { call_import: { embedding_hold: 'call_import' } } });
    await engine.putPage('calls/small', { ...NOTE, frontmatter: { transcript_archive: { embedding_hold: 'archive_backfill' } } });
    const held = await idOf(engine, 'calls/held');
    const small = await idOf(engine, 'calls/small');
    const before = await ledger(engine, held);
    await engine.recordPageEmbeddingHold(held, 'call_import');
    await engine.recordPageEmbeddingHold(held, 'another_reason');
    const refused = view(await engine.reservePageEmbedding(held, { ...OPEN, chunks: CHUNKS }));
    const afterRefusal = await ledger(engine, held);
    const approved = view(await engine.reservePageEmbedding(held, { ...OPEN, approved: true, approvedCapUsd: 1, junk: null, chunks: CHUNKS }));
    const afterApproval = await ledger(engine, held);
    await engine.recordPageEmbeddingHold(small, 'archive_backfill');
    await engine.openPageEmbeddingHold(small);
    const opened = await ledger(engine, small);
    const missing = await engine.readPageEmbeddingBudget(987654321);
    const answers = { before, refused, afterRefusal, approved, afterApproval, opened, missing };
    expect(answers as unknown).toEqual({
      before: { ...ROW, marker: 'call_import', state: null, embedding_signature: null, spent_usd: null, reserved_usd: null, unpriced_calls: null },
      refused: { kind: 'held', reason: 'call_import' },
      afterRefusal: { ...ROW, marker: 'call_import', state: 'held', reason: 'call_import', embedding_signature: null },
      approved: { kind: 'grant', chunkIndexes: [2, 1, 0], reservedUsd: 0.875, deferred: 0, capUsd: 2, window: true },
      afterApproval: { ...ROW, marker: 'call_import', reserved_usd: 0.875, cap_usd: 2, window: true },
      opened: { ...ROW, marker: 'archive_backfill', embedding_signature: null },
      missing: { marker: null, state: null, reason: null, embedding_signature: null, spent_usd: null, reserved_usd: null, cap_usd: null, unpriced_calls: null, reservation_window: null },
    });
    return answers;
  });

  parityTest('a page at its cap is granted nothing and spends nothing; a page part way under it gets the newest chunks that fit', {
    methods: ['putPage', 'getPage', 'reservePageEmbedding', 'readPageEmbeddingBudget'],
  }, async (engine) => {
    await engine.putPage('notes/capped', NOTE);
    await engine.putPage('notes/partial', NOTE);
    const capped = await idOf(engine, 'notes/capped');
    const partial = await idOf(engine, 'notes/partial');
    const none = view(await engine.reservePageEmbedding(capped, { ...OPEN, configuredCapUsd: 0.0009765625, chunks: [{ chunkIndex: 0, costUsd: 0.0078125 }] }));
    const cappedRow = await ledger(engine, capped);
    const some = view(await engine.reservePageEmbedding(partial, { ...OPEN, configuredCapUsd: 0.5, chunks: CHUNKS }));
    const partialRow = await ledger(engine, partial);
    const answers = { none, cappedRow, some, partialRow };
    expect(answers as unknown).toEqual({
      none: { kind: 'grant', chunkIndexes: [], reservedUsd: 0, deferred: 1, capUsd: 0.0009765625, window: false },
      cappedRow: { ...ROW, state: 'capped', reason: 'cap_reached' },
      some: { kind: 'grant', chunkIndexes: [2, 1], reservedUsd: 0.375, deferred: 1, capUsd: 0.5, window: true },
      partialRow: { ...ROW, state: 'capped', reason: 'cap_reached', reserved_usd: 0.375, window: true },
    });
    return answers;
  });

  parityTest('a page under its cap is granted every chunk and settles inside its window only', {
    methods: ['putPage', 'getPage', 'reservePageEmbedding', 'settlePageEmbeddingReservation', 'readPageEmbeddingBudget'],
  }, async (engine) => {
    await engine.putPage('notes/under', NOTE);
    await engine.putPage('notes/unlimited', NOTE);
    const under = await idOf(engine, 'notes/under');
    const unlimited = await idOf(engine, 'notes/unlimited');
    const grant = await engine.reservePageEmbedding(under, { ...OPEN, chunks: CHUNKS });
    const reserved = await ledger(engine, under);
    await engine.settlePageEmbeddingReservation(under, { window: '1', reservedUsd: 0.875, bookedUsd: 0.875, unpricedCalls: 1 });
    const wrongWindow = await ledger(engine, under);
    await engine.settlePageEmbeddingReservation(under, { window: grant.kind === 'grant' ? grant.window : null, reservedUsd: 0.875, bookedUsd: 0.875, unpricedCalls: 1 });
    const settled = await ledger(engine, under);
    const again = view(await engine.reservePageEmbedding(under, { ...OPEN, chunks: [{ chunkIndex: 3, costUsd: 0.0625 }] }));
    const newModel = view(await engine.reservePageEmbedding(under, { ...OPEN, signature: 'model-b:768', chunks: [{ chunkIndex: 0, costUsd: 0.25 }] }));
    const newLedger = await ledger(engine, under);
    const free = view(await engine.reservePageEmbedding(unlimited, { ...OPEN, configuredCapUsd: Infinity, chunks: CHUNKS }));
    const answers = { grant: view(grant), reserved, wrongWindow, settled, again, newModel, newLedger, free };
    expect(answers as unknown).toEqual({
      grant: { kind: 'grant', chunkIndexes: [2, 1, 0], reservedUsd: 0.875, deferred: 0, capUsd: 2, window: true },
      reserved: { ...ROW, reserved_usd: 0.875, window: true },
      wrongWindow: { ...ROW, reserved_usd: 0.875, window: true },
      settled: { ...ROW, spent_usd: 0.875, unpriced_calls: 1 },
      again: { kind: 'grant', chunkIndexes: [3], reservedUsd: 0.0625, deferred: 0, capUsd: 2, window: true },
      newModel: { kind: 'grant', chunkIndexes: [0], reservedUsd: 0.25, deferred: 0, capUsd: 2, window: true },
      newLedger: { ...ROW, embedding_signature: 'model-b:768', reserved_usd: 0.25, unpriced_calls: 1, window: true },
      free: { kind: 'grant', chunkIndexes: [2, 1, 0], reservedUsd: 0.875, deferred: 0, capUsd: Infinity, window: true },
    });
    return answers;
  });

  parityTest('an open page asks for the junk verdict before any grant, and a junk page is held with no spend', {
    methods: ['putPage', 'getPage', 'reservePageEmbedding', 'readPageEmbeddingBudget'],
  }, async (engine) => {
    await engine.putPage('notes/junk', NOTE);
    const junk = await idOf(engine, 'notes/junk');
    const ask = await engine.reservePageEmbedding(junk, { ...OPEN, junk: null, chunks: CHUNKS });
    const held = await engine.reservePageEmbedding(junk, { ...OPEN, junk: { reason: 'markup_ratio' }, chunks: CHUNKS });
    const row = await ledger(engine, junk);
    const stillHeld = await engine.reservePageEmbedding(junk, { ...OPEN, chunks: CHUNKS });
    const answers = { ask, held, row, stillHeld };
    expect(answers as unknown).toEqual({
      ask: { kind: 'needs_junk' },
      held: { kind: 'held', reason: 'markup_ratio' },
      row: { ...ROW, state: 'held', reason: 'markup_ratio', embedding_signature: null },
      stillHeld: { kind: 'held', reason: 'markup_ratio' },
    });
    return answers;
  });

  parityTest('a settle that books Infinity, -Infinity or NaN leaves the same readable ledger row on every arm', {
    methods: ['putPage', 'getPage', 'reservePageEmbedding', 'settlePageEmbeddingReservation', 'readPageEmbeddingBudget'],
  }, async (engine) => {
    // PGLite and Postgres keep DOUBLE PRECISION: Infinity and NaN are booked as they are, -Infinity as 0 (Math.max).
    const cases = [
      ['inf', { reservedUsd: 0.875, bookedUsd: Infinity }],
      ['neg-inf', { reservedUsd: 0.875, bookedUsd: -Infinity }],
      ['nan', { reservedUsd: 0.875, bookedUsd: NaN }],
      ['reserved-nan', { reservedUsd: NaN, bookedUsd: 0.5 }],
      ['reserved-neg-inf', { reservedUsd: -Infinity, bookedUsd: 0.5 }],
    ] as const;
    const answers: Record<string, unknown> = {};
    for (const [name, amounts] of cases) {
      await engine.putPage(`notes/non-finite-${name}`, NOTE);
      const id = await idOf(engine, `notes/non-finite-${name}`);
      const grant = await engine.reservePageEmbedding(id, { ...OPEN, chunks: CHUNKS });
      if (grant.kind !== 'grant' || grant.window === null) throw new Error(`${name}: no grant window`);
      await engine.settlePageEmbeddingReservation(id, { window: grant.window, ...amounts, unpricedCalls: 0 });
      const row = await ledger(engine, id);
      answers[name] = { ...row, json: JSON.stringify(row), spent: String(row.spent_usd), reserved: String(row.reserved_usd) };
    }
    const row = (spent: number, reserved: number) => {
      const r = { ...ROW, spent_usd: spent, reserved_usd: reserved, window: reserved !== 0 };
      return { ...r, json: JSON.stringify(r), spent: String(spent), reserved: String(reserved) };
    };
    expect(answers as unknown).toEqual({
      inf: row(Infinity, 0),
      'neg-inf': row(0, 0),
      nan: row(NaN, 0),
      'reserved-nan': row(0.5, NaN),
      'reserved-neg-inf': row(0.5, Infinity),
    });
    return answers;
  });
});
