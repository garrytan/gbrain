/**
 * `entity names[]` fast path (low-hanging-fruit item 4): the batch resolves
 * each name through candidate selection alone, never assembling the full card
 * it used to throw away, and returns byte-identical rows to the old resolver
 * over adversarial names (helpers/entity-names-parity.ts), for remote and
 * local callers. The Postgres twin is test/e2e/entity-names-parity-postgres.test.ts.
 * The parity cases run with `entity.names_references` off: the reference
 * fields come from one batched read after the lookup and are pinned against
 * the full card by test/entity-records.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { lookupEntityNames } from '../src/core/verbs/entity-names.ts';
import { mentionBrain } from './helpers/mention-brain.ts';
import { addFillerPages, nameLookupPlans, PARITY_NAMES, referenceLookup, seedParityBrain } from './helpers/entity-names-parity.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = await mentionBrain(); await seedParityBrain(engine); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

describe('entity names[] parity with the full-card resolver', () => {
  beforeAll(async () => { await engine.setConfig('entity.names_references', 'false'); });
  afterAll(async () => { await engine.unsetConfig('entity.names_references'); });
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

  test('the fixtures cover what they claim', async () => {
    const remote = new Map((await lookupEntityNames(engine, 'default', PARITY_NAMES, { remote: true })).results.map(r => [r.name, r]));
    const local = new Map((await lookupEntityNames(engine, 'default', PARITY_NAMES, { remote: false })).results.map(r => [r.name, r]));
    expect(remote.get('Copper Fox')).toMatchObject({ found: true, slug: 'accounts/widget-co', siblings: [expect.objectContaining({ slug: 'crm/widget-co' })] });
    expect(remote.get('Harbor Example')).toMatchObject({ found: true, slug: 'companies/harbor-example' });
    expect(remote.get('crm/dual-co')).toMatchObject({ found: true, lead: 'Account: Dual Co. Region: APAC. Default source copy.' });
    expect(remote.get('Secret Co')).toMatchObject({ found: true, slug: 'companies/secret-co' });
    expect(remote.get('SCRT')).toMatchObject({ found: false });
    expect(local.get('SCRT')).toMatchObject({ found: true, slug: 'crm/secret-co' });
    expect(remote.get('Gone Co')?.found).toBe(false);
    expect(remote.get('Stale Alias Example')?.found).toBe(false);
    expect(remote.get('crm/kite-co')?.found).toBe(false);
    expect(local.get('crm/kite-co')).toMatchObject({ found: true, slug: 'crm/kite-co' });
    expect(remote.get('GLCO')).toEqual({ name: 'GLCO', found: false });
    expect(remote.get('Glass Heron')).toMatchObject({ found: true, slug: 'accounts/glass-co' });
    expect(remote.get('Glass Heron')).not.toHaveProperty('siblings');
    expect(local.get('Glass Heron')).toMatchObject({ siblings: [expect.objectContaining({ slug: 'crm/glass-co' })] });
    expect(remote.get('Junk Co')).toEqual({ name: 'Junk Co', found: false });
    expect(remote.get('Mixed Co')).toMatchObject({ found: true, slug: 'companies/mixed-co' });
    expect(remote.get('Nobody Example')?.found).toBe(false);
  });
});

describe('entity names[] reads no card fields', () => {
  test('no links, backlinks, timeline, facts, loops or page snapshots are read for a batch', async () => {
    const calls: string[] = [];
    const spy = engine as unknown as Record<string, (...a: unknown[]) => unknown>;
    const restore: Array<() => void> = [];
    for (const m of ['getLinks', 'getTimeline', 'listFactsByEntity', 'readPageSnapshotsBatch']) {
      const orig = spy[m]!;
      spy[m] = (...a: unknown[]) => { calls.push(m); return orig.apply(engine, a); };
      restore.push(() => { spy[m] = orig; });
    }
    const raw = spy.executeRaw!;
    spy.executeRaw = (...a: unknown[]) => {
      const sql = String(a[0]);
      if (/FROM open_loops|JOIN pages t ON t\.id = l\.to_page_id|FROM facts\s+WHERE source_id = \$1 AND entity_slug/.test(sql)) calls.push(sql.replace(/\s+/g, ' ').slice(0, 60));
      return raw.apply(engine, a);
    };
    restore.push(() => { spy.executeRaw = raw; });
    try {
      const out = await lookupEntityNames(engine, 'default', ['WGCO', 'Copper Fox', 'Harbor Example', 'Nobody Example'], { remote: true });
      expect(out.found).toBe(3);
    } finally {
      for (const r of restore) r();
    }
    expect(calls).toEqual([]);
  });
});

describe('entity names[] reads its per-batch settings once', () => {
  test('a batch of four found names reads config as often as a batch of one', async () => {
    const spy = engine as unknown as Record<string, (...a: unknown[]) => unknown>;
    const getConfig = spy.getConfig!, raw = spy.executeRaw!;
    let reads = 0;
    spy.getConfig = (...a: unknown[]) => { reads++; return getConfig.apply(engine, a); };
    spy.executeRaw = (...a: unknown[]) => { if (/\bFROM config\b/.test(String(a[0]))) reads++; return raw.apply(engine, a); };
    const count = async (names: string[]) => {
      reads = 0;
      expect((await lookupEntityNames(engine, 'default', names, { remote: true })).found).toBe(names.length);
      return reads;
    };
    try {
      const one = await count(['WGCO']);
      expect(one).toBeGreaterThan(0);
      expect(await count(['WGCO', 'Copper Fox', 'Harbor Example', 'crm/dual-co'])).toBe(one);
    } finally {
      spy.getConfig = getConfig;
      spy.executeRaw = raw;
    }
  });
});

describe('entity names[] lookups are index scans (v240)', () => {
  let sized: PGLiteEngine;
  beforeAll(async () => { sized = await mentionBrain(); await seedParityBrain(sized); await addFillerPages(sized, 5000); }, 120_000);
  afterAll(async () => { await sized.disconnect(); });

  test('on a 5,000-page brain the exact-title / slug / suffix arm and the alias title check use the v240 indexes', async () => {
    const plans = await nameLookupPlans(sized, () => lookupEntityNames(sized, 'default', ['WGCO', 'Harbor Example', 'kite-co'], { remote: true }));
    expect(plans.some(p => p.sql.startsWith('SELECT slug, source_id, title'))).toBe(true);
    expect(plans.some(p => p.sql.startsWith('WITH a AS MATERIALIZED'))).toBe(true);
    for (const p of plans) {
      const wanted = p.sql.startsWith('WITH a') ? ['idx_pages_source_title_lower'] : ['idx_pages_source_title_lower', 'idx_pages_slug_trgm'];
      expect({ sql: p.sql, seqScan: /Seq Scan on pages\b/.test(p.plan), indexes: wanted.filter(i => p.plan.includes(i)) })
        .toEqual({ sql: p.sql, seqScan: false, indexes: wanted });
    }
  });
});
