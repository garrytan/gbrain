/**
 * BrainEngine parity: a trust floor (`minTrust`) that names no trust tier.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: searchVector, getContentFlagsByPageIds and getUnverifiedExtractionPageIds refuse a floor that is not one
 *    of TRUST_TIERS (a number, an unknown name, a name in the wrong case) with code `invalid_argument` and the message
 *    `minTrust: "<floor>" names no trust tier`, the Rust store's refusal, before any statement runs. A valid floor still
 *    keeps and drops the same rows.
 *  - Regression: PGLite and Postgres built `trust_tier IN ()` from such a floor and failed with SQL error 42601, so a
 *    caller got a raw syntax error and the engines disagreed.
 *  - Why existing coverage misses it: every floor in the suites was a valid tier; the op layer validates `min_trust`
 *    params, so only a direct engine caller reaches the SQL builder with a bad floor.
 *  - Seam: none. Pages and chunks are written through typed members.
 *  - Rust arm: an engine whose members do not take `minTrust` yet ends on their typed refusal.
 */
import { describe, expect } from 'bun:test';
import { basisEmbedding, parityArms } from './harness.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

/**
 * The value, or the refusal's code and message. A typed capability refusal is rethrown, so an arm whose member does
 * not take `minTrust` ends the case on it (the harness's typed-refusal rule) instead of comparing it as an answer.
 */
async function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: await fn() };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === 'engine_capability_missing') throw e;
    return { refused: err.code ?? 'no code', message: String(err.message) };
  }
}

describe('engine parity: a trust floor that names no tier', () => {
  parityTest(
    'searchVector and the page marker reads refuse a floor that names no trust tier with invalid_argument',
    { methods: ['putPage', 'sealChunks', 'getPage', 'searchVector', 'getContentFlagsByPageIds', 'getUnverifiedExtractionPageIds'] },
    async (engine) => {
      await seedPage(engine, {
        slug: 'notes/floor',
        input: { type: 'note', title: 'Floor', compiled_truth: 'a page for the trust floor.', timeline: '' },
        chunks: [chunk(0, 'a page for the trust floor.', { embedding: basisEmbedding(3) })],
      });
      const id = Number((await engine.getPage('notes/floor'))!.id);
      const query = basisEmbedding(3);
      const read = (minTrust: unknown) => ({
        searchVector: () => engine.searchVector(query, { limit: 5, minTrust } as never).then((rows) => rows.map((r) => r.slug)),
        contentFlags: () => engine.getContentFlagsByPageIds([id], { minTrust } as never).then((m) => m.size),
        unverified: () => engine.getUnverifiedExtractionPageIds([id], { minTrust } as never).then((m) => m.size),
      });
      const out: Record<string, Record<string, unknown>> = {};
      for (const floor of [0.5, 'trusted', 'Unknown', 'unknown', 'agent_written']) {
        const reads = read(floor);
        out[String(floor)] = {
          searchVector: await outcome(reads.searchVector),
          contentFlags: await outcome(reads.contentFlags),
          unverified: await outcome(reads.unverified),
        };
      }
      for (const floor of ['0.5', 'trusted', 'Unknown']) {
        const refused = { refused: 'invalid_argument', message: `minTrust: "${floor}" names no trust tier` };
        expect(out[floor]).toEqual({ searchVector: refused, contentFlags: refused, unverified: refused });
      }
      // A valid floor reads as before: the page is stamped `unknown`, so `unknown` keeps it and `agent_written` drops it.
      expect(out.unknown).toEqual({ searchVector: { ok: ['notes/floor'] }, contentFlags: { ok: 0 }, unverified: { ok: 0 } });
      expect(out.agent_written).toEqual({ searchVector: { ok: [] }, contentFlags: { ok: 0 }, unverified: { ok: 0 } });
      return out;
    },
  );
});
