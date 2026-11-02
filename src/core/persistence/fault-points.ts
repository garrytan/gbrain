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
  // An embedding effect that read its page at its own revision, before it reads the page's text projection (effects.ts `embedPage`).
  | 'effect:embedding:page_read'
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
  // Before a fact purge records its derivation sweep in its transaction (segment-derive.ts recordDerivationPurge); a 57014 from the hook models its statement timeout.
  | 'purge:derivation_sweep'
  // Inside each batch transaction of a purge's derivation sweep (segment-derive.ts continueDerivationPurges), with the batch size as `round` and the cursor as `read`; a 57014 from the hook models the batch outrunning its statement budget.
  | 'purge:derivation_batch'
  // Before the sweep deletes, unread, the one row that alone outran its statement budget; a 57014 from the hook models that statement outrunning it too.
  | 'purge:derivation_unread'
  // Inside each batch transaction of the purge receipt's derivation probe (purge-verify.ts derivationTextReport), with the batch size as `round`; a 57014 models a batch outrunning the probe's statement budget.
  | 'purge:derivation_probe'
  // Before a purge's derivation sweep takes the source's scope lock at the end of a walk (segment-derive.ts continueDerivationPurges): tried without
  // waiting, then waited for a bounded time. A 55P03 from the hook models a write in the source holding it: the try fails, the wait times out.
  | 'purge:derivation_scope_lock'
  // #6712 PR 4b: after a page-row deletion of a managed Git source wrote its origin's deletion marker (sync-markers.ts), before the row goes.
  | 'purge:marker_written'
  // #6712 PR 4b: before each round of a pass reads its level (`round`), and after it read it (`level`: its statements and its
  // confirm-round verdict), before it applies.
  | 'sync:round_start' | 'sync:level_read'
  // GBRA-133 S-69: as a pass starts batching a level's entries (sync-pass-run.ts `batchEntries`); a hook that throws models a
  // rejection there, including a non-Error one.
  | 'sync:batch_entries'
  // #6712 PR 4b: the level's overlapping reads, which share one loop budget (sync-yield.ts `turnYield`): a Git chunk as its
  // records are visited (`read`: ls-tree or ls-files; a synchronous hook), an `I⋈P` result in hand before the shared budget
  // decides whether it waits a turn, and the same result right before its rows are taken.
  | 'sync:level_chunk' | 'sync:level_result' | 'sync:level_take' | 'sync:closure_walk'
  // #6712 PR 4b: a taken confirm round about to patch the previous round's origin domain (sync-pass-narrow.ts); a hook that
  // throws makes it build the domain whole (`confirm.narrow: 'forced'`).
  | 'sync:level_narrow'
  // #6712 PR 4b: before a confirm round's proof sets its parallel scans (sync-pass-confirm.ts `parallelProof`); a hook that
  // throws makes the server refuse the setting, as a restricted role or a managed host does.
  | 'sync:confirm_parallel'
  // #6712 PR 4b (#6926): inside the round's last import's publication, before its folded stamp's checks (sync-pass-fold.ts); a hook
  // that throws models a failed check statement there: the stamp rolls back to its savepoint and the pass stamps by its checkpoint request.
  | 'sync:pass_fold'
  // GBRA-108: before each slice of a legacy sweep is screened (sync-pass-apply.ts); a hook that throws stops the pass mid-sweep,
  // as a kill or the drain's governor does.
  | 'sync:legacy_slice'
  // #6650: `gbrain repair stuck-recovery` (recovery-resolve.ts): after the backup is durable (before its journal step), after the prior
  // bytes are written (before their journal step), after a --keep disk write is abandoned (its journal step written), and after recoverPublication returns.
  | 'stuck_recovery:backed_up' | 'stuck_recovery:written' | 'stuck_recovery:abandoned' | 'stuck_recovery:recovered'
  // Wave B segmented writes (spec 3.4 crash windows): after the texts, the staged manifest rows and the staged chunks of a
  // preparation, after the generation flip (inside the publication transaction), before each chunk batch a projection reads (its segment
  // texts, then its claim renewal and insert), and after a projection staged its chunks (before its seal).
  | 'segmented:texts_staged' | 'segmented:manifest_staged' | 'segmented:chunks_staged' | 'segmented:flipped' | 'segmented:projection_batch'
  | 'segmented:projection_staged'
  // Inside each projection insert transaction, once it holds the page's key lock and before it checks the generation and
  // claim (ingest.ts `stageOccurrenceChunks`): a write to the page that arrives now waits for that transaction.
  | 'segmented:projection_insert'
  // A prior file over the single-string ceiling copied to its before stage (large-file.ts `stageBeforeCopy`): after the copy is
  // written under its temporary name (unverified, unflushed: a crash during the copy) and once it is flushed, before its rename.
  | 'large_file:stage_copying' | 'large_file:stage_flushed'
  // A streamed file (large-file.ts `stageStreamedContent`: restore_page, a segmented withdrawal mirror) after each piece is
  // written to its in-progress name, before the stream is verified, flushed and renamed to the reserved stage name.
  | 'large_file:stage_streaming'
  // GBRA-161: inside a generation activation, after its items are written and after its retirements, both before the commit;
  // and after the activation committed, before the producer acknowledges it.
  | 'generation:published' | 'generation:retired' | 'generation:activated'
  // GBRA-161 PR 1b: as a managed generation member (an overwrite or retirement after its activation committed) is prepared.
  | 'generation:member'
  // G8a (git-conversion.ts): after a conversion group's door commit, and after the strict-equivalent pass, before the flag is set.
  | 'conversion:group_committed' | 'conversion:withhold_stamped' | 'conversion:withhold_committed' | 'conversion:before_flip';
/**
 * `signal` (#6278, `consumer:preparing` only): the preparation's abort signal, so
 * a stalling hook can model both the reporter's cases: a preparer that honours
 * cancellation (settle on abort) and one that ignores it (hang on).
 */
/** `writeId` is the write request row: rows of a caller-bound replay share one `requestId` (crash-robot per-request seams key on the row). */
export interface FaultDetail { requestId?: string; writeId?: string; effectId?: string; sourceId?: string; operation?: string | null; signal?: AbortSignal; slug?: string; path?: string;
  /** The `*_interruption_charged` seams: what was charged and the error it was charged for, so a probe can name a charge it did not expect. */
  interruption?: { cause: string; sqlstate: string | null; error: string };
  round?: number; read?: string; level?: { statements: number; confirm: { taken: boolean; reason: string | null; rows: number; narrow?: string; across?: true } | null; reused?: number;
    /** `sync:level_read`: the level and the input it was read with (sync-pass.ts `readShadowLevel`), for probes that read it again. */
    shadow?: unknown; input?: unknown } }
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
/** A seam inside synchronous work: the hook runs to its first await, and what it returns is not awaited. */
export function faultPointNow(point: FaultPoint, detail: FaultDetailInput = {}): void {
  if (installed) void faultPoint(point, detail).catch(() => undefined);
}
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
