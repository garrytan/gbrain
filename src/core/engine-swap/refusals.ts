/**
 * `engine_swap_refused` (D15): the recovery table and the builders for `gbrain engine swap`.
 *
 * Every reason has one row: its registry class and exit, the measured blocker, the authority state, side effects, the
 * next step, a read-only verify, a retry bound and a guide anchor (docs/guides/engine-swap.md). The CLI, doctor and a
 * later `--resume` build refusals here so each reason renders one way on every surface (test/engine-swap-refusals.test.ts).
 */
import type { Action, ErrorClass } from '../agent-output.ts';
import { opError, type OperationError } from '../ops/contract.ts';

export const SWAP_GUIDE = 'docs/guides/engine-swap.md';

export const SWAP_REFUSAL_REASONS = [
  'refresh_unsettled',
  'managed_storage',
  'no_shadow',
  'not_ready',
  'multiple_writer_hosts',
  'writer_coverage_unknown',
  'team_brain',
  'follower_behind',
  'digest_mismatch',
  'route_override',
  'host_access_unbound',
  'host_access_changed',
  'fingerprint_semantics_differ',
] as const;
export type SwapRefusalReason = typeof SWAP_REFUSAL_REASONS[number];

export interface SwapRecoveryRow {
  class: ErrorClass;
  exit: number;
  /** What was measured that refused the swap. */
  blocker: string;
  /** Where authority is after the refusal. */
  authority: string;
  side_effects: string;
  /** The kind of next step an agent takes (agent operator contract v1). */
  next: 'run' | 'ask_user' | 'wait' | 'report' | 'tell_user_to_run';
  /** How often a retry is worth it. */
  retry: string;
  anchor: string;
}

const KEPT = 'The current engine keeps authority; nothing was written.';
const NONE = 'None: the plan and every refusal before a run are read only.';

