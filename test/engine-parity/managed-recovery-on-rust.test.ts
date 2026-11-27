/**
 * Engine parity: managed clone, topology recovery, owner recovery scans and the parked-push retry on a Rust brain, with
 * the user-facing hold kept (lane LM, slice 2, recovery part).
 *
 * Every case lifts the `managed_persistence` hold on its own Rust test engine (rust-managed.ts `liftManagedHold`), so
 * the ordinary Rust arm runs the managed path for real; `servedCapabilities()` still withholds the capability, so a
 * user's Rust brain keeps refusing. Each case returns its answers and the arms must agree.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a managed clone (`sources add --url`, `sources reclone`, topology-clone.ts `runManagedSourceClone`) clones
 *    into a staging directory, verifies it, swaps it into place and registers the source under topology locks; a reclone
 *    of a diverged remote rolls back and keeps the original checkout; an interrupted clone (a recorded recovering
 *    change) is finished or rolled back by the owner's topology recovery (`recoverSourceTopologies`); a write claim whose
 *    owner died is listed as lapsed with its owner and the consumer then recovers and publishes the write; a Git effect
 *    that parked on its push is retried once the credential is re-wired (`writer git-durability --pat-file`).
 *  - Regression: on the Rust engine the clone, the recovery scan, the restamp and the parked-push retry read and locked
 *    through raw SQL, so each refused `engine_capability_missing` by name; the claim-owner list answered only requests
 *    on no worktree, so a dead owner's worktree claim had no owner to judge.
 *  - Why existing coverage misses it: topology-named-stop.test.ts pinned the refusal; the managed parity files never
 *    reached a clone, a recovering change or a parked push on the Rust arm.
 *  - Seam: the clone's provider hook (`CloneLifecycleHooks.clone`) runs a real `git clone` of a local bare repository
 *    (the clone URL check allows https only, so the URL is a placeholder); the recovery cases stall a change by moving
 *    its worktree out of `recovering` in a boundary hook and restore it before the scan. Real engines and checkouts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { liftManagedHold } from './rust-managed.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { hostIdFor, localHostId, readLocalWriter } from '../../src/core/persistence/identity.ts';
import { runManagedSourceClone, type CloneLifecycleHooks } from '../../src/core/persistence/topology-clone.ts';
import { recoverSourceTopologies } from '../../src/core/persistence/topology-recovery.ts';
import { topologyPrincipal } from '../../src/core/persistence/topology-locks.ts';
import { claimNextWrite } from '../../src/core/persistence/journal.ts';
import { readTopologyRecoveryStops } from '../../src/core/persistence/topology-stop.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { serveGitOverHttps } from '../helpers/git-smart-http.ts';
import { claimPersistenceEffect, parkEffect } from '../../src/core/persistence/effect-journal.ts';
import type { SourceLifecycleInput } from '../../src/core/persistence/source-lifecycle.ts';

const { parityTest } = parityArms(testBackends());

const GIT_ID = ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid'];
const REMOTE_URL = 'https://example.invalid/brain.git';

/** A Git checkout at `root` with one committed note. */
function gitCheckout(root: string, note: string, body: string): void {
  mkdirSync(join(root, 'notes'), { recursive: true });
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'notes', note), body);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, ...GIT_ID, 'commit', '-qm', 'notes']);
}

/** A bare remote holding one note, built from a scratch checkout; returns the bare repository's path. */
function bareRemote(home: string, name: string, note: string, title: string): string {
  const seed = join(home, `${name}-seed`);
  gitCheckout(seed, note, `---\ntitle: ${title}\n---\nWorks at acme-example.\n`);
  const bare = join(home, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['-C', seed, 'push', '-q', bare, 'main']);
  return bare;
}

/** The clone provider hook: a real `git clone` of a local bare repository into the staging directory. */
function cloneFrom(bare: string): NonNullable<CloneLifecycleHooks['clone']> {
  return async (_url, stage) => { execFileSync('git', ['clone', '-q', bare, stage], { env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } }); };
}

