/**
 * BrainEngine parity — folder rules: the rule writes `gbrain access rule add|rm` and the policy sync run
 * (access/policy.ts: proposeRevision, applyApproved, restampSource, policyStatus over engine-sql/access-policy.ts), the
 * folder reads a caller's record is built from (readFolderAccess, listAppliedPolicyRevisions, isFolderRestricted) and
 * the page policy that judges a page under a rule.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a narrowing rule installs at once, stamps the pages under its prefix and keeps them to its readers; a
 *    member outside the rule reads none of them, a member the rule names reads them, and a page outside the prefix
 *    stays open. A widening is held until it is applied. Every engine arm (PGLite always; Postgres with DATABASE_URL;
 *    the Rust arm with GBRAIN_TEST_RUST_ARM=1) gives the same answers.
 *  - Regression: the rule writes ran through executeRaw, so on a Rust brain they stopped on the raw_sql refusal and the
 *    store judged no folder rule at all; once rules could be written there, a member outside a rule would have read
 *    the covered pages PGLite hides. The first case puts such a page where the member's read shows it.
 *  - Why existing coverage misses it: test/access-folder-*.test.ts run on the SQL engines only, and the parity
 *    harness's restrictFolder fixture wrote rules with raw SQL, which stopped on the Rust arm.
 *  - Seam: none. Rules go in through proposeRevision, members through addMember, pages through putPage.
 *  - Known loss on Rust (docs/designs/RUST_ENGINE.md row 32h): moving a source's rules between the database and git
 *    (policy-migrate.ts). The last describe pins its refusal.
 */
import { describe, expect, test } from 'bun:test';
import { parityArms, resetArm } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { addMember } from '../../src/core/access/members.ts';
import { applyApproved, clearPolicyInvalid, listRevisions, markPolicyInvalid, policyStatus, previewApply, proposeRevision, resumePolicy } from '../../src/core/access/policy.ts';
import { migrateAccessStore } from '../../src/core/access/policy-migrate.ts';
import { remoteCallerAccess } from '../../src/core/access/caller.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest, arms } = parityArms(testBackends());

const core = (frontmatter: Record<string, unknown> = {}) =>
  ({ type: 'note' as const, title: 'Core', compiled_truth: `body ${JSON.stringify(frontmatter)}`, timeline: '', frontmatter: { always_load: true, ...frontmatter } });

