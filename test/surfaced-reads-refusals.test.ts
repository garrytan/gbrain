/**
 * The callers of the surfaced-read members report an engine capability refusal and keep their old fallback for any
 * other failure.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: labelledOnlyFor, the extractable_empty_corpus lint, invalidateQueryCache and
 *    assertUnscopedReadReachesPages throw `engine_capability_missing` from their member; any other error still takes
 *    the fallback each caller documents (labelled-only yes, skip the lint, 0 invalidated, no refusal).
 *  - Regression: each caught every error, so an engine that refused the read answered the fallback with no sign.
 *  - Why existing coverage misses it: the parity file runs engines that answer; the caller tests pin the fallback only.
 *  - Seam: stub engines whose member throws.
 */
import { describe, expect, test } from 'bun:test';
import { labelledOnlyFor } from '../src/core/access/labelled-only.ts';
import { extractableEmptyCorpus } from '../src/core/schema-pack/lint-rules.ts';
import { invalidateQueryCache } from '../src/core/schema-pack/query-cache-invalidator.ts';
import { assertUnscopedReadReachesPages } from '../src/core/sources-not-readable.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import type { OperationContext } from '../src/core/operations.ts';

const refused = () => capabilityMissing('raw_sql', 'executeRaw');
const plain = () => new Error('connection reset');
const manifest = { name: 'tiny', page_types: [{ name: 'person', extractable: true, path_prefixes: ['people/'] }] } as never;

function engineThrowing(member: string, error: () => unknown) {
  return new Proxy({ kind: 'pglite', getConfig: async () => null }, {
    get(target, key) {
      if (key === member) return async () => { throw error(); };
      return Reflect.get(target, key);
    },
  }) as never;
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try { return JSON.stringify(await run()) ?? 'undefined'; } catch (e) { return (e as { code?: string }).code ?? 'error'; }
}

describe('surfaced-read callers', () => {
  for (const [name, error, want] of [['a refusal', refused, 'engine_capability_missing'], ['another failure', plain, null]] as const) {
    test(`${name}: labelledOnlyFor, the lint, the invalidation and the reach probe`, async () => {
      const ctx = (member: string) => ({ engine: engineThrowing(member, error), remote: true, sourceId: 'default', auth: { hasSourceGrant: false } }) as unknown as OperationContext;
      const got = {
        labelled: await outcome(() => labelledOnlyFor(engineThrowing('hasLabelledOnlyMemberAmong', error), [['member:alice-example']])),
        lint: await outcome(async () => extractableEmptyCorpus(manifest, { engine: engineThrowing('countLivePagesAtPathPrefix', error) })),
        invalidate: await outcome(() => invalidateQueryCache(engineThrowing('invalidateQueryCacheRows', error), 'default')),
        reach: await outcome(() => assertUnscopedReadReachesPages('search', {}, ctx('readSourcesNotReadable'))),
      };
      expect(got).toEqual(want
        ? { labelled: want, lint: want, invalidate: want, reach: want }
        : { labelled: 'true', lint: '[]', invalidate: '{"rows_invalidated":0}', reach: 'undefined' });
    });
  }
});
