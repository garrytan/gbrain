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
 *  - Moving a source's rules between the database and git (policy-migrate.ts): the journal reads and writes are typed
 *    members, so the same cases run on every arm. The last describe reads the Rust arm's own engine.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms, resetArm } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { addMember } from '../../src/core/access/members.ts';
import { applyApproved, clearPolicyInvalid, listRevisions, markPolicyInvalid, policyStatus, previewApply, proposeRevision, resumePolicy } from '../../src/core/access/policy.ts';
import { migrateAccessStore, migrateSeams, previewMigrate } from '../../src/core/access/policy-migrate.ts';
import { APPROVED_FILE, POLICY_FILE } from '../../src/core/access/policy-git.ts';
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

describe('engine parity: moving a source\'s folder rules between the database and git', () => {
  const journal = async (engine: BrainEngine, sourceId: string) => {
    const j = await engine.readUnfinishedAccessMigration(sourceId);
    return j && { id: j.id.startsWith('mig_'), phase: j.phase, direction: j.direction, receipts: Object.keys(j.receipts).sort() };
  };
  const plain = (text: string) => text.replace(/mig_[0-9a-f-]{36}/g, '<id>');
  /** One migrate: the journal after each phase (the seam), a stop at phase `stop`, and the result or the refusal. */
  async function migrate(engine: BrainEngine, sourceId: string, requested?: 'git' | 'database', stop?: string) {
    const seen: unknown[] = [];
    migrateSeams.afterPhase = async (phase) => { seen.push([phase, await journal(engine, sourceId)]); if (phase === stop) throw new Error('interrupted'); };
    try {
      const done = await migrateAccessStore(engine, sourceId, requested);
      const receipts = Object.fromEntries(Object.entries(done.receipts).map(([k, v]) => [k, typeof v === 'object' && v ? (v as { outcome?: string }).outcome : v]));
      return { seen, id: done.id, done: { from: done.from, to: done.to, phase: done.phase, receipts } };
    } catch (e) { return { seen, id: null, error: plain((e as Error).message) }; } finally { migrateSeams.afterPhase = undefined; }
  }

  parityTest('migrate --to database from no store journals each phase and switches the store', { methods: ['readUnfinishedAccessMigration', 'insertAccessMigration', 'recordAccessMigrationPhase', 'switchAccessMigration', 'writeAccessStoreConfig'] }, async (engine) => {
    await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
    const before = await previewMigrate(engine, 'default', 'database');
    const run = await migrate(engine, 'default', 'database');
    const after = { store: (await policyStatus(engine, 'default')).store, journal: await journal(engine, 'default'), resume: await previewMigrate(engine, 'default').then(p => p.resume, (e: Error) => plain(e.message)) };
    const again = await migrate(engine, 'default', 'database');
    expect({ from: before.from, to: before.to, resume: before.resume, store: after.store, journal: after.journal }).toEqual({ from: null, to: 'database', resume: null, store: 'database', journal: null });
    expect(run.seen).toEqual([['committed', { id: true, phase: 'committed', direction: 'to_database', receipts: [] }], ['switched', null]]);
    return { run: { ...run, id: run.id?.startsWith('mig_') }, after, again };
  });

  parityTest('an interrupted migrate resumes from its journal; a move the other way is refused until it finishes', { methods: ['readUnfinishedAccessMigration', 'insertAccessMigration', 'recordAccessMigrationPhase', 'switchAccessMigration', 'writeAccessStoreConfig'] }, async (engine) => {
    await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
    const stopped = await migrate(engine, 'default', 'database', 'committed');
    const left = await engine.readUnfinishedAccessMigration('default');
    const preview = await previewMigrate(engine, 'default');
    const refused = await previewMigrate(engine, 'default', 'git').then(() => 'allowed', (e: Error) => plain(e.message));
    const refusedRun = await migrate(engine, 'default', 'git');
    const untouched = { store: (await policyStatus(engine, 'default')).store, journal: await journal(engine, 'default') };
    const resumed = await migrate(engine, 'default');
    expect({ stopped: stopped.error, resume: preview.resume?.phase, same: preview.resume?.id === left?.id, finished: resumed.id === left?.id }).toEqual({ stopped: 'interrupted', resume: 'committed', same: true, finished: true });
    expect(refused).toBe('Source default has an unfinished migration <id> to the database store, so it cannot move to the git store now; nothing was written.');
    return { stopped, preview: { ...preview, resume: preview.resume && { ...preview.resume, id: true } }, refused, refusedRun, untouched, resumed: { ...resumed, id: true }, after: await journal(engine, 'default') };
  });

  parityTest('migrate --to git writes the rules into the work tree, journals each phase and switches the store', { methods: ['readUnfinishedAccessMigration', 'insertAccessMigration', 'recordAccessMigrationPhase', 'switchAccessMigration', 'writeAccessStoreConfig'] }, async (engine, backend) => {
    const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const root = mkdtempSync(join(tmpdir(), 'gbrain-parity-mig-'));
    try {
      git(root, 'init', '-q', '-b', 'main');
      git(root, 'config', 'user.email', 't@t.co');
      git(root, 'config', 'user.name', 't');
      writeFileSync(join(root, 'README.md'), 'repo\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'init');
      await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
      await createSource(engine, backend, 'mg', {}, root);
      await addMember(engine, 'alice-example');
      await proposeRevision(engine, 'mg', [{ id: 'alice', prefix: 'partners/alice/', readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
      const run = await migrate(engine, 'mg', 'git');
      const status = await policyStatus(engine, 'mg');
      const files = { yml: readFileSync(join(root, POLICY_FILE), 'utf8'), approved: readFileSync(join(root, APPROVED_FILE), 'utf8'), commits: git(root, 'log', '--format=%s').replaceAll('mg', '<src>').split('\n') };
      expect({ store: status.store, rules: status.rules.map(r => r.id), phase: run.done?.phase }).toEqual({ store: 'git', rules: ['alice'], phase: 'switched' });
      return { run: { ...run, id: run.id?.startsWith('mig_') }, files, journal: await journal(engine, 'mg') };
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// The switched row itself has no typed read (the Rust store's unit tests cover it there); the SQL arms are read directly.
test('a finished migrate leaves one switched journal row with the receipts of its phases', async () => {
  for (const arm of arms().filter((x) => x.backend !== 'rust')) {
    await resetArm(arm);
    await arm.engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
    await migrateAccessStore(arm.engine, 'default', 'database');
    const rows = await arm.engine.executeRaw<{ id: string; direction: string; phase: string; receipts: Record<string, unknown>; ordered: boolean }>(
      'SELECT id, direction, phase, receipts, updated_at >= created_at AS ordered FROM access_policy_migrations WHERE source_id = $1', ['default']);
    expect(rows.map((r) => ({ id: r.id.slice(0, 4), direction: r.direction, phase: r.phase, receipts: r.receipts, ordered: r.ordered }))).toEqual([{ id: 'mig_', direction: 'to_database', phase: 'switched', receipts: {}, ordered: true }]);
  }
});

describe('the Rust arm migrates a source\'s folder rules', () => {
  // A parity case counts a typed refusal as a pass, so these read the Rust arm's own engine: the first is red while the
  // rule write stops on Rust, and it must never show a covered page to a member outside the rule.
  test('a rule written on Rust hides the covered pages from a member outside it', async () => {
    const rust = arms().find((arm) => arm.backend === 'rust');
    if (!rust) return;
    await resetArm(rust);
    await seedRule(rust.engine);
    expect(await readAs(rust.engine, 'bob-example')).toEqual(['notes/open']);
  });
  // A refusal would pass the parity case above; this one fails unless the journal is written and the store switches.
  test('gbrain access rule migrate journals its phases and switches the store on Rust', async () => {
    const rust = arms().find((arm) => arm.backend === 'rust');
    if (!rust) return;
    await resetArm(rust);
    await rust.engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
    const done = await migrateAccessStore(rust.engine, 'default', 'database');
    expect({ to: done.to, phase: done.phase, store: (await policyStatus(rust.engine, 'default')).store, left: await rust.engine.readUnfinishedAccessMigration('default') })
      .toEqual({ to: 'database', phase: 'switched', store: 'database', left: null });
  });
});
