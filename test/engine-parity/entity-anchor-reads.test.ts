/**
 * BrainEngine parity — the entity anchor's titled-page read (`namedEntity`, search/entity-anchor.ts) under
 * `excludePrivate` for the remote callers the store serves.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `namedEntity` names the one readable entity page whose title a query mentions. Fact relevance
 *    (`memory_recall`, `recall`) and the current-state search anchor call it with `excludePrivate` for a remote caller.
 *    On a brain with no member restriction (`restricted: false`, the stdio MCP caller of a fresh brain) a private
 *    entity page is not named for a plain or member caller, and is named for a caller with a private-readable grant
 *    on its source. On a brain with member restrictions a page that names readers is named only for a caller who
 *    meets them. Every engine arm names the same page.
 *  - Regression: the Rust arm compared the unrestricted caller's short member-access form with the no-caller text,
 *    found them different and refused listPagesTitledIn, so MCP memory_recall on a Rust brain stopped at
 *    entity-anchor.ts:79 with a typed refusal instead of ranking the entity's facts.
 *  - Why existing coverage misses it: link-reads pins listPagesTitledIn for restricted callers only, and
 *    unrestricted-caller-reads does not read titled pages. Neither calls `namedEntity`, whose title filter decides.
 *  - Seam: none. Real engines, typed methods only. The unrestricted fixture writes no `readable_by` page, as the
 *    premise of the short form requires.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess, type CallerAccess } from '../../src/core/search/private-visibility.ts';
import { namedEntity } from '../../src/core/search/entity-anchor.ts';

const { parityTest } = parityArms(testBackends());

async function entity(engine: BrainEngine, slug: string, type: 'company' | 'person', title: string, frontmatter: Record<string, unknown> = {}) {
  await engine.putPage(slug, { type, title, compiled_truth: `${title} body`, timeline: '', frontmatter });
}

/** The slug `namedEntity` names for `query` under `access`, read as the remote fact-relevance arm reads it. */
async function named(engine: BrainEngine, query: string, access: Partial<CallerAccess>): Promise<string | null> {
  const page = await withCallerAccess(access, () => namedEntity(engine, query, { sourceIds: ['default'], excludePrivate: true }));
  return page ? `${page.source_id}:${page.slug}` : null;
}

describe('entity anchor reads under excludePrivate', () => {
  parityTest(
    'an unrestricted remote caller is named the open entity, and the private one only with a private-readable grant',
    { methods: ['putPage', 'listPagesTitledIn'] },
    async (engine) => {
      await entity(engine, 'companies/acme-example', 'company', 'Acme Example');
      await entity(engine, 'companies/widget-co', 'company', 'Widget Co', { visibility: 'private' });
      const callers: Record<string, Partial<CallerAccess>> = {
        plain: { identity: [], hidePrivate: true, restricted: false },
        member: { identity: ['member:alice-example'], hidePrivate: true, restricted: false },
        granted: { identity: [], privateReadableSources: ['default'], hidePrivate: true, restricted: false },
      };
      const out: Record<string, Record<string, string | null>> = {};
      for (const [name, access] of Object.entries(callers)) {
        out[name] = {
          acme: await named(engine, 'what is acme example doing now', access),
          widget: await named(engine, 'what is widget co doing now', access),
          both: await named(engine, 'acme example and widget co', access),
        };
      }
      expect(out.plain).toEqual({ acme: 'default:companies/acme-example', widget: null, both: 'default:companies/acme-example' });
      expect(out.member).toEqual(out.plain);
      expect(out.granted).toEqual({ acme: 'default:companies/acme-example', widget: 'default:companies/widget-co', both: null });
      return out;
    },
  );

  parityTest(
    'a restricted remote caller is named an entity that names readers only when the caller meets them',
    { methods: ['putPage', 'listPagesTitledIn'] },
    async (engine) => {
      await entity(engine, 'companies/acme-example', 'company', 'Acme Example');
      await entity(engine, 'people/alice-example', 'person', 'Alice Example', { readable_by: ['alice-example'] });
      await entity(engine, 'people/charlie-example', 'person', 'Charlie Example', { readable_by: 'group:team-a' });
      const callers: Record<string, Partial<CallerAccess>> = {
        plain: { identity: [], hidePrivate: true },
        alice: { identity: ['member:alice-example'], hidePrivate: true },
        team: { identity: ['member:bob-example', 'group:team-a'], hidePrivate: true },
      };
      const out: Record<string, Record<string, string | null>> = {};
      for (const [name, access] of Object.entries(callers)) {
        out[name] = {
          alice: await named(engine, 'is alice example still at acme example', access),
          charlie: await named(engine, 'what does charlie example do now', access),
        };
      }
      expect(out.plain).toEqual({ alice: 'default:companies/acme-example', charlie: null });
      expect(out.alice).toEqual({ alice: null, charlie: null });
      expect(out.team).toEqual({ alice: 'default:companies/acme-example', charlie: 'default:people/charlie-example' });
      return out;
    },
  );
});
