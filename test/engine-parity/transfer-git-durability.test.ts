/**
 * Engine parity for #10123: a cross-host `transfer accept` carries the previous owner's Git durability onto the
 * successor's host binding (BrainEngine writerAdminStore().upsertHostBinding with `carryDurability`), the same on every
 * engine. `enabled` is carried only when the read-only push probe passes on the successor checkout, `disabled` as is;
 * otherwise a new binding stays unrecorded and the accept reports the probe failure, and a binding the successor host
 * already had keeps its own setting. The PGLite-only proving test is test/transfer-git-durability-10123.test.ts.
 *
 * Synthetic content only: a local Git checkout pushing to a bare remote in a scratch directory.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { acceptWriterTransfer, claimWorktree, getWorktreeBinding, prepareWriterTransfer } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { liftManagedHold } from './rust-managed.ts';

const { parityTest } = parityArms(testBackends());

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OWNER_HOST = '00000000-0000-4000-8000-0000000000a1';
const SUCCESSOR_HOST = '00000000-0000-4000-8000-0000000000b2';

/** Runs `run` under a scratch GBRAIN_HOME with file transport allowed for the bare remote. */
async function withHome<T>(engine: BrainEngine, run: (home: string) => Promise<T>): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-transfer-durability-parity-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      async () => { try { return await run(home); } finally { await disposePersistenceConsumer(engine); } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Source `work` owned by OWNER_HOST with `setting`, its checkout tracking a bare remote, prepared for transfer; the successor checkout is a copy. */
async function preparedTransfer(engine: BrainEngine, backend: ParityBackend, home: string, setting: 'enabled' | 'disabled') {
  const root = join(home, 'work'), remote = join(home, 'work.git');
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\ntype: note\n---\nA synthetic observation.\n');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
  mkdirSync(remote); git(remote, 'init', '-q', '--bare');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', '-u', 'origin', 'main');
  await createSource(engine, backend, 'work', {}, root);
  const binding = await claimWorktree(engine, 'work', root, OWNER_HOST);
  // The owner's setting, as `writer git-durability --enable|--disable` records it. That verb's store is held back on a
  // user's Rust brain (managed-hold.ts), so on the Rust arm the hold is lifted for this one seeding call only; the
  // transfer accept below runs with the hold on, as a user's brain runs it.
  const caps = backend === 'rust' ? (engine as unknown as { capabilities?: Set<string> }).capabilities : undefined;
  const lifted = caps !== undefined && !caps.has('managed_persistence');
  if (lifted) liftManagedHold(engine);
  let store: Awaited<ReturnType<BrainEngine['gitDurabilityStore']>>;
  try { store = await engine.gitDurabilityStore(); } finally { if (lifted) caps!.delete('managed_persistence'); }
  expect(await store.setHostBindingDurability(binding.worktree_id, OWNER_HOST, setting)).toEqual({ git_durability: setting });
  const prepared = await prepareWriterTransfer(engine, 'work', OWNER_HOST);
  const successor = join(home, 'work-successor');
  cpSync(root, successor, { recursive: true });
  return { worktreeId: binding.worktree_id, successor, prepared };
}

const accept = (engine: BrainEngine, t: Awaited<ReturnType<typeof preparedTransfer>>) =>
  acceptWriterTransfer(engine, 'work', t.successor, t.prepared.owner_epoch, t.prepared.manifest.digest, SUCCESSOR_HOST);

/** The successor host's binding after the accept: who owns the worktree and the Git durability recorded for it. */
async function successorBinding(engine: BrainEngine) {
  const binding = (await getWorktreeBinding(engine, 'work', SUCCESSOR_HOST))!;
  return { owner_is_successor: binding.owner_host_id === SUCCESSOR_HOST, git_durability: binding.git_durability };
}

describe('#10123 transfer accept carries git durability', () => {
  parityTest('an enabled owner with a working remote: the successor binding is enabled', { methods: ['writerAdminStore', 'gitDurabilityStore', 'getWorktreeBinding', 'readWorktreeManifest'], timeout: 120_000 },
    async (engine, backend) => withHome(engine, async home => {
      const t = await preparedTransfer(engine, backend, home, 'enabled');
      const accepted = await accept(engine, t);
      const out = { probe_failure: accepted.durability_probe_failure ?? null, ...await successorBinding(engine) };
      expect(out).toEqual({ probe_failure: null, owner_is_successor: true, git_durability: 'enabled' });
      return out;
    }));

  parityTest('a disabled owner: the successor binding is disabled', { methods: ['writerAdminStore', 'gitDurabilityStore', 'getWorktreeBinding', 'readWorktreeManifest'], timeout: 120_000 },
    async (engine, backend) => withHome(engine, async home => {
      const t = await preparedTransfer(engine, backend, home, 'disabled');
      const accepted = await accept(engine, t);
      const out = { probe_failure: accepted.durability_probe_failure ?? null, ...await successorBinding(engine) };
      expect(out).toEqual({ probe_failure: null, owner_is_successor: true, git_durability: 'disabled' });
      return out;
    }));

  parityTest('a successor branch with no tracking remote is not carried as enabled, and the accept names the probe failure', { methods: ['writerAdminStore', 'gitDurabilityStore', 'getWorktreeBinding', 'readWorktreeManifest'], timeout: 120_000 },
    async (engine, backend) => withHome(engine, async home => {
      const t = await preparedTransfer(engine, backend, home, 'enabled');
      git(t.successor, 'branch', '--unset-upstream');
      const accepted = await accept(engine, t);
      const out = { probe_failure: accepted.durability_probe_failure ?? null, ...await successorBinding(engine) };
      expect(out).toEqual({ probe_failure: 'no_tracking_remote', owner_is_successor: true, git_durability: null });
      return out;
    }));

  parityTest('a host taking a source back keeps its own recorded setting when nothing carries', { methods: ['writerAdminStore', 'worktreeClaimStore', 'gitDurabilityStore', 'getWorktreeBinding', 'readWorktreeManifest'], timeout: 120_000 },
    async (engine, backend) => withHome(engine, async home => {
      const t = await preparedTransfer(engine, backend, home, 'enabled');
      const owner = (await getWorktreeBinding(engine, 'work', OWNER_HOST))!;
      // The successor host already has a binding of this worktree, recorded enabled.
      const claim = await engine.worktreeClaimStore();
      await claim.insertHostBinding({ worktreeId: t.worktreeId, hostId: SUCCESSOR_HOST, localPath: t.successor, coordinationPath: owner.coordination_path!, gitDurability: 'enabled' });
      git(t.successor, 'remote', 'set-url', 'origin', join(home, 'missing-remote.git'));
      const accepted = await accept(engine, t);
      const out = { probe_failed: typeof accepted.durability_probe_failure === 'string', ...await successorBinding(engine) };
      expect(out).toEqual({ probe_failed: true, owner_is_successor: true, git_durability: 'enabled' });
      return out;
    }));
});
