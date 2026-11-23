/**
 * BrainEngine parity — the hot-memory watermark that every MCP tool call reads before it attaches
 * `_meta.brain_hot_memory` (facts/meta-hook.ts reads `readFactCacheWatermark`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a fresh source every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts) gives the same watermark, and each recorded withdrawal moves the count and the
 *    newest withdrawal time of its own source only, while the access-rule digest stays the same.
 *  - Regression: withdrawalWatermark sent its SELECT through executeRaw, so on a Rust brain every MCP tool call that
 *    builds hot memory (entity first) stopped on the raw_sql refusal before anything else. The build's next read,
 *    readTrustGeneration (eligibility/generation.ts), is a typed member now, covered by trust-withdrawals.test.ts.
 *  - Why existing coverage misses it: the meta-hook tests run on PGLite only. trust-withdrawals.test.ts compares the
 *    watermark row after withdrawals with out-of-order times; this file pins the fresh-source token and that the
 *    watermark moves on each withdrawal and stays put for another source.
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
  parityTest('a fresh source has the same watermark on every engine', { methods: ['readFactCacheWatermark'] },
    async (engine) => {
      const watermark = await engine.readFactCacheWatermark('default');
      expect(watermark).toEqual({ withdrawals: 0, latest_withdrawn_at: null, access_rules: NO_RULES });
      return watermark;
    });

  parityTest('each recorded withdrawal changes the watermark and its count, and only for its source', { methods: ['readFactCacheWatermark', 'insertFactWithdrawal'] },
    async (engine) => {
      const before = await engine.readFactCacheWatermark('default');
      await engine.insertFactWithdrawal('default', 'world', 'the first claim', '*', '2026-01-02T03:04:05.000Z');
      const one = await engine.readFactCacheWatermark('default');
      await engine.insertFactWithdrawal('default', 'private', 'the second claim', 'alice-example', '2026-01-01T00:00:00.000Z');
      const two = await engine.readFactCacheWatermark('default');
      const other = await engine.readFactCacheWatermark('other-source');
      const result = {
        counts: [before, one, two].map((w) => w.withdrawals),
        rules: [...new Set([before, one, two].map((w) => w.access_rules))],
        distinct: new Set([before, one, two].map((w) => JSON.stringify(w))).size,
        other,
      };
      expect(result).toEqual({
        counts: [0, 1, 2], rules: [NO_RULES], distinct: 3,
        other: { withdrawals: 0, latest_withdrawn_at: null, access_rules: NO_RULES },
      });
      return result;
    });
});
