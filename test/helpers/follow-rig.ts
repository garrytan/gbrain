/**
 * Shadow follow rig for test/shadow-follow.test.ts (PGLite) and test/e2e/shadow-follow.test.ts (Postgres): a seeded
 * Rust store, the real follower, follow child and reconciler wired in one process (the supervisor's `send` and
 * `request` become direct calls into the child, which answers through `writeControl` exactly as the process does),
 * and a wrapped primary whose committed writes reach the follower.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import type { RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { openRustEngine } from '../../src/core/rust-engine.ts';
import type { FollowStore } from '../../src/shadow/follow-child.ts';
import { FollowChild } from '../../src/shadow/follow-child.ts';
import { ShadowFollower } from '../../src/shadow/follower.ts';
import { openReadSource } from '../../src/shadow/read-pool.ts';
import { Reconciler } from '../../src/shadow/reconcile.ts';
import { readSeedRecord, writeSeedRecord } from '../../src/shadow/seed.ts';
import { newMirrorCounters } from '../../src/shadow/mirror.ts';
import { wrapShadowEngine } from '../../src/shadow/wrapper.ts';
import { join } from 'node:path';
import { seedInto } from './shadow-seed-fixture.ts';

export interface FollowRig {
  /** The primary as the serving process sees it: committed writes are published to the follower. */
  wrapped: BrainEngine;
  follower: ShadowFollower;
  child: FollowChild;
  reconciler: Reconciler;
  store: FollowStore;
  seedId: string;
  dir: string;
  rust: BrainEngine;
  rpc: <T>(method: string, args?: Record<string, unknown>) => Promise<T>;
  /** Waits for the follower and then the child to finish everything sent so far. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

export async function openFollowRig(primary: BrainEngine, addon: RustAddon, dir: string, kind: 'pglite' | 'postgres', opts: { dirty?: (relation: string) => void; reuseSeed?: boolean } = {}): Promise<FollowRig> {
  // reuseSeed: a process restarted on a shadow seeded earlier reopens that store as it is, never reseeding it.
  const reused = opts.reuseSeed ? readSeedRecord(dir) : null;
  if (opts.reuseSeed && !reused) throw new Error(`no seed record in ${dir} to reuse`);
  const { record, storePath } = reused ? { record: reused, storePath: join(dir, 'store') } : await seedInto(primary, addon, dir, kind);
  if (!reused) writeSeedRecord(dir, record);
  const rust = openRustEngine({ addon, databasePath: storePath });
  await rust.connect({ engine: 'pglite', database_path: storePath } as never);
  const store = await (rust as unknown as { storeFor(member: string): Promise<FollowStore> }).storeFor('follow');
  const waiters = new Map<number, (resp: { ok: boolean; value?: unknown; error?: { code: string; message: string } }) => void>();
  const child = new FollowChild({
    dir, store: async () => store, owner: () => true,
    writeControl: (line) => { const msg = JSON.parse(line); if (msg.t === 'dirty') opts.dirty?.(msg.relation); else waiters.get(msg.id)?.(msg); },
  });
  await new Promise((resolve) => setTimeout(resolve, 5)); // a pass settles only what was invalidated before it started: not in the session's own millisecond
  let nextId = 0;
  const rpc = <T>(method: string, args: Record<string, unknown> = {}): Promise<T> => new Promise<T>((resolve, reject) => {
    const id = ++nextId;
    waiters.set(id, (resp) => { waiters.delete(id); if (resp.ok) resolve(resp.value as T); else reject(Object.assign(new Error(resp.error?.message), { code: resp.error?.code })); });
    child.handle({ t: 'rpc', id, method, args });
  });
  const reads = openReadSource(primary, { pauseMs: 0 });
  const follower = new ShadowFollower({
    reads, rpc, send: (line) => { child.handle(JSON.parse(line)); return true; },
    onDirty: (relation) => { opts.dirty?.(relation); },
  });
  const reconciler = new Reconciler({ dir, reads, rpc, follower });
  // The store was just seeded from the primary, which proves everything up to now; a session otherwise starts invalid.
  const wrapped = wrapShadowEngine(primary, { counters: newMirrorCounters(), offer: () => {}, active: () => true }, { sampleRate: 0, follow: { sink: follower } });
  const settle = async (): Promise<void> => { await follower.settle(); await rpc('state'); };
  return {
    wrapped, follower, child, reconciler, store, seedId: record.seed_id, dir, rust: rust as unknown as BrainEngine, rpc, settle,
    close: async () => { await settle(); await child.close(); await reads.close(); await rust.disconnect(); },
  };
}