/** Two members, the always-loaded pages the reads list, and one narrowing rule over `partners/alice/`. */
async function seedRule(engine: BrainEngine): Promise<void> {
  await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
  await addMember(engine, 'alice-example');
  await addMember(engine, 'bob-example');
  await engine.putPage('partners/alice/deal', core(), { sourceId: 'default' });
  await engine.putPage('partners/alice/notes', core(), { sourceId: 'default' });
  await engine.putPage('notes/open', core(), { sourceId: 'default' });
  await proposeRevision(engine, 'default', [{ id: 'alice', prefix: 'partners/alice/', readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
}

/** The always-loaded pages a stdio server bound to `member` reads under its caller record. */
async function readAs(engine: BrainEngine, member: string): Promise<string[]> {
  await engine.setConfig('mcp.stdio_member', member);
  const access = await remoteCallerAccess(engine, undefined, [], 'stdio');
  const rows = await withCallerAccess(access, () => engine.listCorePageRows({ excludePrivate: true, forCaller: true, limit: 50 }));
  return rows.map(r => r.slug).sort();
}

describe('engine parity: folder rules', () => {
  // The read-side leak, first: a member outside a folder rule never reads the pages under it.
  parityTest('a member outside a folder rule reads none of the pages under it; the member it names reads them', {
    methods: ['insertAccessMember', 'putPage', 'listCorePageRows'],
  }, async (engine) => {
    await seedRule(engine);
    const reads = { bob: await readAs(engine, 'bob-example'), alice: await readAs(engine, 'alice-example') };
    expect(reads).toEqual({ bob: ['notes/open'], alice: ['notes/open', 'partners/alice/deal', 'partners/alice/notes'] });
    return reads;
  });
});

/** A policy status with times reduced to whether they are set (rule rows and revisions compare by value). */
const status = async (engine: BrainEngine, operationId?: string) => {
  const st = await policyStatus(engine, 'default', operationId);
  const rev = (r: typeof st.desired) => r && { ...r, created_at: r.created_at !== null, applied_at: r.applied_at !== null, approved_at: r.approved_at !== null };
  return { ...st, desired: rev(st.desired), pending: st.pending.map(p => p.prefix), invalid: st.invalid.map(p => [p.prefix, p.detail]) };
};

describe('engine parity: folder rule writes and reads', () => {
  parityTest('a widening is held until it is applied; then the member it adds reads the pages', {
    methods: ['readAccessStoreConfig', 'lockAccessPolicy', 'listAccessRules', 'readAccessPolicyRevisions', 'insertAccessPolicyRevision', 'applyAccessRuleChanges',
      'restampAccessWindow', 'finishAccessRestamp', 'approveAccessPolicyRevision', 'markAccessRevisionsApplied', 'readAccessPolicyMarks', 'listAccessPrefixSlugs', 'listCorePageRows'],
  }, async (engine) => {
    await seedRule(engine);
    const widened = await proposeRevision(engine, 'default', [{ id: 'alice', prefix: 'partners/alice/', readable_by: ['member:alice-example', 'member:bob-example'] }], { origin: 'cli', operationId: 'op-widen' });
    const held = { state: widened.state, bob: await readAs(engine, 'bob-example'), status: await status(engine, 'op-widen') };
    const preview = await previewApply(engine, 'default');
    const applied = await applyApproved(engine, 'default', { expect: preview.plan_hash!, approvedBy: 'parity' });
    const after = { state: applied.state, bob: await readAs(engine, 'bob-example'), status: await status(engine, 'op-widen'),
      revisions: (await listRevisions(engine, 'default')).map(r => [r.revision, r.change_kind, r.approved_by, r.applied_at !== null]) };
    const widening = preview.widening.map(w => ({ rule: w.change.rule, pages: w.pages, sample: w.sample }));
    expect({ heldState: held.state, heldBob: held.bob, afterBob: after.bob }).toEqual({ heldState: 'recorded', heldBob: ['notes/open'], afterBob: ['notes/open', 'partners/alice/deal', 'partners/alice/notes'] });
    return { held, widening, after };
  });

  parityTest('the folder reads follow the rules: restricted slugs, applied revisions, the rules a reader meets, invalid marks', {
    methods: ['isFolderRestricted', 'listAppliedPolicyRevisions', 'readFolderAccess', 'replaceAccessInvalidCoverage', 'hasAccessPolicyState', 'listAccessCoverage'],
  }, async (engine) => {
    await seedRule(engine);
    const restricted = async () => ({
      covered: await engine.isFolderRestricted('default', 'partners/alice/deal'),
      sibling: await engine.isFolderRestricted('default', 'partners/alice-2/x'),
      exactPrefix: await engine.isFolderRestricted('default', 'partners/alice'),
      open: await engine.isFolderRestricted('default', 'notes/open'),
    });
    const first = { restricted: await restricted(), revisions: await engine.listAppliedPolicyRevisions(),
      alice: await engine.readFolderAccess(['member:alice-example']), bob: await engine.readFolderAccess(['member:bob-example']), none: await engine.readFolderAccess([]) };
    await markPolicyInvalid(engine, 'default', ['notes/'], { error: 'bad yaml' });
    const invalid = { restricted: await restricted(), status: await status(engine), coverage: (await engine.readFolderAccess([])).coverage };
    await clearPolicyInvalid(engine, 'default');
    const resumed = await resumePolicy(engine, 'default');
    const cleared = { restricted: await restricted(), status: await status(engine), resumed };
    expect(first.restricted).toEqual({ covered: true, sibling: false, exactPrefix: false, open: false });
    expect(invalid.restricted.open).toBe(true);
    return { first, invalid, cleared };
  });

  parityTest('a page written under a rule after it applies is stamped and hidden; the rule add preview counts what it covers', {
    methods: ['putPage', 'listCorePageRows', 'countRuleCoveredPages', 'listRuleCoveredSlugs', 'listRuleCoveredPages'],
  }, async (engine) => {
    await seedRule(engine);
    await engine.putPage('partners/alice/later', core(), { sourceId: 'default' });
    await engine.putPage('partners/alice-x/open', core(), { sourceId: 'default' });
    const reads = { bob: await readAs(engine, 'bob-example'), alice: await readAs(engine, 'alice-example') };
    const preview = {
      one: await engine.countRuleCoveredPages('default', 'partners/alice/'),
      any: await engine.countRuleCoveredPages('default', ['partners/alice/', 'notes/open']),
      slugs: (await engine.listRuleCoveredSlugs('default', ['partners/alice/', 'notes/open'])).sort(),
      pages: await engine.listRuleCoveredPages('default', 'partners/alice/'),
      whole: await engine.countRuleCoveredPages('default', ''),
    };
    expect(reads.bob).toEqual(['notes/open', 'partners/alice-x/open']);
    expect(preview.one).toBe(3);
    return { reads, preview };
  });

  // The hot-memory cache watermark digests the rules and the pending prefixes, so a cached fact answer is dropped when
  // a rule changes; every engine renders the same digest.
  parityTest('the fact cache watermark moves when a rule is added and when it is removed', {
    methods: ['readFactCacheWatermark'],
  }, async (engine) => {
    const digest = async () => (await engine.readFactCacheWatermark('default')).access_rules;
    const before = await digest();
    await seedRule(engine);
    const ruled = await digest();
    await proposeRevision(engine, 'default', [], { origin: 'cli', store: 'database' });
    const held = await digest();
    expect(ruled).not.toBe(before);
    return { before, ruled, held };
  });
});

describe('the Rust arm serves folder rules, and still refuses the store migration (row 32h)', () => {
  // A parity case counts a typed refusal as a pass, so this reads the Rust arm's own engine: it is red while the rule
  // write stops on Rust, and it must never show a covered page to a member outside the rule.
  test('a rule written on Rust hides the covered pages from a member outside it', async () => {
    const rust = arms().find((arm) => arm.backend === 'rust');
    if (!rust) return;
    await resetArm(rust);
    await seedRule(rust.engine);
    expect(await readAs(rust.engine, 'bob-example')).toEqual(['notes/open']);
  });
  // Row 32h: moving a source's rules between the database and git (policy-migrate.ts) still runs raw SQL.
  test('loss (32h): gbrain access rule migrate stops on the raw_sql refusal, with nothing written', async () => {
    const rust = arms().find((arm) => arm.backend === 'rust');
    if (!rust) return;
    await resetArm(rust);
    await rust.engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
    const RAW_SQL = "This brain's engine does not support executeRaw yet (it needs the raw_sql capability), so nothing ran.";
    // `--to database` on a source with no store yet needs no git tree, so the migration reaches its journal read.
    const refused = await migrateAccessStore(rust.engine, 'default', 'database').then(() => ({ refused: false }), (e: Error & { code?: string }) => ({ code: e.code, message: e.message }));
    expect(refused).toEqual({ code: 'engine_capability_missing', message: RAW_SQL });
    expect((await policyStatus(rust.engine, 'default')).store).toBeNull();
  });
});
