/**
 * Named crash seams for the persistence gate (`scripts/persistence/`). Each
 * seam sits at a point where a process death leaves durable state the
 * recovery path must finish: publication boundaries, after an effect's side
 * effect but before its completion is recorded, before a recovery record is
 * cleared, between sync checkpoints, after the consumer prepared a
 * claimed request, (`lane:applied`) when a lane group has applied its pages and waits for its commit turn, and (`stuck_recovery:*`) between the steps of a stuck-recovery resolution. Production never installs a hook, so every call is a
 * no-op there; the gate's workers install one that SIGKILLs or stalls the
 * process at a chosen point.
 */
import type { EffectKind } from './effect-model.ts';
import type { PublicationHooks } from './coordinator.ts';
import type { WriteRequest } from './model.ts';

export type PublicationBoundary = Parameters<NonNullable<PublicationHooks['boundary']>>[0];
export type FaultPoint = `publication:${PublicationBoundary}` | `effect:${EffectKind}:mid` | 'effect:embedding:settle'
  | 'effect_recovery:before_clear' | 'publication_recovery:before_clear' | 'sync:mid_checkpoint' | 'sync:before_group_admission' | 'sync:mid_waiver_run' | 'consumer:prepared'
  | 'consumer:preparing' | 'lane:applied'
  // #6511: the page purge's in-transaction journal lookups (page-purge.ts `journalLookup`); a hook that throws a 57014 models a statement timeout there.
  | 'purge:slug_lookup' | 'purge:tail_recheck' | 'purge:pending_recheck' | 'purge:redaction_read'
  // #6511: before each keyset chunk of the preparation-time journal sweep (a stalling hook models a slow chunk), and the fact purge's planning read.
  | 'purge:sweep_chunk' | 'purge:carrying_lookup'
  // #6650: `gbrain repair stuck-recovery` (recovery-resolve.ts): after the backup is durable (before its journal step), after the prior
  // bytes are written (before their journal step), after a --keep disk write is abandoned (its journal step written), and after recoverPublication returns.
  | 'stuck_recovery:backed_up' | 'stuck_recovery:written' | 'stuck_recovery:abandoned' | 'stuck_recovery:recovered';
/**
 * `signal` (#6278, `consumer:preparing` only): the preparation's abort signal, so
 * a stalling hook can model both the reporter's cases: a preparer that honours
 * cancellation (settle on abort) and one that ignores it (hang on).
 */
export interface FaultDetail { requestId?: string; effectId?: string | number; sourceId?: string; operation?: string | null; signal?: AbortSignal }
type FaultHook = (point: FaultPoint, detail: FaultDetail) => Promise<void> | void;

/** The mid-effect seam of every effect kind; a new kind without one fails typecheck. */
export const EFFECT_FAULT_POINTS: Record<EffectKind, FaultPoint> = {
  git: 'effect:git:mid',
  embedding: 'effect:embedding:mid',
  'withdrawal-mirror': 'effect:withdrawal-mirror:mid',
  'facts-backstop': 'effect:facts-backstop:mid',
  links: 'effect:links:mid',
};

let installed: FaultHook | undefined;
/** Gate workers only. */
export function installFaultHook(hook: FaultHook | undefined): void { installed = hook; }
export async function faultPoint(point: FaultPoint, detail: FaultDetail = {}): Promise<void> {
  if (installed) await installed(point, detail);
}
/** Publication hooks that also reach the installed seam; returns the caller's hooks unchanged when none is installed. */
export function withFaultPoints(hooks: PublicationHooks): PublicationHooks {
  if (!installed) return hooks;
  return { ...hooks, async boundary(name: PublicationBoundary, row: WriteRequest) {
    await hooks.boundary?.(name, row);
    await faultPoint(`publication:${name}`, { requestId: row.request_id, sourceId: row.source_id, operation: row.operation });
  } };
}
