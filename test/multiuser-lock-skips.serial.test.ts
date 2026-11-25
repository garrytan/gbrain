/**
 * The TypeScript lock skips that pass in multi-user mode (docs/designs/rust-engine/multi-user-server.md, "Appendix: skip
 * guarantees under multi-user mode"; src/core/rust-engine/lock-skip-guarantees.ts MULTIUSER_PROVEN). Each case opens a real
 * Rust engine with `GBRAIN_RUST_MULTIUSER=1` and shows, with a concurrent writer, that the guarantee which replaces the
 * skipped lock holds for the member:
 *
 *   read-set: the transaction runs the member, which reads (through the transaction's store handle) the row the SQL locks;
 *   a second writer commits a change to that row before the first transaction commits; the first commit is refused with
 *   `write_conflict`, the callback runs again, and the rerun sees the change. Nothing of the first run is kept.
 *
 * The addon tests need the file `bun run rust:build` writes (rust/target/addon) and skip without it;
 * GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error. Serial: the switch is an environment variable.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { MULTIUSER_PROVEN } from '../src/core/rust-engine/lock-skip-guarantees.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { readManagedMode, readPersistenceBrain } from '../src/core/persistence/managed-mode.ts';
import { closeOpenLoop, upsertOpenLoop } from '../src/core/loops/loops-store.ts';
import type { StoreBrain } from '../src/core/rust-engine/store.ts';
import * as cliSources from '../src/core/rust-engine/store-members/cli-sources.ts';
import * as embeddingInstall from '../src/core/rust-engine/store-members/embedding-install.ts';
import * as effectWorker from '../src/core/rust-engine/store-members/effect-worker.ts';
import * as factTextRepair from '../src/core/rust-engine/store-members/fact-text-repair.ts';
import * as factsConversation from '../src/core/rust-engine/store-members/facts-conversation.ts';
import * as factsRest from '../src/core/rust-engine/store-members/facts-rest.ts';
import * as factsWritePath from '../src/core/rust-engine/store-members/facts-write-path.ts';
import * as jobsClientGrants from '../src/core/rust-engine/store-members/jobs-client-grants.ts';
import * as jobsQueue from '../src/core/rust-engine/store-members/jobs-queue.ts';
import * as mentionPass from '../src/core/rust-engine/store-members/mention-pass.ts';
import * as persistence from '../src/core/rust-engine/store-members/persistence.ts';
import * as publicationJournal from '../src/core/rust-engine/store-members/publication-journal.ts';
import * as repairApplies from '../src/core/rust-engine/store-members/repair-applies.ts';
import * as sharedSkillMembers from '../src/core/rust-engine/store-members/shared-skill-members.ts';
import * as transactionsMembers from '../src/core/rust-engine/store-members/transactions.ts';
import * as worktreeClaim from '../src/core/rust-engine/store-members/worktree-claim.ts';
import * as writerAdmin from '../src/core/rust-engine/store-members/writer-admin.ts';
import * as writerRelease from '../src/core/rust-engine/store-members/writer-release.ts';
import { reserve, reserveGroup, readGroupSpend } from '../src/core/minions/budget-meter.ts';
import { BudgetExceededError } from '../src/core/spend-log.ts';

const TARGET = detectAddonTarget();
// GBRAIN_TEST_RUST_ADDON overrides the built file (a build made with the Rust lock-skip rows of the same tree).
const BUILT = process.env.GBRAIN_TEST_RUST_ADDON ?? join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);
const FILE = 'test/multiuser-lock-skips.serial.test.ts';

let addon: RustAddon | undefined;
const dirs: string[] = [];
const engines: RustEngine[] = [];
const savedMultiuser = process.env.GBRAIN_RUST_MULTIUSER;

async function open(): Promise<RustEngine> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  process.env.GBRAIN_RUST_MULTIUSER = '1';
  const path = mkdtempSync(join(tmpdir(), 'gbrain-lock-skips-'));
  dirs.push(path);
  const engine = openRustEngine({ addon, databasePath: path });
  engines.push(engine);
  await engine.connect({ engine: 'rust', database_path: path } as never);
  return engine;
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedMultiuser === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = savedMultiuser;
});

/** A promise and the function that settles it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

/**
 * The read-set proof. Runs `probe` in a transaction that parks after its first run; `change` then commits a write to the
 * row the SQL locks, outside the transaction; the transaction resumes, its commit is refused, and it runs again from a
 * fresh snapshot. Returns what each run of `probe` saw.
 */
async function rerunsOnChange<T>(engine: RustEngine, probe: (tx: BrainEngine) => Promise<T>, change: (engine: RustEngine) => Promise<unknown>): Promise<{ runs: number; seen: T[]; committed: string | null }> {
  const seen: T[] = [];
  const parked = gate();
  const resume = gate();
  const done = engine.transaction(async (tx) => {
    seen.push(await probe(tx));
    // The write makes the transaction a writer; the commit validates what the probe read.
    await tx.setConfig('lock_skips.marker', `run ${seen.length}`);
    if (seen.length === 1) { parked.open(); await resume.wait; }
  });
  await parked.wait;
  try { await change(engine); } finally { resume.open(); }
  await done;
  return { runs: seen.length, seen, committed: await engine.getConfig('lock_skips.marker') };
}

/** Moves the stored brain mode (its epoch), the row the brain guards guard. */
const moveBrainMode = async (engine: RustEngine) => (await engine.writerReleaseStore()).setBrainEnabled(false);
const WORKTREE = '00000000-0000-4000-8000-000000000011';
/** Registers a worktree, the row the worktree locks guard. */
const addWorktree = async (engine: RustEngine) => (await engine.worktreeClaimStore()).insertWorktree({ id: WORKTREE, ownerHostId: null });

/** A wanted-link replacement whose one row names a page of a source that is not registered yet. */
const WANTED_GHOST = { wanted: { producers: ['body'], readAt: null, rows: [
  { producer: 'body', ref_kind: 'slug', target_source_id: 'ghost', target_ref: 'notes/target', link_type: 'mentions', context: 'x' }] } } as never;

