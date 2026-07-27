/**
 * Mode-switch UX (v0.40.3.0 — D3)
 *
 * When the user runs `gbrain config set search.mode <X>`, this module
 * surfaces a banner explaining the consequences and offers follow-up
 * actions.
 *
 * Three concerns separated:
 *
 *   1. summarizeTransition(old, new) — PURE function that classifies the
 *      transition (no_change / narrowing / broadening / tokenmax_opt_in)
 *      and returns banner lines, reindex requirement, and cost estimate.
 *
 *   2. probeWorkerAvailable(engine) — checks Minion worker heartbeat
 *      (mirrors `gbrain doctor`'s queue_health check). Returns active /
 *      stale / never_seen with a paste-ready start command.
 *
 *   3. runModeSwitchUx(opts) — the orchestrator. Calls summarizeTransition,
 *      prints the banner, and for tokenmax_opt_in + TTY: prompts to run
 *      reindex, calls probeWorkerAvailable, and either submits the
 *      reindex job or prints the loud-fail "start a worker first" hint
 *      per D3.
 *
 * Suppression: GBRAIN_NO_MODE_SWITCH_UX=1 skips the entire UX for
 * scripted operators (CI fixtures, automation). Non-TTY also skips
 * interactive prompts; prints paste-ready hints to stderr.
 *
 * The reindex idempotency key is content-stable per codex D12 Bug 1:
 *   cr-backfill:<source_id>:<chunker_version>:<corpus_generation_or_mode>
 * NOT timestamp-based. Two retries against the same brain state dedupe
 * via the Minion idempotency_key contract (v0.13.1).
 */

import type { BrainEngine } from '../engine.ts';
import { readLineSafe } from '../../commands/init.ts';
import { MinionQueue } from '../minions/queue.ts';
import { isSearchMode, type SearchMode } from './mode.ts';

export type TransitionKind =
  | 'no_change'
  | 'narrowing'
  | 'broadening'
  | 'tokenmax_opt_in'
  | 'invalid_new_mode';

export interface TransitionSummary {
  kind: TransitionKind;
  reindex_required: boolean;
  reindex_command?: string;
  cost_estimate_per_query_cents?: number;
  callout_lines: string[];
}

export type WorkerStatus = 'active' | 'stale' | 'never_seen';

export interface WorkerProbeResult {
  status: WorkerStatus;
  last_heartbeat_iso?: string;
  paste_ready_start_command: string;
}

export interface ModeSwitchOpts {
  oldMode: SearchMode | null;
  newMode: string;
  engine: BrainEngine;
  isTty: boolean;
  yesFlag?: boolean;
  /** Test seam: injectable worker probe. */
  probeFn?: (engine: BrainEngine) => Promise<WorkerProbeResult>;
  /** Test seam: injectable Minion submitter (avoids real queue in unit tests). */
  submitFn?: (jobName: string, params: Record<string, unknown>, idempotencyKey: string) => Promise<number>;
}

/**
 * Worker stale threshold: 2 minutes (matches gbrain doctor's
 * queue_health check semantics for "alive Minion worker").
 */
export const WORKER_STALE_THRESHOLD_MS = 120_000;

/**
 * Classify the transition + build banner content. Pure: no engine, no
 * file I/O. Test surface for the 5-cell decision matrix below.
 *
 * Decision matrix:
 *   | old → new                | kind                | reindex |
 *   |--------------------------|---------------------|---------|
 *   | any → tokenmax           | tokenmax_opt_in     | yes     |
 *   | balanced → conservative  | narrowing           | no      |
 *   | conservative → balanced  | broadening          | no      |
 *   | any → balanced (else)    | broadening          | no      |
 *   | same → same              | no_change           | no      |
 *   | any → INVALID            | invalid_new_mode    | no      |
 */
