/**
 * `entity names[]` fast path on Postgres (low-hanging-fruit item 4): the batch
 * returns byte-identical rows to the old full-card resolver over the
 * adversarial fixtures in test/helpers/entity-names-parity.ts, for remote and
 * local callers and from a second source. The PGLite twin is
 * test/entity-names-parity.test.ts. Runs only when DATABASE_URL is set. The
 * parity cases run with `entity.names_references` off (the reference fields
 * are pinned against the full card by test/e2e/entity-records-postgres.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { setCliOptions } from '../../src/core/cli-options.ts';
import { lookupEntityNames } from '../../src/core/verbs/entity-names.ts';
import { addFillerPages, nameLookupPlans, PARITY_NAMES, referenceLookup, seedParityBrain } from '../helpers/entity-names-parity.ts';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

(hasDatabase() ? describe : describe.skip)('entity names[] parity on Postgres', () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null });
    await setupDB();
    engine = await getEngine();
    await engine.setConfig('schema_pack', 'gbrain-base-v2');
    await seedParityBrain(engine);
    await engine.setConfig('entity.names_references', 'false');
  }, 120_000);
  afterAll(async () => { await teardownDB(); });

  for (const remote of [true, false]) {
    test(`${remote ? 'remote' : 'local'} rows are byte-identical, per name and as one batch`, async () => {
      const batch = await lookupEntityNames(engine, 'default', PARITY_NAMES, { remote });
      expect(JSON.stringify(batch)).toBe(JSON.stringify(await referenceLookup(engine, 'default', PARITY_NAMES, { remote })));
      for (const name of PARITY_NAMES) {
        expect(JSON.stringify(await lookupEntityNames(engine, 'default', [name], { remote })))
          .toBe(JSON.stringify(await referenceLookup(engine, 'default', [name], { remote })));
      }
      expect(batch.found).toBeGreaterThan(10);
      expect(batch.missing).toBeGreaterThan(5);
    });
  }

  test('the other source resolves its own copy of a shared slug', async () => {
    const names = ['crm/dual-co', 'Dual Co', 'Other Only Example', 'WGCO'];
    const out = await lookupEntityNames(engine, 'other', names, { remote: true });
    expect(JSON.stringify(out)).toBe(JSON.stringify(await referenceLookup(engine, 'other', names, { remote: true })));
    expect(out.results[0]).toMatchObject({ found: true, lead: 'Account: Dual Co. Region: OTHER-SOURCE copy.' });
  });

  test('on a 5,000-page brain the exact-title / slug / suffix arm and the alias title check use the v240 indexes', async () => {
    await addFillerPages(engine, 5000);
    const plans = await nameLookupPlans(engine, () => lookupEntityNames(engine, 'default', ['WGCO', 'Harbor Example', 'kite-co'], { remote: true }));
    expect(plans.some(p => p.sql.startsWith('SELECT slug, source_id, title'))).toBe(true);
    expect(plans.some(p => p.sql.startsWith('WITH a AS MATERIALIZED'))).toBe(true);
    for (const p of plans) {
      const wanted = p.sql.startsWith('WITH a') ? ['idx_pages_source_title_lower'] : ['idx_pages_source_title_lower', 'idx_pages_slug_trgm'];
      expect({ sql: p.sql, seqScan: /Seq Scan on pages\b/.test(p.plan), indexes: wanted.filter(i => p.plan.includes(i)) })
        .toEqual({ sql: p.sql, seqScan: false, indexes: wanted });
    }
  });
});
