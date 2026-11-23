/**
 * #6803 on Postgres: a doctor entry's typed engine reads carry the entry deadline to the server, as the raw statements
 * they replaced did through the deadline wrapper (src/core/statement-deadline.ts `deadlineBoundEngine`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: under a doctor entry's deadline, on Postgres, each read in the table sends its statement with a
 *    statement_timeout no longer than the time left (the raw statement's bound), so a lock or a slow scan ends at
 *    the entry deadline.
 *  - Regression: the wrapper applied a bounded typed read to the raw engine, so a member built on `this.executeRaw`
 *    sent its statement through the raw engine's executeRaw, which does not read the ambient read deadline; and the
 *    doctor reads moved to typed members by the Rust doctor slices (embedding columns, entity duplicates, the source
 *    lists, onboard coverage, derived taint, generations, backup maturity, trust backfill, sync holds and pass rows)
 *    were not in the bounded set, so they got only the refusal before the call.
 *  - Why existing coverage misses it: test/doctor-entry-deadline-6803.test.ts reroutes the typed persistence reads
 *    through its own executeRaw, so the real member's path is never taken; the parity tests run without a deadline.
 *  - Seam: the recording fake postgres.js client (test/helpers/fake-postgres-sql.ts).
 */
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { deadlineBoundEngine, withStatementDeadline } from '../src/core/statement-deadline.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

const never = () => new Promise<never>(() => {});
const control = /statement_timeout|^\s*SET\b|^\s*(BEGIN|COMMIT|ROLLBACK)\b/i;
type Run = (e: any) => Promise<unknown>;

/** [member, a call of it] */
const reads: ReadonlyArray<readonly [string, Run]> = [
  // Controls: the raw statement and a preparation-read member keep the bound at head.
  ['executeRaw', e => e.executeRaw('SELECT 1 AS n FROM pages')],
  ['getConfigValues', e => e.getConfigValues(['a.key'])],
  // In the bounded set, built on this.executeRaw.
  ['countPageChildOrphans', e => e.countPageChildOrphans({ table: 'tags', col: 'page_id' })],
  // Doctor-path moves outside the bounded set.
  ['readChunkColumnTypes', e => e.readChunkColumnTypes(['embedding'])],
  ['countChunkColumnCoverage', e => e.countChunkColumnCoverage('embedding')],
  ['listUnretiredPagesBySlugPattern', e => e.listUnretiredPagesBySlugPattern('default', ['people/%'], 5)],
  ['countDistinctInboundLinkers', e => e.countDistinctInboundLinkers(['default'], ['people/a'])],
  ['listNameVariantCandidates', e => e.listNameVariantCandidates('default', { types: ['person'], slugPatterns: ['people/%'], probes: ['%a%'], limit: 5 })],
  ['readSoleSourceId', e => e.readSoleSourceId()],
  ['readFirstSourceId', e => e.readFirstSourceId()],
  ['listSourceIds', e => e.listSourceIds()],
  ['countDatedMeetingPages', e => e.countDatedMeetingPages()],
  ['entityFeatureCoverage', e => e.entityFeatureCoverage({ types: ['person'], per_source: [] }, 'links')],
  ['countDerivedRowTaint', e => e.countDerivedRowTaint('takes')],
  ['listPendingGenerationMembers', e => e.listPendingGenerationMembers(['default'], null)],
  ['listGenerationOrphanCandidates', e => e.listGenerationOrphanCandidates(['default'], null)],
  ['readBrainMaturity', e => e.readBrainMaturity()],
  ['readOpCheckpointKeys', e => e.readOpCheckpointKeys('an.op', 'a-fingerprint')],
  ['readGitHoldRecords', e => e.readGitHoldRecords()],
  ['readLiveSyncPassRows', e => e.readLiveSyncPassRows(null)],
];

describe('doctor typed reads keep the entry deadline on Postgres (#6803)', () => {
  for (const [name, run] of reads) {
    test(`${name} sends its statement with a statement_timeout inside the time left`, async () => {
      const fake = makeFakeSql(stmt => (control.test(stmt.text) ? undefined : never()));
      const engine = new PostgresEngine();
      (engine as unknown as { _sql: unknown })._sql = fake.sql;
      const scope = { startedAt: Date.now(), deadlineAt: Date.now() + 2_000, expired: false };
      void withStatementDeadline(scope, () => run(deadlineBoundEngine(engine))).catch(() => undefined);
      await Bun.sleep(150);
      const sent = fake.statements();
      expect(sent.some(s => !control.test(s.text))).toBe(true);
      const timeouts = sent.filter(s => s.text.includes('statement_timeout'));
      expect(timeouts.length).toBeGreaterThan(0);
      const last = timeouts.at(-1)!;
      const values = last.params.map(Number).filter(n => Number.isFinite(n) && n > 0);
      const literal = /statement_timeout\s*=\s*'?(\d+)/i.exec(last.text);
      const ms = literal ? Number(literal[1]) : values.at(0);
      expect(ms).toBeDefined();
      expect(ms!).toBeLessThanOrEqual(2_000);
    });
  }
});
