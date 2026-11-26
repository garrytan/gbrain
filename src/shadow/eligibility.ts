/**
 * The `eligibility` fields of the shadow status document (readiness criterion 11; docs/designs/RUST_ENGINE.md "Swap
 * readiness" item 11 and "Swap and the way back").
 *
 *   writer_hosts_7d       distinct host ids in engine_writer_observations seen in the window (one read-only SELECT)
 *   unknown_writer_paths  evidence of a write no process accounts for: on a hooked (Postgres) primary, writing
 *                         connections no process claimed, trigger gap rows, brain tables with no hook and roles that
 *                         cannot record evidence (writer-hooks.ts), plus the file-side source (writer-coverage.ts)
 *   team_brain            the configured brain is a mounted brain, not the personal `host` brain
 *   preview_target        this machine's addon target is one a release ships (linux-x64-glibc, darwin-arm64)
 *
 * The window starts at the later of the shadow's start and now minus 7 days, minus the observation refresh interval, so
 * a writer's last throttled write never ages out early. With no engine passed in, or a SELECT that throws, the two
 * writer fields are left out (readiness reads them as missing, never a pass); after a failed SELECT,
 * `eligibility_evidence` names the failure by its code only. `gbrain engine shadow status` never passes an engine, so it never opens the database.
 */
import type { BrainEngine } from '../core/engine.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { HOST_BRAIN_ID } from '../core/brain-registry.ts';
import { detectAddonTarget } from '../core/rust-engine/addon-target.ts';
import { RELEASE_ADDON_TARGETS } from '../core/rust-engine/addon-manifest.ts';
import type { ShadowState } from './state.ts';
import { readEpoch } from './evidence-epoch.ts';
import { OBSERVATION_REFRESH_MS, readWriterEvidence } from './writer-observations.ts';
import { primaryTakesWriterHooks, WRITER_EVIDENCE_TABLES, WRITER_HOOK_TRIGGER } from './writer-hooks.ts';
import { planAsWrittenSource, type WriterCoverageSource } from './writer-coverage.ts';

export const ELIGIBILITY_WINDOW_MS = 7 * 86_400_000;

export interface EligibilityFields {
  writer_hosts_7d?: number;
  unknown_writer_paths?: number;
  /** Observed writers in this evidence epoch (less the refresh slack) with no `write_protocol` or one below this build's: counted in `unknown_writer_paths`, named here. */
  legacy_write_writers?: number;
  team_brain: boolean;
  preview_target: boolean;
}

export interface EligibilityEvidence { state: 'read_failed'; code: string }

export interface EligibilityStatus {
  eligibility: EligibilityFields;
  /** Present only after a failed SELECT: the error code, never its message or SQL. */
  eligibility_evidence?: EligibilityEvidence;
}

export interface EligibilityInput {
  dir: string;
  state: ShadowState | null;
  /** The primary the caller already holds open (the swap). Absent: the writer fields are left out. */
  engine?: BrainEngine;
  now?: Date;
  /** Seams for tests. */
  source?: WriterCoverageSource;
  brainId?: () => string;
  addonTarget?: () => string | null;
  /** The status document passes true: with an engine in hand, a missing or unreadable state file counts as an unknown path. */
  stateRequired?: boolean;
}

/** The window start: the later of the shadow start and now minus 7 days, minus the refresh slack. */
export function eligibilityWindowStart(state: ShadowState | null, now: Date): Date {
  const since = state?.writer_evidence_since ?? state?.started_at;
  const started = since ? Date.parse(since) : Number.NaN;
  const base = Math.max(now.getTime() - ELIGIBILITY_WINDOW_MS, Number.isFinite(started) ? started : Number.NEGATIVE_INFINITY);
  return new Date(base - OBSERVATION_REFRESH_MS);
}

