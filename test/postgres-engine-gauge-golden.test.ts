/**
 * Refactor wave 1, W0 / EO9 (T-G5): pin PostgresEngine's checkoutGauge
 * (issue #6 pool diagnostics) on master. The W1 engine-sql adapter must bypass
 * the gauge exactly like today's tagged-template calls do, and keep the
 * raw / direct / reserved / tx labels where master counts them.
 *
 * Two goldens in `test/fixtures/goldens/postgres-engine-gauge.json`:
 *   - `sequence`: `getPoolDiagnostics()` after each step of a fixed op
 *     sequence on a fake connection (queries held in flight, then released,
 *     then a rejected query), covering every lane: raw, direct, tx (incl. a
 *     nested savepoint that must not double count), reserved, and tagged
 *     domain calls that must not count at all;
 *   - `acquiresByCase`: per EO8 SQL-text case (12 W1 domains), how many times
 *     each gauge kind was acquired, plus the invariant that every acquire was
 *     released when the method settled.
 */

import { describe, expect, test } from 'bun:test';
import { CheckoutGauge, type GaugeKind } from '../src/core/pool-gauge.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { defineNormalizer, expectGolden, expectNormalizerStable } from './helpers/golden.ts';
import { makeFakeSql, type RecordedStatement } from './helpers/fake-postgres-sql.ts';
import { SQL_CASES, makeEngineWithFake, withPinnedSqlEnvironment } from './helpers/postgres-engine-sql-cases.ts';

class RecordingGauge extends CheckoutGauge {
  acquired: Record<string, number> = {};
  override acquire(kind: GaugeKind): void {
    this.acquired[kind] = (this.acquired[kind] ?? 0) + 1;
    super.acquire(kind);
  }
}

async function settle(until: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!until()) throw new Error('gauge sequence: held statement never reached the fake');
}

async function captureSequence(): Promise<Array<{ step: string; diagnostics: unknown }>> {
  const holds = new Map<string, (rows: unknown[] | Error) => void>();
  const fake = makeFakeSql((stmt: RecordedStatement) => {
    const name = /\/\*hold:([\w-]+)\*\//.exec(stmt.text)?.[1]
      ?? (stmt.text.includes('COUNT(DISTINCT l.from_page_id)') ? 'enrichment' : undefined)
      ?? (stmt.text.includes('SELECT DISTINCT tag FROM tags') ? 'domain-tagged' : undefined);
    if (!name) return undefined;
    return new Promise((resolve) => holds.set(name, resolve as (rows: unknown[] | Error) => void));
  }, { poolMax: 10 });
  const engine = new PostgresEngine() as any;
  engine._sql = fake.sql;
  engine._connectionStyle = 'instance';
  const held = (name: string) => () => holds.has(name);
  const release = (name: string, value: unknown[] | Error = []) => { holds.get(name)!(value); holds.delete(name); };
  const steps: Array<{ step: string; diagnostics: unknown }> = [];
  const snap = (step: string) => steps.push({ step, diagnostics: engine.getPoolDiagnostics() });

  snap('idle');
  const raw = engine.executeRaw('SELECT /*hold:raw*/ 1');
  await settle(held('raw')); snap('executeRaw in flight');
  const direct = engine.executeRawDirect('SELECT /*hold:direct*/ 1');
  await settle(held('direct')); snap('+ executeRawDirect in flight');
  const tx = engine.transaction(async (t: any) => {
    await t.executeRaw('SELECT /*hold:tx-raw*/ 1');
    await t.transaction(async (inner: any) => inner.executeRaw('SELECT /*hold:savepoint-raw*/ 1'));
  });
  await settle(held('tx-raw')); snap('+ transaction body executeRaw in flight');
  release('tx-raw');
  await settle(held('savepoint-raw')); snap('+ nested savepoint executeRaw in flight (tx counted once)');
  const reserved = engine.withReservedConnection(async (conn: any) => conn.executeRaw('SELECT /*hold:reserved*/ 1'));
  await settle(held('reserved')); snap('+ withReservedConnection in flight');
  const tagged = engine.sql`SELECT /*hold:tagged*/ 1`;
  const taggedDone = tagged.then(() => undefined);
  await settle(held('tagged')); snap('+ tagged-template query in flight (not tracked)');
  const domainTagged = engine.getTags('people/alice-example');
  await settle(held('domain-tagged')); snap('+ getTags in flight (tagged domain SQL, not tracked)');
  const enrichment = engine.getBacklinkCounts([1, 2]);
  await settle(held('enrichment')); snap('+ getBacklinkCounts in flight (executeRaw-backed, counted raw)');
  release('enrichment'); await enrichment; snap('getBacklinkCounts released');
  release('domain-tagged'); await domainTagged; snap('getTags released');

  release('raw'); await raw; snap('raw released');
  release('direct'); await direct; snap('direct released');
  release('savepoint-raw'); await tx; snap('transaction committed');
  release('reserved'); await reserved; snap('reserved released');
  release('tagged'); await taggedDone; snap('tagged released');
  const rejected = engine.executeRaw('SELECT /*hold:rejected*/ 1');
  await settle(held('rejected')); snap('executeRaw in flight before rejection');
  release('rejected', new Error('query was cancelled'));
  await expect(rejected).rejects.toThrow('query was cancelled');
  snap('after rejected executeRaw (released)');
  return steps;
}

async function captureAcquiresByCase(): Promise<Record<string, Record<string, number>>> {
  return withPinnedSqlEnvironment(undefined, async () => {
    const out: Record<string, Record<string, number>> = {};
    for (const c of SQL_CASES) {
      const { engine } = makeEngineWithFake(c.rows);
      const gauge = new RecordingGauge();
      engine.checkoutGauge = gauge;
      await c.run(engine);
      const leaked = Object.entries(gauge.snapshot()).filter(([, n]) => n !== 0);
      if (leaked.length) throw new Error(`${c.method}#${c.variant} leaked gauge counts: ${JSON.stringify(leaked)}`);
      out[`${c.method}#${c.variant}`] = gauge.acquired;
    }
    return out;
  });
}

/** No volatile content: counts and fixed step labels only. */
const SEQUENCE_NORMALIZER = defineNormalizer<Array<{ step: string; diagnostics: unknown }>>('gauge-sequence-v1', (steps) => steps);
const ACQUIRES_NORMALIZER = defineNormalizer<Record<string, Record<string, number>>>('gauge-acquires-by-case-v1', (m) => m);

describe('EO9 checkoutGauge golden (fake connection)', () => {
  test('gauge snapshot after each step of the fixed op sequence matches master', async () => {
    const steps = await expectNormalizerStable(captureSequence, SEQUENCE_NORMALIZER);
    expect((steps.at(-1)!.diagnostics as { tracked: unknown }).tracked).toEqual({ raw: 0, direct: 0, reserved: 0, tx: 0 });
    expectGolden('postgres-engine-gauge/sequence', steps, SEQUENCE_NORMALIZER);
  });

  test('per-method gauge acquires for the W1 domain cases match master, and every acquire is released', async () => {
    const acquires = await expectNormalizerStable(captureAcquiresByCase, ACQUIRES_NORMALIZER);
    expectGolden('postgres-engine-gauge/acquires-by-case', acquires, ACQUIRES_NORMALIZER);
  });
});
