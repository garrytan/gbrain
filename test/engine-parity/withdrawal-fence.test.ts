/**
 * BrainEngine parity — the withdrawal check on a malformed facts fence (engine-sql/withdrawal-fence.ts
 * `hasWithdrawnFenceClaim`) and the import guard that runs it (facts/withdrawal.ts `assertPreparedFactWithdrawals`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `hasWithdrawnFenceClaim(source, claims, subject)` is true when a withdrawal or a purge tombstone of the
 *    source has the fingerprint (or the v1 fingerprint) of a claim, at the claim's visibility (either visibility when
 *    it has none), under subject '*' or the subject (any subject when the subject is null); false for no claims. A
 *    prepared import whose malformed fence holds such a claim refuses with `invalid_fence` /
 *    `withdrawn_claim_in_malformed_fence`, naming the body or the timeline, and a fence with no such claim passes.
 *  - Regression: the check ran through `executeRaw`, which the Rust engine refuses, so every import of a page with a
 *    malformed fence, and `remember` on such a page, stopped on a Rust brain before saving anything.
 *  - Why existing coverage misses it: test/facts-withdrawal-fingerprint-once.test.ts runs the SQL engines only and
 *    seeds withdrawals, never a purge tombstone.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { assertPreparedFactWithdrawals } from '../../src/core/facts/withdrawal.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const SLUG = 'people/fence-example';
const OTHER = 'people/other-fence-example';
const T1 = '2026-03-01T10:00:00.000Z';
const REQUEST = '6f9619ff-8b86-4d01-b42d-00cf4fc964aa';

/** Inserts one fence fact of SLUG and returns its fingerprint (loadPurgeTarget, the purge's own read). */
async function fingerprintOf(engine: BrainEngine, rowNum: number, claim: string, visibility: 'world' | 'private' = 'world'): Promise<string> {
  const out = await engine.insertFacts([{ fact: claim, entity_slug: SLUG, source_markdown_slug: SLUG, row_num: rowNum, kind: 'fact', visibility,
    source: 'fence' }] as never, { source_id: SRC }) as { ids: number[] };
  const target = await engine.loadPurgeTarget(out.ids[0]!, SRC);
  return target!.fact_hash;
}

const purge = (engine: BrainEngine, visibility: string, subject: string, factHash: string) =>
  engine.insertFactPurge({ sourceId: SRC, visibility, subject, factHash, requestId: REQUEST, actor: 'owner:local', reason: 'parity' });

/** A facts fence with no end marker, holding one row: the import guard reads its rows as ambiguous claims. */
const unbalanced = (claim: string, visibility: string) => `# Fence Example\n\n<!--- gbrain:facts:begin -->\n`
  + `| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n`
  + `|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n`
  + `| 1 | ${claim} | preference | 1.0 | ${visibility} | medium | 2026-01-01 |  | chat |  |\n`;

const outcome = async (run: () => Promise<unknown>) => {
  try { await run(); return 'passed'; } catch (e) {
    const err = e as { code?: string; canonical?: string; reason?: string; fence?: { section?: string } };
    return { code: err.code, canonical: err.canonical, reason: err.reason, section: err.fence?.section };
  }
};

async function seed(engine: BrainEngine): Promise<void> {
  await engine.putPage(SLUG, { type: 'person', title: 'Fence Example', compiled_truth: 'Fence Example.', timeline: '' });
  await purge(engine, 'world', '*', await fingerprintOf(engine, 1, 'Prefers email'));
  await purge(engine, 'private', SLUG, await fingerprintOf(engine, 2, 'Has a budget', 'private'));
  await purge(engine, 'world', OTHER, await fingerprintOf(engine, 3, 'Plays chess'));
  await engine.insertFactWithdrawal(SRC, 'world', 'Lives in Lisbon', SLUG, T1);
  await engine.insertFactWithdrawal(SRC, 'private', 'Rides a bike', '*', T1);
}

