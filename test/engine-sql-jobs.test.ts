/**
 * engine-sql/jobs.ts and engine-sql/jobs-queue.ts literals that copy a constant from elsewhere.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the stall sweep's drain-lease queue name and the claim's legacy spend predicate are written into the
 *    SQL as literals (the engine module may not import the queue modules), so they must equal the constants they copy:
 *    `LEASE_BEACON_QUEUE` and `LEGACY_SPEND_KEY_PREFIXES`. The queue members copy the same way: the timeout sweeps'
 *    drain-lease name and wall-clock threshold (`WALL_CLOCK_THRESHOLD_MS_SQL`), the watchdog mark SQL
 *    (`appendSuspectMarkSql`, `markedJobSql`), the owner-actor filter (`jobActorSql`), the claim gate's live statuses
 *    (`LIVE_JOB_STATUSES`) and the dream-inline private queue prefix.
 *  - Regression: renaming the drain-lease queue, or adding a consent-gated producer prefix, without the SQL following
 *    makes the sweep requeue lease holders as jobs, or a claim skip the spend fence of the new producer. A drifted
 *    queue-member copy kills a lease holder on timeout, kills a job at another threshold than the doctor reports,
 *    marks or finds watchdog suspects another way than the claim, lists another client's jobs, misses a live status in
 *    the claim gate, or stops recovering and folding dream-inline queues.
 *  - Why existing coverage misses it: the queue tests use the current values, so both sides change together only by
 *    luck; nothing compares the literal with the constant.
 *  - Seam: none. Reads the exported SQL text and the module source.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderFragment } from '../src/core/engine-sql/fragment.ts';
import { LEGACY_SPEND_PREDICATE_SQL } from '../src/core/engine-sql/jobs.ts';
import { DREAM_INLINE_PRIVATE_QUEUE_PREFIX, jobActorFragment, jobOwnedFragment, UNREVIEWED_LIVE_JOBS_WHERE } from '../src/core/engine-sql/jobs-queue.ts';
import { WALL_CLOCK_THRESHOLD_MS_SQL } from '../src/core/minions/handler-timeouts.ts';
import { LEASE_BEACON_QUEUE } from '../src/core/minions/protected-names.ts';
import { LEGACY_SPEND_KEY_PREFIXES } from '../src/core/minions/spend-authorization.ts';
import { LIVE_JOB_STATUSES } from '../src/core/minions/submission-authority.ts';
import { jobActorSql, jobOwnedSql, jobOwnerParams } from '../src/core/minions/types.ts';
import { appendSuspectMarkSql, markedJobSql } from '../src/core/minions/watchdog-attribution.ts';

/** A module's source with whitespace runs collapsed, so a copied SQL fragment matches across re-indentation. */
function flatSource(file: string): string {
  // test-reads-source-ok[structural]: the copies are literals inside SQL text, so only the source holds them.
  return readFileSync(new URL(`../src/core/engine-sql/${file}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

const flat = (sql: string) => sql.replace(/\s+/g, ' ');

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('engine-sql/jobs.ts copied constants', () => {
  test('the legacy spend predicate names exactly the LEGACY_SPEND_KEY_PREFIXES producers', () => {
    const expected = Object.entries(LEGACY_SPEND_KEY_PREFIXES)
      .map(([name, prefixes]) => `(name = '${name}' AND (${prefixes.map(p => `idempotency_key LIKE '${p}%'`).join(' OR ')}))`)
      .join(' OR ');
    expect(LEGACY_SPEND_PREDICATE_SQL).toBe(expected);
  });

  test('the stall sweep and the timeout sweeps skip and clean the LEASE_BEACON_QUEUE', () => {
    for (const [file, min] of [['jobs.ts', 2], ['jobs-queue.ts', 2]] as const) {
      const queues = [...flatSource(file).matchAll(/queue\s*(?:=|<>)\s*'([^']+)'/g)].map(m => m[1]);
      expect(queues.length).toBeGreaterThanOrEqual(min);
      expect([...new Set(queues)]).toEqual([LEASE_BEACON_QUEUE]);
    }
  });

  test('the wall-clock sweep uses the WALL_CLOCK_THRESHOLD_MS_SQL threshold in its select and its update', () => {
    expect(count(flatSource('jobs-queue.ts'), flat(WALL_CLOCK_THRESHOLD_MS_SQL))).toBe(2);
  });

  test('the watchdog members append and find the mark with the watchdog-attribution SQL', () => {
    const source = flatSource('jobs-queue.ts');
    expect(source).toContain(flat(appendSuspectMarkSql('$4')));
    expect(source).toContain(flat(appendSuspectMarkSql('$2')));
    expect(source).toContain(flat(markedJobSql('$3')));
  });

  test('the owner-actor fragment renders as jobActorSql', () => {
    const { text, params } = renderFragment(jobActorFragment(['sys', 'ext', 'mem', 'aud']));
    expect(text).toBe(jobActorSql(1));
    expect(params).toEqual(['sys', 'ext', 'mem', 'aud']);
  });

  test('the job owner fragment renders as jobOwnedSql, with and without an alias', () => {
    const owner = { principal: { kind: 'oauth_client', id: 'c1' }, clientId: 'c1', actor: ['sys', 'ext', 'mem', 'aud'] as const };
    for (const alias of [undefined, 'j']) {
      const { text, params } = renderFragment(jobOwnedFragment(owner, alias));
      expect(text).toBe(jobOwnedSql(1, alias));
      expect(params).toEqual(jobOwnerParams(owner));
    }
    expect(renderFragment(jobActorFragment(['s', 'e', 'm', 'a'], 'p')).text).toBe(jobActorSql(1, 'p'));
  });

  test('the claim gate population names exactly the LIVE_JOB_STATUSES', () => {
    const list = /status IN \(([^)]*)\)/.exec(UNREVIEWED_LIVE_JOBS_WHERE)![1];
    expect(list.split(',').map(s => s.trim().replace(/'/g, ''))).toEqual([...LIVE_JOB_STATUSES]);
  });

  test('the private queue recovery and the family stats spell the dream-inline prefix', () => {
    const source = flatSource('jobs-queue.ts');
    expect(count(source, `LIKE '${DREAM_INLINE_PRIVATE_QUEUE_PREFIX}%'`)).toBe(3);
    expect(source).toContain(`THEN '${DREAM_INLINE_PRIVATE_QUEUE_PREFIX.replace(/-$/, '')}' ELSE queue END`);
  });
});
