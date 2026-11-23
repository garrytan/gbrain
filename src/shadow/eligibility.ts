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
import { OBSERVATION_REFRESH_MS, readWriterEvidence } from './writer-observations.ts';
import { primaryTakesWriterHooks, WRITER_EVIDENCE_TABLES, WRITER_HOOK_TRIGGER } from './writer-hooks.ts';
import { planAsWrittenSource, type WriterCoverageSource } from './writer-coverage.ts';

export const ELIGIBILITY_WINDOW_MS = 7 * 86_400_000;

export interface EligibilityFields {
  writer_hosts_7d?: number;
  unknown_writer_paths?: number;
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
}

/** The window start: the later of the shadow start and now minus 7 days, minus the refresh slack. */
export function eligibilityWindowStart(state: ShadowState | null, now: Date): Date {
  const started = state?.started_at ? Date.parse(state.started_at) : Number.NaN;
  const base = Math.max(now.getTime() - ELIGIBILITY_WINDOW_MS, Number.isFinite(started) ? started : Number.NEGATIVE_INFINITY);
  return new Date(base - OBSERVATION_REFRESH_MS);
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
  let ev;
  try {
    ev = await readWriterEvidence(input.engine, since, primaryTakesWriterHooks(input.state?.primary_engine), WRITER_HOOK_TRIGGER, WRITER_EVIDENCE_TABLES);
  } catch (error) {
    return { eligibility: fields, eligibility_evidence: { state: 'read_failed', code: errorCode(error) } };
  }
  const source = input.source ?? planAsWrittenSource(input.dir);
  const unknown = ev.unresolved + ev.gaps + ev.unhooked + ev.uncovered_roles + source.unknownPaths(since);
  return { eligibility: { writer_hosts_7d: ev.hosts, unknown_writer_paths: unknown, ...fields } };
}
