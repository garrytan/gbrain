/**
 * #6696 (A5): who a write is for. `interactive` writes are the user's own
 * (`remember`, `put_page`, `edit_page` from the CLI or an MCP client, an
 * operator's `gbrain sync`, an approved `gbrain repair`); everything else is
 * `background` (maintenance, conversation facts, autopilot cycle phases,
 * autopilot catch-up syncs, minion jobs). Trusted host-side callers set the
 * origin explicitly: `OperationContext.admissionOrigin` at the CLI and MCP
 * entry points and the persistence owner's verified IPC dispatch, or a
 * `withAdmissionOrigin` scope around a command (`gbrain sync`, its delegated
 * run on the owner, `gbrain repair`; `runCycle` scopes itself background).
 * A caller that sets nothing is background. It is never inferred from
 * `ctx.remote`: an autopilot phase writes with `remote: true` too.
 *
 * Near a cumulative cap (`persistence.capacity.background_pause_pct`, default
 * 80 percent, of a principal's or the brain's request ids or receipt bytes) a
 * background admission refuses `write_capacity_backpressure` before any
 * receipt exists, so the rest stays free for interactive writes. #6741 C: a
 * background admission bound to a worktree in recovery refuses
 * `owner_unavailable` the same way (backgroundWorktreeInactive), so a producer
 * retrying against it burns no permanent request ids. A draining (paused)
 * owner still admits: its receipts stay pending and its restart replays them.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { opError, type OperationError } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';
import type { SqlEngine } from './model.ts';
import { CAPACITY_VERIFY } from './capacity-verify.ts';

export type AdmissionOrigin = 'interactive' | 'background';
export const ADMISSION_ORIGINS: readonly AdmissionOrigin[] = ['interactive', 'background'];
export const BACKGROUND_PAUSE_KEY = 'persistence.capacity.background_pause_pct';
export const DEFAULT_BACKGROUND_PAUSE_SHARE = 0.8;
/** What a paused admission's doctor finding names as paused. */
export const BACKGROUND_PRODUCERS = ['managed maintenance', 'conversation facts', 'autopilot cycle phases', 'autopilot catch-up sync', 'minion jobs'] as const;

/** #6741 C: a run's origin, and its per-source owner verification outcomes (backgroundOwnerCheck). */
interface OriginScope { origin: AdmissionOrigin; owners: Map<string, Promise<OperationError | null>> }
const scope = new AsyncLocalStorage<OriginScope>();

/** Runs `fn` with every admission inside it attributed to `origin` (a background scope wins over an inner interactive caller). */
export function withAdmissionOrigin<T>(origin: AdmissionOrigin, fn: () => T): T {
  const outer = scope.getStore();
  return scope.run(outer?.origin === 'background' ? outer : { origin, owners: new Map() }, fn);
}

/** The origin an admission is charged to: a surrounding background scope, else the explicit origin, else the scope, else background. */
export function resolveAdmissionOrigin(explicit?: AdmissionOrigin): AdmissionOrigin {
  const surrounding = scope.getStore()?.origin;
  if (surrounding === 'background') return 'background';
  return explicit ?? surrounding ?? 'background';
}

/**
 * #6741 C: whether this admission is declared background work: an explicit background origin, or a surrounding
 * background run (withAdmissionOrigin). An admission with neither (a direct caller relying on the default) is charged
 * as background but is not a declared producer run, so it keeps the publication's own fences (a physical-root change
 * fails its receipt with the specific code, as sync dispatch and put_page always have).
 */
export function declaredBackground(explicit?: AdmissionOrigin): boolean {
  const surrounding = scope.getStore()?.origin;
  return surrounding === 'background' || (explicit ?? surrounding) === 'background';
}

export function isAdmissionOrigin(value: unknown): value is AdmissionOrigin {
  return value === 'interactive' || value === 'background';
}

/** The pause line as a share of each cumulative cap (0 < share <= 1); the setting is a percent (80), and a share (0.8) reads the same. */
export async function readBackgroundPauseShare(engine: SqlEngine): Promise<number> {
  const [row] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1', [BACKGROUND_PAUSE_KEY]);
  return backgroundPauseShare(row?.value);
}

