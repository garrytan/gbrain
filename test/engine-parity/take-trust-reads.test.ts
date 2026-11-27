/**
 * BrainEngine parity — the take trust reads of the take write gate, the accepted-takes and lost-fence-rows repairs and
 * the two trust explainers.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readTakeRowTrust(pageId, rowNum) returns the stored take at that row number with its claim and stored
 *    trust tier (null when the page has no take there); readTakeTrustRef(id) returns the take with its page's source,
 *    claim, stored tier, write origin (keys in jsonb order), whether it is active and whether its page carries the
 *    quarantine frontmatter key (null for an unknown id). Every engine arm answers the same (PGLite always; Postgres
 *    with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: these reads decide whether a lower-tier writer may remove or supersede a take (takes-prepare), which
 *    tier a restored take may keep (accepted-takes, lost-fence-rows) and what `gbrain trust explain` reports. A wrong
 *    tier lets a lower-tier writer overwrite a more trusted take, and a missed quarantine shows a quarantined take as
 *    live. Before these members, each site ran its own SQL and the Rust arm refused the whole flow.
 *  - Why existing coverage misses it: take-trust-fields.test.ts reads the tier through readRowTrustRows, which neither
 *    looks a take up by row number nor reads the page's source or quarantine key.
 *  - Seam: none. Typed methods only (no executeRaw: D18); tiers are declared through applyTransactionSettings inside a
 *    transaction, as the write paths do. Take ids are sequence values, so they are compared only as relations.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, TakeBatchInput } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SLUG = 'people/take-trust-reads-example';
const QUARANTINED = 'people/take-trust-reads-quarantined';

function declaredWrite(engine: BrainEngine, tier: string, origin: Record<string, unknown> | null, fn: (tx: BrainEngine) => Promise<unknown>) {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, origin ? JSON.stringify(origin) : '']);
    return fn(tx);
  });
}

const take = (page_id: number, row_num: number, claim: string): TakeBatchInput => ({
  page_id, row_num, claim, kind: 'take', holder: 'world', weight: 0.5,
});

async function page(engine: BrainEngine, slug: string, frontmatter?: Record<string, unknown>): Promise<number> {
  return (await engine.putPage(slug, { type: 'person', title: 'T', compiled_truth: 'T', timeline: '', ...(frontmatter ? { frontmatter } : {}) })).id;
}

/** The take id at a row number, through listTakes (active and inactive). */
async function idAt(engine: BrainEngine, pageId: number, rowNum: number): Promise<number> {
  const rows = [...await engine.listTakes({ page_id: pageId, active: true }), ...await engine.listTakes({ page_id: pageId, active: false })];
  const found = rows.find(t => t.row_num === rowNum);
  expect(found).toBeDefined();
  return Number(found!.id);
}

describe('engine parity: take trust reads', () => {
  parityTest('readTakeRowTrust reads the stored claim and tier at a row number, null where the page has none', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'addTakesBatch', 'listTakes', 'readTakeRowTrust'],
  }, async (engine) => {
    const pageId = await page(engine, SLUG);
    await declaredWrite(engine, 'agent_written', { channel: 'agent' }, tx => tx.addTakesBatch([take(pageId, 1, 'agent claim')]));
    await engine.addTakesBatch([take(pageId, 2, 'undeclared claim')]);
    const one = await engine.readTakeRowTrust(pageId, 1);
    const two = await engine.readTakeRowTrust(pageId, 2);
    expect(one).toMatchObject({ claim: 'agent claim', trust_tier: 'agent_written' });
    expect(two).toMatchObject({ claim: 'undeclared claim', trust_tier: 'unknown' });
    expect(one!.id).toBe(await idAt(engine, pageId, 1));
    expect(two!.id).toBe(await idAt(engine, pageId, 2));
    expect(Object.keys(one!).sort()).toEqual(['claim', 'id', 'trust_tier']);
    const missing = await engine.readTakeRowTrust(pageId, 9);
    const otherPage = await engine.readTakeRowTrust(pageId + 1000, 1);
    expect(missing).toBeNull();
    expect(otherPage).toBeNull();
    return { one: { ...one, id: 'take@1' }, two: { ...two, id: 'take@2' }, missing, otherPage };
  });

  parityTest('readTakeRowTrust reads the tier a later content write restamped, inside the writing transaction', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'addTakesBatch', 'readTakeRowTrust'],
  }, async (engine) => {
    const pageId = await page(engine, SLUG);
    await declaredWrite(engine, 'tool_observed', { channel: 'tool' }, tx => tx.addTakesBatch([take(pageId, 1, 'first text')]));
    const inside = await declaredWrite(engine, 'agent_written', { channel: 'agent' }, async (tx) => {
      await tx.addTakesBatch([take(pageId, 1, 'second text')]);
      return tx.readTakeRowTrust(pageId, 1);
    }) as { claim: string; trust_tier: string } | null;
    const after = await engine.readTakeRowTrust(pageId, 1);
    expect(inside).toMatchObject({ claim: 'second text', trust_tier: 'agent_written' });
    expect(after).toMatchObject({ claim: 'second text', trust_tier: 'agent_written' });
    return { inside: { claim: inside!.claim, trust_tier: inside!.trust_tier }, after: { claim: after!.claim, trust_tier: after!.trust_tier } };
  });

  parityTest('readTakeTrustRef reads the source, claim, tier, origin in jsonb key order, activity and quarantine of a take', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'addTakesBatch', 'listTakes', 'supersedeTake', 'readTakeTrustRef'],
  }, async (engine) => {
    const pageId = await page(engine, SLUG);
    const quarantinedId = await page(engine, QUARANTINED, { quarantine: { reason: 'test' } });
    await declaredWrite(engine, 'agent_written', { zz: 1, a: { y: 1, x: 2 }, mm: 3 }, tx => tx.addTakesBatch([
      take(pageId, 1, 'agent claim'), take(pageId, 2, 'old claim'),
    ]));
    await engine.addTakesBatch([take(quarantinedId, 1, 'quarantined claim')]);
    await engine.supersedeTake(pageId, 2, { claim: 'new claim', kind: 'take', holder: 'world', weight: 0.5 });
    const read = async (pid: number, row: number) => {
      const id = await idAt(engine, pid, row);
      const ref = await engine.readTakeTrustRef(id);
      expect(ref).not.toBeNull();
      expect(ref!.id).toBe(id);
      return { ...ref!, id: `take@${row}`, originKeys: ref!.write_origin ? Object.keys(ref!.write_origin as object) : null };
    };
    const agent = await read(pageId, 1);
    const superseded = await read(pageId, 2);
    const quarantined = await read(quarantinedId, 1);
    expect(agent).toEqual({ id: 'take@1', source_id: 'default', claim: 'agent claim', trust_tier: 'agent_written',
      write_origin: { zz: 1, a: { y: 1, x: 2 }, mm: 3 }, active: true, quarantined: false, originKeys: ['a', 'mm', 'zz'] });
    expect(superseded).toMatchObject({ claim: 'old claim', active: false, quarantined: false });
    expect(quarantined).toEqual({ id: 'take@1', source_id: 'default', claim: 'quarantined claim', trust_tier: 'unknown',
      write_origin: null, active: true, quarantined: true, originKeys: null });
    const missing = await engine.readTakeTrustRef(987654321);
    expect(missing).toBeNull();
    return { agent, superseded, quarantined, missing, inner: Object.keys((agent.write_origin as Record<string, Record<string, number>>).a!) };
  });
});