/** The recovery table (RUST_ENGINE.md "Errors"); test/engine-swap-refusals.test.ts checks every row and anchor. */
export const SWAP_RECOVERY: Readonly<Record<SwapRefusalReason, SwapRecoveryRow>> = {
  refresh_unsettled: { class: 'retryable', exit: 1, blocker: 'A worktree refresh row is draining, fenced, merged, syncing or recovery_required. The Rust engine resumes no refresh, so a carried row would fence its sources for good (row L7-1).', authority: KEPT, side_effects: NONE, next: 'run', retry: 'Once per refresh, after `gbrain sources refresh <id> --resume` (or `--abandon`, with the user) settles it.', anchor: `${SWAP_GUIDE}#refresh_unsettled` },
  managed_storage: { class: 'consent', exit: 3, blocker: 'The brain uses managed storage (`persistence_brain.enabled` is true) and this build's Rust engine does not serve managed mode, so the Rust destination cannot hold it. The cutover would fail after the write fence is up.', authority: KEPT, side_effects: NONE, next: 'ask_user', retry: 'Only after the user turns managed storage off for this brain; there is no override.', anchor: `${SWAP_GUIDE}#managed_storage` },
  no_shadow: { class: 'consent', exit: 3, blocker: 'No shadow runs for this brain, so there is no readiness evidence: `gbrain engine shadow status` has no shadow directory for it.', authority: KEPT, side_effects: NONE, next: 'ask_user', retry: 'Only after the user seeds and starts a shadow (`gbrain engine shadow seed`, then `gbrain engine shadow start`) and it has run for the readiness window.', anchor: `${SWAP_GUIDE}#no_shadow` },
  not_ready: { class: 'caller', exit: 1, blocker: 'A readiness criterion is failing or has no evidence; the plan lists each one.', authority: KEPT, side_effects: NONE, next: 'report', retry: 'Never on a timer: keep shadowing and read the plan again when the shadow report changes. There is no override.', anchor: `${SWAP_GUIDE}#not_ready` },
  multiple_writer_hosts: { class: 'consent', exit: 3, blocker: 'Durable writer observations show writers on more than one machine in the last 7 days.', authority: KEPT, side_effects: NONE, next: 'ask_user', retry: 'Only after the user changes the topology. A brain with writers on more than one machine stays on Postgres until the Rust server phase passes the D17 bar (D19).', anchor: `${SWAP_GUIDE}#multiple_writer_hosts` },
  writer_coverage_unknown: { class: 'consent', exit: 3, blocker: 'A write path has no writer observation, or no observation window exists yet.', authority: KEPT, side_effects: NONE, next: 'ask_user', retry: 'Only after every writer runs a build that records observations and 7 days have passed.', anchor: `${SWAP_GUIDE}#writer_coverage_unknown` },
  team_brain: { class: 'consent', exit: 3, blocker: 'The brain is a mounted team brain, not a personal brain.', authority: KEPT, side_effects: NONE, next: 'ask_user', retry: 'Never: the preview swaps personal brains only.', anchor: `${SWAP_GUIDE}#team_brain` },
  follower_behind: { class: 'retryable', exit: 1, blocker: 'The shadow follower has lag, a queue, or an invalid coverage watermark.', authority: KEPT, side_effects: NONE, next: 'wait', retry: 'Up to 3 times, 60 s apart, reading the shadow status; then report.', anchor: `${SWAP_GUIDE}#follower_behind` },
  digest_mismatch: { class: 'unavailable', exit: 1, blocker: 'The final relation digests or sequence checks differ between the engines.', authority: 'The old engine keeps authority; diagnostics are kept.', side_effects: 'The run stops before the switch; the fence and diagnostics stay.', next: 'report', retry: 'Never blindly: report the diagnostics first.', anchor: `${SWAP_GUIDE}#digest_mismatch` },
  route_override: { class: 'consent', exit: 3, blocker: 'An environment variable or service definition still selects the current engine.', authority: KEPT, side_effects: NONE, next: 'ask_user', retry: 'Once, after the user removes the named override.', anchor: `${SWAP_GUIDE}#route_override` },
  host_access_unbound: { class: 'consent', exit: 3, blocker: 'An observed writer host has no credential for the shadow host.', authority: KEPT, side_effects: NONE, next: 'ask_user', retry: 'Once per host, after the user binds a credential.', anchor: `${SWAP_GUIDE}#host_access_unbound` },
  host_access_changed: { class: 'consent', exit: 3, blocker: 'A host would read something different through its planned credential.', authority: KEPT, side_effects: NONE, next: 'ask_user', retry: 'Only with the separate access approval (`--accept-access-change --expect <hash>`).', anchor: `${SWAP_GUIDE}#host_access_changed` },
  fingerprint_semantics_differ: { class: 'unavailable', exit: 1, blocker: 'The fingerprint probe failed: collation or server semantics differ between the engines.', authority: KEPT, side_effects: NONE, next: 'report', retry: 'Never until the engine or the source host changes.', anchor: `${SWAP_GUIDE}#fingerprint_semantics_differ` },
};

export function planArgv(): string[] { return ['gbrain', 'engine', 'swap', '--to', 'rust', '--plan', '--json']; }

const PLAN_VERIFY = { argv: planArgv() };

/** One unsettled refresh row, as `readUnsettledRefreshes` returns it. */
export interface UnsettledRefresh {
  id: string;
  state: string;
  source_ids: string[];
  updated_at: string | null;
  /** The next step `gbrain sources writer status` gives for this refresh. */
  next: string | null;
}

/** `engine_swap_refused` / `refresh_unsettled`: checked before any readiness criterion (row L7-1). */
export function refreshUnsettledError(rows: readonly UnsettledRefresh[]): OperationError {
  const row = SWAP_RECOVERY.refresh_unsettled;
  const list = rows.map(r => `${r.id} (${r.state}; sources ${r.source_ids.join(', ') || 'none'})`).join('; ');
  const first = rows[0]?.source_ids[0];
  const why = `${rows.length} worktree refresh row(s) are not finished: ${list}. The Rust engine does not resume a worktree refresh, so a row carried into a Rust store would fence its sources with no resume and no log. Finish or abandon each refresh first, as the write journal is drained first.`;
  const fix: Action = first
    ? { argv: ['gbrain', 'sources', 'refresh', first, '--resume'], consent: [], actor: 'agent', requires_exclusive: false, docs: row.anchor, verify: PLAN_VERIFY,
        why: `Resumes the refresh of source ${first} so it finishes; run it for each listed source, then read the plan again. Abandoning a refresh (--abandon) needs the user.` }
    : { consent: [], actor: 'user', requires_exclusive: false, docs: row.anchor, verify: PLAN_VERIFY, why,
        user_message: 'A worktree refresh with no bound source is unfinished. Can you check it with `gbrain doctor --json`? The engine swap waits until it is settled; nothing changed.' };
  return opError('engine_swap_refused', `The swap is refused: ${rows.length} worktree refresh row(s) are unfinished (${list}).`,
    'Finish each refresh (fix), then read the swap plan again. Nothing changed; the brain stays on its current engine.',
    { reason: 'refresh_unsettled', why, docs: row.anchor, fix, detail: `refreshes: ${list}. Next: ${rows.map(r => `${r.id}: ${r.next ?? `gbrain sources refresh ${r.source_ids[0] ?? '<source>'} --resume`}`).join('; ')}. ${row.authority}` });
}

/** `engine_swap_refused` / `managed_storage`: checked before any readiness criterion, next to the refresh gate; raised only when this build's Rust engine does not serve managed mode (plan.ts rustHoldsManagedStorage). */
export function managedStorageError(): OperationError {
  const row = SWAP_RECOVERY.managed_storage;
  const why = 'This brain uses managed storage (persistence_brain.enabled is true). This build's Rust engine does not serve managed mode, so the cutover could not carry it and would fail after writes are fenced. The swap refuses now, before anything is read or written.';
  return opError('engine_swap_refused', 'The swap is refused: this brain uses managed storage, which this build of the Rust engine does not support.',
    'Ask the user whether this brain should stay on its current engine (fix); nothing changed.',
    { reason: 'managed_storage', why, docs: row.anchor, detail: row.authority,
      fix: { ask_user: true, consent: [], actor: 'user', requires_exclusive: false, docs: row.anchor, verify: PLAN_VERIFY, why,
        user_message: 'This brain uses managed storage, and this build's Rust engine cannot hold a managed brain, so the engine swap is refused. Do you want to keep this brain on its current engine? Nothing changed.' } });
}

/** `engine_swap_refused` / `team_brain` for a mounted brain: the preview swaps the host's personal brain only. */
export function mountedBrainError(brainId: string): OperationError {
  const row = SWAP_RECOVERY.team_brain;
  const why = `The selected brain is the mounted brain ${brainId}, not this machine's own brain. The preview swaps a personal brain only, and a mount is never opened in its place.`;
  return opError('engine_swap_refused', `The swap is refused: ${brainId} is a mounted brain; only the host brain can be previewed.`,
    'Ask the user whether they meant their own brain (fix); nothing changed.',
    { reason: 'team_brain', why, docs: row.anchor, detail: row.authority,
      fix: { ask_user: true, argv: ['gbrain', '--brain', 'host', 'engine', 'swap', '--to', 'rust', '--plan', '--json'], consent: [], actor: 'user', requires_exclusive: false, docs: row.anchor, verify: PLAN_VERIFY, why,
        user_message: `${brainId} is a mounted brain, and the Rust engine preview moves only your own brain. Do you want the plan for your own brain instead? Nothing changed.` } });
}