/**
 * Criterion 11 fails closed on what it cannot prove: shadow mode being off, a `stop`, or a `start` that continued an existing
 * epoch each leave a stretch where hooks may not have recorded a writer, and a gap row alone cannot prove otherwise (it can ride
 * out of the window, or fail to insert under a lock). So each counts as one unknown writer path while it is inside the window,
 * and a stopped state counts for as long as it is stopped. A time that cannot be read counts. A file-based rule: no database.
 */
export function coverageBreaks(state: ShadowState | null, since: Date): number {
  if (!state) return 0;
  let n = state.enabled === true ? 0 : 1; // off, or not provably on (a missing or mistyped field)
  for (const t of [state.writer_coverage_restarted_at, state.writer_coverage_stopped_at]) {
    if (t === undefined) continue;
    const ms = Date.parse(t);
    if (!Number.isFinite(ms) || ms >= since.getTime()) { n++; break; }
  }
  return n;
}

export function isPreviewTarget(target: string | null): boolean {
  return target !== null && RELEASE_ADDON_TARGETS.includes(target);
}

function isTeamBrain(brainId: () => string): boolean {
  try { return brainId() !== HOST_BRAIN_ID; } catch { return true; } // an unresolvable brain is never called personal
}

function errorCode(error: unknown): string {
  const rec = (error && typeof error === 'object' ? error : {}) as { code?: unknown };
  return typeof rec.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(rec.code) ? rec.code : 'unknown';
}

export async function buildEligibilityStatus(input: EligibilityInput): Promise<EligibilityStatus> {
  const now = input.now ?? new Date();
  const fields: EligibilityFields = {
    team_brain: isTeamBrain(input.brainId ?? (() => resolveBrainId(getCliOptions().brain))),
    preview_target: isPreviewTarget((input.addonTarget ?? (() => detectAddonTarget()))()),
  };
  if (!input.engine) return { eligibility: fields };
  const since = eligibilityWindowStart(input.state, now);
  // The open engine decides whether hooks must exist, never the state file alone: a state that names no primary engine (or an
  // unreadable one) or names another kind than the engine in hand is not proof of anything, so it counts as an unknown path.
  const hooksExpected = input.engine.capabilities?.has('postgres_admin') === true; // the server database: hooks and role rights exist only there
  const stateKind = input.state?.primary_engine as unknown;
  const stateDisagrees = input.state ? !(typeof stateKind === 'string' && (stateKind === 'pglite' || stateKind === 'postgres') && stateKind === input.engine.kind) : false;
  // No readable state is no proof of an enabled shadow: the status document asks for one, and a missing one counts.
  const stateMissing = input.stateRequired === true && !input.state;
  let ev;
  try {
    // A writer of an older build (no write_protocol, or a lower one) seen since this evidence epoch began may have lost write samples nothing can prove were recorded: it counts from the epoch start (less the refresh slack), or the window start when there is no epoch.
    const epochStart = Date.parse(readEpoch(input.dir)?.started_at ?? '');
    const legacySince = Number.isFinite(epochStart) ? new Date(Math.max(since.getTime(), epochStart - OBSERVATION_REFRESH_MS)) : since;
    ev = await readWriterEvidence(input.engine, since, hooksExpected, WRITER_HOOK_TRIGGER, WRITER_EVIDENCE_TABLES, legacySince);
  } catch (error) {
    return { eligibility: fields, eligibility_evidence: { state: 'read_failed', code: errorCode(error) } };
  }
  const source = input.source ?? planAsWrittenSource(input.dir);
  const unknown = ev.legacy_write_writers + ev.unresolved + ev.gaps + ev.unhooked + ev.uncovered_roles + source.unknownPaths(since) + coverageBreaks(input.state, since) + (stateDisagrees ? 1 : 0) + (stateMissing ? 1 : 0);
  return { eligibility: { writer_hosts_7d: ev.hosts, unknown_writer_paths: unknown, legacy_write_writers: ev.legacy_write_writers, ...fields } };
}
