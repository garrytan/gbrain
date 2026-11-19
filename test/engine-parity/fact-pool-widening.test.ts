/**
 * BrainEngine parity — the fact relevance pool's world-only scope, widened per row for a member caller and a
 * private-facts grant.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the pool keeps world facts for a world-only scope through factVisibilitySql('f', ['world'])
 *    (poolWhere in engine-sql/facts-trust.ts), so listFactsForRelevance (the keyword and entity arms) and
 *    countUncomparableFacts also admit a private fact held on the caller's own member page while that page names the
 *    member as a reader (memberFactAdmitSql), and a private fact of a granted source whose pages keep it private for no
 *    reason (grantedPrivateFactSql). With and without `excludePrivate`, no caller sees a fact held on another member's
 *    page, a fact whose provenance page is private, or a fact its grant does not reach.
 *  - Regression: the Rust arm refused every world-only pool read once the caller's list was widened
 *    (store-members/facts-trust.ts poolArgs, 'visibility widened by member pages or grants').
 *  - Why existing coverage misses it: the pool cases in facts-trust.test.ts read as the no-caller record.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { CALLERS, ENTITY, fixture } from './fact-widening-fixture.ts';

const { parityTest } = parityArms(testBackends());

type Pool = { keyword: string[]; entity: string[]; uncomparable: Array<{ source_id: string; n: number }> };

/** The facts each pool read shows each caller, for one scope. */
async function poolByCaller(engine: BrainEngine, extra: { excludePrivate?: boolean; sourceIds?: string[] } = {}) {
  const scope = { sourceIds: extra.sourceIds ?? ['default'], worldOnly: true, excludePrivate: extra.excludePrivate === true };
  const out: Record<string, Pool> = {};
  for (const [name, caller] of Object.entries(CALLERS)) {
    out[name] = await withCallerAccess(caller, async () => ({
      keyword: sorted((await engine.listFactsForRelevance({ arm: 'keyword', scope, vector: null, terms: 'fact', limit: 50 })).map(r => r.fact)),
      entity: sorted((await engine.listFactsForRelevance({
        arm: 'entity', scope, vector: null, entity: { sourceId: 'default', slug: ENTITY }, limit: 50,
      })).map(r => r.fact)),
      uncomparable: sorted(await engine.countUncomparableFacts({ scope, dims: 1536, model: 'm1', declared: true }), r => r.source_id),
    }));
  }
  return out;
}

describe('engine parity: the fact relevance pool widens its world-only scope for a member and a private-facts grant', () => {
  parityTest(
    'a world-only pool admits the member\'s own member-page facts and the granted facts whose pages are open, and nothing else',
    { methods: ['putPage', 'insertFacts', 'listFactsForRelevance', 'countUncomparableFacts'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'other');
      await fixture(engine);
      const out = await poolByCaller(engine);
      expect(out.plain!.entity).toEqual(['world fact']);
      expect(out.alice!.entity).toEqual(['own member fact', 'world fact']);
      expect(out.granted!.entity).toEqual(['granted fact', 'world fact']);
      expect(out.grantedOther!.entity).toEqual(['world fact']);
      expect(out.aliceGranted!.entity).toEqual(['granted fact', 'own member fact', 'world fact']);
      for (const pool of Object.values(out)) {
        expect(pool.keyword).toEqual(pool.entity);
        expect(pool.uncomparable).toEqual([{ source_id: 'default', n: pool.entity.length }]);
      }
      const both = await poolByCaller(engine, { sourceIds: ['default', 'other'] });
      expect(both.grantedOther!.keyword).toEqual(['other source fact', 'world fact']);
      expect(both.granted!.keyword).toEqual(['granted fact', 'world fact']);
      return { out, both };
    },
  );

  parityTest(
    'with excludePrivate the widened pool still never shows a fact the provenance gate hides',
    { methods: ['putPage', 'insertFacts', 'listFactsForRelevance', 'countUncomparableFacts'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'other');
      await fixture(engine);
      const out = await poolByCaller(engine, { excludePrivate: true });
      for (const pool of Object.values(out)) {
        for (const hidden of ['other member fact', 'private holding fact', 'private provenance fact', 'readers holding fact', 'private entity fact']) {
          expect(pool.keyword).not.toContain(hidden);
        }
      }
      expect(out.alice!.keyword).toContain('own member fact');
      expect(out.granted!.keyword).toContain('granted fact');
      expect(out.plain!.keyword).toEqual(['world fact']);
      return out;
    },
  );
});
