/**
 * History fixture mode of the crash robot: builds a managed brain with real
 * persistence history at a requested size (up to 10k pages), for engine
 * graduation and the attribution-backfill check.
 *
 * Frozen signature: `buildHistoryFixture(engine, { pages, seed, sources, worktrees })`.
 *
 * The engine must be connected, `initSchema()`d, not yet activated, and the
 * process must run under an isolated `GBRAIN_HOME` (the persistence host
 * identity and worktree locks live there). The fixture registers its sources
 * in fresh durability-hardened Git checkouts under `root` (a new temporary
 * directory unless given), activates managed persistence, and writes history
 * through the real operation handlers (see `ops.ts`). On return the in-process
 * persistence consumer is stopped, so the queued request and the delayed
 * effect stay exactly as recorded until the caller starts an owner.
 *
 * Reached through real operations: pages, revisions and `page_versions`
 * (put_page, edit_page), timeline, takes with supersession and attribution,
 * remembered facts and their withdrawals (remember, forget), delete/restore,
 * `chronicle_page_state` (the publication-time chronicle decision on
 * meeting pages), local writer registrations, remote writes by an OAuth
 * client and a legacy token (verified through the production token verifier).
 * Seeded through the narrowest real API instead:
 * - sources rows: `INSERT INTO sources` (as the gate's fixtures), then the real
 *   `claimWorktree` and `activatePersistence` (worktrees, host bindings);
 * - the OAuth client and its token: `GBrainOAuthProvider.registerClientManual`
 *   and `exchangeClientCredentials`;
 * - the access token with unified grant columns: `mintLegacyToken`;
 * - the delayed effect: a real Git effect that failed on a stale `index.lock`
 *   (dated past the 10-minute contention grace, `git_index_stale`) and was
 *   rescheduled with `next_attempt_at` in the future, then held a day out so
 *   it stays delayed for the fixture's lifetime (the lock is then removed);
 * - the queued request: `admitWrite`, the journal call every page mutation
 *   makes, with no owner running: the state a crash right after admission leaves.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { activatePersistence } from '../../src/core/persistence/activation.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { requestPrincipalForContext } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { random } from './harness.ts';
import { authenticateRemotes, connectorSourceConfig, contextFor, descriptor, executeOp, type OpDescriptor,
  type OpObservation, type RemoteActor, type World } from './ops.ts';

export interface HistoryFixtureOptions {
  /** Pages written through put_page (1..10,000). */
  pages: number;
  /** Unsigned 32-bit seed; the same seed yields the same logical history. */
  seed: number;
  /** Registered sources (>= worktrees). */
  sources: number;
  /** Git checkouts the sources are spread across (>= 1). */
  worktrees: number;
  /** Scratch directory for the checkouts; a fresh temporary directory by default. */
  root?: string;
}
export interface HistoryFixtureSource { id: string; root: string; worktree: number }
export interface HistoryFixture {
  root: string;
  seed: number;
  sources: HistoryFixtureSource[];
  /** Remote principals with their synthetic bearer tokens (valid only in this scratch brain). */
  remotes: RemoteActor[];
  /** The access token row minted with unified grant columns. */
  accessTokenId: string;
  oauthClientId: string;
  /** Every op the fixture ran, in order, with what its caller observed. */
  observations: OpObservation[];
  queuedRequestId: string;
  delayedEffectId: string;
  /** Row counts of the tables the fixture is required to populate. */
  counts: Record<string, number>;
  /** sha256 over the logical history (slugs, contents, takes, facts, withdrawals): equal for equal seeds. */
  digest: string;
}

export const HISTORY_FIXTURE_TABLES = ['persistence_requests', 'persistence_effects', 'fact_withdrawals', 'persistence_worktrees',
  'persistence_host_bindings', 'persistence_local_writers', 'access_tokens', 'oauth_clients', 'oauth_tokens', 'takes',
  'page_versions', 'chronicle_page_state', 'pages', 'facts', 'timeline_entries'] as const;

function durableGitRepo(root: string): void {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode) throw new Error(`git ${args[0]}: ${result.stderr.toString()}`);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'History Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'README.md'), '# History fixture\n');
  git('add', 'README.md'); git('commit', '-q', '-m', 'Initial');
  // The durability banner makes Git effects run real commits; with no remote the hook does nothing.
  const hook = join(root, '.git', 'hooks', 'post-commit');
  writeFileSync(hook, '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n');
  chmodSync(hook, 0o755);
}

