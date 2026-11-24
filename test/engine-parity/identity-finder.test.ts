/**
 * Engine parity: the identity work that reads the entity key rows (engine.listEntityKeyRows) — the duplicate finder
 * (core/entities/duplicates.ts findDuplicateGroups), the fingerprint fill of bare "different" decisions
 * (core/entities/identity-decisions.ts fillDecisionEvidence) and the full company sweep that `gbrain dedupe reconcile`
 * runs (core/entities/company-auto-link.ts autoLinkCompanies with no `near`), across two sources.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Protects: on PGLite, Postgres and Rust the finder names the same groups (ids, kinds, classes, members, evidence),
 *    a bare "different" decision gets the same fingerprints, and a reconcile links, keeps and unlinks the same
 *    cross-source company pair.
 *  - Regression: the Rust store refused listEntityKeyRows (it kept no page generation), so `gbrain dedupe`, the
 *    evidence fill and `gbrain dedupe reconcile` stopped on a Rust brain; a Rust answer that drifts from the SQL
 *    engines' (a missed key, a different fingerprint, a group linked twice) now fails here. The evidence fill writes
 *    back the decisions it read, so a Rust apply that refused the `decided_at` text its own list returns
 *    (`2026-11-18 00:00:00+00`) stopped the fill.
 *  - Why existing coverage misses it: pages.test.ts reads the key rows and runs the sweep a sync starts (one changed
 *    page, `near`), not the finder's whole answer, the evidence fill or the sweep over every company;
 *    test/entity-duplicates.test.ts and test/entity-company-auto-link.test.ts run on PGLite only.
 *  - Seam: none; real engines, seeded pages and decisions. Page ids and generations never leave the engine here: the
 *    cases compare slugs, entity ids and counts, since a Rust generation is an equality-only token.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { autoLinkCompanies } from '../../src/core/entities/company-auto-link.ts';
import { findDuplicateGroups } from '../../src/core/entities/duplicates.ts';
import { decidedSets, fillDecisionEvidence } from '../../src/core/entities/identity-decisions.ts';
import type { PageInput } from '../../src/core/types.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const OTHER = 'other-src';
const ACME_IDS = { linkedin: 'https://www.linkedin.com/company/acme-example/', website: 'https://acme-example.com' };
const company = (title: string, frontmatter: Record<string, unknown> = {}): PageInput =>
  ({ type: 'company', title, compiled_truth: `${title} builds widgets.`, timeline: '', frontmatter });
const person = (title: string, frontmatter: Record<string, unknown> = {}): PageInput =>
  ({ type: 'person', title, compiled_truth: `${title} works on widgets.`, timeline: '', frontmatter });
const ref = (source_id: string, slug: string) => ({ source_id, slug });

/** Every live membership as `source|slug|entity|established_by|canonical`, sorted. */
async function identities(engine: BrainEngine) {
  return (await engine.listEntityIdentityRows({}))
    .map(r => `${r.source_id}|${r.slug}|${r.entity_id}|${r.established_by}|${r.canonical}`)
    .sort();
}

