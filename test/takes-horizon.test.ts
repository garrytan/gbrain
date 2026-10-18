/**
 * W7 (wave 4b): the forecast horizon of a take, stored in its own table
 * (`take_horizons`) and never in the takes fence. Tests first, on PGLite;
 * the Postgres mirror is test/e2e/takes-horizon-postgres.test.ts.
 *
 * Protects:
 *   - the stated-horizon parser reads only an explicit deadline in the claim
 *     ("by the end of 2024", "by Q3 2024", "within 18 months" from since_date)
 *     and returns null when the claim states none or two;
 *   - a horizon belongs to the claim it was set for: editing the claim makes
 *     it stale (read as not current), deleting the take removes it;
 *   - the scan is preview-first and never overwrites an owner-set horizon;
 *   - takes_list and takes_scorecard return byte-identical output, locally and
 *     to remote callers, whether or not horizons exist (the journal is private).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { clearTakeHorizon, parseStatedHorizon, readTakeHorizons, scanStatedHorizons, setTakeHorizon } from '../src/core/takes-horizon.ts';

let engine: PGLiteEngine;
const ids: Record<string, number> = {};

const op = (name: string) => operations.find(o => o.name === name)!;
function ctx(remote = false): OperationContext {
  return { engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId: 'default',
    ...(remote ? { auth: { token: 't', clientId: 'c1', scopes: ['read'], sourceId: 'default' } } : {}) } as unknown as OperationContext;
}

async function takeOn(slug: string, rowNum: number, claim: string, sinceDate: string | null, resolved?: { quality: 'correct' | 'incorrect' }): Promise<number> {
  const existing = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]);
  if (!existing.length) await engine.putPage(slug, { type: 'company', title: slug, compiled_truth: `${slug} test page.` });
  const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]);
  await engine.addTakesBatch([{ page_id: page!.id, row_num: rowNum, claim, kind: 'bet', holder: 'world', weight: 0.7, since_date: sinceDate ?? undefined }]);
  const [take] = await engine.executeRaw<{ id: number }>('SELECT id FROM takes WHERE page_id = $1 AND row_num = $2', [page!.id, rowNum]);
  if (resolved) {
    await engine.executeRaw(
      `UPDATE takes SET resolved_at = now(), resolved_quality = $2, resolved_outcome = $3, resolved_by = 'owner' WHERE id = $1`,
      [take!.id, resolved.quality, resolved.quality === 'correct']);
  }
  return Number(take!.id);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  ids.acme = await takeOn('companies/acme-example', 1, 'Acme-example will reach $5M ARR by the end of 2024', '2023-02-01', { quality: 'correct' });
  ids.bluefin = await takeOn('companies/bluefin-example', 1, 'Bluefin-example will open a Berlin office within 18 months', '2023-02-10');
  ids.cobalt = await takeOn('companies/cobalt-example', 1, 'Cobalt-example has the strongest team in its market', '2023-03-01');
  ids.dune = await takeOn('companies/dune-example', 1, 'Dune-example will ship its API by Q3 2024', '2023-01-15', { quality: 'incorrect' });
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

describe('parseStatedHorizon', () => {
  const cases: Array<[string, string | null, { date: string; basis: string } | null]> = [
    ['Acme-example will reach $5M ARR by the end of 2024', '2023-02-01', { date: '2024-12-31', basis: 'stated' }],
    ['Acme-example will reach $5M ARR by end of 2024', null, { date: '2024-12-31', basis: 'stated' }],
    ['Dune-example will ship its API by Q3 2024', '2023-01-15', { date: '2024-09-30', basis: 'stated' }],
    ['Dune-example will ship its API by the end of Q1 2025', null, { date: '2025-03-31', basis: 'stated' }],
    ['Fernhill-example will hire 40 people by March 2025', null, { date: '2025-03-31', basis: 'stated' }],
    ['Fernhill-example will hire 40 people by February 2024', null, { date: '2024-02-29', basis: 'stated' }],
    ['Gale-example will be acquired before 2025', null, { date: '2024-12-31', basis: 'stated' }],
    ['Gale-example will be profitable by 2026', null, { date: '2026-12-31', basis: 'stated' }],
    ['Bluefin-example will open a Berlin office within 18 months', '2023-02-10', { date: '2024-08-10', basis: 'stated_relative' }],
    ['Bluefin-example will open a Berlin office within 18 months', null, null],
    ['Cobalt-example has the strongest team in its market', '2023-03-01', null],
    ['Hollow-example will raise by Q2 2024 and list before 2026', null, null],
  ];
  for (const [claim, since, want] of cases) {
    test(`${claim} (since ${since ?? 'unknown'})`, () => {
      const got = parseStatedHorizon(claim, since);
      if (want === null) expect(got).toBeNull();
      else expect(got).toMatchObject(want);
    });
  }
});

describe('take_horizons store', () => {
  test('an owner-set horizon reads back as current', async () => {
    await setTakeHorizon(engine, ids.cobalt!, '2025-06-30', 'owner');
    const got = (await readTakeHorizons(engine, [ids.cobalt!])).get(ids.cobalt!);
    expect(got).toMatchObject({ take_id: ids.cobalt, horizon_date: '2025-06-30', basis: 'owner', current: true });
  });

  test('rejects a date that is not YYYY-MM-DD and a basis it does not know', async () => {
    await expect(setTakeHorizon(engine, ids.cobalt!, '30/06/2025', 'owner')).rejects.toThrow(/YYYY-MM-DD/);
    await expect(setTakeHorizon(engine, ids.cobalt!, '2025-06-30', 'guess' as never)).rejects.toThrow(/basis/);
  });

  test('editing the claim makes the horizon stale without rewriting it', async () => {
    const eId = await takeOn('companies/ember-example', 1, 'Ember-example will reach 100 staff by the end of 2024', '2023-01-01');
    await setTakeHorizon(engine, eId, '2024-12-31', 'stated');
    await takeOn('companies/ember-example', 1, 'Ember-example will reach 200 staff by the end of 2025', '2023-01-01');
    const got = (await readTakeHorizons(engine, [eId])).get(eId);
    expect(got).toMatchObject({ horizon_date: '2024-12-31', current: false });
    const [row] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM take_horizons WHERE take_id = $1', [eId]);
    expect(row!.n).toBe(1);
  });

  test('deleting the take removes its horizon', async () => {
    const fId = await takeOn('companies/flint-example', 1, 'Flint-example will close a round by Q4 2024', '2023-05-01');
    await setTakeHorizon(engine, fId, '2024-12-31', 'stated');
    await engine.executeRaw('DELETE FROM takes WHERE id = $1', [fId]);
    expect((await readTakeHorizons(engine, [fId])).size).toBe(0);
    const [row] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM take_horizons WHERE take_id = $1', [fId]);
    expect(row!.n).toBe(0);
  });

  test('clear removes an owner horizon and reports whether one existed', async () => {
    expect(await clearTakeHorizon(engine, ids.cobalt!)).toBe(true);
    expect(await clearTakeHorizon(engine, ids.cobalt!)).toBe(false);
    expect((await readTakeHorizons(engine, [ids.cobalt!])).size).toBe(0);
  });
});

describe('scanStatedHorizons', () => {
  test('preview writes nothing; apply writes stated horizons and never overwrites an owner horizon', async () => {
    await setTakeHorizon(engine, ids.dune!, '2024-10-31', 'owner');
    const before = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM take_horizons');
    const preview = await scanStatedHorizons(engine, { apply: false });
    const after = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM take_horizons');
    expect(after[0]!.n).toBe(before[0]!.n);
    expect(preview.written).toBe(0);
    const byId = new Map(preview.proposed.map(p => [p.take_id, p]));
    expect(byId.get(ids.acme!)).toMatchObject({ horizon_date: '2024-12-31', basis: 'stated' });
    expect(byId.get(ids.bluefin!)).toMatchObject({ horizon_date: '2024-08-10', basis: 'stated_relative' });
    expect(byId.has(ids.cobalt!)).toBe(false);
    expect(byId.has(ids.dune!)).toBe(false);
    expect(preview.kept_owner).toBeGreaterThanOrEqual(1);

    const applied = await scanStatedHorizons(engine, { apply: true });
    expect(applied.written).toBe(preview.proposed.length);
    const h = await readTakeHorizons(engine, [ids.acme!, ids.bluefin!, ids.dune!]);
    expect(h.get(ids.acme!)).toMatchObject({ horizon_date: '2024-12-31', basis: 'stated', current: true });
    expect(h.get(ids.dune!)).toMatchObject({ horizon_date: '2024-10-31', basis: 'owner' });
    expect((await scanStatedHorizons(engine, { apply: false })).proposed).toEqual([]);
  });
});

describe('the journal stays private', () => {
  test('takes_list and takes_scorecard are byte-identical with and without horizons, locally and remotely', async () => {
    const snapshot = async () => JSON.stringify(await Promise.all([
      op('takes_list').handler(ctx(false), {}),
      op('takes_list').handler(ctx(true), {}),
      op('takes_scorecard').handler(ctx(false), {}),
      op('takes_scorecard').handler(ctx(true), {}),
    ]));
    const withHorizons = await snapshot();
    await engine.executeRaw('DELETE FROM take_horizons');
    const without = await snapshot();
    expect(withHorizons).toBe(without);
    expect(withHorizons).not.toContain('horizon');
  });
});