export function summarizeTransition(
  oldMode: SearchMode | null,
  newMode: string,
): TransitionSummary {
  if (!isSearchMode(newMode)) {
    return {
      kind: 'invalid_new_mode',
      reindex_required: false,
      callout_lines: [
        `Invalid search.mode value: "${newMode}".`,
        `Valid options: conservative | balanced | tokenmax`,
      ],
    };
  }

  if (oldMode === newMode) {
    return {
      kind: 'no_change',
      reindex_required: false,
      callout_lines: [],
    };
  }

  // tokenmax opt-in wins regardless of old mode. Triggers reindex prompt
  // because per-chunk Haiku synopsis backfill is needed for full quality.
  if (newMode === 'tokenmax') {
    return {
      kind: 'tokenmax_opt_in',
      reindex_required: true,
      reindex_command: 'gbrain reindex --markdown',
      cost_estimate_per_query_cents: 0.03, // ~$0.0003 per typical search
      callout_lines: [
        `Switched to tokenmax. Per-chunk Haiku synopsis enabled.`,
        `Backfill cost (one-time): ~$1-5 per 10K pages via Anthropic Haiku.`,
        `Per-query overhead: ~$0.0003 (reranker + slightly larger payload).`,
        `Run \`gbrain reindex --markdown\` to backfill existing pages.`,
      ],
    };
  }

  // Narrowing: dropping a feature (e.g. balanced → conservative drops
  // reranker + expansion). Cache will refill within TTL; no backfill.
  if (oldMode && narrowness(newMode) < narrowness(oldMode)) {
    return {
      kind: 'narrowing',
      reindex_required: false,
      callout_lines: [
        `Switched to ${newMode}. Some features dropped from prior mode.`,
        `Cache refills within TTL (default 1h). No backfill required.`,
      ],
    };
  }

  // Default: broadening or first-time set to balanced.
  return {
    kind: 'broadening',
    reindex_required: false,
    callout_lines: [
      `Switched to ${newMode}.`,
      oldMode
        ? `Existing wrapped embeddings (if any) continue serving queries.`
        : `First-time mode set. Cache will populate as queries run.`,
    ],
  };
}

// Cheap ordering for narrowing detection. Higher = more features enabled.
function narrowness(mode: SearchMode): number {
  switch (mode) {
    case 'conservative':
      return 1;
    case 'balanced':
      return 2;
    case 'tokenmax':
      return 3;
  }
}

/**
 * Probe Minion worker heartbeat. Mirrors the queue_health doctor check
 * semantics: a worker that pushed a heartbeat within
 * WORKER_STALE_THRESHOLD_MS is considered active.
 *
 * Best-effort: any error returns `never_seen` so the caller can decide
 * what to do. The paste-ready start command is always populated so the
 * banner can offer a recovery path.
 *
 * The PGLite inline path (`gbrain agent run` with `--follow`) doesn't
 * require a worker; this probe is for the production "spawn a real
 * Minion worker" path.
 */
export async function probeWorkerAvailable(engine: BrainEngine): Promise<WorkerProbeResult> {
  const startCmd = 'gbrain jobs work';
  try {
    // gbrain doesn't have a minion_workers heartbeat table yet (B7 follow-up
    // from v0.19.1 — see CLAUDE.md). Use a proxy: any minion_jobs row
    // started or finished within WORKER_STALE_THRESHOLD_MS means a worker
    // is doing real work. If only OLDER activity exists, treat as stale
    // (worker likely died). If no activity at all, never_seen.
    const rows = await engine.executeRaw<{ ts: string | null }>(
      `SELECT MAX(GREATEST(
                COALESCE(started_at, '-infinity'::timestamptz),
                COALESCE(finished_at, '-infinity'::timestamptz)
              ))::text AS ts
         FROM minion_jobs
        WHERE COALESCE(started_at, finished_at) > now() - INTERVAL '10 minutes'`,
    );
    const ts = rows[0]?.ts;
    if (!ts) {
      return { status: 'never_seen', paste_ready_start_command: startCmd };
    }
    const ageMs = Date.now() - new Date(ts).getTime();
    if (ageMs <= WORKER_STALE_THRESHOLD_MS) {
      return {
        status: 'active',
        last_heartbeat_iso: ts,
        paste_ready_start_command: startCmd,
      };
    }
    return {
      status: 'stale',
      last_heartbeat_iso: ts,
      paste_ready_start_command: startCmd,
    };
  } catch {
    // Table may not exist on a fresh brain. Treat as never_seen.
    return { status: 'never_seen', paste_ready_start_command: startCmd };
  }
}

/**
 * Build the content-stable idempotency key for the reindex submission
 * per codex D12 Bug 1. NOT timestamp-based — two retries against the
 * same brain state must produce the SAME key so the Minion dedupes.
 */
export function buildReindexIdempotencyKey(
  sourceId: string,
  chunkerVersion: number,
  modeOrCorpusGen: string,
): string {
  return `cr-backfill:${sourceId}:${chunkerVersion}:${modeOrCorpusGen}`;
}