describe('engine parity: the identity work that reads entity key rows', () => {
  parityTest(
    'findDuplicateGroups names the same cross-source company pair and in-source person pair, and a "different" decision keeps a pair apart',
    { methods: ['putPage', 'listEntityKeyRows', 'listIdentityDecisions', 'applyIdentityDecisions'] },
    async (engine, backend) => {
      await createSource(engine, backend, OTHER);
      await engine.putPage('companies/acme-example', company('Acme Example', ACME_IDS));
      await engine.putPage('companies/acme-example', company('Acme Example', ACME_IDS), { sourceId: OTHER });
      await engine.putPage('people/alice-example', person('Alice Example', { email: 'alice@example.com' }));
      await engine.putPage('people/alice-example-2', person('Alice Example', { email: 'alice@example.com' }));
      await engine.putPage('people/charlie-example', person('Charlie Example', { email: 'charlie@example.com' }));
      await engine.putPage('companies/widget-co', company('Widget Co', { website: 'https://widget-co.example' }));

      const before = await findDuplicateGroups(engine);
      expect(before.groups.map(g => [g.kind, g.members.map(m => `${m.source_id}:${m.slug}`).sort()]).sort()).toEqual([
        ['cross_source', ['default:companies/acme-example', `${OTHER}:companies/acme-example`]],
        ['in_source', ['default:people/alice-example', 'default:people/alice-example-2']],
      ]);

      await engine.applyIdentityDecisions({ upsert: [{
        decision_id: '00000000000000a1', verdict: 'different',
        members: [ref('default', 'people/alice-example'), ref('default', 'people/alice-example-2')],
        group_id: null, entity_id: null, canonical: null, decided_by: 'owner', decided_at: '2026-11-18T00:00:00Z',
        origin: 'database', home_source_id: null, git_blob: null,
      }] });
      const after = await findDuplicateGroups(engine, { decided: decidedSets(await engine.listIdentityDecisions()) });
      expect(after.groups.map(g => g.kind)).toEqual(['cross_source']);
      return { before, after };
    },
  );

  parityTest(
    'fillDecisionEvidence fills a bare "different" decision with its pages\' fingerprints once, in the database only',
    { methods: ['putPage', 'listEntityKeyRows', 'listIdentityDecisions', 'applyIdentityDecisions'] },
    async (engine) => {
      await engine.putPage('companies/acme-example', company('Acme Example', { website: 'https://acme-example.com' }));
      await engine.putPage('companies/acme-example-inc', company('Acme Example Inc', { website: 'https://acme-example.com' }));
      const members = [ref('default', 'companies/acme-example'), ref('default', 'companies/acme-example-inc')];
      const decision = (decision_id: string, slugs: typeof members) => ({
        decision_id, verdict: 'different' as const, members: slugs, group_id: null, entity_id: null, canonical: null,
        decided_by: 'owner', decided_at: '2026-11-18T00:00:00Z', origin: 'database' as const, home_source_id: null, git_blob: null,
      });
      // The second decision names a page that does not exist, so it keeps one fingerprint and stays bare.
      await engine.applyIdentityDecisions({ upsert: [decision('00000000000000b1', members),
        decision('00000000000000b2', [members[0]!, ref('default', 'companies/gone-example')])] });
      const filled = await fillDecisionEvidence(engine);
      const again = await fillDecisionEvidence(engine);
      const evidence = (await engine.listIdentityDecisions()).decisions.map(d => [d.decision_id, d.evidence]);
      expect([filled, again]).toEqual([1, 0]);
      expect(evidence.map(([id, e]) => [id, Array.isArray(e) ? e.map(f => /^[0-9a-f]{32}$/.test(f)) : e])).toEqual([
        ['00000000000000b1', [true, true]], ['00000000000000b2', null]]);
      return { filled, again, evidence };
    },
  );

  parityTest(
    'a reconcile (autoLinkCompanies over every company) links a cross-source pair that shares an id, keeps it, and unlinks it when the ids part',
    { methods: ['putPage', 'listEntityKeyRows', 'listIdentityDecisions', 'applyIdentityDecisions', 'listEntityIdentityRows'] },
    async (engine, backend) => {
      await createSource(engine, backend, OTHER);
      await engine.putPage('companies/acme-example', company('Acme Example', ACME_IDS));
      await engine.putPage('companies/acme-example', company('Acme Example', ACME_IDS), { sourceId: OTHER });
      await engine.putPage('companies/widget-co', company('Widget Co', { website: 'https://widget-co.example' }));

      const steps: Array<{ result: Awaited<ReturnType<typeof autoLinkCompanies>>; rows: string[] }> = [];
      const step = async () => { steps.push({ result: await autoLinkCompanies(engine), rows: await identities(engine) }); };
      await step();
      await step();
      await engine.putPage('companies/acme-example', company('Acme Example', {
        linkedin: 'https://www.linkedin.com/company/widget-co/', website: 'https://widget-co.example' }), { sourceId: OTHER });
      await step();

      expect(steps.map(s => s.result)).toEqual([
        { scope: 'all', planned: 1, linked: 1, unlinked: 0, skipped: 0 },
        { scope: 'all', planned: 1, linked: 0, unlinked: 0, skipped: 0 },
        { scope: 'all', planned: 0, linked: 0, unlinked: 1, skipped: 0 },
      ]);
      expect(steps[0]!.rows.map(r => r.split('|').slice(0, 2).concat(r.split('|').slice(3)).join('|'))).toEqual([
        `default|companies/acme-example|dedupe:auto|true`, `${OTHER}|companies/acme-example|dedupe:auto|false`]);
      expect(steps[1]!.rows).toEqual(steps[0]!.rows);
      expect(steps[2]!.rows).toEqual([]);
      return steps;
    },
  );
});
