/**
 * Named crash seams for the persistence gate (`scripts/persistence/`). Each
 * seam sits at a point where a process death leaves durable state the
 * recovery path must finish: publication boundaries, after an effect's side
 * effect but before its completion is recorded, before a recovery record is
 * cleared, between sync checkpoints, after the consumer prepared a
 * claimed request, (`consumer:claiming`) before the consumer claims a request or a lane head, (`sync:after_freeze`) after a managed sync import entry is frozen and before it is admitted, (`lane:applied`) when a lane group has applied its pages and waits for its commit turn, (`stuck_recovery:*`) between the steps of a stuck-recovery resolution, (`segmented:*`) between the stages of a segmented write, and (`large_file:*`) while a large prior file is copied to its before stage. Production never installs a hook, so every call is a
 * no-op there; the gate's workers install one that SIGKILLs or stalls the
 * process at a chosen point.
 */
import type { EffectKind } from './effect-model.ts';
import type { PublicationHooks } from './coordinator.ts';
import type { WriteRequest } from './model.ts';

export type PublicationBoundary = Parameters<NonNullable<PublicationHooks['boundary']>>[0];
export type FaultPoint = `publication:${PublicationBoundary}` | `effect:${EffectKind}:mid` | 'effect:embedding:settle'
  | 'effect_recovery:before_clear' | 'publication_recovery:before_clear'
  // A streamed (version 2) withdrawal mirror (effect-recovery.ts): once its record is durable and before its file is
  // streamed into the publication stage, and after that step (the stage written and flushed, or left as it was found),
  // before the recovery transaction renames it.
  | 'effect_recovery:before_stage' | 'effect_recovery:staged' | 'sync:mid_checkpoint' | 'sync:before_group_admission' | 'sync:mid_waiver_run' | 'sync:prescreened' | 'consumer:prepared'
  | 'consumer:preparing' | 'lane:applied'
  // Flip lane C: after a statement-cancelled (57014) write's attempt is charged, before its claim is released or finished.
  | 'persistence:interruption_charged'
  // Flip lane C: on publishMutation's recovery route, after a statement-cancelled (57014) write's attempt is charged, before the request is marked recovering.
  | 'persistence:recovery_interruption_charged'
  // Flip lane C: before a group's memoized shared preparation read (group-publish.ts `preparationReads`) is sent; a hook that throws a 57014 models the database cancelling it.
  | 'group:shared_read'
  // Before each claim attempt of the consumer, a FIFO claim or a lane head's: a stalling hook keeps this process from starting
  // another request or lane group meanwhile, while the requests it already holds run on.
  | 'consumer:claiming'
  // #6712 PR 0: after `freezeEntry` froze an import entry (its bytes are read) and before the request is admitted or published.
  | 'sync:after_freeze'
  // #6712 PR 1 (L2): after the cursor step that holds a failed entry and settles its index commits (`holdUnderGate`), and after
  // the cursor step that defers an entry whose file changed after admission past the manifest end (`deferChangedEntry`).
  | 'sync:held_settled' | 'sync:retry_deferred'
  // #6712 PR 1: after a pass took the source's drain lease (before it reads the cursor); after each cursor the fan-in
  // superseded is retired (before the next one), and after a pass stamped its authority on a cursor another writer started.
  | 'sync:lease_acquired' | 'sync:cursor_adopted'
  // #6712 PR 2 (L5): after the drain lease is released, before the owed tail (statistics, links) of a committed checkpoint runs.
  | 'sync:tail_started'
  // #6511: the page purge's in-transaction journal lookups (page-purge.ts `journalLookup`); a hook that throws a 57014 models a statement timeout there.
  | 'purge:slug_lookup' | 'purge:tail_recheck' | 'purge:pending_recheck' | 'purge:redaction_read'
  // #6511: before each keyset chunk of the preparation-time journal sweep (a stalling hook models a slow chunk), and the fact purge's planning read.
  | 'purge:sweep_chunk' | 'purge:carrying_lookup'
  // W1: before each keyset batch of the belief ledger's purge redaction (belief/purge.ts); a 57014 from the hook models its statement timeout.
  | 'purge:ledger_redaction'
  // #6650: `gbrain repair stuck-recovery` (recovery-resolve.ts): after the backup is durable (before its journal step), after the prior
  // bytes are written (before their journal step), after a --keep disk write is abandoned (its journal step written), and after recoverPublication returns.
  | 'stuck_recovery:backed_up' | 'stuck_recovery:written' | 'stuck_recovery:abandoned' | 'stuck_recovery:recovered'
  // Wave B segmented writes (spec 3.4 crash windows): after the texts, the staged manifest rows and the staged chunks of a
  // preparation, after the generation flip (inside the publication transaction), before each chunk batch a projection reads (its segment
  // texts, then its claim renewal and insert), and after a projection staged its chunks (before its seal).
  | 'segmented:texts_staged' | 'segmented:manifest_staged' | 'segmented:chunks_staged' | 'segmented:flipped' | 'segmented:projection_batch'
  | 'segmented:projection_staged'
  // A prior file over the single-string ceiling copied to its before stage (large-file.ts `stageBeforeCopy`): after the copy is
  // written under its temporary name (unverified, unflushed: a crash during the copy) and once it is flushed, before its rename.
  | 'large_file:stage_copying' | 'large_file:stage_flushed'
  // A streamed file (large-file.ts `stageStreamedContent`: restore_page, a segmented withdrawal mirror) after each piece is
  // written to its in-progress name, before the stream is verified, flushed and renamed to the reserved stage name.
  | 'large_file:stage_streaming';
/**
 * `signal` (#6278, `consumer:preparing` only): the preparation's abort signal, so
 * a stalling hook can model both the reporter's cases: a preparer that honours
 * cancellation (settle on abort) and one that ignores it (hang on).
 */
/** `writeId` is the write request row: rows of a caller-bound replay share one `requestId` (crash-robot per-request seams key on the row). */
export interface FaultDetail { requestId?: string; writeId?: string; effectId?: string; sourceId?: string; operation?: string | null; signal?: AbortSignal; slug?: string; path?: string }
/** Postgres returns `persistence_effects.id` (bigserial) as a BigInt; `faultPoint` hands hooks its decimal string (#6584). */
export type FaultDetailInput = Omit<FaultDetail, 'effectId'> & { effectId?: string | number | bigint };
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
/** Whether a hook is installed: a seam that must not delay a synchronous send in production checks it first. */
export function faultHookInstalled(): boolean { return installed !== undefined; }
export async function faultPoint(point: FaultPoint, detail: FaultDetailInput = {}): Promise<void> {
  if (!installed) return;
  const { effectId, ...rest } = detail;
  await installed(point, effectId === undefined ? rest : { ...rest, effectId: String(effectId) });
}
/** Publication hooks that also reach the installed seam; returns the caller's hooks unchanged when none is installed. */
export function withFaultPoints(hooks: PublicationHooks): PublicationHooks {
  if (!installed) return hooks;
  return { ...hooks, async boundary(name: PublicationBoundary, row: WriteRequest) {
    await hooks.boundary?.(name, row);
    await faultPoint(`publication:${name}`, { requestId: row.request_id, sourceId: row.source_id, operation: row.operation });
  } };
}
