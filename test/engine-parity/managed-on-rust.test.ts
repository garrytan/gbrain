/**
 * Engine parity: managed mode on a Rust brain, with the user-facing hold kept (lane LM, slice 1).
 *
 * Every case lifts the `managed_persistence` hold on its own Rust test engine (rust-managed.ts `liftManagedHold`), so the
 * ordinary Rust arm runs the managed path for real; `servedCapabilities()` still withholds the capability, so a user's
 * Rust brain keeps refusing. Each case returns its answers and the arms must agree.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a claimed checkout, a put_page to the bound source commits the page and writes its file; a refusal at
 *    publication ends the request failed with no page and no file; source lifecycle changes of a managed brain (add,
 *    archive, restore, set-path, remove) commit under topology locks with the same receipts and rows; a moved checkout
 *    is found with its members; add_link and remove_link on a managed page rewrite its links fence.
 *  - Regression: an engine that refuses a step of managed mode (worktree admission, ownership, compareFileTarget,
 *    publication recovery, topology locks, the moved-checkout read, the managed link rewrite), or answers it
 *    differently from PGLite.
 *  - Why existing coverage misses it: the managed parity files declare `requires: 'managed_persistence'`, so on the
 *    ordinary Rust arm they count the hold's refusal as stopped and never run the managed members.
 *  - Seam: the publication fault hook (persistence/fault-points.ts); real engines, real Git checkouts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { liftManagedHold } from './rust-managed.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { servedCapabilities } from '../../src/core/rust-engine/store-capabilities.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { installFaultHook, type FaultPoint } from '../../src/core/persistence/fault-points.ts';
import { hostIdFor, localHostId, readLocalWriter } from '../../src/core/persistence/identity.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { runManagedSourceLifecycle } from '../../src/core/persistence/source-lifecycle.ts';
import { movedPhysicalRoot } from '../../src/core/persistence/physical-root.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';

const { parityTest } = parityArms(testBackends());

const GIT_ID = ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid'];

/** A Git checkout at `root` with one committed note. */
function gitCheckout(root: string, note: string, body: string): void {
  mkdirSync(join(root, 'notes'), { recursive: true });
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'notes', note), body);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, ...GIT_ID, 'commit', '-qm', 'notes']);
}

/**
 * Lifts the hold on the Rust arm's engine, then runs `run` under a scratch GBRAIN_HOME with source `work` registered on a
 * one-note Git checkout and claimed (`gbrain sources writer claim`); `activate` also turns managed mode on.
 */
