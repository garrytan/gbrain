/**
 * BrainEngine parity: findByTitleFuzzy's `dirPrefix` LIKE pattern matches in bounded time (review pass 2, finding F2 of PR 9730).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `slug LIKE ($dirPrefix || '/%')` treats `%` and `_` in the caller's prefix as wildcards. Postgres matches
 *    a pattern of many `%` against a long slug in time polynomial in the two lengths, so the call answers at once, with
 *    a hit or with null. The Rust arm must answer the same, and as fast.
 *  - Regression: the Rust matcher recursed on every `%` and tried every split of the text, so a prefix of 18 to 24
 *    `%a` groups and a final literal that the slug lacked ran for longer than the test timeout.
 *  - Why existing coverage misses it: the fuzzy cases use short slugs and prefixes of one or two wildcards.
 *  - Seam: none (typed methods only).
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

describe('findByTitleFuzzy with a wildcard-heavy dirPrefix', () => {
  parityTest(
    'a prefix of many `%a` groups answers at once, with a hit or with null',
    { methods: ['findByTitleFuzzy', 'putPage'] },
    async (engine) => {
      const input = { type: 'note' as const, title: 'Quasar Ledger', compiled_truth: 'body', timeline: '' };
      await engine.putPage(`${'a'.repeat(36)}/p`, input);
      await engine.putPage(`${'a'.repeat(36)}/q`, input);
      const find = (prefix: string) => engine.findByTitleFuzzy('Quasar Ledger', prefix, 0.5);
      const started = Date.now();
      const results = {
        // The final `b` is in no slug: no split of the text can match.
        noMatchShort: (await find(`${'%a'.repeat(18)}b`))?.slug ?? null,
        noMatchLong: (await find(`${'%a'.repeat(24)}b`))?.slug ?? null,
        // Every `%a` group fits in the 36 a's of both slugs: both match, and the lower slug wins. The two differ only in
        // their last letter, so the order does not depend on the database collation (a Postgres database sorts `/` away).
        match: (await find('%a'.repeat(18)))?.slug ?? null,
        // `_` and an escaped `%` in the prefix.
        underscores: (await find('_'.repeat(36)))?.slug ?? null,
        escaped: (await find('a\\%'))?.slug ?? null,
      };
      expect(Date.now() - started).toBeLessThan(2000);
      expect(results.noMatchShort).toBeNull();
      expect(results.noMatchLong).toBeNull();
      expect(results.match).toBe(`${'a'.repeat(36)}/p`);
      expect(results.underscores).toBe(`${'a'.repeat(36)}/p`);
      expect(results.escaped).toBeNull();
      return results;
    },
  );
});
