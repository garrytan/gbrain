/**
 * engine-sql/jobs.ts literals that copy a constant from elsewhere.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the stall sweep's drain-lease queue name and the claim's legacy spend predicate are written into the
 *    SQL as literals (the engine module may not import the queue modules), so they must equal the constants they copy:
 *    `LEASE_BEACON_QUEUE` and `LEGACY_SPEND_KEY_PREFIXES`.
 *  - Regression: renaming the drain-lease queue, or adding a consent-gated producer prefix, without the SQL following
 *    makes the sweep requeue lease holders as jobs, or a claim skip the spend fence of the new producer.
 *  - Why existing coverage misses it: the queue tests use the current values, so both sides change together only by
 *    luck; nothing compares the literal with the constant.
 *  - Seam: none. Reads the exported SQL text and the module source.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { LEGACY_SPEND_PREDICATE_SQL } from '../src/core/engine-sql/jobs.ts';
import { LEASE_BEACON_QUEUE } from '../src/core/minions/protected-names.ts';
import { LEGACY_SPEND_KEY_PREFIXES } from '../src/core/minions/spend-authorization.ts';

describe('engine-sql/jobs.ts copied constants', () => {
  test('the legacy spend predicate names exactly the LEGACY_SPEND_KEY_PREFIXES producers', () => {
    const expected = Object.entries(LEGACY_SPEND_KEY_PREFIXES)
      .map(([name, prefixes]) => `(name = '${name}' AND (${prefixes.map(p => `idempotency_key LIKE '${p}%'`).join(' OR ')}))`)
      .join(' OR ');
    expect(LEGACY_SPEND_PREDICATE_SQL).toBe(expected);
  });

  test('the stall sweep skips and cleans the LEASE_BEACON_QUEUE', () => {
    // test-reads-source-ok[structural]: the queue name is a literal inside SQL text, so only the source holds it.
    const source = readFileSync(new URL('../src/core/engine-sql/jobs.ts', import.meta.url), 'utf8');
    const queues = [...source.matchAll(/queue\s*(?:=|<>)\s*'([^']+)'/g)].map(m => m[1]);
    expect(queues.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(queues)]).toEqual([LEASE_BEACON_QUEUE]);
  });
});