const words = ['alpha', 'harbor', 'ledger', 'quartz', 'meadow', 'signal', 'copper', 'lantern', 'orbit', 'thistle', 'cobalt', 'drift'];
function phrase(rand: () => number, n: number): string {
  return Array.from({ length: n }, () => words[Math.floor(rand() * words.length)]).join(' ');
}
function pageContent(type: string, title: string, body: string, extra = ''): string {
  return `---\ntype: ${type}\ntitle: ${title}\n${extra}---\n\n${body}\n`;
}

/**
 * The logical plan: deterministic descriptors for a seed. Request ids derive
 * from the seed too, so two builds with one seed submit identical requests.
 */
export function historyPlan(opts: HistoryFixtureOptions, sourceIds: string[], remotes: Pick<RemoteActor, 'name' | 'sourceId'>[]): OpDescriptor[] {
  const rand = random(opts.seed);
  const uuid = (n: number) => {
    const h = createHash('sha256').update(`${opts.seed}:${n}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const plan: OpDescriptor[] = [];
  let n = 0;
  const add = (kind: OpDescriptor['kind'], actor: string, source: string, args: OpDescriptor['args'], deps?: string[]) => {
    const id = `op-${n}`; plan.push(descriptor(id, kind, actor, source, args, { requestId: uuid(n), deps })); n++; return id;
  };
  const meetingDate = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  for (let i = 0; i < opts.pages; i++) {
    const source = sourceIds[i % sourceIds.length];
    const remote = remotes.find(r => r.sourceId === source && i % 7 === 3);
    const actor = remote?.name ?? 'local';
    const meeting = i % 25 === 5;
    const slug = meeting ? `meetings/m-${i}` : `notes/p-${i}`;
    const body = meeting
      ? `Weekly sync on ${meetingDate} about ${phrase(rand, 6)}. Decided to ${phrase(rand, 8)} and follow up next week with ${phrase(rand, 4)}.`
      : `Page ${i}: ${phrase(rand, 10)}.\n\nMarker line ${i}.`;
    const put = add('put_page', actor, source, { slug, content: pageContent(meeting ? 'meeting' : 'note', slug, body, meeting ? `date: ${meetingDate}\n` : '') });
    if (i % 5 === 1) add('edit_page', actor, source, { slug, expected_revision: { $ref: put, field: 'revision' },
      edits: [{ old_text: `Marker line ${i}.`, new_text: `Marker line ${i}, revised.` }] }, [put]);
    if (i % 6 === 2) add('add_timeline_entry', actor, source, { slug, date: '2026-09-1' + (i % 10), summary: `Event ${i}: ${phrase(rand, 3)}` }, [put]);
    if (i % 8 === 4) {
      const take = add('takes_add', 'local', source, { slug, claim: `Claim ${i}: ${phrase(rand, 5)}`, kind: 'take', holder: 'world', weight: 0.6 }, [put]);
      if (i % 16 === 4) add('takes_supersede', 'local', source, { slug, row_num: { $ref: take, field: 'row_num' }, claim: `Revised claim ${i}: ${phrase(rand, 5)}` }, [put, take]);
    }
    if (i % 10 === 6) {
      const fact = add('remember', actor, source, { fact: `Fact ${i}: ${phrase(rand, 6)}`, entity: slug }, [put]);
      if (i % 20 === 6) add('forget', actor, source, { fact_id: { $ref: fact, field: 'fact_id' }, reason: 'history fixture withdrawal' }, [fact]);
    }
    if (i % 50 === 9) {
      add('delete_page', 'local', source, { slug, expected_revision: '$current' }, [put]);
      if (i % 100 === 9) add('restore_page', 'local', source, { slug, expected_revision: '$current' }, [put]);
    }
  }
  return plan;
}

function digestOf(plan: OpDescriptor[], observations: OpObservation[]): string {
  const h = createHash('sha256');
  for (const d of plan) h.update(JSON.stringify([d.id, d.kind, d.actor, d.source, d.requestId, d.args]));
  for (const o of observations) h.update(JSON.stringify([o.id, o.status, o.code ?? null]));
  return h.digest('hex');
}

export interface ManagedTopology { world: World; checkouts: string[]; sources: HistoryFixtureSource[]; accessTokenId: string; oauthClientId: string }
/**
 * Register `sources` sources spread across `worktrees` durability-hardened Git
 * checkouts under `root`, activate managed persistence, and authenticate two
 * remote agents through the production token verifier: an OAuth client on the
 * first source and a legacy access token (unified grant columns) on the second.
 */
export async function prepareTopology(engine: BrainEngine, { sources, worktrees, root, prefix = 'history', connector = false }:
  { sources: number; worktrees: number; root: string; prefix?: string; connector?: boolean }): Promise<ManagedTopology> {
  const checkouts = Array.from({ length: worktrees }, (_, k) => { const dir = join(root, `worktree-${k}`); mkdirSync(dir, { recursive: true }); durableGitRepo(dir); return dir; });
  const fixtureSources: HistoryFixtureSource[] = Array.from({ length: sources }, (_, i) => {
    const worktree = i % worktrees; const dir = join(checkouts[worktree], `source-${i}`); mkdirSync(dir, { recursive: true });
    return { id: `${prefix}-${i}`, root: dir, worktree };
  });
  for (const source of fixtureSources) {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source.id, source.root]);
    await claimWorktree(engine, source.id, source.root);
  }
  // A GitHub connector source in its own checkout; its items publish through the coordinator.
  const connectorSource = connector ? { sourceId: `${prefix}-gh`, root: join(root, 'connector') } : undefined;
  if (connectorSource) {
    mkdirSync(connectorSource.root, { recursive: true }); durableGitRepo(connectorSource.root);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)',
      [connectorSource.sourceId, connectorSource.root, JSON.stringify(connectorSourceConfig())]);
    await claimWorktree(engine, connectorSource.sourceId, connectorSource.root);
  }
  assert.equal((await activatePersistence(engine, { confirmQuiesced: true })).enabled, true);
  const sql = sqlQueryForEngine(engine);
  const provider = new GBrainOAuthProvider({ sql, transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const client = await provider.registerClientManual(`${prefix} fixture agent`, ['client_credentials'], 'read write', [], fixtureSources[0].id);
  const oauth = await provider.exchangeClientCredentials(client.clientId, client.clientSecret!, 'read write');
  const tokenSource = fixtureSources[Math.min(1, sources - 1)].id;
  const minted = await mintLegacyToken(engine, { name: `${prefix}-fixture-token`, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [tokenSource] });
  const remotes: RemoteActor[] = [{ name: 'agent-oauth', kind: 'oauth_client', sourceId: fixtureSources[0].id, token: oauth.access_token },
    { name: 'agent-token', kind: 'legacy_token', sourceId: tokenSource, token: minted.token }];
  const world: World = { engine, config: { engine: engine.kind, embedding_disabled: true } as GBrainConfig, remotes, auth: new Map(), observations: new Map(),
    roots: Object.fromEntries(fixtureSources.map(s => [s.id, s.root])), ...(connectorSource ? { connector: connectorSource } : {}) };
  await authenticateRemotes(world);
  return { world, checkouts, sources: fixtureSources, accessTokenId: minted.id, oauthClientId: client.clientId };
}

/** Build a brain with real persistence history. See the module comment for preconditions. */
export async function buildHistoryFixture(engine: BrainEngine,
  { pages, seed, sources, worktrees, root: requestedRoot }: HistoryFixtureOptions): Promise<HistoryFixture> {
  assert(Number.isSafeInteger(pages) && pages >= 1 && pages <= 10_000, 'history fixture: pages must be 1..10000');
  assert(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xFFFFFFFF, 'history fixture: seed must be an unsigned 32-bit integer');
  assert(Number.isSafeInteger(worktrees) && worktrees >= 1, 'history fixture: worktrees must be >= 1');
  assert(Number.isSafeInteger(sources) && sources >= worktrees, 'history fixture: sources must be >= worktrees');
  assert(process.env.GBRAIN_HOME, 'history fixture: run under an isolated GBRAIN_HOME');
  const root = requestedRoot ?? mkdtempSync(join(tmpdir(), 'gbrain-history-fixture-'));
  const topology = await prepareTopology(engine, { sources, worktrees, root });
  const { world, checkouts, sources: fixtureSources, accessTokenId, oauthClientId } = topology;
  const remotes = world.remotes;

  const plan = historyPlan({ pages, seed, sources, worktrees }, fixtureSources.map(s => s.id), remotes);
  // Sources publish independently; ops within one source run in plan order.
  const lanes = new Map<string, OpDescriptor[]>();
  for (const d of plan) lanes.set(d.source, [...(lanes.get(d.source) ?? []), d]);
  await Promise.all([...lanes.values()].map(async lane => { for (const d of lane) await executeOp(world, d); }));
  const observations = plan.map(d => world.observations.get(d.id)!);
  const failed = observations.filter(o => o.status !== 'committed');
  assert.deepEqual(failed.map(o => `${o.id} ${o.kind} ${o.code}`), [], 'every history op must commit');

  // A Git effect that fails on a stale index.lock reschedules into the future. A lock younger than
  // 10 minutes is contention (`git_index_locked`, retried after 250 ms), so the lock is dated
  // 11 minutes back: the effect fails as `git_index_stale` and requeues 30 s out.
  const delayedSource = fixtureSources[0];
  const lock = join(checkouts[delayedSource.worktree], '.git', 'index.lock');
  writeFileSync(lock, '');
  const staleAt = new Date(Date.now() - 11 * 60_000);
  utimesSync(lock, staleAt, staleAt);
  let delayedEffectId: string;
  try {
    const delayed = descriptor('delayed-effect', 'put_page', 'local', delayedSource.id,
      { slug: 'notes/delayed-effect', content: pageContent('note', 'Delayed effect', 'Its Git effect waits on a stale index.lock.') });
    assert.equal((await executeOp(world, delayed)).status, 'committed');
    observations.push(world.observations.get('delayed-effect')!);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const [effect] = await engine.executeRaw<{ id: string }>(`SELECT e.id::text AS id FROM persistence_effects e
        JOIN persistence_requests r ON r.id=e.request_id WHERE r.request_id=$1::uuid AND e.kind='git'
          AND e.state='queued' AND e.attempts>0 AND e.error_code='git_index_stale' AND e.next_attempt_at>now()`, [delayed.requestId]);
      if (effect) { delayedEffectId = effect.id; break; }
      assert(Date.now() < deadline, 'history fixture: the Git effect never rescheduled after the stale index.lock');
      await Bun.sleep(100);
    }
    // The production requeue is a fixed 30 s with no setting to lengthen it, and callers keep the
    // fixture longer than that (a graduation copies it), so the recorded failure is kept and only
    // its retry moves a day out: the effect stays delayed for the fixture's lifetime.
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 day' WHERE id=$1", [delayedEffectId]);
    });
  } finally {
    await disposePersistenceConsumer(engine);
    if (existsSync(lock)) rmSync(lock);
  }

  // A request accepted with no owner running, exactly as admission records it.
  const queuedSlug = 'notes/queued-request';
  const ctx = contextFor(world, 'local', delayedSource.id);
  const principal = await requestPrincipalForContext(ctx);
  const [sourceRow] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [delayedSource.id]);
  const binding = (await getWorktreeBinding(engine, delayedSource.id))!;
  const callerIntent = { source_id: delayedSource.id, slug: queuedSlug, content: pageContent('note', 'Queued request', 'Accepted while no owner ran.') };
  const queuedRequestId = historyPlan({ pages: 1, seed: seed ^ 0x5eed, sources, worktrees }, [delayedSource.id], [])[0].requestId;
  const queued = await admitWrite(engine, { principal, operation: 'put_page', sourceId: delayedSource.id, sourceIncarnation: sourceRow.incarnation,
    slug: queuedSlug, pageId: null, requestId: queuedRequestId, callerIntent, intent: { ...callerIntent },
    authority: await submissionAuthority(ctx, 'put_page', delayedSource.id, sourceRow.incarnation, queuedSlug),
    worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
  assert.equal(queued.state, 'queued');

  const counts: Record<string, number> = {};
  for (const table of HISTORY_FIXTURE_TABLES) {
    counts[table] = Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0].n);
  }
  return { root, seed, sources: fixtureSources, remotes, accessTokenId, oauthClientId,
    observations, queuedRequestId, delayedEffectId: delayedEffectId!, counts, digest: digestOf(plan, observations) };
}

