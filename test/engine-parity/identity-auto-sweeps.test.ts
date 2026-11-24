/**
 * Engine parity: the automatic company groups ('dedupe:auto', core/entities/company-auto-link.ts) that
 * applyIdentityDecisions removes (engine-sql/identity-decisions.ts). Every apply sweeps the automatic groups a decision
 * now covers and the ones left with one member, no canonical member or a deleted member; `auto.unlink` removes the
 * groups the company sweep names. The groups are seeded through linkEntityIdentityRow, as a sync's link leaves them.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Protects: an apply on a brain that holds a sync-made company link answers the same on PGLite, Postgres and Rust,
 *    and removes the same automatic groups, leaving hand links and other automatic groups alone.
 *  - Regression: the Rust store refused every apply while it held a 'dedupe:auto' row (invalid_state) and refused the
 *    `auto` option outright, so `gbrain dedupe` and the sync's decision hook stopped on a Rust brain.
 *  - Why existing coverage misses it: pages.test.ts seeds no automatic group, and test/entity-company-auto-link.test.ts
 *    runs on PGLite only.
 *  - Seam: none; real engines, seeded pages and links. auto.link (writing a planned group) is covered by
 *    pages.test.ts and identity-finder.test.ts.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const COMPANY = (title: string): PageInput => ({ type: 'company', title, compiled_truth: `${title} builds widgets.`, timeline: '' });
const ref = (slug: string) => ({ source_id: 'default', slug });

async function seed(engine: BrainEngine, slugs: string[]) {
  for (const slug of slugs) await engine.putPage(slug, COMPANY(slug.split('/')[1]!));
}

async function link(engine: BrainEngine, entityId: string, slug: string, establishedBy: string, canonical: boolean) {
  await engine.linkEntityIdentityRow({ entityId, slug, sourceId: 'default', confidence: 1, establishedBy, canonical });
}

/** Every live membership as `entity|slug|established_by|canonical`, sorted. */
async function rows(engine: BrainEngine) {
  return (await engine.listEntityIdentityRows({}))
    .map(r => `${r.entity_id}|${r.slug}|${r.established_by}|${r.canonical}`)
    .sort();
}

function decision(decision_id: string, verdict: 'same' | 'different', slugs: string[]) {
  return {
    decision_id, verdict, members: slugs.map(ref), group_id: `dedupe/${decision_id}`,
    entity_id: verdict === 'same' ? `dedupe/${decision_id}` : null, canonical: verdict === 'same' ? ref(slugs[0]!) : null,
    decided_by: 'owner', decided_at: '2026-11-18T00:00:00Z', origin: 'database' as const, home_source_id: null, git_blob: null,
  };
}

