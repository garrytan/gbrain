/**
 * BrainEngine parity — the fence cell writes keep a fact's history (master #10389, #10055), on every engine.
 *  - What: updateFenceFactCells (the extract_facts reconcile) keeps a stored valid_from its whole-second cell states;
 *    refreshFenceFactFields (the page write's fence projection) keeps that valid_from too, and for a row that stays
 *    retired keeps its expiry time, its valid_until (a blank cell, or a cell stating the stored end to the second) and
 *    its context when the cell is the generated `superseded by #N` marker of a superseded row. A changed valid_until or
 *    an explicit note still updates the row.
 *  - Regression: an engine that writes the cells back as they render restamps the retirement time, drops the original
 *    context and the sub-second `remember` instant, and records an unrelated page edit as a write of the archived row.
 *  - Why existing coverage misses it: test/retired-fact-history-10055.test.ts proves the flow on PGLite and Postgres
 *    only; these cases hold the Rust store to the same answers.
 *  - Seam: none. Rows come from insertFacts and the typed supersede/expiry writes.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const SLUG = 'notes/history';
const SUB = '2026-03-04T05:06:07.890Z';
const WHOLE = '2026-03-04T05:06:07.000Z';

async function fenced(engine: BrainEngine, rows: Array<Record<string, unknown>>): Promise<number[]> {
  const out = await engine.insertFacts(rows.map((r) => ({ kind: 'fact', visibility: 'world', source: 'fence', embedding: null, entity_slug: null,
    source_markdown_slug: SLUG, ...r })) as never, { source_id: SRC });
  return out.ids.map(Number);
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString());

async function row(engine: BrainEngine, n: number) {
  const r = (await engine.listFactsForPage(SRC, SLUG)).find((f) => Number(f.row_num) === n)!;
  return { context: r.context, valid_from: iso(r.valid_from), valid_until: iso(r.valid_until), expired_at: iso(r.expired_at) };
}

describe('engine parity: fence cell writes keep a fact\'s history (#10055)', () => {
  parityTest('updateFenceFactCells keeps a sub-second valid_from its whole-second cell states, and moves it for another second', {
    methods: ['insertFacts', 'updateFenceFactCells', 'listFactsForPage'],
  }, async (engine) => {
    const [a, b] = await fenced(engine, [
      { fact: 'kept instant', row_num: 1, valid_from: new Date(SUB) },
      { fact: 'moved instant', row_num: 2, valid_from: new Date(SUB) },
    ]);
    const cells = (validFrom: string) => ({ kind: 'fact', visibility: 'world', notability: 'medium', context: null, validFrom, setValidUntil: true,
      validUntil: null, expiredAt: null, source: 'fence', confidence: 1, claimMetric: null, claimValue: null, claimUnit: null, claimPeriod: null });
    await engine.updateFenceFactCells(SRC, a!, cells(WHOLE));
    await engine.updateFenceFactCells(SRC, b!, cells('2026-03-05T00:00:00.000Z'));
    const out = { kept: (await row(engine, 1)).valid_from, moved: (await row(engine, 2)).valid_from };
    expect(out).toEqual({ kept: SUB, moved: '2026-03-05T00:00:00.000Z' });
    return out;
  });

  parityTest('refreshFenceFactFields keeps a retired superseded row\'s context, end and expiry, and a sub-second valid_from; an explicit note and a new end still write', {
    methods: ['insertFacts', 'setFactSupersededBy', 'expireFactInPlace', 'refreshFenceFactFields', 'listFactsForPage'],
  }, async (engine) => {
    const ended = '2026-04-01T10:20:30.456Z';
    const [old1, next, old3, old4] = await fenced(engine, [
      { fact: 'retired, marker cell', row_num: 1, context: 'original note', valid_from: new Date(SUB), valid_until: new Date(ended) },
      { fact: 'successor', row_num: 2 },
      { fact: 'retired, owner note', row_num: 3, context: 'original note', valid_until: new Date(ended) },
      { fact: 'retired, new end', row_num: 4, valid_until: new Date(ended) },
    ]);
    for (const id of [old1!, old3!, old4!]) {
      await engine.setFactSupersededBy(SRC, id, next!);
      await engine.expireFactInPlace(SRC, id);
    }
    const before = { r1: await row(engine, 1), r3: await row(engine, 3), r4: await row(engine, 4) };
    const today = '2026-11-25T00:00:00.000Z';
    const field = (n: number, context: string | null, validUntil: string | null, untilCell: boolean, validFrom: string | null) => ({
      row_num: n, kind: 'fact', notability: 'medium', context, valid_from: validFrom, valid_until: validUntil, until_cell: untilCell, expired_at: today,
      source: 'fence', confidence: 1, claim_metric: null, claim_value: null, claim_unit: null, claim_period: null, attributed_to: null,
    });
    await engine.refreshFenceFactFields(SRC, SLUG, JSON.stringify([
      field(1, `superseded by #${next}`, today, false, WHOLE),
      field(3, 'the owner\'s new note', '2026-04-01T10:20:30.000Z', true, null),
      field(4, null, '2027-01-01T00:00:00.000Z', true, null),
    ]));
    const after = { r1: await row(engine, 1), r3: await row(engine, 3), r4: await row(engine, 4) };
    expect(after.r1).toEqual(before.r1);
    expect(after.r3).toEqual({ ...before.r3, context: 'the owner\'s new note' });
    expect(after.r4).toEqual({ ...before.r4, context: null, valid_until: '2027-01-01T00:00:00.000Z' });
    // The answer each engine gives, without the times only that engine's clock wrote.
    const kept = (k: 'r1' | 'r3' | 'r4') => Object.fromEntries(Object.entries(after[k]).map(([key, v]) => [key, v === before[k][key as keyof typeof before.r1] ? 'kept' : v]));
    return { r1: kept('r1'), r3: kept('r3'), r4: kept('r4') };
  });
});
