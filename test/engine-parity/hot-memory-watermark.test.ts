/**
 * BrainEngine parity — the hot-memory watermark that every MCP tool call reads before it attaches
 * `_meta.brain_hot_memory` (facts/meta-hook.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a fresh source every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts) gives the same watermark on a fresh source, and each recorded withdrawal changes
 *    the watermark and its count while the access-rule part stays the same.
 *  - Regression: withdrawalWatermark sent its SELECT through executeRaw, so on a Rust brain every MCP tool call that
 *    builds hot memory (entity first) stopped on the raw_sql refusal before anything else. The build's next read,
 *    readTrustGeneration (eligibility/generation.ts), still runs raw SQL and is not covered here.
 *  - Why existing coverage misses it: the meta-hook tests run on PGLite only, and the trust parity cases compare the
 *    withdrawal ledger members, not the watermark the cache reads.
 *  - Seam: none. The watermark is an opaque token: each case compares the fresh-source token, which every arm spells
 *    alike, and how the token moves, not the spelling of a token after a withdrawal (PGLite and Postgres carry the
 *    latest withdrawal time, the Rust store a digest of the ledger keys).
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

/** md5('') twice: no access rule and no pending coverage row. */
const NO_RULES = 'd41d8cd98f00b204e9800998ecf8427e:d41d8cd98f00b204e9800998ecf8427e';

describe('engine parity: the hot-memory watermark', () => {
  parityTest('a fresh source has the same watermark on every engine', { methods: ['readHotMemoryWatermark'] },
    async (engine) => {
      const watermark = await engine.readHotMemoryWatermark('default');
      expect(watermark).toBe(`0::${NO_RULES}`);
      return watermark;
    });

  parityTest('each recorded withdrawal changes the watermark and its count, and only for its source', { methods: ['readHotMemoryWatermark', 'insertFactWithdrawal'] },
    async (engine) => {
      const before = await engine.readHotMemoryWatermark('default');
      await engine.insertFactWithdrawal('default', 'world', 'the first claim', '*', '2026-01-02T03:04:05.000Z');
      const one = await engine.readHotMemoryWatermark('default');
      await engine.insertFactWithdrawal('default', 'private', 'the second claim', 'alice-example', '2026-01-01T00:00:00.000Z');
      const two = await engine.readHotMemoryWatermark('default');
      const other = await engine.readHotMemoryWatermark('other-source');
      // The count leads; the rule part is the last two md5 digests (a withdrawal time in the middle has its own colons).
      const shape = (w: string) => ({ count: w.split(':')[0], rules: w.split(':').slice(-2).join(':') });
      const result = {
        counts: [shape(before).count, shape(one).count, shape(two).count],
        rules: [...new Set([before, one, two].map((w) => shape(w).rules))],
        distinct: new Set([before, one, two]).size,
        other,
      };
      expect(result).toEqual({ counts: ['0', '1', '2'], rules: [NO_RULES], distinct: 3, other: `0::${NO_RULES}` });
      return result;
    });
});
