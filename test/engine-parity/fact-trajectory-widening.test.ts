/**
 * BrainEngine parity — findTrajectory's world-only read, widened per row for a member caller and a private-facts grant.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a remote findTrajectory keeps world facts through factVisibilitySql('facts', ['world'])
 *    (access/member-facts.ts), so it also shows a private fact held on the caller's own member page while that page
 *    names the member as a reader (memberFactAdmitSql), and a private fact of a granted source whose pages keep it
 *    private for no reason (grantedPrivateFactSql). With and without `excludePrivate`, no caller sees a fact held on
 *    another member's page, a fact whose provenance page is private, or a fact its grant does not reach. A local read
 *    (`remote: false`) shows every unexpired fact of the entity to every caller.
 *  - Regression: the Rust arm refused every remote findTrajectory once the caller's list was widened
 *    (store-members/facts.ts, 'visibility widened by member pages or grants').
 *  - Why existing coverage misses it: the findTrajectory cases in facts.test.ts read as the no-caller record.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { CALLERS, ENTITY, fixture } from './fact-widening-fixture.ts';

const { parityTest } = parityArms(testBackends());

/** The facts findTrajectory shows each caller for one shape of the read. */
async function trajectoryByCaller(engine: BrainEngine, shape: Record<string, unknown>, sourceIds = ['default']) {
  const out: Record<string, string[]> = {};
  for (const [name, caller] of Object.entries(CALLERS)) {
    out[name] = await withCallerAccess(caller, async () =>
      sorted((await engine.findTrajectory({ entitySlug: ENTITY, sourceIds, ...shape })).map(p => p.text)));
  }
  return out;
}

describe('engine parity: findTrajectory widens its world-only read for a member and a private-facts grant', () => {
  parityTest(
    'a remote read admits the member\'s own member-page facts and the granted facts whose pages are open, and nothing else',
    { methods: ['putPage', 'insertFacts', 'findTrajectory'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'other');
      await fixture(engine);
      const out = await trajectoryByCaller(engine, { remote: true });
      expect(out.plain).toEqual(['world fact']);
      expect(out.alice).toEqual(['own member fact', 'world fact']);
      expect(out.granted).toEqual(['granted fact', 'world fact']);
      expect(out.grantedOther).toEqual(['world fact']);
      expect(out.aliceGranted).toEqual(['granted fact', 'own member fact', 'world fact']);
      const both = await trajectoryByCaller(engine, { remote: true }, ['default', 'other']);
      expect(both.grantedOther).toEqual(['other source fact', 'world fact']);
      expect(both.granted).toEqual(['granted fact', 'world fact']);
      return { out, both };
    },
  );

  parityTest(
    'with excludePrivate the widened read still never shows a fact the provenance gate hides',
    { methods: ['putPage', 'insertFacts', 'findTrajectory'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'other');
      await fixture(engine);
      const out = await trajectoryByCaller(engine, { remote: true, excludePrivate: true });
      for (const facts of Object.values(out)) {
        for (const hidden of ['other member fact', 'private holding fact', 'private provenance fact', 'readers holding fact']) {
          expect(facts).not.toContain(hidden);
        }
      }
      expect(out.alice).toContain('own member fact');
      expect(out.granted).toContain('granted fact');
      expect(out.plain).toEqual(['world fact']);
      return out;
    },
  );

  parityTest(
    'a local read is not widened: every caller reads every unexpired fact of the entity',
    { methods: ['putPage', 'insertFacts', 'findTrajectory'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'other');
      await fixture(engine);
      const out = await trajectoryByCaller(engine, { remote: false });
      for (const facts of Object.values(out)) expect(facts).toEqual(out.plain!);
      expect(out.plain).toContain('private holding fact');
      return out;
    },
  );
});
