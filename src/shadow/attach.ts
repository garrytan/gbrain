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
import { MirrorQueue } from './mirror.ts';
import type { ShadowState } from './state.ts';
import { ShadowSupervisor, type ShadowSupervisorOptions } from './supervisor.ts';
import { wrapShadowEngine } from './wrapper.ts';

export interface AttachShadowDeps {
  /** argv of the gbrain CLI to spawn; default the running gbrain, never a different one on PATH. */
  gbrainArgv?: string[];
  supervisor?: Partial<ShadowSupervisorOptions>;
  random?: () => number;
}

export interface AttachedShadow<E extends BrainEngine> {
  engine: E;
  queue: MirrorQueue;
  supervisor: ShadowSupervisor;
}

/** The child's argv for `dir`. */
export function shadowChildArgv(dir: string, gbrainArgv?: string[]): string[] {
  const base = gbrainArgv ?? resolveServeGbrainCommand({ which: () => null });
  return [...base, 'engine', 'shadow', '__child', dir];
}

export function attachShadowParts<E extends BrainEngine>(engine: E, dir: string, state: ShadowState, deps: AttachShadowDeps = {}): AttachedShadow<E> {
  const supervisor = new ShadowSupervisor({ dir, argv: shadowChildArgv(dir, deps.gbrainArgv), ...deps.supervisor });
  const queue = new MirrorQueue({ bound: state.queue_bound, transport: supervisor });
  const sink = {
    counters: queue.counters,
    offer: (capture: Parameters<MirrorQueue['offer']>[0]) => queue.offer(capture),
    active: () => supervisor.active(),
  };
  engine.registerBeforeDisconnect(async () => {
    try {
      queue.stop(); // delivers the reads still queued, so the child sees them and the counters add up
      if (supervisor.active() && supervisor.childPid !== null) queue.flushStats();
    } finally {
      supervisor.stop();
    }
  });
  return { engine: wrapShadowEngine(engine, sink, { sampleRate: state.sample_rate, random: deps.random }), queue, supervisor };
}

/** The engine factory's entry point: the wrapped engine. */
export function attachShadow<E extends BrainEngine>(engine: E, dir: string, state: ShadowState): E {
  return attachShadowParts(engine, dir, state).engine;
}
