/**
 * Turns shadow mode on for one opened engine (plan PR S1). The engine factory imports this module only when
 * state.json says shadow mode is on for the brain, so a brain that never used it loads none of src/shadow beyond
 * state.ts.
 *
 * Wiring: wrapper (captures reads after the primary answered) -> bounded MirrorQueue (sheds, never blocks) ->
 * ShadowSupervisor (lazy child, restarts, watchdog). The engine's disconnect flushes the counters and ends the
 * child's stdin without waiting.
 */
import type { BrainEngine } from '../core/engine.ts';
import { resolveServeGbrainCommand } from '../core/serve-service.ts';
import type { FollowOptions } from './follow.ts';
import { ShadowFollower } from './follower.ts';
import { openReadSource } from './read-pool.ts';
import { Reconciler } from './reconcile.ts';
import { readSeedRecord } from './seed.ts';
import { MirrorQueue } from './mirror.ts';
import type { ShadowState } from './state.ts';
import { ShadowSupervisor, type ShadowSupervisorOptions } from './supervisor.ts';
import { wrapShadowEngine } from './wrapper.ts';

export interface AttachShadowDeps {
  /** argv of the gbrain CLI to spawn; default the running gbrain, never a different one on PATH. */
  gbrainArgv?: string[];
  supervisor?: Partial<ShadowSupervisorOptions>;
  random?: () => number;
  /**
   * Shadow follow: a producer to publish committed primary writes to. When left out and the brain has been seeded
   * (seed.json), the follower applies committed writes to the Rust store (follower.ts) and a reconciler repairs what it
   * missed. A brain with no seed follows nothing.
   */
  follow?: FollowOptions;
}

export interface AttachedShadow<E extends BrainEngine> {
  engine: E;
  queue: MirrorQueue;
  supervisor: ShadowSupervisor;
  /** Set when the brain is seeded and `follow` was left out. */
  follower?: ShadowFollower;
  reconciler?: Reconciler;
}

/** The child's argv for `dir`. */
export function shadowChildArgv(dir: string, gbrainArgv?: string[]): string[] {
  const base = gbrainArgv ?? resolveServeGbrainCommand({ which: () => null });
  return [...base, 'engine', 'shadow', '__child', dir];
}

export function attachShadowParts<E extends BrainEngine>(engine: E, dir: string, state: ShadowState, deps: AttachShadowDeps = {}): AttachedShadow<E> {
  const supervisor = new ShadowSupervisor({ dir, argv: shadowChildArgv(dir, deps.gbrainArgv), onDirty: (relation) => reconciler?.markDirty(relation), ...deps.supervisor });
  const queue = new MirrorQueue({ bound: state.queue_bound, transport: supervisor });
  const sink = {
    counters: queue.counters,
    offer: (capture: Parameters<MirrorQueue['offer']>[0]) => queue.offer(capture),
    active: () => supervisor.active(),
  };
  const seeded = deps.follow === undefined && readSeedRecord(dir)?.digests === true;
  const rpc = <T>(method: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T> => supervisor.request<T>(method, args, timeoutMs);
  const reads = seeded ? openReadSource(engine) : undefined;
  const follower = reads ? new ShadowFollower({
    reads, send: (line) => supervisor.send(line), rpc,
    onDirty: (relation) => reconciler?.markDirty(relation),
    onFirstBatch: () => { void reconciler?.probe().catch(() => undefined); },
  }) : undefined;
  const reconciler = reads ? new Reconciler({ dir, reads, rpc, follower }) : undefined;
  reconciler?.startNightly();
  engine.registerBeforeDisconnect(async () => {
    try {
      queue.stop(); // delivers the reads still queued, so the child sees them and the counters add up
      if (supervisor.active() && supervisor.childPid !== null) queue.flushStats();
      // Let the follower finish reading what was just committed; a slow read is shed rather than waited on.
      if (follower) await Promise.race([follower.settle(), new Promise((resolve) => { setTimeout(resolve, 2_000).unref?.(); })]);
    } finally {
      reconciler?.stop();
      supervisor.stop();
      await reads?.close().catch(() => undefined);
    }
  });
  const follow = follower ? { sink: follower } : deps.follow;
  return { engine: wrapShadowEngine(engine, sink, { sampleRate: state.sample_rate, random: deps.random, follow }), queue, supervisor, follower, reconciler };
}

/** The engine factory's entry point: the wrapped engine. */
export function attachShadow<E extends BrainEngine>(engine: E, dir: string, state: ShadowState): E {
  return attachShadowParts(engine, dir, state).engine;
}