/** The pause share a stored setting (undefined when unset) stands for. */
export function backgroundPauseShare(raw: string | undefined): number {
  const value = raw === undefined ? DEFAULT_BACKGROUND_PAUSE_SHARE : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 100) return DEFAULT_BACKGROUND_PAUSE_SHARE;
  return value > 1 ? value / 100 : value;
}

/**
 * The refusal of a background admission past the pause line; nothing was
 * submitted. Request ids are never freed, so past the line on ids the only fix
 * is the host's config raise; receipt bytes also free as receipts compact.
 */
export function backgroundPaused(scopeKey: string, resource: 'lifetime_ids' | 'terminal_bytes', used: number, limit: number, share: number,
  configKey: string, value: number, context: { what?: string; alternative?: string } = {}): OperationError {
  const raise = `gbrain config set ${configKey} ${value}`;
  return opError('write_capacity_backpressure',
    `${context.what ?? 'Background writes are paused'}: ${scopeKey} ${resource} is at ${used} of ${limit}, past the ${Math.round(share * 100)}% pause line (${BACKGROUND_PAUSE_KEY}).`,
    `Nothing was submitted; interactive writes keep the rest of ${configKey}. ${context.alternative ? `${context.alternative} ` : ''}${resource === 'lifetime_ids'
      ? `Request ids are never freed, so background work resumes only after the brain host runs ${raise} (covers about one more year; undo with gbrain config unset ${configKey}).`
      : `Background work resumes as retained receipts compact, or at once after the brain host runs ${raise} (covers about one more year; undo with gbrain config unset ${configKey}).`}`,
    { reason: resource, detail: configKey.slice('persistence.limits.'.length), docs: 'docs/guides/write-refusals.md#write_capacity_backpressure',
      fix: { argv: ['gbrain', 'config', 'set', configKey, String(value)], consent: [], actor: 'host_admin', requires_exclusive: false,
        why: resource === 'lifetime_ids' ? 'Request ids are permanent, so only a larger cap moves the pause line; the raise is reversible.'
          : 'The raise moves the pause line at once and is reversible; compaction frees reserved bytes only as receipts age out of the retention window.',
        verify: CAPACITY_VERIFY, docs: 'docs/guides/concurrent-writes.md#quota-near-exhaustion' } });
}

/**
 * #6741 C: the refusal of a background admission to a worktree in recovery; nothing was submitted and no request id
 * was used. `owner_unavailable` with the owner-status read fix, as facts-maintenance refuses a non-active fact writer.
 */
export function backgroundWorktreeInactive(sourceId: string, state: string, ownerStatusFix: Action): OperationError {
  return opError('owner_unavailable', `Background writes to source ${sourceId} are paused: its worktree is ${state}.`,
    `Nothing was submitted and no request id was used. Background work for source ${sourceId} resumes once its writer is active again; writer status shows what it is waiting on.`,
    { fix: ownerStatusFix });
}

/**
 * #6741 C: the owner verification of one source, at most once per background producer run: the outcome is cached in
 * the surrounding background scope (withAdmissionOrigin('background', …)); an admission outside any scope verifies
 * on its own.
 */
export function backgroundOwnerCheck(sourceId: string, verify: () => Promise<OperationError | null>): Promise<OperationError | null> {
  const owners = scope.getStore()?.owners;
  if (!owners) return verify();
  let check = owners.get(sourceId);
  if (!check) { check = verify(); owners.set(sourceId, check); }
  return check;
}

/** #6741 C: the refusal of a background admission whose source's owner on this host fails the claim's owner verification. */
export function backgroundOwnerUnverified(sourceId: string, physicalError: string | undefined, ownerStatusFix: Action): OperationError {
  return opError('owner_unavailable', `Background writes to source ${sourceId} are paused: its canonical owner could not be verified.`,
    `${physicalError ?? `Source ${sourceId}'s host binding has no canonical path or coordination lock path.`} Nothing was submitted and no request id was used. `
      + `Writer status shows the recovery the source needs (a deleted owner marker is repaired by a writer self-transfer, the user's decision); background work resumes after it.`,
    { fix: ownerStatusFix });
}