describe('engine parity: automatic company groups in applyIdentityDecisions', () => {
  parityTest(
    "auto.unlink removes the named automatic groups only, and an apply without auto leaves a sync-made link alone",
    { methods: ['putPage', 'linkEntityIdentityRow', 'applyIdentityDecisions', 'listEntityIdentityRows'] },
    async (engine) => {
      await seed(engine, ['companies/acme-a', 'companies/acme-b', 'companies/widget-a', 'companies/widget-b', 'companies/globex-a', 'companies/globex-b']);
      await link(engine, 'auto/acme', 'companies/acme-a', 'dedupe:auto', true);
      await link(engine, 'auto/acme', 'companies/acme-b', 'dedupe:auto', false);
      await link(engine, 'auto/widget', 'companies/widget-a', 'dedupe:auto', true);
      await link(engine, 'auto/widget', 'companies/widget-b', 'dedupe:auto', false);
      await link(engine, 'hand/globex', 'companies/globex-a', 'manual', true);
      await link(engine, 'hand/globex', 'companies/globex-b', 'manual', false);
      const plain = await engine.applyIdentityDecisions({});
      const afterPlain = await rows(engine);
      const unlinked = await engine.applyIdentityDecisions({ auto: { link: [], unlink: ['auto/acme', 'auto/none'] } });
      const after = await rows(engine);
      expect(plain).toEqual({ upserted: 0, removed: 0, linked: 0, unlinked: 0 });
      expect(afterPlain).toHaveLength(6);
      expect(unlinked).toEqual({ upserted: 0, removed: 0, linked: 0, unlinked: 0, auto: { linked: 0, unlinked: 1, skipped: 0 } });
      expect(after).toEqual([
        'auto/widget|companies/widget-a|dedupe:auto|true', 'auto/widget|companies/widget-b|dedupe:auto|false',
        'hand/globex|companies/globex-a|manual|true', 'hand/globex|companies/globex-b|manual|false',
      ]);
      return { plain, afterPlain, unlinked, after };
    },
  );

  parityTest(
    'a "same" or "different" decision over an automatic group removes it, the confirm takes over, and removing the decision undoes the confirm',
    { methods: ['putPage', 'linkEntityIdentityRow', 'applyIdentityDecisions', 'listEntityIdentityRows', 'listIdentityDecisions'] },
    async (engine) => {
      await seed(engine, ['companies/acme-a', 'companies/acme-b', 'companies/widget-a', 'companies/widget-b', 'companies/globex-a', 'companies/globex-b', 'companies/other-example']);
      for (const name of ['acme', 'widget', 'globex']) {
        await link(engine, `auto/${name}`, `companies/${name}-a`, 'dedupe:auto', true);
        await link(engine, `auto/${name}`, `companies/${name}-b`, 'dedupe:auto', false);
      }
      const applied = await engine.applyIdentityDecisions({
        upsert: [
          decision('0000000000000001', 'same', ['companies/acme-a', 'companies/acme-b']),
          decision('0000000000000002', 'different', ['companies/widget-a', 'companies/widget-b']),
          // One member of auto/globex and a page outside it: the group stays.
          decision('0000000000000003', 'different', ['companies/globex-a', 'companies/other-example']),
        ],
        auto: { link: [], unlink: [] },
      });
      const confirmed = await rows(engine);
      const pending = (await engine.listIdentityDecisions()).pending;
      const undone = await engine.applyIdentityDecisions({ remove: ['0000000000000001'], auto: { link: [], unlink: [] } });
      const after = await rows(engine);
      expect(applied).toEqual({ upserted: 3, removed: 0, linked: 2, unlinked: 0, auto: { linked: 0, unlinked: 2, skipped: 0 } });
      expect(confirmed).toEqual([
        'auto/globex|companies/globex-a|dedupe:auto|true', 'auto/globex|companies/globex-b|dedupe:auto|false',
        'dedupe/0000000000000001|companies/acme-a|dedupe:confirm|true', 'dedupe/0000000000000001|companies/acme-b|dedupe:confirm|false',
      ]);
      expect(undone).toEqual({ upserted: 0, removed: 1, linked: 0, unlinked: 2, auto: { linked: 0, unlinked: 0, skipped: 0 } });
      expect(after).toEqual(['auto/globex|companies/globex-a|dedupe:auto|true', 'auto/globex|companies/globex-b|dedupe:auto|false']);
      return { applied, confirmed, pending, undone, after };
    },
  );

  parityTest(
    'every apply removes automatic groups left with one member, no canonical member or a deleted member',
    { methods: ['putPage', 'linkEntityIdentityRow', 'softDeletePage', 'applyIdentityDecisions', 'listEntityIdentityRows'] },
    async (engine) => {
      await seed(engine, ['companies/acme-a', 'companies/widget-a', 'companies/widget-b', 'companies/globex-a', 'companies/globex-b',
        'companies/initech-a', 'companies/initech-b', 'companies/hooli-a']);
      await link(engine, 'auto/one', 'companies/acme-a', 'dedupe:auto', true);
      await link(engine, 'auto/no-canonical', 'companies/widget-a', 'dedupe:auto', false);
      await link(engine, 'auto/no-canonical', 'companies/widget-b', 'dedupe:auto', false);
      await link(engine, 'auto/deleted', 'companies/globex-a', 'dedupe:auto', true);
      await link(engine, 'auto/deleted', 'companies/globex-b', 'dedupe:auto', false);
      await link(engine, 'auto/kept', 'companies/initech-a', 'dedupe:auto', true);
      await link(engine, 'auto/kept', 'companies/initech-b', 'dedupe:auto', false);
      await link(engine, 'hand/one', 'companies/hooli-a', 'manual', true);
      await engine.softDeletePage('companies/globex-b');
      const swept = await engine.applyIdentityDecisions({ auto: { link: [], unlink: [] } });
      const after = await rows(engine);
      const again = await engine.applyIdentityDecisions({ auto: { link: [], unlink: [] } });
      expect(swept).toEqual({ upserted: 0, removed: 0, linked: 0, unlinked: 0, auto: { linked: 0, unlinked: 3, skipped: 0 } });
      expect(after).toEqual([
        'auto/kept|companies/initech-a|dedupe:auto|true', 'auto/kept|companies/initech-b|dedupe:auto|false', 'hand/one|companies/hooli-a|manual|true',
      ]);
      expect(again).toEqual({ upserted: 0, removed: 0, linked: 0, unlinked: 0, auto: { linked: 0, unlinked: 0, skipped: 0 } });
      return { swept, after, again };
    },
  );
});
