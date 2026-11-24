/**
 * BrainEngine parity: `entity names[]` with identity siblings (src/core/verbs/entity-names.ts lookupEntityNames), whose
 * sibling leads come from the entity card's hydrate read (`readEntityCardRows` with slugs).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm, a name that resolves to a page with an identity sibling answers the page, the
 *    sibling, and each one's lead from its own body; the same rows for a local and a remote caller.
 *  - Regression: the sibling bodies were read through executeRaw inside a catch that answered no rows, so on a Rust brain
 *    every sibling came back with no lead and no error (triage row core/verbs/entity-names.ts:105).
 *  - Why existing coverage misses it: test/entity-names-parity.test.ts runs on PGLite only.
 *  - Seam: none. Real engines and the real lookup; `entity.names_references` is off, so the reference reads (pinned by
 *    test/entity-records.test.ts) stay out of the case.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageType } from '../../src/core/types.ts';
import { lookupEntityNames } from '../../src/core/verbs/entity-names.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const page = (engine: BrainEngine, slug: string, type: string, title: string, body: string) =>
  engine.putPage(slug, { type: type as PageType, title, compiled_truth: body, timeline: '', frontmatter: {} });

describe('engine parity: entity names with identity siblings', () => {
  parityTest('a name with an identity sibling answers both pages with their own leads, for a local and a remote caller',
    { methods: ['readEntityCardRows'], timeout: 90_000 },
    async (engine) => {
      await engine.setConfig('schema_pack', 'gbrain-base-v2');
      await engine.setConfig('entity.names_references', 'false');
      await page(engine, 'accounts/widget-co', 'account', 'Account sheet: Widget Co', 'Account: Widget Co. Nickname used by the team: Copper Fox. Region: EMEA.');
      await page(engine, 'crm/widget-co', 'crm', 'CRM record: Widget Co', 'Account: Widget Co. Account code: WGCO.\n\nSegment: growth. Region: EMEA.');
      const view = async (remote: boolean) => {
        const out = await lookupEntityNames(engine, 'default', ['accounts/widget-co'], { remote });
        const [r] = out.results as Array<{ found: boolean; slug?: string; lead?: string; siblings?: Array<{ slug: string; lead: string | null }> }>;
        return { found: r?.found ?? null, slug: r?.slug ?? null, lead: r?.lead ?? null, siblings: (r?.siblings ?? []).map(s => ({ slug: s.slug, lead: s.lead })) };
      };
      const result = { local: await view(false), remote: await view(true) };
      expect(result.local).toEqual({ found: true, slug: 'accounts/widget-co', lead: 'Account: Widget Co. Nickname used by the team: Copper Fox. Region: EMEA.',
        siblings: [{ slug: 'crm/widget-co', lead: 'Account: Widget Co. Account code: WGCO. Segment: growth. Region: EMEA.' }] });
      expect(result.remote).toEqual(result.local);
      return result;
    });
});
