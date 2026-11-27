/**
 * Typed seeders for the persistence binding rows the collate parity cases need (persistence_worktrees,
 * persistence_source_bindings, persistence_host_bindings), written through BrainEngine.worktreeClaimStore, so the same
 * fixture lands on PGLite, Postgres and the Rust store. Each insert runs in its own transaction, as the store expects. The inserts take the column defaults the raw seeds took (owner
 * epoch 0, generation 1, state active unless given); the worktree id is a fresh uuid, as the table default made it.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource } from './harness.ts';

type Backend = Parameters<typeof createSource>[1];

type ClaimStore = Awaited<ReturnType<BrainEngine['worktreeClaimStore']>>;
const withStore = (engine: BrainEngine, run: (store: ClaimStore) => Promise<void>) => engine.transaction(async tx => run(await tx.worktreeClaimStore()));

/** Registers the source (no change when it exists) and returns its incarnation. */
export async function seedSource(engine: BrainEngine, backend: Backend, id: string, localPath?: string): Promise<string> {
  if (!(await engine.readSourceState(id))) await createSource(engine, backend, id, {}, localPath);
  return String((await engine.readSourceState(id))!.incarnation);
}

/** A worktree row owned by `owner` (null: unowned) in `state`; returns its id. */
export async function seedWorktree(engine: BrainEngine, owner: string | null = null, state: 'active' | 'draining' | 'recovering' = 'active'): Promise<string> {
  const id = randomUUID();
  await withStore(engine, store => store.insertWorktree({ id, ownerHostId: owner, state }));
  return id;
}

/** Binds the source incarnation to the worktree at `relativePath`. */
export async function seedSourceBinding(engine: BrainEngine, sourceId: string, incarnation: string, worktreeId: string, relativePath = ''): Promise<void> {
  await withStore(engine, store => store.insertSourceBinding({ sourceId, incarnation, worktreeId, relativePath }));
}

/** Binds the worktree to `hostId` at `localPath`, with its coordination file beside it (`<path>.lock`). */
export async function seedHostBinding(engine: BrainEngine, worktreeId: string, hostId: string, localPath: string): Promise<void> {
  await withStore(engine, store => store.insertHostBinding({ worktreeId, hostId, localPath, coordinationPath: `${localPath}.lock` }));
}
