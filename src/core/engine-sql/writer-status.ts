/**
 * The reads of `gbrain sources writer status` (persistence/administration.ts, persistence/diagnostics.ts) and the
 * helpers it shares with other writer commands: the writer diagnostics row sets, the status bindings and stopped
 * retire requests, the onboarding preflight's sources (persistence/onboarding.ts), the blocking effects
 * (persistence/blocking-effects.ts) and the active worktree refreshes (persistence/worktree-refresh.ts).
 *
 * Text keys sort in byte order (`COLLATE "C"`), so the output does not depend on the server's locale. Timestamps come
 * back as the driver returns them (a `Date` on both SQL engines); a Rust brain answers the same rows from its records
 * (src/core/rust-engine/store-members/writer-status.ts).
 */
import type { BrainEngine } from '../engine.ts';

type RawSql = Pick<BrainEngine, 'executeRaw'>;
type Time = Date | string;

/** One source binding as writer status prints it, with this host's root and Git durability. */
export interface WriterStatusBindingRow {
  source_id: string; source_incarnation: string; worktree_id: string; relative_path: string; topology_generation: string;
  owner_host_id: string | null; owner_epoch: string; state: string; manifest_digest: string | null; prepared_at: string | null;
  local_path: string | null; git_durability: string | null; git_durability_state: 'on' | 'off' | 'unknown';
}
/** A stopped remove or purge request (a retire admission), or one a later lifecycle change superseded. */
export interface WriterStatusTopologyRow {
  request_id: string; operation: string; source_id: string; source_incarnation: string; state: string; error: string | null; created_at: string;
}
export interface WriterStatusRows { bindings: WriterStatusBindingRow[]; topology_requests: WriterStatusTopologyRow[] }

/** One active source as the onboarding preflight reads it. */
export interface OnboardingSourceRow { id: string; local_path: string | null; incarnation: string; kind: string | null }

/** One effect that keeps the brain from quiescing. */
export interface BlockingEffectRow {
  effect_id: string; kind: string; state: string; recovering: boolean; source_id: string; slug: string; request_id: string;
  attempts: number | string; next_attempt_at: Time | null;
}