async function withManagedCheckout<T>(engine: BrainEngine, backend: ParityBackend, opts: { activate?: boolean; durable?: boolean },
  run: (home: string, root: string) => Promise<T>): Promise<T> {
  if (backend === 'rust') liftManagedHold(engine);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-managed-on-rust-')));
  try {
    // GBRAIN_GIT_ALLOW_FILE_TRANSPORT: the durable cases push to a local bare remote.
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => {
      const root = join(home, 'checkout');
      gitCheckout(root, 'alice-example.md', '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
      await createSource(engine, backend, 'work', {}, root);
      const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed('writer_claim') });
      if (opts.activate) await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') });
      if (opts.durable) {
        // A local bare remote the push probe and the Git effect's push reach without the network.
        const remote = join(home, 'remote.git');
        execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
        execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
        execFileSync('git', ['-C', root, 'push', '-q', '-u', 'origin', 'main']);
        await runPersistenceAdministration(engine, 'writer_git_durability', { source_id: 'work', enable: true, ...await reviewed('writer_git_durability') });
      }
      try { return await run(home, root); } finally { await disposePersistenceConsumer(engine); }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const ctxFor = (engine: BrainEngine, sourceId = 'work') => ({ engine, sourceId, remote: false as const,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

/** A lifecycle receipt with its fresh ids blanked and its scratch home written `<home>`, so the arms compare. */
const receipt = (out: unknown, home: string) => {
  const r = out as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return r;
  const { request_id: _r, source_incarnation: _i, ...rest } = r;
  return JSON.parse(JSON.stringify({ ...rest, ...(typeof r.request_id === 'string' ? { request_id: 'set' } : {}) }).split(home).join('<home>'));
};
const codeOf = (run: () => Promise<unknown>) => run().then(() => null, (e: { code?: string }) => e?.code ?? String(e));

describe('managed mode on a Rust brain, hold kept for users', () => {
  parityTest('the hold is still reported off for every user Rust engine', {
    methods: ['getConfig'],
  }, async (engine) => {
    await engine.getConfig('managed_on_rust_probe');
    const out = { held: !servedCapabilities().has('managed_persistence') };
    expect(out).toEqual({ held: true });
    return out;
  });

  parityTest('claim the checkout, put_page to the bound source: the page and its file are written', {
    methods: ['worktreeClaimStore', 'getPage'],
    timeout: 120_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, {}, async (_home, root) => {
    await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page',
      params: { slug: 'notes/bob-example', content: '---\ntype: note\ntitle: Bob Example\n---\nWorks at widget-co.\n', request_id: randomUUID() } });
    const page = await engine.getPage('notes/bob-example', { sourceId: 'work' });
    const file = join(root, 'notes', 'bob-example.md');
    const out = { title: page?.title ?? null, file: existsSync(file) ? readFileSync(file, 'utf8').includes('Works at widget-co.') : false };
    expect(out).toEqual({ title: 'Bob Example', file: true });
    return out;
  }));

  parityTest('the Git effects of two bound writes commit and push the checkout', {
    methods: ['worktreeClaimStore', 'readRequestEffects', 'claimCoalescedGitEffects'],
    timeout: 120_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, { durable: true }, async (home, root) => {
    const ids = [randomUUID(), randomUUID()];
    await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page',
      params: { slug: 'notes/gina-example', content: '---\ntype: note\ntitle: Gina Example\n---\nWorks at widget-co.\n', request_id: ids[0] } });
    await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page',
      params: { slug: 'notes/hank-example', content: '---\ntype: note\ntitle: Hank Example\n---\nWorks at widget-co.\n', request_id: ids[1] } });
    const writer = (await readLocalWriter(engine, 'cli')).id;
    const gitStates = async () => Promise.all(ids.map(async id => {
      const row = await engine.readWriteRequest('local_cli', writer, id);
      return row ? (await engine.readRequestEffects(row.id, 'git'))[0]?.state ?? 'none' : 'no request';
    }));
    // The consumer may already have run them, and an effect waits (publication_pending) until its write is published;
    // bounded passes settle whatever is left.
    for (let i = 0; i < 100 && (await gitStates()).some(state => state === 'queued' || state === 'running'); i++) {
      await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: hostIdFor(engine), limit: 20 });
      await Bun.sleep(100);
    }
    // A direct claim on the worktree now finds nothing left to coalesce.
    const worktree = (await engine.getWorktreeBinding('work', hostIdFor(engine)))!.worktree_id;
    const left = await engine.claimCoalescedGitEffects({ hostId: hostIdFor(engine), worktreeId: worktree, limit: 5, deadOwners: [], ownerJson: '{}' });
    const tracked = execFileSync('git', ['-C', root, 'ls-files', 'notes'], { encoding: 'utf8' }).trim().split('\n').sort();
    const pushed = execFileSync('git', ['-C', join(home, 'remote.git'), 'ls-tree', '-r', '--name-only', 'main', 'notes'], { encoding: 'utf8' }).trim().split('\n').sort();
    const out = { git: await gitStates(), tracked, pushed, left: left.length };
    const all = ['notes/alice-example.md', 'notes/gina-example.md', 'notes/hank-example.md'];
    expect(out).toEqual({ git: ['committed', 'committed'], tracked: all, pushed: all, left: 0 });
    return out;
  }));

  parityTest('a refusal at publication ends the bound write failed through recovery: no page, no file', {
    methods: ['worktreeClaimStore', 'readWriteRequest', 'getPage'],
    timeout: 120_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, {}, async (_home, root) => {
    const request_id = randomUUID();
    const stored = async () => engine.readWriteRequest('local_cli', (await readLocalWriter(engine, 'cli')).id, request_id);
    const seen: FaultPoint[] = [];
    installFaultHook(async (point) => {
      seen.push(point);
      if (point === 'publication:before_publication') throw new OperationError('storage_error', 'Injected refusal at publication.', 'Test fault.');
    });
    let code: string | undefined;
    try {
      await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page',
        params: { slug: 'notes/carol-example', content: '---\ntype: note\ntitle: Carol Example\n---\nWorks at widget-co.\n', request_id } });
    } catch (e) { code = (e as { code?: string }).code; } finally { installFaultHook(undefined); }
    const final = await stored();
    const out = { code, recovered: seen.includes('publication_recovery:before_clear'),
      final: final && { state: final.state, error_code: final.error_code, recovery: final.recovery != null },
      page: (await engine.getPage('notes/carol-example', { sourceId: 'work' }))?.title ?? null,
      file: existsSync(join(root, 'notes', 'carol-example.md')) };
    expect(out).toEqual({ code: 'storage_error', recovered: true, final: { state: 'failed', error_code: 'storage_error', recovery: false }, page: null, file: false });
    return out;
  }));

  parityTest('a managed brain adds, archives, restores and removes a source in its own checkout under topology locks', {
    methods: ['worktreeClaimStore', 'readSourceMembership', 'readTopologyChange'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, { activate: true }, async (home) => {
    const second = join(home, 'second');
    gitCheckout(second, 'dana-example.md', '---\ntitle: Dana Example\n---\nWorks at widget-co.\n');
    const steps: unknown[] = [];
    const step = async (input: Parameters<typeof runManagedSourceLifecycle>[1]) => {
      try { steps.push(receipt(await runManagedSourceLifecycle(engine, input), home)); }
      catch (e) { if ((e as { code?: string }).code === 'engine_capability_missing') throw e; steps.push({ refused: (e as { code?: string }).code }); }
      const member = await engine.readSourceMembership('second');
      steps.push({ registered: member !== null, archived: member?.archived ?? null });
    };
    await step({ operation: 'add', sourceId: 'second', path: second });
    await step({ operation: 'archive', sourceId: 'second' });
    await step({ operation: 'restore', sourceId: 'second' });
    await step({ operation: 'remove', sourceId: 'second', confirmDestructive: true });
    return steps;
  }));

  parityTest('set-path moves a source to the checkout where it now lives', {
    methods: ['worktreeClaimStore', 'getWorktreeBinding'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, { activate: true }, async (home, root) => {
    const moved = join(home, 'moved-checkout');
    renameSync(root, moved);
    const out: Record<string, unknown> = {};
    try { out.rebind = receipt(await runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: 'work', path: moved }), home); }
    catch (e) { if ((e as { code?: string }).code === 'engine_capability_missing') throw e; out.rebind = { refused: (e as { code?: string }).code }; }
    const binding = await engine.getWorktreeBinding('work', localHostId());
    out.bound = binding ? { local: binding.local_path === moved, relative: binding.relative_path } : null;
    return out;
  }));

  parityTest('a moved checkout is found with its members', {
    methods: ['worktreeClaimStore'],
    timeout: 120_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, {}, async (home, root) => {
    const moved = join(home, 'moved-root');
    renameSync(root, moved);
    const found = await movedPhysicalRoot(engine as never, moved, localHostId());
    return { found: found ? found.members.map(member => member.sourceId) : null };
  }));

  parityTest('add_link and remove_link on a managed page rewrite its links fence', {
    methods: ['worktreeClaimStore', 'getPage', 'getLinks'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, { activate: true }, async (_home, root) => {
    const { operationsByName } = await import('../../src/core/operations.ts');
    const call = async (name: string, params: Record<string, unknown>) => {
      try { await operationsByName[name]!.handler(ctxFor(engine) as never, params); return 'ok'; }
      catch (e) { if ((e as { code?: string }).code === 'engine_capability_missing') throw e; return (e as { code?: string }).code ?? 'error'; }
    };
    const put = (slug: string, title: string) => call('put_page', { slug, content: `---\ntype: note\ntitle: ${title}\n---\nSynthetic note.\n` });
    const steps = [await put('notes/erin-example', 'Erin Example'), await put('notes/frank-example', 'Frank Example')];
    steps.push(await call('add_link', { from: 'notes/erin-example', to: 'notes/frank-example', link_type: 'mentions', context: 'Synthetic' }));
    const fenced = () => readFileSync(join(root, 'notes', 'erin-example.md'), 'utf8').includes('frank-example');
    const linked = async () => (await engine.getLinks('notes/erin-example', { sourceId: 'work' })).map(l => l.to_slug);
    const afterAdd = { file: fenced(), links: await linked() };
    steps.push(await call('remove_link', { from: 'notes/erin-example', to: 'notes/frank-example', link_type: 'mentions' }));
    return { steps, afterAdd, afterRemove: { file: fenced(), links: await linked() } };
  }));

  parityTest('a lifecycle change of the claimed source itself refuses while managed writes are pending, by code', {
    methods: ['worktreeClaimStore'],
    timeout: 120_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, { activate: true }, async () => {
    // The default source can never be removed: a refusal that needs no topology lock, the same on every engine.
    const out = { removeDefault: await codeOf(() => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: 'default', confirmDestructive: true })) };
    expect(out).toEqual({ removeDefault: 'invalid_params' });
    return out;
  }));
});