describe('engine parity: the withdrawal check on a malformed fence', () => {
  parityTest('hasWithdrawnFenceClaim matches both ledgers at the visibility, for the subject', {
    methods: ['putPage', 'insertFacts', 'loadPurgeTarget', 'insertFactPurge', 'insertFactWithdrawal', 'hasWithdrawnFenceClaim'],
  }, async (engine) => {
    await seed(engine);
    const has = (claim: string, visibility: string | null, subject: string | null, sourceId = SRC) =>
      engine.hasWithdrawnFenceClaim(sourceId, [{ claim, visibility }], subject);
    const out = {
      none: await engine.hasWithdrawnFenceClaim(SRC, [], SLUG),
      purgeWildcard: await has('  PREFERS   email. ', 'world', SLUG),
      purgeWildcardNoSubject: await has('Prefers email', 'world', null),
      purgeAnyVisibility: await has('Prefers email', null, OTHER),
      purgeOtherVisibility: await has('Prefers email', 'private', SLUG),
      purgeSubject: await has('Has a budget', 'private', SLUG),
      purgeNotThatSubject: await has('Has a budget', 'private', OTHER),
      purgeAnySubject: await has('Plays chess', 'world', null),
      purgeOtherSubject: await has('Plays chess', 'world', SLUG),
      withdrawalSubject: await has('lives in LISBON', 'world', SLUG),
      withdrawalNotThatSubject: await has('Lives in Lisbon', 'world', OTHER),
      withdrawalAnySubject: await has('Lives in Lisbon', null, null),
      withdrawalWildcard: await has('Rides a bike', 'private', OTHER),
      withdrawalOtherVisibility: await has('Rides a bike', 'world', OTHER),
      otherSource: await has('Prefers email', 'world', SLUG, 'missing'),
      unknownClaim: await has('Flies kites', null, null),
      oneOfMany: await engine.hasWithdrawnFenceClaim(SRC, [{ claim: 'Flies kites', visibility: 'world' }, { claim: 'Plays chess', visibility: null }], OTHER),
    };
    expect(out).toEqual({ none: false, purgeWildcard: true, purgeWildcardNoSubject: true, purgeAnyVisibility: true, purgeOtherVisibility: false,
      purgeSubject: true, purgeNotThatSubject: false, purgeAnySubject: true, purgeOtherSubject: false, withdrawalSubject: true,
      withdrawalNotThatSubject: false, withdrawalAnySubject: true, withdrawalWildcard: true, withdrawalOtherVisibility: false,
      otherSource: false, unknownClaim: false, oneOfMany: true });
    return out;
  });

  parityTest('a prepared import refuses a malformed fence that holds a purged or withdrawn claim', {
    methods: ['putPage', 'insertFacts', 'loadPurgeTarget', 'insertFactPurge', 'insertFactWithdrawal', 'hasWithdrawnFenceClaim'],
  }, async (engine) => {
    await seed(engine);
    const guard = (body: string, timeline: string, subject?: string) => outcome(() => assertPreparedFactWithdrawals(engine, SRC, body, timeline, subject));
    const out = {
      purgedInBody: await guard(unbalanced('Prefers email', 'world'), '', SLUG),
      purgedInTimeline: await guard('# Fence Example\n', unbalanced('Prefers email', 'world'), SLUG),
      purgedNoSubject: await guard(unbalanced('Plays chess', 'world'), ''),
      purgedOtherVisibility: await guard(unbalanced('Prefers email', 'private'), '', SLUG),
      purgedOtherSubject: await guard(unbalanced('Plays chess', 'world'), '', SLUG),
      withdrawn: await guard(unbalanced('Lives in Lisbon', 'world'), '', SLUG),
      withdrawnOtherSubject: await guard(unbalanced('Lives in Lisbon', 'world'), '', OTHER),
      clean: await guard(unbalanced('Flies kites', 'world'), '', SLUG),
    };
    const refused = (section: string) => ({ code: 'invalid_params', canonical: 'invalid_fence', reason: 'withdrawn_claim_in_malformed_fence', section });
    expect(out).toEqual({ purgedInBody: refused('body'), purgedInTimeline: refused('timeline'), purgedNoSubject: refused('body'),
      purgedOtherVisibility: 'passed', purgedOtherSubject: 'passed', withdrawn: refused('body'), withdrawnOtherSubject: 'passed', clean: 'passed' });
    return out;
  });
});