/** The generation the generation-key lock guards. */
const GENERATION_KEY = { kind: 'fence', sourceId: 'default', ownerKey: 'people/alice' } as never;

const EPOCH_0 = '00000000-0000-4000-8000-0000000000e0';
const EPOCH_1 = '00000000-0000-4000-8000-0000000000e1';
const EPOCH_2 = '00000000-0000-4000-8000-0000000000e2';

/** One case: the sites it proves, its name (cited by MULTIUSER_PROVEN), the probe and the concurrent change. */
type Probe = (tx: BrainEngine, ctx: any) => Promise<unknown>;

interface Case {
  readonly name: string;
  readonly sites: readonly string[];
  /** Seeds the rows of one run (each probe runs on its own engine); what it returns is passed to the probe and the change. */
  readonly setup?: (engine: RustEngine) => Promise<any>;
  /** Each probe is run on its own, so each member is shown to take the guarantee alone. */
  readonly probe: Probe | readonly Probe[];
  readonly change: (engine: RustEngine, ctx: any) => Promise<unknown>;
  /** What the first and the second run of the probe saw, for a probe that returns the row. */
  /** A probe that takes no lock of the member under test: the same change must leave it alone (the rerun above comes from the lock). */
  readonly without?: Probe;
  readonly observe?: (first: unknown, second: unknown) => void;
}

/** A barrier of `n` first runs: each run's first call waits until all `n` arrived; a rerun passes at once. */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  const all = gate();
  return async () => { if (++arrived === n) all.open(); if (arrived <= n) await all.wait; };
}

/** The jobs queue's insert values with the defaults the parity tests use. */
const jobValues = (name: string, extra: Record<string, unknown> = {}) => ({
  name, queue: 'default', status: 'waiting', priority: 0, data: {}, max_attempts: 3, backoff_type: 'exponential', backoff_delay: 1000, backoff_jitter: 0.2, delay_until: null,
  parent_job_id: null, on_child_fail: 'fail_parent', max_children: null, timeout_ms: null, lock_duration_ms: null, remove_on_complete: false, remove_on_fail: false,
  idempotency_key: null, quiet_hours: null, stagger_key: null, private_queue_owner_job_id: null, private_queue_owner_token: null, private_queue_lease_until: null,
  submission_authority: { version: 1, kind: 'application' }, spend_authorization: null, max_stalled: null, ...extra,
});

/** Tests that drive a cap or a claim with several concurrent writers, not one probe: the sites they prove, and the rows (E*) they answer. */
const BESPOKE = {
  admitJob: {
    name: 'admitJob: two overlapping delegated admissions at a cap of one never both insert',
    sites: ['admitJob'],
  },
  chronicle: {
    name: 'chronicle judge cap: four overlapping transactions reserve at most the daily cap',
    sites: [],
  },
  mention: {
    name: 'mention pass: two overlapping disables lose no generation bump and two overlapping gazetteer saves apply once',
    sites: [],
  },
  prune: {
    name: 'telemetry prune: two overlapping pruners delete every old row exactly once',
    sites: [],
  },
  fileInsert: {
    name: 'files insert: a page rewritten before the commit reruns the file row that reads its slug',
    sites: [],
  },
  budget: {
    name: 'budget admission: overlapping client and group reservations never exceed the cap',
    sites: [],
  },
} as const;