/**
 * Orchestrator. Called by `gbrain config set search.mode <X>` after the
 * config write lands. Honors GBRAIN_NO_MODE_SWITCH_UX=1 (full skip),
 * non-TTY (skip prompt, print paste-ready hints), --yes (auto-submit
 * reindex on tokenmax_opt_in transitions).
 *
 * Idempotent: invoking with the same (old, new) twice is harmless; the
 * Minion idempotency_key ensures the reindex doesn't submit twice.
 */
export async function runModeSwitchUx(opts: ModeSwitchOpts): Promise<void> {
  if (process.env.GBRAIN_NO_MODE_SWITCH_UX === '1') return;
  if (!isSearchMode(opts.newMode)) {
    // The runConfig caller should have validated. Defense-in-depth:
    // print the invalid banner anyway.
    const summary = summarizeTransition(opts.oldMode, opts.newMode);
    for (const line of summary.callout_lines) console.error(`[mode-switch] ${line}`);
    return;
  }

  const summary = summarizeTransition(opts.oldMode, opts.newMode);
  if (summary.kind === 'no_change') return; // Quiet no-op.

  // Print banner regardless of TTY/non-TTY.
  console.error(`[mode-switch] ${summary.callout_lines[0]}`);
  for (let i = 1; i < summary.callout_lines.length; i++) {
    console.error(`[mode-switch]   ${summary.callout_lines[i]}`);
  }

  if (!summary.reindex_required) return;

  // Reindex offered only for tokenmax_opt_in (today). Honor --yes /
  // non-TTY by NOT prompting; just print the paste-ready command.
  if (!opts.isTty || opts.yesFlag) {
    console.error(`[mode-switch] To backfill now: ${summary.reindex_command}`);
    return;
  }

  // TTY + interactive: prompt.
  const answer = await readLineSafe(
    `Run '${summary.reindex_command}' now? [y/N]: `,
    'n',
    60_000,
  );
  if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
    console.error(`[mode-switch] Skipped. Run \`${summary.reindex_command}\` when ready.`);
    return;
  }

  // User opted in. Probe worker availability before submitting.
  const probeFn = opts.probeFn ?? probeWorkerAvailable;
  const worker = await probeFn(opts.engine);

  if (worker.status !== 'active') {
    // Loud-fail per D3 to avoid the silent-stall footgun. Caller can
    // still invoke reindex inline (`gbrain reindex --markdown` runs
    // synchronously without a worker on the PGLite inline path).
    console.error(`[mode-switch] No active worker (${worker.status}).`);
    console.error(`[mode-switch] Either run inline: ${summary.reindex_command}`);
    console.error(`[mode-switch] Or start a worker first: ${worker.paste_ready_start_command}`);
    return;
  }

  // Submit via Minion queue with content-stable idempotency key.
  const sourceId = await resolveDefaultSourceId(opts.engine);
  const chunkerVersion = await resolveChunkerVersion(opts.engine);
  const idempotencyKey = buildReindexIdempotencyKey(sourceId, chunkerVersion, opts.newMode);

  const submitFn = opts.submitFn ?? defaultSubmit;
  try {
    const jobId = await submitFn(
      'reindex',
      { markdown: true, source_id: sourceId },
      idempotencyKey,
    );
    console.error(`[mode-switch] Submitted as job ${jobId}. Watch with: gbrain jobs follow ${jobId}`);
  } catch (err) {
    console.error(`[mode-switch] Submit failed: ${(err as Error).message}`);
    console.error(`[mode-switch] Run inline: ${summary.reindex_command}`);
  }

  async function defaultSubmit(
    jobName: string,
    params: Record<string, unknown>,
    idemKey: string,
  ): Promise<number> {
    const queue = new MinionQueue(opts.engine);
    const job = await queue.add(
      jobName,
      params,
      { idempotency_key: idemKey },
      { allowProtectedSubmit: true },
    );
    return job.id;
  }
}

async function resolveDefaultSourceId(engine: BrainEngine): Promise<string> {
  try {
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE id = 'default' LIMIT 1`,
    );
    return rows[0]?.id ?? 'default';
  } catch {
    return 'default';
  }
}

async function resolveChunkerVersion(engine: BrainEngine): Promise<number> {
  try {
    const rows = await engine.executeRaw<{ v: string | null }>(
      `SELECT value AS v FROM config WHERE key = 'chunker_version'`,
    );
    const v = Number(rows[0]?.v ?? 0);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}