/** Lifts the hold on the Rust arm's engine, then runs `run` under a scratch GBRAIN_HOME with the managed brain active. */
async function withManagedBrain<T>(engine: BrainEngine, backend: ParityBackend, opts: { claim?: boolean; durable?: boolean },
  run: (home: string, root: string) => Promise<T>): Promise<T> {
  if (backend === 'rust') liftManagedHold(engine);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-managed-recovery-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => {
      const root = join(home, 'checkout');
      gitCheckout(root, 'alice-example.md', '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
      await createSource(engine, backend, 'work', {}, root);
      const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed('writer_claim') });
      await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') });
      if (opts.durable) {
        const remote = join(home, 'remote.git');
        execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
        execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
        execFileSync('git', ['-C', root, 'push', '-q', '-u', 'origin', 'main']);
        await runPersistenceAdministration(engine, 'writer_git_durability', { source_id: 'work', enable: true, ...await reviewed('writer_git_durability') });
      }
      try { return await run(home, root); } finally { installFaultHook(undefined); await disposePersistenceConsumer(engine); }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const ctxFor = (engine: BrainEngine, sourceId = 'work') => ({ engine, sourceId, remote: false as const,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

/** One managed clone or reclone, as `sources add --url` and `sources reclone` run it after their checks; the receipt or the refusal's code. */
async function clone(engine: BrainEngine, input: Omit<SourceLifecycleInput, 'requestId'>, hooks: CloneLifecycleHooks): Promise<Record<string, unknown>> {
  const request = { ...input, requestId: randomUUID() } as SourceLifecycleInput;
  try {
    return await runManagedSourceClone(engine, request, await topologyPrincipal(engine), request.requestId!, { ...request, requestId: undefined, dryRun: undefined }, hooks);
  } catch (error) {
    if ((error as { code?: string }).code === 'engine_capability_missing') throw error;
    return { refused: (error as { code?: string }).code ?? String(error) };
  }
}

/** A receipt with its fresh ids blanked and the scratch home written `<home>`, so the arms compare. */
const receipt = (out: Record<string, unknown>, home: string) => {
  const { request_id: _r, source_incarnation: _i, ...rest } = out;
  return JSON.parse(JSON.stringify({ ...rest, ...(typeof out.request_id === 'string' ? { request_id: 'set' } : {}) }).split(home).join('<home>'));
};

/** Directories a clone leaves beside its target while it works (staging and the retained original). */
const leftovers = (home: string) => readdirSync(home).filter(name => name.startsWith('.gbrain-clone-') || name.includes('.gbrain-old-'));

const sourceOf = async (engine: BrainEngine, id: string) => {
  const row = await engine.readSourceMembership(id);
  return row && { registered: true, archived: row.archived };
};

/** The worktree id of `sourceId`'s binding on this host. */
const worktreeOf = async (engine: BrainEngine, sourceId: string) => (await engine.getWorktreeBinding(sourceId, hostIdFor(engine)))!.worktree_id;

/** Sets a worktree's state through the topology store (a transaction, as every topology change runs). */
async function setWorktreeState(engine: BrainEngine, worktreeId: string, state: 'active' | 'recovering'): Promise<void> {
  await engine.transaction(async tx => {
    const store = await tx.topologyStore();
    if (state === 'active') await store.markWorktreeActive(worktreeId); else await store.markWorktreeRecovering(worktreeId);
  });
}

describe('managed clone and recovery on a Rust brain, hold kept for users', () => {
  parityTest('sources add --url clones the remote into a managed checkout and registers the source', {
    methods: ['worktreeClaimStore', 'topologyStore', 'readSourceMembership', 'getWorktreeBinding'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedBrain(engine, backend, {}, async home => {
    const bare = bareRemote(home, 'one', 'dana-example.md', 'Dana Example');
    const target = join(home, 'cloned');
    const out = await clone(engine, { operation: 'add', sourceId: 'cloned', remoteUrl: REMOTE_URL, path: target }, { clone: cloneFrom(bare) });
    const binding = await engine.getWorktreeBinding('cloned', hostIdFor(engine));
    const answer = { receipt: receipt(out, home), source: await sourceOf(engine, 'cloned'),
      note: existsSync(join(target, 'notes', 'dana-example.md')), bound: binding && { local: binding.local_path === target, state: binding.state, relative: binding.relative_path },
      leftovers: leftovers(home), recovering: (await engine.listTopologyRecoveries(localHostId(), null, 16)).length };
    expect(answer).toEqual({ receipt: expect.objectContaining({ state: 'committed', cloned: true, operation: 'add', local_path: '<home>/cloned' }),
      source: { registered: true, archived: false }, note: true, bound: { local: true, state: 'active', relative: '' }, leftovers: [], recovering: 0 });
    return answer;
  }));

  parityTest('sources add --url clones over a real https transport (Git smart HTTP on 127.0.0.1, no file transport) and registers the source', {
    methods: ['worktreeClaimStore', 'topologyStore', 'readSourceMembership', 'getWorktreeBinding'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedBrain(engine, backend, {}, async home => {
    const bare = bareRemote(home, 'net', 'nora-example.md', 'Nora Example');
    const server = await serveGitOverHttps(home);
    try {
      const remote = `${server.url}/${bare.split('/').pop()}`;
      const target = join(home, 'cloned-over-https');
      // The real clone: no provider hook, and none of the file-transport escape hatch the other cases use.
      const answer = await withEnv({ GBRAIN_GIT_ALLOW_FILE_TRANSPORT: undefined, GBRAIN_ALLOW_PRIVATE_REMOTES: '1', GIT_SSL_CAINFO: server.caFile }, async () => {
        const plain = await clone(engine, { operation: 'add', sourceId: 'plain-http', remoteUrl: remote.replace('https:', 'http:'), path: join(home, 'refused-plain-http') }, {});
        const loopback = await withEnv({ GBRAIN_ALLOW_PRIVATE_REMOTES: undefined }, () =>
          clone(engine, { operation: 'add', sourceId: 'loopback', remoteUrl: remote, path: join(home, 'refused-loopback') }, {}));
        const out = await clone(engine, { operation: 'add', sourceId: 'cloned-over-https', remoteUrl: remote, path: target }, {});
        const binding = await engine.getWorktreeBinding('cloned-over-https', hostIdFor(engine));
        return { fileTransport: process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT ?? null, plain, loopback, receipt: receipt(out, home), source: await sourceOf(engine, 'cloned-over-https'),
          refusedSources: [await sourceOf(engine, 'plain-http'), await sourceOf(engine, 'loopback')],
          note: existsSync(join(target, 'notes', 'nora-example.md')), bound: binding && { local: binding.local_path === target, state: binding.state },
          served: { info: server.requests.some(r => r.includes('/info/refs?service=git-upload-pack')), pack: server.requests.some(r => r.startsWith('POST') && r.includes('/git-upload-pack')) },
          leftovers: leftovers(home), recovering: (await engine.listTopologyRecoveries(localHostId(), null, 16)).length };
      });
      expect(answer).toEqual({ fileTransport: null, plain: { refused: 'unsupported_scheme' }, loopback: { refused: 'internal_target' },
        receipt: expect.objectContaining({ state: 'committed', cloned: true, operation: 'add', local_path: '<home>/cloned-over-https' }),
        source: { registered: true, archived: false }, refusedSources: [null, null], note: true, bound: { local: true, state: 'active' },
        served: { info: true, pack: true }, leftovers: [], recovering: 0 });
      return answer;
    } finally {
      await server.stop();
    }
  }));

  parityTest('sources reclone replaces the checkout with a fresh clone of the same remote', {
    methods: ['worktreeClaimStore', 'topologyStore', 'getWorktreeBinding'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedBrain(engine, backend, {}, async home => {
    const bare = bareRemote(home, 'two', 'erin-example.md', 'Erin Example');
    const target = join(home, 'recloned');
    const first = await clone(engine, { operation: 'add', sourceId: 'recloned', remoteUrl: REMOTE_URL, path: target }, { clone: cloneFrom(bare) });
    const before = statSync(target, { bigint: true }).ino;
    const out = await clone(engine, { operation: 'reclone', sourceId: 'recloned' }, { clone: cloneFrom(bare) });
    const after = statSync(target, { bigint: true }).ino;
    const binding = await engine.getWorktreeBinding('recloned', hostIdFor(engine));
    const answer = { first: first.state, receipt: receipt(out, home), replaced: before !== after, note: readFileSync(join(target, 'notes', 'erin-example.md'), 'utf8').includes('Erin Example'),
      bound: binding && { local: binding.local_path === target, state: binding.state }, leftovers: leftovers(home) };
    expect(answer).toEqual({ first: 'committed', receipt: expect.objectContaining({ state: 'committed', cloned: true, operation: 'reclone' }), replaced: true, note: true,
      bound: { local: true, state: 'active' }, leftovers: [] });
    return answer;
  }));

  parityTest('a reclone whose remote differs from the canonical checkout rolls back and keeps the original', {
    methods: ['worktreeClaimStore', 'topologyStore', 'getWorktreeBinding'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedBrain(engine, backend, {}, async home => {
    const bare = bareRemote(home, 'three', 'fay-example.md', 'Fay Example');
    const other = bareRemote(home, 'four', 'gus-example.md', 'Gus Example');
    const target = join(home, 'diverged');
    await clone(engine, { operation: 'add', sourceId: 'diverged', remoteUrl: REMOTE_URL, path: target }, { clone: cloneFrom(bare) });
    const out = await clone(engine, { operation: 'reclone', sourceId: 'diverged' }, { clone: cloneFrom(other) });
    const binding = await engine.getWorktreeBinding('diverged', hostIdFor(engine));
    const answer = { receipt: receipt(out, home), original: existsSync(join(target, 'notes', 'fay-example.md')), foreign: existsSync(join(target, 'notes', 'gus-example.md')),
      bound: binding && { state: binding.state }, leftovers: leftovers(home), recovering: (await engine.listTopologyRecoveries(localHostId(), null, 16)).length };
    expect(answer).toEqual({ receipt: expect.objectContaining({ state: 'failed', write_error: 'writer_manifest_mismatch' }), original: true, foreign: false,
      bound: { state: 'active' }, leftovers: [], recovering: 0 });
    return answer;
  }));

  parityTest('an interrupted clone that stopped after its stage was verified is rolled forward by the owner recovery scan', {
    methods: ['worktreeClaimStore', 'topologyStore', 'listTopologyRecoveries', 'getWorktreeBinding'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedBrain(engine, backend, {}, async home => {
    const bare = bareRemote(home, 'five', 'hal-example.md', 'Hal Example');
    const target = join(home, 'rolled-forward');
    const host = hostIdFor(engine);
    // The worktree leaves `recovering` after the clone was prepared, so neither the clone's own finish nor its rollback can
    // run (each refuses on the changed ownership): the change stays recorded as recovering, as after a crash.
    const stalled = await clone(engine, { operation: 'add', sourceId: 'rolled-forward', remoteUrl: REMOTE_URL, path: target }, { clone: cloneFrom(bare),
      boundary: async name => { if (name === 'prepared') await setWorktreeState(engine, await worktreeOf(engine, 'rolled-forward'), 'active'); } });
    const parked = await engine.listTopologyRecoveries(host, null, 16);
    const status = await readTopologyRecoveryStops(engine, host);
    const during = { refused: stalled.refused, change: parked.map(row => ({ source: row.source_id, operation: row.operation, state: row.state })),
      listed: status.recovering.map(row => ({ source: row.source_id, stop: row.stop })), stop: status.stop, source: await sourceOf(engine, 'rolled-forward'), target: existsSync(target) };
    // The worktree is back in recovery: the scan finishes the clone.
    await setWorktreeState(engine, await worktreeOf(engine, 'rolled-forward'), 'recovering');
    const recovered = await recoverSourceTopologies(engine, { hostId: host });
    const after = await engine.listTopologyRecoveries(host, null, 16);
    const binding = await engine.getWorktreeBinding('rolled-forward', host);
    const answer = { during, recovered, left: after.length, source: await sourceOf(engine, 'rolled-forward'), note: existsSync(join(target, 'notes', 'hal-example.md')),
      bound: binding && { local: binding.local_path === target, state: binding.state }, leftovers: leftovers(home) };
    expect(answer).toEqual({ during: { refused: 'recovery_required', change: [{ source: 'rolled-forward', operation: 'add', state: 'recovering' }],
      listed: [{ source: 'rolled-forward', stop: null }], stop: null, source: null, target: false },
    recovered: 1, left: 0, source: { registered: true, archived: false }, note: true, bound: { local: true, state: 'active' }, leftovers: [] });
    return answer;
  }));

  parityTest('an interrupted clone that never finished staging is rolled back by the owner recovery scan, registering nothing', {
    methods: ['worktreeClaimStore', 'topologyStore', 'listTopologyRecoveries', 'getWorktreeBinding'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedBrain(engine, backend, {}, async home => {
    const bare = bareRemote(home, 'six', 'ida-example.md', 'Ida Example');
    const target = join(home, 'rolled-back');
    const host = hostIdFor(engine);
    const stalled = await clone(engine, { operation: 'add', sourceId: 'rolled-back', remoteUrl: REMOTE_URL, path: target }, { clone: cloneFrom(bare),
      boundary: async name => { if (name === 'reserved') await setWorktreeState(engine, await worktreeOf(engine, 'rolled-back'), 'active'); } });
    const parked = await engine.listTopologyRecoveries(host, null, 16);
    const during = { refused: stalled.refused, change: parked.map(row => ({ source: row.source_id, operation: row.operation, state: row.state })), source: await sourceOf(engine, 'rolled-back') };
    await setWorktreeState(engine, await worktreeOf(engine, 'rolled-back'), 'recovering');
    const recovered = await recoverSourceTopologies(engine, { hostId: host });
    const after = await engine.listTopologyRecoveries(host, null, 16);
    const answer = { during, recovered, left: after.length, source: await sourceOf(engine, 'rolled-back'), bound: (await engine.getWorktreeBinding('rolled-back', host)) !== null,
      target: existsSync(target), leftovers: leftovers(home) };
    expect(answer).toEqual({ during: { refused: 'recovery_required', change: [{ source: 'rolled-back', operation: 'add', state: 'recovering' }], source: null },
      recovered: 1, left: 0, source: null, bound: false, target: false, leftovers: [] });
    return answer;
  }));

  parityTest('a write claim whose owner died is listed as lapsed with its owner, and the consumer then recovers and publishes the write', {
    methods: ['worktreeClaimStore', 'listRunningClaimOwners', 'getPage'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedBrain(engine, backend, {}, async (_home, root) => {
    const host = hostIdFor(engine);
    const request_id = randomUUID();
    // No owner pass may claim or expire anything while the dead owner's claim is staged: the consumer's tick waits at its claim.
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    installFaultHook(async point => { if (point === 'consumer:claiming') await held; });
    const submitted = await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page', waitMs: 0,
      params: { slug: 'notes/jon-example', content: '---\ntype: note\ntitle: Jon Example\n---\nWorks at widget-co.\n', request_id } }).catch((e: { code?: string }) => ({ refused: e.code }));
    const writer = (await readLocalWriter(engine, 'cli')).id;
    const stored = () => engine.readWriteRequest('local_cli', writer, request_id);
    const queued = (await stored())?.state ?? null;
    // The owner claims the write and dies: nothing releases the claim, which lapses after its short lease.
    const claimed = await claimNextWrite(engine, host, 300);
    const owners = async () => (await engine.listRunningClaimOwners(host)).map(row => ({ source: row.source_id, hasOwner: row.owner !== null && typeof row.owner === 'object', lapsed: row.lapsed }));
    const live = await owners();
    await Bun.sleep(450);
    const lapsed = await owners();
    release();
    installFaultHook(undefined);
    let final = await stored();
    for (let i = 0; i < 100 && final?.state !== 'committed'; i++) { await Bun.sleep(100); final = await stored(); }
    const answer = { submitted: 'refused' in (submitted as object) ? (submitted as { refused?: string }).refused : 'pending', queued, claimed: claimed?.state ?? null, live, lapsed,
      final: final && { state: final.state, claim: final.execution_token === null }, page: (await engine.getPage('notes/jon-example', { sourceId: 'work' }))?.title ?? null,
      file: existsSync(join(root, 'notes', 'jon-example.md')) };
    expect(answer).toEqual({ submitted: expect.anything(), queued: 'queued', claimed: 'running', live: [{ source: 'work', hasOwner: true, lapsed: false }],
      lapsed: [{ source: 'work', hasOwner: true, lapsed: true }], final: expect.objectContaining({ state: 'committed' }), page: 'Jon Example', file: true });
    return answer;
  }));

  parityTest('a Git effect parked on its push is retried once --pat-file re-wires the credential', {
    methods: ['worktreeClaimStore', 'readRequestEffects', 'gitDurabilityStore'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedBrain(engine, backend, { durable: true }, async (home, root) => {
    const remote = join(home, 'remote.git');
    const host = hostIdFor(engine);
    const request_id = randomUUID();
    // The owner pass that published the write waits at its next claim, so the test claims the Git effect first and parks it on
    // its push, as the effect runner does once the push has failed five times (a real failing push waits 30 s between attempts).
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let committed = false;
    installFaultHook(async point => {
      if (point === 'publication:after_commit') committed = true;
      else if (point === 'consumer:claiming' && committed) await held;
    });
    await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page',
      params: { slug: 'notes/kate-example', content: '---\ntype: note\ntitle: Kate Example\n---\nWorks at widget-co.\n', request_id } });
    let claimed: Awaited<ReturnType<typeof claimPersistenceEffect>> = null;
    for (let i = 0; i < 100 && !claimed; i++) { claimed = await claimPersistenceEffect(engine, host); if (!claimed) await Bun.sleep(50); }
    release();
    installFaultHook(undefined);
    const effect = claimed!;
    await parkEffect(engine, effect, { ...effect.data, parked: [{ slug: 'notes/kate-example', error_code: 'git_push_unavailable' }] });
    const writer = (await readLocalWriter(engine, 'cli')).id;
    const gitEffect = async () => {
      const row = await engine.readWriteRequest('local_cli', writer, request_id);
      const stored = row ? (await engine.readRequestEffects(row.id, 'git'))[0] : undefined;
      return stored ? { state: stored.state, code: stored.error_code } : null;
    };
    const parked = await gitEffect();
    const token = join(home, 'token');
    writeFileSync(token, 'ghp_exampleexampleexample\n', { mode: 0o600 });
    const reviewed = { admin_intent: 'writer_git_durability', expected_state: await writerAdminState(engine) };
    const report = await runPersistenceAdministration(engine, 'writer_git_durability', { source_id: 'work', pat_file: token, ...reviewed }) as Record<string, any>;
    let retried = await gitEffect();
    for (let i = 0; i < 150 && retried?.state !== 'committed'; i++) {
      await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: host, limit: 20 });
      await Bun.sleep(100);
      retried = await gitEffect();
    }
    const pushed = execFileSync('git', ['-C', remote, 'ls-tree', '-r', '--name-only', 'main', 'notes'], { encoding: 'utf8' }).trim().split('\n').sort();
    const answer = { parked, retry: { status: report.parked_pushes?.status, requests: report.parked_pushes?.requests, queued: report.parked_pushes?.queued,
      unchanged: report.parked_pushes?.unchanged, refused: report.parked_pushes?.refused?.length }, retried: retried && { state: retried.state }, pushed,
    checkout: existsSync(join(root, 'notes', 'kate-example.md')) };
    expect(answer).toEqual({ parked: { state: 'failed', code: 'targets_parked' }, retry: { status: 'ok', requests: 1, queued: 1, unchanged: 0, refused: 0 },
      retried: { state: 'committed' }, pushed: ['notes/alice-example.md', 'notes/kate-example.md'], checkout: true });
    return answer;
  }));
});