const CASES: Case[] = [
  // ---------------------------------------------------------------- the source row
  {
    name: 'source row, whole table: a source written before the commit reruns lockAllSourceRows',
    sites: ['lockAllSourceRows'],
    probe: (tx) => tx.lockAllSourceRows('share'),
    change: (e) => e.updateSourceConfig('default', { changed: 'yes' }),
  },
  {
    name: 'source row: a source written before the commit reruns lockSourceRow and the rerun reads the new row',
    sites: ['lockSourceRow'],
    probe: async (tx) => (await tx.lockSourceRow('default'))?.config,
    change: (e) => e.updateSourceConfig('default', { changed: 'yes' }),
    observe: (first, second) => { expect(first).not.toHaveProperty('changed'); expect(second).toHaveProperty('changed', 'yes'); },
  },
  {
    name: 'source row: a source written before the commit reruns lockSourceForUpdate',
    sites: ['lockSourceForUpdate'],
    probe: (tx) => tx.lockSourceForUpdate('default'),
    change: (e) => e.updateSourceConfig('default', { changed: 'yes' }),
  },
  {
    name: 'source row: a source written before the commit reruns lockSourceShared',
    sites: ['lockSourceShared'],
    probe: (tx) => tx.lockSourceShared('default'),
    change: (e) => e.updateSourceConfig('default', { changed: 'yes' }),
  },
  // ---------------------------------------------------------------- more source readers
  {
    name: 'source row: a source written before the commit reruns the share-locked source readers',
    sites: ['readSourceArchivedForShare', 'readSourceState', 'readScopeSourceConfigs', 'readSourceMembership', 'listConnectorSources'],
    probe: [
      (tx) => tx.readSourceArchivedForShare('default'),
      (tx) => tx.readSourceState('default', { lock: 'share' }),
      (tx) => tx.readScopeSourceConfigs(['default'], 'share'),
      (tx) => tx.readSourceMembership('default', { lock: true }),
      (tx) => tx.listConnectorSources({ lock: true }),
    ],
    change: (e) => e.updateSourceConfig('default', { changed: 'yes' }),
  },
  // ---------------------------------------------------------------- the brain row (its stored mode and epoch)
  {
    name: 'brain row: a mode change committed before the commit reruns readManagedMode and readPersistenceBrain',
    sites: ['readManagedMode', 'readManagedMode.afterRead', 'readPersistenceBrain', 'readPersistenceBrain.afterRead'],
    probe: [
      (tx) => readManagedMode(tx as never, { lock: 'update' }),
      async (tx) => (await readPersistenceBrain(tx as never, { lock: 'share' })).mode_epoch,
    ],
    change: moveBrainMode,
  },
  {
    name: 'brain row: a mode change committed before the commit reruns declarePersistence',
    sites: ['declarePersistence'],
    probe: (tx) => tx.declarePersistence(),
    change: moveBrainMode,
  },
  {
    name: 'brain row: a mode change committed before the commit reruns the brain guards of writer release, writer admin, the claim store and the effect guard',
    sites: ['writerRelease.shareBrain', 'writerAdmin.lockBrain', 'worktreeClaimStore', 'lockEffectGuard', 'lockSharedSkillBrainId', 'readWriterAdminState'],
    probe: [
      async (tx) => (await tx.writerReleaseStore()).shareBrain(),
      async (tx) => (await tx.writerAdminStore()).lockBrain(),
      async (tx) => { await tx.worktreeClaimStore(); },
      (tx) => tx.lockEffectGuard(null),
      (tx) => tx.lockSharedSkillBrainId(),
      (tx) => tx.readWriterAdminState({ lock: true }),
    ],
    change: moveBrainMode,
  },
  // ---------------------------------------------------------------- worktree rows (absent until a claim registers one)
  {
    name: 'worktree row: a worktree registered before the commit reruns the worktree locks',
    sites: ['writerRelease.shareWorktree', 'writerAdmin.lockWorktree', 'publicationJournal.shareWorktree', 'publicationJournal.shareWorktreeOwner'],
    probe: [
      async (tx) => (await tx.writerReleaseStore()).shareWorktree(WORKTREE),
      async (tx) => (await tx.writerAdminStore()).lockWorktree(WORKTREE),
      async (tx) => (await tx.publicationJournalStore()).shareWorktree(WORKTREE),
      async (tx) => (await tx.publicationJournalStore()).shareWorktreeOwner(WORKTREE),
    ],
    change: addWorktree,
  },
  {
    name: 'source row: a source written before the commit reruns the claim and publication source locks',
    sites: ['worktreeClaim.lockSource', 'publicationJournal.lockSource', 'writerRelease.configuredSources', 'writerRelease.lockWorktreesAndSources'],
    probe: [
      async (tx) => (await (await tx.worktreeClaimStore()).lockSource('default')),
      async (tx) => (await tx.publicationJournalStore()).lockSource('default'),
      async (tx) => (await tx.writerReleaseStore()).configuredSources(true),
      async (tx) => (await tx.writerReleaseStore()).lockWorktreesAndSources(),
    ],
    change: (e) => e.updateSourceConfig('default', { changed: 'yes' }),
  },
  {
    name: 'worktree row: a worktree registered before the commit reruns lockWorktreesAndSources',
    sites: [],
    probe: async (tx) => (await tx.writerReleaseStore()).lockWorktreesAndSources(),
    change: addWorktree,
  },
  {
    name: 'config row: a change committed before the commit reruns the config guards',
    sites: ['readConfigForUpdate', 'lockAgentWritebackSetting', 'lockEmbeddingSwitch', 'lockContentDriftState'],
    probe: [
      (tx) => tx.readConfigForUpdate('lock_skips.cfg'),
      (tx) => tx.lockAgentWritebackSetting('lock_skips.cfg'),
      (tx) => tx.lockEmbeddingSwitch(),
    ],
    change: async (e) => { await e.setConfig('lock_skips.cfg', 'changed'); await e.setConfig('embedding_disabled', 'true'); },
  },
  // ---------------------------------------------------------------- OAuth clients
  {
    name: 'oauth client row: a change committed before the commit reruns the client-row readers and locks',
    sites: ['readOAuthClientReceiptGrant', 'readOAuthClientMemberGrant', 'readOauthClientAttest', 'readOauthClientForUpdate', 'lockOAuthClient', 'readOAuthClientWriteGrant', 'shareLockWriteCredential', 'readCredentialBindingForUpdate'],
    setup: async (e) => { await e.insertOauthClient({ client_id: 'client-a', client_name: 'client-a', scope: 'read' }); return 'client-a'; },
    probe: [
      (tx, id) => tx.readOAuthClientReceiptGrant(id, { lock: true }),
      (tx, id) => tx.readOAuthClientMemberGrant(id, { lock: true }),
      (tx, id) => tx.readOauthClientAttest(id, { lock: true }),
      (tx, id) => tx.readOauthClientForUpdate(id),
      (tx, id) => tx.lockOAuthClient(id),
      (tx, id) => tx.readOAuthClientWriteGrant(id, { lock: true }),
      (tx, id) => tx.shareLockWriteCredential('oauth_client', id),
      (tx, id) => tx.readCredentialBindingForUpdate({ kind: 'client', id }, { readsUnscoped: false }),
    ],
    change: (e, id) => e.setOauthClientTokenTtl(id, 777),
  },
  {
    name: 'oauth client rows: a client registered before the commit reruns lockOauthClientName',
    sites: ['lockOauthClientName'],
    probe: (tx) => tx.lockOauthClientName('gbrain:register-client:same-name'),
    change: (e) => e.insertOauthClient({ client_id: 'client-b', client_name: 'same-name', scope: 'read' }),
  },
  {
    name: 'config row: a writer-admin lock change committed before the commit reruns the admin-unlocked checks',
    sites: ['worktreeClaim.assertAdminUnlocked', 'writerAdmin.assertAdminUnlocked'],
    probe: [
      async (tx) => (await tx.worktreeClaimStore()).assertAdminUnlocked(),
      async (tx) => (await tx.writerAdminStore()).assertAdminUnlocked(),
    ],
    change: (e) => e.setConfig('persistence.writer_admin_lock', JSON.stringify({ locked: false, set_at: null, host_id: null, generation: 1 })),
  },
  // ---------------------------------------------------------------- access tokens and local writers
  {
    name: 'access token row: a revocation committed before the commit reruns the token-row readers and locks',
    sites: ['readAccessTokenReceiptGrant', 'readAccessTokenMemberGrant', 'readAccessTokenWriteGrant'],
    setup: async (e) => (await e.insertAccessToken({ name: 'tok', token_hash: 'h-tok', scopes: ['read'], permissions: {}, source_grant: null, source_id: null,
      federated_read: null, allowed_operations: null, takes_holders: null })).id,
    probe: [
      (tx, id) => tx.readAccessTokenReceiptGrant(id, { lock: true }),
      (tx, id) => tx.readAccessTokenMemberGrant(id, { lock: true }),
      (tx, id) => tx.readAccessTokenWriteGrant(id, { lock: true }),
      (tx, id) => tx.shareLockWriteCredential('legacy_token', id),
      (tx, id) => tx.readCredentialBindingForUpdate({ kind: 'token', id }, { readsUnscoped: false }),
    ],
    change: (e, id) => e.revokeAccessTokenById(id),
  },
  {
    name: 'local writer row: a revocation committed before the commit reruns the local-writer readers',
    sites: ['readLocalWriterRow', 'readLocalWriterMemberGrant'],
    setup: async (e) => {
      const id = '00000000-0000-4000-8000-0000000000a1';
      await e.insertLocalWriterRow({ id, lane: 'cli', credentialHash: 'c'.repeat(64), grant: { sourceIds: ['default'], operations: null, scopes: ['read'], slugPrefixes: null } });
      return id;
    },
    probe: [
      (tx, id) => tx.readLocalWriterRow(id, { lock: true }),
      (tx, id) => tx.readLocalWriterMemberGrant(id),
    ],
    change: (e, id) => e.revokeLocalWriterRow(id),
  },
  // ---------------------------------------------------------------- proposals
  {
    name: 'proposal rows: a transition committed before the commit reruns the proposal readers',
    sites: ['getTrustProposal', 'getDecideProposal', 'getDecideReviewProposal'],
    setup: async (e) => {
      const page = await e.putPage('notes/proposal', { type: 'note', title: 'P', compiled_truth: 'Body.', timeline: '' });
      const trust = await e.insertTrustProposal({ action: 'lower_page', sourceId: 'default', target: { table: 'pages', id: page.id }, before: {}, proposer: 'test' });
      const decide = await e.insertDecideProposal({ source_id: 'default', sweep_id: 's1', pair_index: 0, new_fact_id: 1, old_fact_id: 2, direction: 'new_supersedes_old',
        p_supersede: 0.9, threshold: 0.5, proposal_floor: 0.1, model_resolved: null });
      const review = await e.insertDecideReviewProposal({ kind: 'k', source_id: 'default', sweep_id: 's1', a_ref: 'a', b_ref: 'b', subject: 's', visibility: null, p_action: 0.5,
        threshold: null, model_resolved: null, question_version: null, receipt: null });
      return { trust: trust.id, decide: decide!, review: review! };
    },
    probe: [
      (tx, ids) => tx.getTrustProposal(ids.trust, true),
      (tx, ids) => tx.getDecideProposal(ids.decide, true),
      (tx, ids) => tx.getDecideReviewProposal(ids.review, true),
    ],
    change: async (e, ids) => {
      await e.transitionTrustProposal(ids.trust, 'pending', 'rejected');
      await e.transitionDecideProposal(ids.decide, 'pending', 'rejected');
      await e.transitionDecideReviewProposal(ids.review, 'pending', 'rejected');
    },
  },
  // ---------------------------------------------------------------- fact rows
  {
    name: 'fact row: a fact expired before the commit reruns the fact guards and claim reads',
    sites: ['lockFactRows', 'lockApprovedFacts', 'readForgetTarget', 'readFactWithdrawalClaim'],
    setup: async (e) => (await e.insertFact({ fact: 'Lives in Lisbon', visibility: 'world', source: 'synthetic' }, { source_id: 'default' })).id,
    probe: [
      (tx, id) => tx.lockFactRows('default', [id]),
      (tx, id) => tx.lockApprovedFacts('default', [id]),
      (tx, id) => tx.readForgetTarget({ id, sourceId: 'default', worldOnly: false, remoteFloor: false, lock: true, ownPage: null }),
      (tx, id) => tx.readFactWithdrawalClaim({ id, sourceId: 'default', worldOnly: false, memberPage: null, remoteFloor: false, lock: true }),
    ],
    change: (e, id) => e.expireSourceFactNow(id, 'default'),
  },
  // ---------------------------------------------------------------- page rows
  {
    name: 'page row: a page rewritten before the commit reruns the page guards and reads',
    sites: ['lockPageById', 'readLiveStoredBody', 'readMentionPageRevisions', 'listSecretHoldingPages'],
    setup: async (e) => {
      await e.putPage('notes/locked', { type: 'note', title: 'Locked', compiled_truth: 'Body one.', timeline: '' });
      return (await e.readPageSnapshot('notes/locked', { sourceId: 'default' }))!.page.id;
    },
    probe: [
      (tx, id) => tx.lockPageById(id),
      (tx) => tx.readLiveStoredBody('default', 'notes/locked', true),
      (tx, id) => tx.readMentionPageRevisions([id], { forShare: true }),
      (tx) => tx.listSecretHoldingPages('default', ['notes/locked'], '00000000-0000-4000-8000-0000000000b1'),
    ],
    change: (e) => e.putPage('notes/locked', { type: 'note', title: 'Locked', compiled_truth: 'Body two.', timeline: '' }),
  },
  // ---------------------------------------------------------------- the mention pass (TS-only advisory locks on the SQL engines)
  {
    name: 'mention status row: a generation bump committed before the commit reruns lockMentionSources and readMentionGenerations',
    sites: ['lockMentionSources', 'readMentionGenerations'],
    probe: [
      (tx) => tx.lockMentionSources(['default'], false),
      (tx) => tx.lockMentionSources(['default'], true),
      (tx) => tx.readMentionGenerations(['default'], true),
    ],
    change: (e) => e.writeMentionIndexStatus('default', { state: 'pending', pending: null, lastPassAt: null, error: null, bumpGeneration: true, fingerprint: null, setFingerprint: false }),
  },
  {
    name: 'mention gazetteer entries: a save committed before the commit reruns lockMentionEntries',
    sites: ['lockMentionEntries'],
    probe: (tx) => tx.lockMentionEntries('default'),
    change: (e) => e.applyGazetteerEntryChanges('default', [], [{ source_id: 'default', name_norm: 'alice', target_slug: 'people/alice', case_sensitive: false }]),
  },
  // ---------------------------------------------------------------- generations (the lock is followed by the live-generation read)
  {
    name: 'generation key: a generation activated before the commit reruns lockGenerationKey followed by the live-generation read',
    sites: ['lockGenerationKey'],
    probe: async (tx) => { await tx.lockGenerationKey('gbrain:generation:fence:default:people/alice'); return tx.readLiveGenerationRow(GENERATION_KEY); },
    change: (e) => e.activateGenerationRows(GENERATION_KEY, null, { generation: 1, runId: null, operationId: 'op-1', inputPin: null, inputSize: null, completeness: '{}', setHash: 'h',
      restoreOf: null, activationId: null, locator: null }, []),
  },
  // ---------------------------------------------------------------- more source, cycle-lock and worktree readers
  {
    name: 'source row: a source written before the commit reruns lockPurgeSource',
    sites: ['lockPurgeSource'],
    probe: (tx) => tx.lockPurgeSource('default'),
    change: (e) => e.updateSourceConfig('default', { changed: 'yes' }),
  },
  {
    name: 'worktree rows: a worktree registered before the commit reruns readWorktreeAdmission',
    sites: ['readWorktreeAdmission'],
    setup: async (e) => ({ worktreeId: WORKTREE, sourceId: 'default', sourceIncarnation: (await e.readSourceIncarnation('default'))!.incarnation, topologyGeneration: null }),
    probe: (tx, key) => tx.readWorktreeAdmission(key),
    change: addWorktree,
  },
  // ---------------------------------------------------------------- shared skills
  {
    name: 'shared skill rows: a rebind, a policy write and an acknowledgement committed before the commit rerun the shared-skill readers',
    sites: ['readSharedSkillPolicyRow', 'readSharedSkillMember', 'readSharedSkillDeliveryBatch'],
    setup: async (e) => {
      const installationId = '00000000-0000-4000-8000-0000000000c1';
      const token = '00000000-0000-4000-8000-0000000000c2';
      const incarnation = String((await e.readSourceIncarnation('default'))!.incarnation);
      await e.enrollSharedSkillMember({ installationId, principalKind: 'token', principalId: 'p1', adapter: 'a1', brainId: (await e.readPersistenceBrainId())!, followPolicy: null });
      await e.writeSharedSkillPolicy({ sourceId: 'default', incarnation, epoch: EPOCH_1, policy: { follow: true }, principalKind: 'token', principalId: 'p1', previousEpoch: EPOCH_0 });
      await e.issueSharedSkillDeliveryBatch({ installationId, epoch: 1, issuedSequence: 1, viewToken: 'v1', authorityDigest: 'd1', revisions: [], token, retainedBatches: 3 });
      return { installationId, token, incarnation };
    },
    probe: [
      (tx, c) => tx.readSharedSkillPolicyRow('default', c.incarnation, true),
      (tx, c) => tx.readSharedSkillMember({ installationId: c.installationId, principalKind: 'token', principalId: 'p1' }),
      (tx, c) => tx.readSharedSkillDeliveryBatch(c.token, c.installationId, 1),
    ],
    change: async (e, c) => {
      await e.writeSharedSkillPolicy({ sourceId: 'default', incarnation: c.incarnation, epoch: EPOCH_2, policy: { follow: false }, principalKind: 'token', principalId: 'p1', previousEpoch: EPOCH_1 });
      await e.rebindSharedSkillMember(c.installationId, null, 1);
      await e.acknowledgeSharedSkillDeliveryBatch({ token: c.token, evidence: { ok: true }, installationId: c.installationId, advance: null });
    },
  },
  // ---------------------------------------------------------------- loops, fence facts, write requests
  {
    name: 'loop row: a close committed before the commit reruns readLoopFactState',
    sites: ['readLoopFactState'],
    setup: async (e) => {
      const fact = await e.insertFact({ fact: 'Send the deck by Friday', visibility: 'world', source: 'synthetic' }, { source_id: 'default' });
      const loop = await upsertOpenLoop(e, { sourceId: 'default', dedupKey: 'commit:one', loopType: 'commitment_owed_by_me', summary: 'Send the deck', evidence: [],
        threadId: 'thread-1', pageSlug: 'emails/one', detector: 'llm_extract', factId: fact.id } as never);
      return loop.id;
    },
    probe: (tx, id) => tx.readLoopFactState(id, { lock: true }),
    change: (e, id) => closeOpenLoop(e, 'default', id, 'done', 'test'),
  },
  {
    name: 'fence facts: a fact written for the page before the commit reruns listFenceFactRows',
    sites: ['listFenceFactRows'],
    probe: (tx) => tx.listFenceFactRows({ sourceId: 'default', slug: 'people/alice', incoming: '[]' }),
    change: (e) => e.insertFacts([{ fact: 'Alice leads the team', visibility: 'world', source: 'synthetic', entity_slug: 'people/alice', source_markdown_slug: 'people/alice', row_num: 1 }], { source_id: 'default' }),
  },
  {
    name: 'write request row: a cancellation committed before the commit reruns lockWriteRequest, lockWriteRequestsById and recoveryStaging',
    sites: ['lockWriteRequest', 'lockWriteRequestsById', 'publicationJournal.recoveryStaging'],
    setup: async (e) => {
      const source = await e.readSourceMembership('default');
      const row = await e.insertWriteRequest({ principalKind: 'local_cli', principalId: 'lock-skips', requestId: 'b0000000-0000-4000-8000-000000000001', operation: 'put_page',
        sourceId: 'default', sourceIncarnation: source!.incarnation, pageId: null, slug: 'notes/w', worktreeId: null, topologyGeneration: null, digest: '1'.repeat(64), intent: {},
        authority: {}, intentBytes: 10, terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'v-test', admitterHostId: null,
        counterKeys: ['brain'], clientRequestId: null, state: 'queued', deferredRefreshId: null } as never);
      return row.id;
    },
    probe: [
      (tx, id) => tx.lockWriteRequest(id),
      (tx, id) => tx.lockWriteRequestsById([id]),
      async (tx, id) => (await tx.publicationJournalStore()).recoveryStaging('persistence_requests', id),
    ],
    change: (e, id) => e.cancelWriteRow({ id, state: 'cancelled', expectState: 'queued', expectExecutionToken: null, outcome: null, errorCode: 'cancelled', errorMessage: 'x',
      consumerVersion: 'v', consumerHostId: null, errorDetail: null, resultBytes: 100, counterKeys: ['brain'], intentBytes: 10, retainedBytes: 512, terminalReservation: 4096,
      probePurges: false } as never),
  },
  {
    name: 'effect rows: an effect queued before the commit reruns readNoopEmbeddingCandidates',
    sites: ['readNoopEmbeddingCandidates'],
    setup: async (e) => {
      const source = await e.readSourceMembership('default');
      const row = await e.insertWriteRequest({ principalKind: 'local_cli', principalId: 'lock-skips', requestId: 'b0000000-0000-4000-8000-000000000002', operation: 'put_page', sourceId: 'default',
        sourceIncarnation: source!.incarnation, pageId: null, slug: 'notes/e', worktreeId: null, topologyGeneration: null, digest: '2'.repeat(64), intent: {}, authority: {},
        intentBytes: 10, terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'v-test', admitterHostId: null, counterKeys: ['brain'],
        clientRequestId: null, state: 'queued', deferredRefreshId: null } as never);
      return row.id;
    },
    probe: (tx) => tx.readNoopEmbeddingCandidates({ hostId: '00000000-0000-4000-8000-0000000000f1', signature: 's', expectedModel: 'm', window: [], pageIds: [], column: 'embedding' } as never),
    change: (e, request) => e.insertWithdrawalEffects({ requestId: request, sourceId: 'default', targets: [] }),
  },
  // ---------------------------------------------------------------- wanted links (foreign sources checked after the publish)
  {
    name: 'source rows: a source registered before the commit reruns the wanted-link replacement that checked it',
    sites: ['replaceDerivedLinks.wanted', 'replaceDerivedLinksBatch.wanted'],
    setup: async (e) => {
      await e.putPage('notes/origin', { type: 'note', title: 'O', compiled_truth: 'Body.', timeline: '' });
      const snapshot = (await e.readPageSnapshot('notes/origin', { sourceId: 'default' }))!;
      return { sourceId: 'default', slug: 'notes/origin', expectedRevision: snapshot.revision, sourceIncarnation: snapshot.sourceIncarnation };
    },
    probe: [
      (tx, origin) => tx.replaceDerivedLinks(origin, [], WANTED_GHOST),
      (tx, origin) => tx.replaceDerivedLinksBatch([{ origin, links: [], opts: WANTED_GHOST }]),
    ],
    without: (tx, origin) => tx.replaceDerivedLinks(origin, [], { wanted: { producers: ['body'], rows: [], readAt: null } } as never),
    change: (e) => e.insertSource({ id: 'ghost', name: 'ghost', local_path: null, config: {} }),
  },
];

