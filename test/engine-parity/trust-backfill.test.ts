/**
 * BrainEngine parity — the trust backfill's entry points (src/core/trust/backfill.ts) on an engine without raw SQL.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: runTrustBackfill (dry run, apply, resume and a source-scoped claim lift) and relowerClaimedRows (dry run
 *    and apply) give the same report on PGLite and Postgres. Their batch, apply and relower statements embed the trust
 *    classifier's generated SQL and stay raw, so an engine without raw SQL (the Rust arm, GBRAIN_TEST_RUST_ARM=1) must
 *    refuse every backfill entry point with `engine_capability_missing` (reason raw_sql) that names the entry point, before it
 *    reads a batch or writes a tier, a cursor or a page; relowerClaimedRows refuses by name the same way once a table holds
 *    claim-lifted rows to read, and answers an empty report before that.
 *  - Regression: an entry point that starts on an engine that cannot finish it leaves a half-run backfill (a saved
 *    cursor, some tiers moved) or fails with an executeRaw refusal that does not name the trust backfill.
 *  - Why existing coverage misses it: test/trust-backfill.test.ts and test/trust-claim*.test.ts run PGLite or Postgres
 *    one at a time and never the Rust arm.
 *  - Seam: the trust tiers have no typed reader, so the case declares raw_sql; the Rust arm proves the refusal and
 *    that the page it seeded through putPage is unchanged.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { isCapabilityRefusal } from './arm-capabilities.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { relowerClaimedRows, runTrustBackfill } from '../../src/core/trust/backfill.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const quiet = () => {};

describe('engine parity: trust backfill', () => {
  parityTest('every backfill and relower entry point refuses by name before any write on an engine without raw SQL', {
    methods: ['putPage', 'getPage'], requires: 'raw_sql' }, async (engine) => {
    await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'A body.', frontmatter: {} }, { sourceId: SRC });
    const before = JSON.stringify(await engine.getPage('notes/a', { sourceId: SRC }));
    const settle = (p: Promise<unknown>) => p.then(value => ({ value }), (error: unknown) => ({ error }));
    const runs = {
      dryRun: await settle(runTrustBackfill(engine, { dryRun: true, log: quiet })),
      apply: await settle(runTrustBackfill(engine, { log: quiet })),
      resume: await settle(runTrustBackfill(engine, { resume: true, log: quiet })),
      claimLift: await settle(runTrustBackfill(engine, { sources: [SRC], log: quiet })),
      relowerDryRun: await settle(relowerClaimedRows(engine, { dryRun: true })),
      relower: await settle(relowerClaimedRows(engine, {})),
    };
    const unchanged = JSON.stringify(await engine.getPage('notes/a', { sourceId: SRC })) === before;
    const refusals = Object.entries(runs).filter(([, r]) => 'error' in r && isCapabilityRefusal(r.error, 'raw_sql'));
    if (refusals.length) {
      // The Rust arm: every entry point refused up front, by its own name, and the page is as it was.
      const named = refusals.map(([name, r]) => [name, String((r as { error: Error }).error.message)] as const);
      // relowerClaimedRows reads the claimed sources and the claim-lifted counts through typed members first, so a brain with
      // nothing a claim lifted answers it on every engine (doctor's trust_sources_unclaimed relies on that); it refuses by name
      // only when a table has rows its raw statement must read.
      expect({ refused: named.map(([name]) => name), unchanged }).toEqual({ refused: ['dryRun', 'apply', 'resume', 'claimLift'], unchanged: true });
      expect(['relowerDryRun', 'relower'].map(name => ('value' in runs[name as keyof typeof runs]))).toEqual([true, true]);
      for (const [name, message] of named) {
        expect(message).toContain(name.startsWith('relower') ? 'relowerClaimedRows' : 'runTrustBackfill');
      }
      throw (refusals[0]![1] as { error: unknown }).error;
    }
    const shape = (r: { value?: unknown; error?: unknown }) => {
      if ('error' in r) return `${(r.error as { code?: string }).code}: ${(r.error as Error).message}`;
      const v = r.value as { mode: string; status?: string; rows: number; tables: unknown[] };
      return { mode: v.mode, status: v.status ?? null, rows: v.rows, tables: v.tables.length };
    };
    const out = { ...Object.fromEntries(Object.entries(runs).map(([name, r]) => [name, shape(r)])), unchanged };
    expect(out).toMatchObject({
      dryRun: { mode: 'dry_run', status: 'complete' }, apply: { mode: 'apply', status: 'complete' },
      resume: { mode: 'apply', status: 'complete' }, claimLift: { mode: 'apply', status: 'complete' },
      relowerDryRun: { mode: 'dry_run', rows: 0 }, relower: { mode: 'apply', rows: 0 },
    });
    return out;
  });
});
