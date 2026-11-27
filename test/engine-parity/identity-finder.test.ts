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
 *    (`2026-11-18 00:00:00+00`) stopped the fill. A `decided_at` with a non-ASCII character where the zone is looked for
 *    made the Rust apply panic (a byte slice inside a character); it must refuse as the SQL cast does, write nothing,
 *    and keep non-ASCII slugs and deciders as they were sent.
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
    'listEntityKeyRows with collapsed reads the retired pages a dedupe collapse made, and without it only the live unretired ones (master #10313)',
    { methods: ['putPage', 'listEntityKeyRows'] },
    async (engine) => {
      await engine.putPage('people/dana-example', person('Dana Example', { email: 'dana@example.com' }));
      await engine.putPage('people/dana-example-2', person('Dana Example', { email: 'dana@example.com', merged_into: 'people/dana-example', dedupe_collapse: { at: '2026-11-25' } }));
      await engine.putPage('people/dana-example-3', person('Dana Example', { email: 'dana@example.com', merged_into: '  ', dedupe_collapse: null }));
      await engine.putPage('people/dana-example-4', person('Dana Example', { email: 'dana@example.com', merged_into: 'people/dana-example' }));
      const read = async (collapsed?: boolean) => (await engine.listEntityKeyRows({ types: ['person'], keys: ['email'], limit: 50, ...(collapsed ? { collapsed } : {}) })).map(r => r.slug);
      const out = { live: await read(), collapsed: await read(true) };
      expect(out.collapsed).toEqual(['people/dana-example-2']);
      expect(out.live).toEqual(['people/dana-example', 'people/dana-example-3']);
      return out;
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

  parityTest('applyIdentityDecisions refuses a non-ASCII decided_at without writing, and keeps non-ASCII slugs and deciders', {
    methods: ['putPage', 'applyIdentityDecisions', 'listIdentityDecisions'],
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const slug = 'people/zo\u00eb-example';
    await engine.putPage(slug, person('Zo\u00eb Example'));
    await engine.putPage(slug, person('Zo\u00eb Example'), { sourceId: OTHER });
    const decision = (decided_at: string) => ({
      decision_id: '00000000000000cd', verdict: 'different' as const, members: [ref('default', slug), ref(OTHER, slug)],
      group_id: null, entity_id: null, canonical: null, decided_by: 'Zo\u00eb \u6771\u4eac', decided_at, origin: 'database' as const,
      home_source_id: null, git_blob: null,
    });
    // Byte 19 falls inside a character in each: the SQL cast refuses them, and so must the Rust apply.
    // Each arm refuses the text as not a timestamp, before any write: Postgres with 22007 (invalid input syntax for
    // timestamptz), PGLite's driver with "Invalid Date" before the statement, Rust with invalid_argument naming
    // decided_at. A panic surfaced as internal_error, or any other failure, keeps its own code and fails the case.
    const classify = (e: unknown) => {
      const x = e as { code?: unknown; message?: unknown };
      const message = String(x.message ?? '');
      const invalid = x.code === '22007' || message === 'Invalid Date'
        || (x.code === 'invalid_argument' && message.includes('decided_at is not a timestamp'));
      return invalid ? 'not_a_timestamp' : `${String(x.code)}: ${message.slice(0, 80)}`;
    };
    const refused: Array<{ text: string; outcome: string }> = [];
    for (const text of ['2026-11-18 00:00:0\u00e9+00', '2026-11-18 00:00:\u2160+00', '\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}']) {
      const outcome = await engine.applyIdentityDecisions({ upsert: [decision(text)] }).then(() => 'applied', classify);
      refused.push({ text, outcome });
    }
    const afterRefusals = (await engine.listIdentityDecisions()).decisions.length;
    await engine.applyIdentityDecisions({ upsert: [decision('2026-11-18T00:00:00Z')] });
    const [kept] = (await engine.listIdentityDecisions()).decisions;
    const result = { refused, afterRefusals, kept: { decided_by: kept?.decided_by, members: kept?.members, day: kept?.decided_at.slice(0, 10) } };
    expect(result.refused.map(r => r.outcome)).toEqual(['not_a_timestamp', 'not_a_timestamp', 'not_a_timestamp']);
    expect(result.afterRefusals).toBe(0);
    expect(result.kept).toEqual({ decided_by: 'Zo\u00eb \u6771\u4eac', members: [ref('default', slug), ref(OTHER, slug)], day: '2026-11-18' });
    return result;
  });

});