/** The unrelated change of the control run: a config key no case reads. */
const unrelatedChange = (engine: RustEngine) => engine.setConfig('lock_skips.unrelated', 'x');

describe('multi-user lock skips: the guarantee that replaces the lock holds with a concurrent writer', () => {
  for (const c of CASES) {
    withAddon(c.name, async () => {
      for (const [index, probe] of ([] as Probe[]).concat(c.probe).entries()) {
        const engine = await open();
        const ctx = await c.setup?.(engine);
        // Control: a committed write to a row the member does not read leaves the transaction alone.
        const control = await rerunsOnChange(engine, (tx) => probe(tx, ctx), unrelatedChange);
        expect(control.runs, `probe ${index} reran on an unrelated write`).toBe(1);
        // The row the SQL locks changes before the commit: the commit is refused and the callback runs again.
        const proof = await rerunsOnChange(engine, (tx) => probe(tx, ctx), (e) => c.change(e, ctx));
        expect(proof.runs, `probe ${index} did not rerun after the locked row changed`).toBe(2);
        expect(proof.committed).toBe('run 2');
        c.observe?.(proof.seen[0], proof.seen[1]);
        if (c.without) {
          const bare = await open();
          const bareCtx = await c.setup?.(bare);
          expect((await rerunsOnChange(bare, (tx) => c.without!(tx, bareCtx), (e) => c.change(e, bareCtx))).runs, 'the same call without the lock reran').toBe(1);
        }
      }
    }, 120_000);
  }

  // ------------------------------------------------------------------ admissions and caps: concurrent writers over one cap
  withAddon(BESPOKE.admitJob.name, async () => {
    const engine = await open();
    const owner = 'client-a';
    await engine.insertOauthClient({ client_id: owner, client_name: owner, scope: 'read' });
    const policy = { lock: async () => 1, checkCapacity: async (tx: BrainEngine, limit: number | null) => {
      const open = await tx.countOpenJobsByOwner(owner);
      if (open >= (limit ?? 0)) throw new Error('at the client cap');
      await meet();
    }, decide: async () => 'coalesce' as const } as never;
    const meet = barrier(2);
    const admit = (n: number) => engine.admitJob({ maxSpawnDepth: 5, insert: jobValues('subagent', { data: { __owner_client_id: owner, __delegation_grant: { n } } }) } as never, policy);
    const results = await Promise.allSettled([admit(1), admit(2)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason?.message))).toEqual(['at the client cap']);
    expect(await engine.countOpenJobsByOwner(owner)).toBe(1);
  }, 60_000);

  withAddon(BESPOKE.chronicle.name, async () => {
    const engine = await open();
    const meet = barrier(4);
    const reserved = await Promise.all([1, 2, 3, 4].map((n) => engine.transaction(async (tx) => {
      const taken = await tx.reserveChronicleJudgeSlot(2, { sourceId: 'default', pageId: n, contentHash: `h${n}` });
      await meet();
      return taken;
    })));
    expect(reserved.filter(Boolean)).toHaveLength(2);
    expect(await engine.countRecentChronicleReservations()).toBe(2);
  }, 60_000);

  withAddon(BESPOKE.budget.name, async () => {
    const engine = await open();
    await engine.insertOauthClient({ client_id: 'spender', client_name: 'spender', scope: 'read' });
    const meet = barrier(3);
    const opts = { clientId: 'spender', estimatedCents: 60, capCents: 100, model: 'm', provider: 'p', validateAdmission: async () => { await meet(); } };
    const client = await Promise.allSettled([1, 2, 3].map(() => reserve(engine, opts)));
    expect(client.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(client.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof BudgetExceededError)).toBe(true);
    // The group budget: the first attempt reserves what room is left; concurrent attempts see its live hold (pressure) or the exhausted total.
    const group = await Promise.allSettled([1, 2, 3].map(() => reserveGroup(engine, { budgetKey: 'group:g1', estimatedCents: 60, capCents: 100, model: 'm', provider: 'p' })));
    expect(group.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await readGroupSpend(engine, 'group:g1')).liveCents).toBe(60);
  }, 60_000);

  withAddon(BESPOKE.prune.name, async () => {
    const engine = await open();
    for (let n = 0; n < 12; n++) {
      await engine.logMcpRequest({ token_name: 't', agent_name: 'a', operation: 'op', latency_ms: 1, status: 'success', params: { n } } as never);
    }
    const cutoff = new Date(Date.now() + 3_600_000).toISOString();
    // Two workers prune in batches of four inside overlapping transactions: every row is deleted by exactly one batch.
    const deleted: number[] = [];
    const meet = barrier(2);
    const worker = async () => {
      for (;;) {
        const batch = await engine.transaction(async (tx) => {
          const out = await tx.pruneMcpRequestLogBatch(cutoff, [], 4);
          await meet();
          return out.deleted;
        });
        if (batch === 0) return;
        deleted.push(batch);
      }
    };
    await Promise.all([worker(), worker()]);
    expect(deleted.reduce((a, b) => a + b, 0)).toBe(12);
    expect((await engine.pruneMcpRequestLogBatch(cutoff, [], 100)).deleted).toBe(0);
  }, 60_000);

  withAddon(BESPOKE.fileInsert.name, async () => {
    const engine = await open();
    await engine.putPage('notes/with-file', { type: 'note', title: 'W', compiled_truth: 'Body one.', timeline: '' });
    const page = (await engine.readPageSnapshot('notes/with-file', { sourceId: 'default' }))!.page;
    const spec = { page_id: page.id, filename: 'a.png', storage_path: 'files/a.png', content_hash: 'h1', size_bytes: 1 };
    const probe = (tx: BrainEngine) => tx.upsertFile(spec as never);
    const control = await rerunsOnChange(engine, probe, unrelatedChange);
    expect(control.runs).toBe(1);
    // The insert reads the page row for its slug: a page rewritten before the commit reruns it.
    const proof = await rerunsOnChange(engine, (tx) => tx.upsertFile({ ...spec, storage_path: 'files/b.png', filename: 'b.png' } as never),
      (e) => e.putPage('notes/with-file', { type: 'note', title: 'W', compiled_truth: 'Body two.', timeline: '' }));
    expect(proof.runs).toBe(2);
  }, 60_000);

  withAddon('the harness tells a no-op lock from a read: lockGenerationKey alone reads nothing, so the generation write does not rerun it', async () => {
    const engine = await open();
    const alone = await rerunsOnChange(engine, (tx) => tx.lockGenerationKey('gbrain:generation:fence:default:people/alice'), (e) => e.activateGenerationRows(GENERATION_KEY, null,
      { generation: 1, runId: null, operationId: 'op-1', inputPin: null, inputSize: null, completeness: '{}', setHash: 'h', restoreOf: null, activationId: null, locator: null }, []));
    expect(alone.runs).toBe(1);
  }, 60_000);

  // The members that gained a read take it only in multi-user mode: with it off they make exactly the store calls they made before.
  describe('members that read the locked row in multi-user mode', () => {
    /** A store handle that records the method names called on it and answers `{}`. */
    function recorder(mode: { serialized: boolean; multiuser: boolean }): { brain: StoreBrain; calls: string[] } {
      const calls: string[] = [];
      const brain = new Proxy({}, {
        get(_target, name) {
          if (name === 'serializedTransactions') return mode.serialized;
          if (name === 'multiuser') return mode.multiuser;
          if (name === 'then') return undefined;
          return async () => { calls.push(String(name)); return {}; };
        },
      }) as unknown as StoreBrain;
      return { brain, calls };
    }
    const thisEngine = { _seenSettings: new Set<string>() } as never;
    const store = async (factory: any, brain: StoreBrain) => (await factory.call(thisEngine, brain));
    const READ: Array<[member: string, calls: string[], run: (brain: StoreBrain) => Promise<unknown>]> = [
      ['lockAllSourceRows', ['listSourceRecords'], (b) => cliSources.lockAllSourceRows(b, 'update')],
      ['lockSourceForUpdate', ['readSourceWriteRow'], (b) => cliSources.lockSourceForUpdate(b, 's')],
      ['lockSourceShared', ['readSourceWriteRow'], (b) => factsWritePath.lockSourceShared(b, 's')],
      ['lockOAuthClient', ['readOauthClient'], (b) => jobsQueue.lockOAuthClient(b, 'c')],
      ['lockOauthClientName', ['listOauthClients'], (b) => jobsClientGrants.lockOauthClientName(b, 'k')],
      ['lockPageById', ['readPageIndexingState'], (b) => factsConversation.lockPageById(b, 1)],
      ['lockFactRows', ['listUnexpiredFactIds'], (b) => factTextRepair.lockFactRows(b, 's', [1])],
      ['lockApprovedFacts', ['listUnexpiredFactIds'], (b) => repairApplies.lockApprovedFacts(b, 's', [1])],
      ['lockAgentWritebackSetting', ['getConfig'], (b) => factsRest.lockAgentWritebackSetting(b, 'k')],
      ['lockEmbeddingSwitch', ['getConfig'], (b) => embeddingInstall.lockEmbeddingSwitch(b)],
      ['lockEffectGuard', ['writerReleaseRows'], (b) => effectWorker.lockEffectGuard(b, null)],
      ['shareLockWriteCredential', ['readOauthClientWriteGrant'], (b) => persistence.shareLockWriteCredential(b, 'oauth_client', 'c')],
      ['lockMentionSources', ['readMentionGenerations'], (b) => mentionPass.lockMentionSources(b, ['s'], false)],
      ['lockMentionEntries', ['listGazetteerEntryKeys'], (b) => mentionPass.lockMentionEntries(b, 's')],
      ['writerRelease.shareBrain', ['writerReleaseRows'], async (b) => (await store(writerRelease.writerReleaseStore, b)).shareBrain()],
      ['writerRelease.lockWorktreesAndSources', ['writerAdminStateText'], async (b) => (await store(writerRelease.writerReleaseStore, b)).lockWorktreesAndSources()],
      ['writerRelease.shareWorktree', ['readWorktreeOwner'], async (b) => (await store(writerRelease.writerReleaseStore, b)).shareWorktree('w')],
      ['writerAdmin.lockBrain', ['writerReleaseRows'], async (b) => (await store(writerAdmin.writerAdminStore, b)).lockBrain()],
      ['worktreeClaimStore', ['writerReleaseRows'], (b) => store(worktreeClaim.worktreeClaimStore, b)],
      ['publicationJournal.shareWorktree', ['readWorktreeOwner'], async (b) => (await store(publicationJournal.publicationJournalStore, b)).shareWorktree('w')],
      ['publicationJournal.lockSource', ['readSourceMembership'], async (b) => (await store(publicationJournal.publicationJournalStore, b)).lockSource('s')],
      ['declarePersistence', ['getBrainIdentity', 'writerReleaseRows'], (b) => transactionsMembers.declarePersistence.call(thisEngine, b)],
      ['lockSharedSkillBrainId', ['writerReleaseRows', 'getBrainIdentity'], (b) => sharedSkillMembers.lockSharedSkillBrainId(b)],
    ];

    test.each(READ)('%s: multi-user off makes the store calls it made before the read was added', async (_member, calls, run) => {
      const off = recorder({ serialized: true, multiuser: false });
      await run(off.brain);
      // Before the read was added the members made no store call, except the two that read the brain id.
      expect(off.calls).toEqual(calls.filter((call) => call === 'getBrainIdentity'));
    });

    test.each(READ)('%s: multi-user on takes the read', async (_member, calls, run) => {
      const on = recorder({ serialized: false, multiuser: true });
      await run(on.brain);
      expect([...on.calls].sort()).toEqual([...calls].sort());
    });
  });

  withAddon(BESPOKE.mention.name, async () => {
    const engine = await open();
    const bump = { state: 'pending', pending: null, lastPassAt: null, error: null, bumpGeneration: true, fingerprint: null, setFingerprint: false } as const;
    const generation = async (e: BrainEngine) => Number((await e.readMentionGenerations(['default'], false))[0]?.generation ?? 0);
    // Two disables of one source overlap: each locks the source, reads its generation and bumps it. No bump is lost.
    const meet = barrier(2);
    await Promise.all([1, 2].map(() => engine.transaction(async (tx) => {
      await tx.lockMentionSources(['default'], false);
      await tx.readMentionGenerations(['default'], true);
      await meet();
      await tx.writeMentionIndexStatus('default', bump);
    })));
    expect(await generation(engine)).toBe(2);
    // Two gazetteer saves of one source overlap: only one finds the entry list empty and applies its change.
    const entry = { source_id: 'default', name_norm: 'alice', target_slug: 'people/alice', case_sensitive: false };
    const meetSaves = barrier(2);
    const outcomes = await Promise.all([1, 2].map(() => engine.transaction(async (tx) => {
      await tx.lockMentionEntries('default');
      const before = await tx.listGazetteerEntryKeys('default');
      await meetSaves();
      if (before.length > 0) return 'skipped';
      await tx.applyGazetteerEntryChanges('default', [], [entry]);
      return 'applied';
    })));
    expect([...outcomes].sort()).toEqual(['applied', 'skipped']);
  }, 60_000);

  test('every proven TypeScript row of this file names a case that lists its site', () => {
    const own = Object.entries(MULTIUSER_PROVEN).filter(([, row]) => row.test.startsWith(`${FILE}::`));
    const bySite = new Map<string, string[]>();
    for (const c of [...CASES, ...Object.values(BESPOKE)]) for (const site of c.sites) bySite.set(site, [...(bySite.get(site) ?? []), c.name]);
    expect(own.filter(([site, row]) => !bySite.get(site)?.includes(row.test.slice(FILE.length + 2))).map(([site]) => site)).toEqual([]);
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });
});
