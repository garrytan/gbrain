/**
 * W7 on Postgres: the take_horizons store behaves as on PGLite
 * (test/takes-horizon.test.ts). Protects: the DATE round trip as YYYY-MM-DD
 * text, the bigint[] filter, the cascade from takes, the claim-hash staleness
 * check, the preview-first scan, and byte-identical takes_list /
 * takes_scorecard output for local and remote callers with horizons present.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { clearTakeHorizon, readTakeHorizons, scanStatedHorizons, setTakeHorizon } from '../../src/core/takes-horizon.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;
const op = (name: string) => operations.find(o => o.name === name)!;
const ctx = (remote: boolean) => ({ engine: getEngine(), config: { engine: 'postgres' }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId: 'default',
  ...(remote ? { auth: { token: 't', clientId: 'c1', scopes: ['read'], sourceId: 'default' } } : {}) }) as unknown as OperationContext;

async function takeOn(slug: string, claim: string, since: string): Promise<number> {
  const engine = getEngine();
  const existing = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]);
  if (!existing.length) await engine.putPage(slug, { type: 'company', title: slug, compiled_truth: `${slug} test page.` });
  const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]);
  await engine.addTakesBatch([{ page_id: page!.id, row_num: 1, claim, kind: 'bet', holder: 'world', weight: 0.7, since_date: since }]);
  const [take] = await engine.executeRaw<{ id: number | string }>('SELECT id FROM takes WHERE page_id = $1 AND row_num = 1', [page!.id]);
  return Number(take!.id);
}

beforeAll(async () => { if (RUN) await setupDB(); });
afterAll(async () => { if (RUN) await teardownDB(); });

d('take_horizons on Postgres (W7)', () => {
  test('set, read, stale on claim edit, clear, cascade', async () => {
    const engine = getEngine();
    const a = await takeOn('companies/acme-example', 'Acme-example will reach $5M ARR by the end of 2024', '2023-02-01');
    await setTakeHorizon(engine, a, '2024-12-31', 'owner');
    expect((await readTakeHorizons(engine, [a])).get(a)).toMatchObject({ take_id: a, horizon_date: '2024-12-31', basis: 'owner', current: true });
    await takeOn('companies/acme-example', 'Acme-example will reach $8M ARR by the end of 2025', '2023-02-01');
    expect((await readTakeHorizons(engine, [a])).get(a)).toMatchObject({ horizon_date: '2024-12-31', current: false });
    expect(await clearTakeHorizon(engine, a)).toBe(true);
    expect(await clearTakeHorizon(engine, a)).toBe(false);
    await setTakeHorizon(engine, a, '2025-12-31', 'stated');
    await engine.executeRaw('DELETE FROM takes WHERE id = $1', [a]);
    const [row] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM take_horizons WHERE take_id = $1', [a]);
    expect(row!.n).toBe(0);
  });

  test('scan is preview-first, keeps owner horizons, and the journal stays private', async () => {
    const engine = getEngine();
    const b = await takeOn('companies/bluefin-example', 'Bluefin-example will open a Berlin office within 18 months', '2023-02-10');
    const c = await takeOn('companies/cobalt-example', 'Cobalt-example will ship its API by Q3 2024', '2023-01-15');
    await setTakeHorizon(engine, c, '2024-10-31', 'owner');
    const snapshot = async () => JSON.stringify(await Promise.all([
      op('takes_list').handler(ctx(false), {}), op('takes_list').handler(ctx(true), {}),
      op('takes_scorecard').handler(ctx(false), {}), op('takes_scorecard').handler(ctx(true), {}),
    ]));
    const before = await snapshot();
    const preview = await scanStatedHorizons(engine, { apply: false });
    expect(preview.written).toBe(0);
    expect(preview.proposed.find(p => p.take_id === b)).toMatchObject({ horizon_date: '2024-08-10', basis: 'stated_relative' });
    expect(preview.proposed.some(p => p.take_id === c)).toBe(false);
    expect((await readTakeHorizons(engine, [b])).size).toBe(0);
    const applied = await scanStatedHorizons(engine, { apply: true });
    expect(applied.written).toBe(preview.proposed.length);
    expect((await readTakeHorizons(engine, [b, c])).get(c)).toMatchObject({ horizon_date: '2024-10-31', basis: 'owner' });
    const after = await snapshot();
    expect(after).toBe(before);
    expect(after).not.toContain('horizon');
  });
});
