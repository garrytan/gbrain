import { maintenancePreflight, stampMaintenancePage, verifyMaintenanceOutputs, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { digest } from '../persistence/digest.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
/**
 * Patterns phase (v0.23) — cross-session theme detection.
 *
 * Reads recent reflections (within `lookback_days`), runs a single Sonnet
 * subagent to surface themes that recur across ≥`min_evidence` distinct
 * reflections, and writes one pattern page per theme.
 *
 * MUST run after `extract` so the graph state (links, timeline) is fresh.
 * Subagent put_page calls have ctx.remote=true; the trusted-workspace
 * allow-list re-enables auto-link / auto-timeline for synth + pattern
 * writes (operations.ts:trustedWorkspace branch).
 *
 * v1 behavior:
 *   - Single Sonnet subagent (no fan-out — one job per cycle is plenty).
 *   - Idempotent: if reflection set is below `min_evidence`, phase is skipped.
 *   - Pattern slug uses LLM's chosen topic-slug (subagent prompt instructs format).
 *   - Existing pattern pages are updated in place via put_page (idempotent
 *     ON CONFLICT semantics in importFromContent).
 */

import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult, PhaseError } from '../cycle.ts';
import { DEFAULT_PRIVATE_QUEUE_LEASE_MS, MinionQueue } from '../minions/queue.ts';
import { isQueueQuotaExceededError } from '../minions/admission.ts';
import { waitForCompletionRenewing, TimeoutError } from '../minions/wait-for-completion.ts';
import type { MinionJobInput, MinionJobStatus, SubagentHandlerData } from '../minions/types.ts';
import { serializeMarkdown } from '../markdown.ts';
import { truncateUtf8 } from '../text-safe.ts';
import type { Page, PageType } from '../types.ts';
// #2415: allow-list + output-root resolution shared with the synthesize
// phase — both phases must agree on the configured namespace.
// runSubagentsInline is shared too: a job submitted via queue.add() sits in
// 'waiting' forever unless something drives the claim -> run -> complete
// loop — on PGLite because no separate worker can open the embedded
// data-dir, on Postgres because the parent phase itself occupies a worker
// slot and can deadlock a fully-occupied worker (#2050). synthesize.ts
// drains its own children the same way.
import { loadAllowedSlugPrefixes, loadOutputRoot, runSubagentsInline } from './synthesize.ts';
import { stampDreamProvenance } from './dream-provenance.ts';
import { probeChatModel } from '../ai/gateway.ts';
import { normalizeModelId } from '../model-id.ts';
import { throwIfAborted } from '../abort-check.ts';
import { resolveCycleDate } from './cycle-date.ts';
import { clearPatternsSourceDeaths, patternsBreakerSkip } from './dream-breaker.ts';
import { dedupePatternClaimSources, withClaimSources } from './pattern-claim-sources.ts';
import { publishOrHold } from '../persistence/accepted-pending.ts';

export interface PatternsPhaseOpts {
  brainDir: string;
  dryRun: boolean;
  /** C-15: the cycle's calendar date (runCycle resolves one per cycle). */
  cycleDate?: string;
  /** #4077: cooperative cancellation from the enclosing cycle/minion job. A
   *  cancelled cycle must stop the inline child and every derived-state
   *  write instead of running out the force-evict grace. Mirrors
   *  synthesize.ts's `signal`. */
  signal?: AbortSignal;
  yieldDuringPhase?: () => Promise<void>;
  /**
   * issue #2860 — `gbrain dream --phase patterns --once`. Bypasses the
   * `dream.patterns.enabled` gate AND the #4879 no-new-evidence gate for
   * THIS call only; never reads or writes the `.enabled` key. A completed
   * forced run still stamps `dream.patterns.last_evidence_ts` so the next
   * autopilot tick doesn't re-pay for evidence the operator just consumed.
   */
  once?: boolean;
  /**
   * Absolute deadline (epoch ms) of the enclosing minion job, or null for
   * direct callers (`gbrain dream`). When set, the subagent's job timeout
   * and the wait timeout are clamped so the phase finishes (or times out)
   * BEFORE the parent job's budget expires — a fixed 30/35-min default
   * inside an interval-derived cycle budget dead-letters the whole cycle
   * mid-phase and starves every tail phase (#2781).
   */
  deadlineAtMs?: number | null;
  /**
   * #1586: the cycle's resolved source. Stamped onto every subagent child as
   * `source_id` so put_page writes land in this source's rows, and passed to
   * reverseWriteRefs so getPage/getTags read the correct (source_id, slug)
   * row. Unset → legacy 'default'. Mirrors synthesize.ts's `sourceId`.
   */
  sourceId?: string;
  /** Internal: minion owner job id for private dream-inline queue recovery. */
  privateQueueOwnerJobId?: number | null;
}

/**
 * Stop-margin reserved under the parent deadline when clamping subagent
 * budgets. NOT a promise that tail phases complete — the cycle is allowed
 * to go partial and resume next tick. This only guarantees the phase's
 * wait returns and the handler unwinds cleanly before the worker's abort
 * fires: wait poll interval (5s) + worker force-evict grace (30s) + lock
 * and DB cleanup headroom.
 *
 * gbrain#4168: the canonical definition moved to base-phase.ts (one home for
 * every phase); re-exported here so existing imports (tests included) keep
 * working.
 */
import { CYCLE_DEADLINE_RESERVE_MS } from './base-phase.ts';
import { recordPatternsLastRun, sizePatternsRun } from './patterns-plan.ts';
export { CYCLE_DEADLINE_RESERVE_MS };

/**
 * Smallest remaining budget worth submitting a subagent for. Below this,
 * the LLM call is near-certain to be killed mid-flight — wasted spend and
 * a guaranteed-timeout child — so the phase skips honestly instead
 * (`insufficient_cycle_budget`) and the next cycle retries with a fresh
 * budget.
 */
export const MIN_PATTERNS_SUBAGENT_BUDGET_MS = 2 * 60 * 1000;

/**
 * Clamp the configured subagent budgets to the remaining parent-job time.
 * Both timeouts derive from the SAME absolute child deadline
 * (`deadlineAtMs - reserve`) so the child job's kill switch and our wait
 * agree. Returns null when the remaining budget is below the minimum —
 * caller should skip the phase without submitting.
 */
export function clampSubagentBudgets(
  config: { subagentTimeoutMs: number; subagentWaitTimeoutMs: number },
  deadlineAtMs: number | null | undefined,
  nowMs: number,
): { timeoutMs: number; waitTimeoutMs: number } | null {
  if (deadlineAtMs == null) {
    return { timeoutMs: config.subagentTimeoutMs, waitTimeoutMs: config.subagentWaitTimeoutMs };
  }
  const childBudgetMs = deadlineAtMs - CYCLE_DEADLINE_RESERVE_MS - nowMs;
  if (childBudgetMs < MIN_PATTERNS_SUBAGENT_BUDGET_MS) return null;
  return {
    timeoutMs: Math.min(config.subagentTimeoutMs, childBudgetMs),
    waitTimeoutMs: Math.min(config.subagentWaitTimeoutMs, childBudgetMs),
  };
}

export async function runPhasePatterns(
  engine: BrainEngine,
  opts: PatternsPhaseOpts,
): Promise<PhaseResult> {
  const start = Date.now();
  let ownedPrivateQueue: { queue: MinionQueue; name: string } | null = null;
  try {
    throwIfAborted(opts.signal, '[dream] patterns');
    const config = await loadPatternsConfig(engine);

    if (!config.enabled) {
      if (!opts.once) {
        return skipped('disabled', 'dream.patterns.enabled is false');
      }
      process.stderr.write(
        '[dream] --once: dream.patterns.enabled is false but ' +
        '--phase patterns --once forces this run (config untouched)\n',
      );
    }

    const [source] = await managedPersistenceEnabled(engine)
      ? await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [opts.sourceId ?? 'default']) : [];
    const evidenceKey = source ? `${LAST_EVIDENCE_KEY}.${opts.sourceId ?? 'default'}.${source.incarnation}` : LAST_EVIDENCE_KEY;

    // Gather reflections within lookback window.
    const reflections = await gatherReflections(engine, config.lookbackDays, config.sourceSlugPrefix, opts.sourceId ?? 'default');
    if (reflections.length < config.minEvidence) {
      return skipped(
        'insufficient_evidence',
        `${reflections.length} reflections in last ${config.lookbackDays}d (need ≥${config.minEvidence})`,
      );
    }

    // #4879: evidence watermark. Autopilot re-dispatches this phase every
    // global tick (~60 min); without a consumed-marker it re-paid a Sonnet
    // run on the same unchanged reflections and minted near-duplicate pattern
    // pages. Skip when no reflection is newer than the evidence the last
    // COMPLETED run consumed (rows are ORDER BY updated_at DESC, so [0] is
    // the high-water mark). Absent/unparseable stamp fails open, same as
    // synthesize's checkCooldown; `--once` forces past it.
    const newestEvidenceMs = reflections[0].updatedAt.getTime();
    if (!opts.once) {
      const stampMs = Date.parse((await engine.getConfig(evidenceKey)) ?? '');
      if (Number.isFinite(stampMs) && newestEvidenceMs <= stampMs) {
        return skipped(
          'no_new_evidence',
          `${reflections.length} reflections in window, none newer than last completed run ` +
          `(${new Date(stampMs).toISOString()}); pass --once to force`,
        );
      }
    }

    if (opts.dryRun) {
      return ok(`dry-run: would detect patterns over ${reflections.length} reflections`, {
        reflections_considered: reflections.length,
        patterns_written: 0,
        dryRun: true,
      });
    }

    // Submit one subagent for pattern detection. The subagent dispatches via
    // the gateway model-tier resolver, so gate on "is the resolved model's
    // provider reachable" rather than ANTHROPIC_API_KEY specifically — a
    // hardcoded env gate misclassified non-Anthropic stacks (litellm,
    // deepseek, openrouter, ...) as "no upstream" even though the subagent
    // routes them through the gateway (agent.use_gateway_loop), and it missed
    // Anthropic keys set via `gbrain config set anthropic_api_key`. Same
    // probe semantics as think/index.ts + synthesize's makeJudgeClient:
    // unknown provider/model or Anthropic-without-key skips cheaply; other
    // providers' auth is checked lazily at dispatch and surfaces in the job
    // outcome. (Takeover of PR #2279's intent by @brettdavies.)
    const maintenance = await maintenancePreflight(engine, opts.sourceId ?? 'default', opts.brainDir);
    const probe = probeChatModel(normalizeModelId(config.model));
    if (!probe.ok) {
      return skipped('no_provider', `pattern detection skipped: ${probe.detail}`);
    }

    const allowedSlugPrefixes = await loadAllowedSlugPrefixes(config.outputRoot, engine);
    if (allowedSlugPrefixes.length === 0) {
      return failed(makeError('InternalError', 'NO_ALLOWLIST',
        'skills/_brain-filing-rules.json missing dream_synthesize_paths.globs'));
    }
    // A configured dream.patterns.output_slug_prefix diverging from the
    // default `${outputRoot}/personal/patterns` composition (e.g. a flat
    // schema with no personal/ nesting) is not covered by the filing-rules
    // globs above, which only remap the `wiki/personal/patterns/*` literal
    // by outputRoot. Add it explicitly so the subagent's put_page allow-list
    // actually grants write access to wherever it's configured to write.
    const outputGlob = `${config.outputSlugPrefix}/*`;
    if (!allowedSlugPrefixes.includes(outputGlob)) {
      allowedSlugPrefixes.push(outputGlob);
    }

    // #2781: budget the subagent from the REMAINING parent-job time, not
    // the fixed config default. Checked after the cheap gates (disabled /
    // insufficient_evidence / no_provider) so a skip for budget reasons
    // only fires when the phase would otherwise have submitted.
    const budgets = clampSubagentBudgets(config, opts.deadlineAtMs, Date.now());
    if (budgets === null) {
      return skipped(
        'insufficient_cycle_budget',
        `remaining cycle budget under ${Math.round(MIN_PATTERNS_SUBAGENT_BUDGET_MS / 1000)}s ` +
        `(reserve ${Math.round(CYCLE_DEADLINE_RESERVE_MS / 1000)}s); next cycle retries with a fresh budget`,
      );
    }

    // #6177: size an in-cycle run from the recorded cost of recent runs; a run that cannot fit is skipped before any spend.
    const sized = await sizePatternsRun(engine, { budgetMs: opts.deadlineAtMs == null ? null : budgets.timeoutMs, reflections: reflections.length, minEvidence: config.minEvidence });
    if (sized.kind === 'skip') return sized.result;
    const { plan } = sized, selected = reflections.length, submitted = reflections.slice(0, plan.n);

    const queue = new MinionQueue(engine);
    // #2050: children drain inline on BOTH engines (see runSubagentsInline),
    // so give this job a private per-run queue: the inline drain must never
    // claim unrelated 'default'-queue jobs, and a 'default'-queue worker must
    // never claim a child this parent is about to run itself. Mirrors
    // synthesize.ts's childQueueName derivation exactly.
    const childQueueName = `dream-inline-${Date.now()}-${randomUUID().slice(0, 8)}`;
    ownedPrivateQueue = { queue, name: childQueueName };
    const privateQueueOwnerToken = randomUUID();
    // Same lease posture as synthesize: rolling 10-min default lease renewed
    // every ≤30s (drain loop + chunked post-drain wait); the whole wrapper is
    // 30s-throttled so idle polls cost one UPDATE per half-minute.
    const renewPrivateQueueLease = queue.makeThrottledLeaseRenewer(
      childQueueName, privateQueueOwnerToken, opts.yieldDuringPhase,
    );
    const cycleDate = opts.cycleDate ?? await resolveCycleDate(engine);
    const data: SubagentHandlerData = {
      prompt: buildPatternsPrompt(submitted, config.minEvidence, config.sourceSlugPrefix, config.outputSlugPrefix, cycleDate),
      model: config.model,
      max_turns: 30,
      // #4217/CDX-12: a patterns child whose every put_page failed must
      // dead-letter (its whole purpose is writing pattern pages), not report
      // completed with zero pages. #5540: a clean finish that examined the
      // evidence and named nothing completes, so the #4879 watermark stamps
      // instead of re-billing the same reflections every run. Older workers
      // ignore the opt-in and keep the strict behavior.
      require_writes: true,
      allow_clean_zero_writes: true,
      allowed_slug_prefixes: allowedSlugPrefixes,
      // #1586: scope every child tool call to the cycle's resolved source so
      // put_page writes land there instead of the hardcoded 'default'.
      ...(opts.sourceId ? { source_id: opts.sourceId } : {}),
    };
    const submitOpts: Partial<MinionJobInput> = {
      ...(maintenance ? { idempotency_key: `dream:patterns:${digest({ source: maintenance.writer.sourceIncarnation,
        authority: maintenance.writer, reflections: withoutSeats(submitted), model: config.model, output: config.outputSlugPrefix })}` } : {}),
      max_stalled: 3,
      timeout_ms: budgets.timeoutMs,
      queue: childQueueName,
      private_queue_owner_job_id: opts.privateQueueOwnerJobId ?? null,
      private_queue_owner_token: privateQueueOwnerToken,
      private_queue_lease_ms: DEFAULT_PRIVATE_QUEUE_LEASE_MS,
    };
    // Paid-loop breaker (#6236): deaths count per source, whatever reflections each run read; only maintenance runs carry a key.
    const breakerSkip = submitOpts.idempotency_key ? await patternsBreakerSkip(engine, opts.sourceId ?? 'default') : null;
    if (breakerSkip) return breakerSkip;
    // #6236: the child reads existing pattern pages, so their claim sources are de-duplicated first; never pay while a rewrite is held.
    const claimHeld = await dedupePatternsBeforeChild(engine, maintenance, config.outputSlugPrefix, opts.sourceId ?? 'default', opts.signal);
    if (claimHeld) return claimHeld;
    let job: Awaited<ReturnType<typeof queue.add>>;
    const submittedAt = Date.now();
    try {
      job = await queue.add('subagent', data as unknown as Record<string, unknown>, submitOpts, {
        allowProtectedSubmit: true,
      });
    } catch (e) {
      // Admission quota (minions.quota_max_waiting.subagent, config-only): a
      // rejected submit is a recorded phase SKIP, never a phase crash — the
      // next cycle retries once the backlog drains.
      if (isQueueQuotaExceededError(e)) {
        return skipped('admission_quota', e.message);
      }
      throw e;
    }
    // #4077: cancelled between submit and drain — unwind now; the finally's
    // reconcilePrivateQueue cancels the just-submitted child.
    throwIfAborted(opts.signal, '[dream] patterns subagent');

    // Drain this phase's private child queue inline so the parent observes
    // the terminal state instead of polling waitForCompletion until
    // subagentWaitTimeoutMs expires. Runs on BOTH engines — on Postgres the
    // parent job otherwise deadlocks a fully-occupied worker (#2050).
    await runSubagentsInline(
      engine, queue, childQueueName, renewPrivateQueueLease,
      undefined, undefined, 1, null, opts.signal ?? null,
    );

    let outcome: MinionJobStatus | 'timeout';
    try {
      const final = await waitForCompletionRenewing(queue, job.id, {
        timeoutMs: budgets.waitTimeoutMs,
        pollMs: 5 * 1000,
        renew: renewPrivateQueueLease,
        signal: opts.signal,
      });
      // #4077: on abort the wait returns its last snapshot instead of
      // throwing — unwind before treating it as an outcome.
      throwIfAborted(opts.signal, '[dream] patterns completion wait');
      outcome = final.status;
    } catch (e) {
      if (e instanceof TimeoutError) {
        outcome = 'timeout';
        // The child's own timeout_ms clock starts at ITS claim, not at
        // submit — a child that sat queued behind other work can outlive
        // the parent deadline this wait was clamped to. Cancel it so the
        // subagent can't keep spending/writing after the phase gave up
        // (waiting child → cancelled immediately; active child → lock
        // stripped, worker abort fires on next renew tick).
        try { await queue.cancelJob(job.id); } catch { /* best-effort */ }
      } else {
        throw e;
      }
    }

    await recordPatternsLastRun(engine, { duration_ms: Date.now() - submittedAt, reflections: submitted.length, outcome }); // #6177: every child, timed out or failed too
    if (outcome === 'completed' && submitOpts.idempotency_key) await clearPatternsSourceDeaths(engine, opts.sourceId ?? 'default'); // #6236: only consecutive deaths trip

    if (opts.yieldDuringPhase) {
      try { await opts.yieldDuringPhase(); } catch { /* best-effort */ }
    }

    // Collect refs the subagent wrote (codex finding #2 — query tool exec rows).
    // v0.32.8: refs carry source_id so reverseWriteRefs targets the right
    // (source, slug) row instead of the first DB match.
    // #1586: refs carry the cycle's resolved source (children wrote there via
    // SubagentHandlerData.source_id), so getPage/getTags read the same row the
    // child wrote, and the reverse-write treats it as the native source.
    const cycleSourceId = opts.sourceId ?? 'default';
    // #4077: no post-abort derived-state writes (collection is a read, but
    // the reverse-write below dual-writes files).
    throwIfAborted(opts.signal, '[dream] patterns output');
    const writtenRefs = await collectChildPutPageSlugs(engine, [job.id], cycleSourceId);

    // #6052: `finalized` leaves out outputs whose managed publication is held (pending or contended); `held` counts them.
    const { quoteVerify, finalized, held } = await stampPatternOutputs(engine, maintenance, writtenRefs, submitted, config, cycleSourceId, cycleDate, opts.signal);
    const reverseWriteCount = maintenance ? await verifyMaintenanceOutputs(engine, maintenance, finalized)
      : await reverseWriteRefs(engine, opts.brainDir, writtenRefs, cycleSourceId, opts.signal);
    const details = { reflections_considered: submitted.length, reflections_selected: selected, plan_basis: plan.basis, patterns_written: finalized.length,
      ...(quoteVerify ? { quote_verify: quoteVerify } : {}), reverse_write_count: reverseWriteCount, publish_deferred: held,
      child_outcome: outcome, job_id: job.id };

    // #2782: the phase status must reflect the child outcome. Pre-fix this
    // returned status:ok even when the subagent timed out (e.g. no
    // subagent-capable worker slot free for the whole wait window) and zero
    // pattern pages were written — a silent no-op for days.
    if (outcome !== 'completed') {
      if (finalized.length === 0) {
        return {
          phase: 'patterns',
          status: 'fail',
          duration_ms: 0,
          summary: `pattern-detection subagent job ${job.id} ended '${outcome}'; nothing was written`,
          details,
          error: makeError(
            outcome === 'timeout' ? 'Timeout' : 'InternalError',
            `PATTERNS_CHILD_${outcome.toUpperCase()}`,
            `subagent job ${job.id} outcome '${outcome}' with zero pattern pages written`,
            outcome === 'timeout'
              ? 'A timeout with zero writes usually means no subagent-capable worker claimed the job. Check `gbrain jobs list` and worker capacity.'
              : undefined,
          ),
        };
      }
      // Partial: the child died/timed out but some pages landed first.
      return {
        phase: 'patterns',
        status: 'warn',
        duration_ms: 0,
        summary: `${finalized.length} pattern page(s) written but subagent job ${job.id} ended '${outcome}'`,
        details,
      };
    }
    // A held output is unfinished: warn and leave the evidence watermark unstamped so the next cycle retries.
    if (held > 0) return { phase: 'patterns', status: 'warn', duration_ms: 0, details,
      summary: `${finalized.length} pattern page(s) written; ${held} publication(s) held by the writer (pending or contended), retried next cycle` };

    // #4879: stamp the EVIDENCE watermark (not now()) only on a completed
    // child — fail/warn/timeout above must retry next tick. A reflection
    // edited between gather and here has updated_at > stamp, so the next run
    // still fires. Zero writes stamps too: the model saw this evidence and
    // named nothing; re-running it is exactly the spend bug.
    await engine.setConfig(evidenceKey, new Date(newestEvidenceMs).toISOString());

    return ok(`${writtenRefs.length} pattern page(s) written/updated (${outcome})`, details);
  } catch (e) {
    return failed(makeError('InternalError', 'PATTERNS_PHASE_FAIL',
      e instanceof Error ? (e.message || 'patterns phase threw') : String(e)));
  } finally {
    if (ownedPrivateQueue) {
      try {
        const cancelled = await ownedPrivateQueue.queue.reconcilePrivateQueue(
          ownedPrivateQueue.name,
          'private queue owner terminalized: patterns phase ended',
        );
        if (cancelled.length > 0) {
          process.stderr.write(
            `[dream] patterns reconciled ${cancelled.length} non-terminal child job(s) from ${ownedPrivateQueue.name}\n`,
          );
        }
      } catch (cleanupError) {
        process.stderr.write(
          `[dream] patterns private-queue cleanup failed for ${ownedPrivateQueue.name}: ` +
          `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
        );
      }
    }
    void start;
  }
}

// ── Config ────────────────────────────────────────────────────────────

interface PatternsConfig {
  enabled: boolean;
  lookbackDays: number;
  minEvidence: number;
  model: string;
  /** #2415: shared output namespace (dream.synthesize.output_root, default 'wiki'). */
  outputRoot: string;
  /**
   * Slug prefix `gatherReflections` reads from (SQL `LIKE` scope). Defaults
   * to `${outputRoot}/personal/reflections`, matching pre-existing behavior.
   * Config `dream.patterns.source_slug_prefix` overrides it for brains whose
   * schema has no `personal/reflections/` convention (e.g. a flat
   * `meetings/` tree) so the phase can read from wherever compiled_truth
   * excerpts actually live.
   */
  sourceSlugPrefix: string;
  /**
   * Slug prefix new pattern pages are written under. Defaults to
   * `${outputRoot}/personal/patterns`, matching pre-existing behavior.
   * Config `dream.patterns.output_slug_prefix` overrides it.
   */
  outputSlugPrefix: string;
  /** #1594-family: subagent job timeout, config `dream.patterns.subagent_timeout_ms`. */
  subagentTimeoutMs: number;
  /** #1594-family: waitForCompletion timeout, config `dream.patterns.subagent_wait_timeout_ms`. */
  subagentWaitTimeoutMs: number;
}

const DEFAULT_PATTERNS_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_PATTERNS_SUBAGENT_WAIT_TIMEOUT_MS = 35 * 60 * 1000;

async function getNumberConfig(engine: BrainEngine, key: string, fallback: number): Promise<number> {
  const raw = await engine.getConfig(key);
  if (raw === undefined || raw === null) return fallback;
  const value = Number(raw);
  return Number.isNaN(value) ? fallback : value;
}

/** Trims leading/trailing slashes from a config-supplied slug prefix; falls back to `fallback` when unset or empty after trimming. */
async function getSlugPrefixConfig(engine: BrainEngine, key: string, fallback: string): Promise<string> {
  const raw = await engine.getConfig(key);
  if (!raw) return fallback;
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  return trimmed || fallback;
}

/** Where pattern pages land; also a dream output directory synthesize discovery excludes (#5471). */
export async function loadPatternsOutputSlugPrefix(engine: BrainEngine, outputRoot: string): Promise<string> {
  return getSlugPrefixConfig(engine, 'dream.patterns.output_slug_prefix', `${outputRoot}/personal/patterns`);
}

async function loadPatternsConfig(engine: BrainEngine): Promise<PatternsConfig> {
  const enabledStr = await engine.getConfig('dream.patterns.enabled');
  const enabled = enabledStr === null ? true : enabledStr === 'true';
  const lookbackStr = await engine.getConfig('dream.patterns.lookback_days');
  const minEvidenceStr = await engine.getConfig('dream.patterns.min_evidence');
  // v0.28: unified model resolution
  const { resolveModel } = await import('../model-config.ts');
  const model = await resolveModel(engine, {
    configKey: 'models.dream.patterns',
    deprecatedConfigKey: 'dream.patterns.model',
    tier: 'reasoning',
    fallback: 'sonnet',
  });
  const outputRoot = await loadOutputRoot(engine);
  return {
    enabled,
    lookbackDays: lookbackStr ? Math.max(1, parseInt(lookbackStr, 10) || 30) : 30,
    minEvidence: minEvidenceStr ? Math.max(1, parseInt(minEvidenceStr, 10) || 3) : 3,
    model,
    outputRoot,
    sourceSlugPrefix: await getSlugPrefixConfig(
      engine, 'dream.patterns.source_slug_prefix', `${outputRoot}/personal/reflections`,
    ),
    outputSlugPrefix: await loadPatternsOutputSlugPrefix(engine, outputRoot),
    subagentTimeoutMs: await getNumberConfig(
      engine, 'dream.patterns.subagent_timeout_ms', DEFAULT_PATTERNS_SUBAGENT_TIMEOUT_MS,
    ),
    subagentWaitTimeoutMs: await getNumberConfig(
      engine, 'dream.patterns.subagent_wait_timeout_ms', DEFAULT_PATTERNS_SUBAGENT_WAIT_TIMEOUT_MS,
    ),
  };
}

// ── Reflection gathering ─────────────────────────────────────────────

/** #4879: config-plane STATE row (not a user knob) — ISO of the newest
 *  reflection `updated_at` the last completed run consumed. Same class as
 *  `dream.synthesize.last_completion_ts`; `dream.` is already a known prefix. */
const LAST_EVIDENCE_KEY = 'dream.patterns.last_evidence_ts';

export interface ReflectionRef {
  slug: string;
  title: string;
  excerpt: string;
  updatedAt: Date;
  /** #4618: the seat the reflection was synthesized from, when stamped. */
  seat: string | null;
}

/** The submission key's reflection identity, unchanged by #4618's seat field
 * (a seat must never re-key, and so re-pay, a retained patterns child). */
function withoutSeats(reflections: ReflectionRef[]): Array<Omit<ReflectionRef, 'seat'>> {
  return reflections.map(({ slug, title, excerpt, updatedAt }) => ({ slug, title, excerpt, updatedAt }));
}

/** #4618: a pattern credits a seat only when every input reflection shares one. */
function sharedSeat(reflections: ReflectionRef[]): string | undefined {
  const seats = new Set(reflections.map(r => r.seat));
  return seats.size === 1 ? (reflections[0]?.seat ?? undefined) : undefined;
}

async function gatherReflections(
  engine: BrainEngine,
  lookbackDays: number,
  sourceSlugPrefix = 'wiki/personal/reflections',
  sourceId = 'default',
): Promise<ReflectionRef[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  // Reflections live under the configured source slug prefix (bound as a
  // parameter; see PatternsConfig.sourceSlugPrefix / dream.patterns.source_slug_prefix).
  const rows = await engine.executeRaw<{
    slug: string; title: string | null; compiled_truth: string | null; updated_at: string | Date; seat: string | null;
  }>(
    `SELECT slug, title, compiled_truth, updated_at, frontmatter->>'seat' AS seat
       FROM pages
      WHERE slug LIKE $2
        AND source_id = $3 AND deleted_at IS NULL AND COALESCE(frontmatter->>'visibility','') <> 'private'
        AND updated_at >= $1::timestamptz
      ORDER BY updated_at DESC
      LIMIT 100`,
    [since, `${sourceSlugPrefix}/%`, sourceId],
  );
  return rows.map(r => ({
    slug: r.slug,
    title: r.title ?? r.slug,
    // Both engines hand timestamptz back as Date; wrap so a string-returning
    // driver shape still parses (backfill-registry.ts precedent).
    updatedAt: new Date(r.updated_at),
    // A raw UTF-16 slice can split an astral character at the boundary and
    // leave a lone surrogate. Postgres rejects that when the prompt is bound
    // into the minion job's JSONB payload. Use the shared safe truncator so a
    // reflection containing emoji cannot abort the entire patterns phase.
    excerpt: truncateUtf8(r.compiled_truth ?? '', 600),
    seat: r.seat ?? null,
  }));
}

// ── Prompt ────────────────────────────────────────────────────────────

function buildPatternsPrompt(
  reflections: ReflectionRef[],
  minEvidence: number,
  sourceSlugPrefix = 'wiki/personal/reflections',
  outputSlugPrefix = 'wiki/personal/patterns',
  today: string,
): string {
  const corpus = reflections
    .map((r, i) => `### ${i + 1}. [[${r.slug}]] — ${r.title}\n${r.excerpt}`)
    .join('\n\n---\n\n');

  return `You are surfacing recurring themes across the user's recent reflections.

OUTPUT POLICY
- Only name a pattern if it appears in at least ${minEvidence} DISTINCT reflections.
- Each pattern page MUST cite the reflections that constitute its evidence (use [[${sourceSlugPrefix}/...]] wikilinks).
- Use \`search\` to check whether a similar pattern page already exists; if yes, update it (use the same slug). If no, create a new one.
- Pattern slug format: \`${outputSlugPrefix}/<topic-slug>\` (lowercase alphanumeric + hyphens; no underscores, no extension, no date).
- A "pattern" is a recurring theme, anxiety, decision pattern, relationship dynamic, or self-knowledge motif. NOT a single insight. NOT a list of unrelated topics.

DO NOT WRITE
- A "patterns from today" digest (that's the dream-cycle-summaries page; not your job).
- Patterns with <${minEvidence} reflections cited.
- Anything outside ${outputSlugPrefix}/.

CONTEXT
- Today: ${today}
- Reflections in scope: ${reflections.length}

REFLECTIONS
${corpus}

When done, briefly list the pattern slugs you wrote/updated in your final message.`;
}

/**
 * #5733: pages under the patterns output prefix are dream output and carry the
 * dream_generated identity stamp every dream_generated consumer reads, through
 * the managed maintenance write on a managed brain, before the reverse-write.
 * #5884: a pattern is derived from reflection pages, not raw material, so it is
 * stamped raw-trace exempt (doctor raw_provenance) on every run that writes it.
 */
/**
 * Quote-ground the pattern outputs (and pages a crashed run left unverified), then stamp provenance on the
 * outputs. Returns the grounding counts (null when dream.quote_verify is off), the written refs whose managed
 * publications all landed, and the number of pages whose publication is held for a later cycle.
 */
async function stampPatternOutputs(engine: BrainEngine, maintenance: MaintenanceAuthority | null, written: Array<{ slug: string; source_id: string }>,
  reflections: ReflectionRef[], config: { outputSlugPrefix: string; sourceSlugPrefix: string }, sourceId: string, cycleDate: string, signal?: AbortSignal) {
  const heldSlugs = new Set<string>();
  const quoteVerify = await groundPatternPages(engine, maintenance, written, reflections, config.outputSlugPrefix, sourceId, cycleDate, signal, heldSlugs);
  await stampProvenance(engine, maintenance, written.filter(ref => ref.slug.startsWith(`${config.outputSlugPrefix}/`)), cycleDate, config.sourceSlugPrefix, sharedSeat(reflections), signal, heldSlugs);
  // Holds are recorded for this cycle's source only, so a ref in any other source is never excused from verification.
  const finalized = written.filter(ref => ref.source_id !== sourceId || !heldSlugs.has(ref.slug));
  return { quoteVerify, finalized, held: heldSlugs.size };
}

async function stampProvenance(engine: BrainEngine, maintenance: MaintenanceAuthority | null,
  refs: Array<{ slug: string; source_id: string }>, cycleDate: string, sourceSlugPrefix: string, seat: string | undefined, signal: AbortSignal | undefined,
  heldSlugs: Set<string>): Promise<void> {
  const reason = `derived from reflections under ${sourceSlugPrefix}/; raw traces live on the cited reflection pages`;
  // A pattern earns a seat only while its reflections share one, so a pattern without one drops a seat an earlier run stamped.
  if (!maintenance) return stampDreamProvenance(engine, refs.map(ref => ({ ...ref, raw_trace_exempt_reason: reason, seat: seat ?? null })), cycleDate, signal);
  for (const ref of refs) {
    throwIfAborted(signal, '[dream] patterns provenance');
    // A page whose grounding publish is held must not be stamped over the pending revision.
    if (heldSlugs.has(ref.slug)) continue;
    if (await publishOrHold(() => stampMaintenancePage(engine, maintenance, ref.slug, cycleDate, undefined, reason, seat ?? null))) heldSlugs.add(ref.slug);
  }
}

// ── Quote grounding ──────────────────────────────────────────────────

/**
 * Ground every quoted span on the pattern pages against the full reflection
 * pages the run read (quotes and speaker attribution only: a pattern counts
 * its evidence). A failing claim unit leaves the body for frontmatter
 * `unverified_claims`; `quote_verified_at` marks a checked page, so a page a
 * crashed run left behind is verified by the next run. Kill switch:
 * dream.quote_verify (default on). Returns null when disabled. With `heldSlugs`
 * a managed publish that is pending or contended (publicationHold) is recorded
 * there and the loop moves on; without it every publish error propagates.
 */
export async function groundPatternPages(engine: BrainEngine, maintenance: MaintenanceAuthority | null, refs: Array<{ slug: string; source_id: string }>,
  reflections: ReflectionRef[], outputSlugPrefix: string, sourceId: string, cycleDate: string, signal?: AbortSignal, heldSlugs?: Set<string>):
  Promise<{ pages: number; quarantined: number; repaired: number } | null> {
  const { dreamQuoteVerifyEnabled, groundSource, verifyBody } = await import('./synthesize-verify.ts');
  if (!await dreamQuoteVerifyEnabled(engine)) return null;
  const leftover = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND slug LIKE $2 AND deleted_at IS NULL
       AND frontmatter->>'dream_generated' = 'true' AND frontmatter->>'quote_verified_at' IS NULL`, [sourceId, `${outputSlugPrefix}/%`]);
  const slugs = [...new Set([...refs.map(r => r.slug).filter(slug => slug.startsWith(`${outputSlugPrefix}/`)), ...leftover.map(r => r.slug)])];
  if (slugs.length === 0) return { pages: 0, quarantined: 0, repaired: 0 };
  const sourcePages = await engine.executeRaw<{ slug: string; compiled_truth: string; timeline: string }>(
    'SELECT slug, compiled_truth, timeline FROM pages WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL',
    [sourceId, reflections.map(r => r.slug)]);
  const sources = sourcePages.map(p => groundSource(p.slug, `${p.compiled_truth}\n\n${p.timeline ?? ''}`, { tolerant: true }));
  const stats = { pages: 0, quarantined: 0, repaired: 0 };
  const { serializePageToMarkdown } = await import('../markdown.ts');
  for (const slug of slugs) {
    throwIfAborted(signal, '[dream] patterns quote verify');
    const snapshot = await engine.readPageSnapshot(slug, { sourceId });
    if (!snapshot) continue;
    const ct = verifyBody(snapshot.page.compiled_truth, sources, { checks: 'quotes' });
    const tl = verifyBody(snapshot.page.timeline ?? '', sources, { checks: 'quotes' });
    const quarantined = [...ct.quarantined, ...tl.quarantined];
    stats.pages++;
    stats.quarantined += quarantined.length;
    stats.repaired += ct.normalized + ct.near + tl.normalized + tl.near;
    // #6236: the reflection list is stored once per page (lossless), not on every claim.
    const { frontmatter } = withClaimSources({ ...snapshot.page.frontmatter, quote_verified_at: cycleDate },
      quarantined.map(c => ({ ...c, detected_at: cycleDate })), sources.map(x => x.path));
    const page = { ...snapshot.page,
      compiled_truth: ct.body.trim() ? ct.body : (await import('./synthesize-verify.ts')).ALL_CLAIMS_QUARANTINED_BODY,
      timeline: tl.body, frontmatter };
    const content = serializePageToMarkdown(page, snapshot.tags);
    if (maintenance) {
      const { publishMaintenancePage } = await import('../persistence/prepared-maintenance.ts');
      const publish = () => publishMaintenancePage(engine, maintenance, slug, content, { expectedRevision: snapshot.revision });
      if (!heldSlugs) await publish();
      else if (await publishOrHold(publish)) heldSlugs.add(slug);
    } else {
      const [{ importFromContent }, { isAvailable }] = await Promise.all([import('../import-file.ts'), import('../ai/gateway.ts')]);
      await importFromContent(engine, slug, content, { noEmbed: !isAvailable('embedding'), sourceId, preserveGateMarkers: true });
    }
  }
  return stats;
}

// ── Provenance via put_page tool execution rows ─────────────────────

async function collectChildPutPageSlugs(
  engine: BrainEngine,
  childIds: number[],
  sourceId = 'default',
): Promise<Array<{ slug: string; source_id: string }>> {
  if (childIds.length === 0) return [];
  // v0.32.8: subagent put_page tool schema doesn't expose source_id (subagents
  // are scoped to a single source). #1586: stamp the cycle's resolved source —
  // children write there via SubagentHandlerData.source_id — so reverseWriteRefs
  // can pass it through getPage and pick the correct (source_id, slug) row
  // instead of whatever the DB happens to return. Unset → legacy 'default'.
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT DISTINCT
            COALESCE(input->>'slug', (input #>> '{}')::jsonb->>'slug') AS slug
       FROM subagent_tool_executions
      WHERE job_id = ANY($1::int[])
        AND tool_name = 'brain_put_page'
        AND status = 'complete'
      ORDER BY 1`,
    [childIds],
  );
  return rows
    .map(r => r.slug)
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map(slug => ({ slug, source_id: sourceId }));
}

// ── Reverse-write ────────────────────────────────────────────────────

import { validateSourceId } from '../utils.ts';

async function reverseWriteRefs(
  engine: BrainEngine,
  brainDir: string,
  refs: Array<{ slug: string; source_id: string }>,
  nativeSourceId = 'default',
  signal?: AbortSignal,
): Promise<number> {
  let count = 0;
  for (const { slug, source_id } of refs) {
    throwIfAborted(signal, '[dream] patterns reverse-write');
    // v0.32.8 F6: guard against malformed source_id (would let join() break
    // out of brainDir). validateSourceId throws on `..`, `/`, etc.
    validateSourceId(source_id);
    const page = await engine.getPage(slug, { sourceId: source_id });
    if (!page) continue;
    const tags = await engine.getTags(slug, { sourceId: source_id });
    // #4077: re-check after the row reads — an abort that lands during
    // getPage/getTags must not reach this ref's file write.
    throwIfAborted(signal, '[dream] patterns reverse-write');
    try {
      const md = renderPageToMarkdown(page, tags);
      // v0.32.8 F6: foreign-source pages land under brainDir/.sources/<id>/<slug>.md
      // so same-slug-different-source pages don't collide on disk. Pages belonging
      // to the cycle's own source (#1586: brainDir IS that source's checkout —
      // legacy 'default' when unscoped) stay at brainDir/<slug>.md so single-source
      // brains see no change. `.sources/` is a reserved prefix; walkBrainRepo skips dot-dirs.
      const filePath = source_id === nativeSourceId
        ? join(brainDir, `${slug}.md`)
        : join(brainDir, '.sources', source_id, `${slug}.md`);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, md, 'utf8');
      count++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[dream] reverse-write ${slug}@${source_id} failed: ${msg}\n`);
    }
  }
  return count;
}

function renderPageToMarkdown(page: Page, tags: string[]): string {
  const frontmatter = (page.frontmatter ?? {}) as Record<string, unknown>;
  return serializeMarkdown(
    frontmatter,
    page.compiled_truth ?? '',
    page.timeline ?? '',
    {
      type: (page.type as string) ?? 'note',
      title: page.title ?? '',
      tags,
    },
  );
}

// ── Status helpers ───────────────────────────────────────────────────

function ok(summary: string, details: Record<string, unknown> = {}): PhaseResult {
  return { phase: 'patterns', status: 'ok', duration_ms: 0, summary, details };
}

/** #6236: de-duplicate the claim sources of existing pattern pages; a skip result while any rewrite is held (no paid child then). */
async function dedupePatternsBeforeChild(engine: BrainEngine, maintenance: MaintenanceAuthority | null, outputSlugPrefix: string,
  sourceId: string, signal?: AbortSignal): Promise<PhaseResult | null> {
  const { held } = await dedupePatternClaimSources(engine, maintenance, outputSlugPrefix, sourceId, signal);
  if (!held.length) return null;
  const summary = `patterns: ${held.length} pattern page(s) are waiting on a claim-source rewrite (${held.slice(0, 3).join(', ')}); `
    + 'no patterns child was submitted, so it never reads the oversized pages. The next cycle retries.';
  process.stderr.write(`[dream] ${summary}\n`);
  return { phase: 'patterns', status: 'skipped', duration_ms: 0, summary, details: { reason: 'pattern_claims_pending', code: 'pattern_claims_pending', held,
    why: 'Existing pattern pages carried a full reflection list on every quarantined claim; the child reads those pages, so it runs only after they are rewritten.',
    fix: { argv: ['gbrain', 'dream', '--phase', 'patterns', '--source', sourceId], consent: ['paid'], actor: 'agent', requires_exclusive: false,
      why: 'Re-runs the patterns phase once the held rewrites have landed; it is a paid model run, so ask the user first.',
      verify: { argv: ['gbrain', 'write-requests', '--source', sourceId] } } } };
}

function skipped(reason: string, summary: string): PhaseResult {
  return {
    phase: 'patterns',
    status: 'skipped',
    duration_ms: 0,
    summary,
    details: { reason },
  };
}

function failed(error: PhaseError): PhaseResult {
  return {
    phase: 'patterns',
    status: 'fail',
    duration_ms: 0,
    summary: 'patterns phase failed',
    details: {},
    error,
  };
}

function makeError(cls: string, code: string, message: string, hint?: string): PhaseError {
  return hint ? { class: cls, code, message, hint } : { class: cls, code, message };
}

// `__testing` re-exports otherwise-private helpers so unit tests can pin the
// source-scoping contract (#1586) without driving a whole dream cycle.
// Mirrors synthesize.ts's `__testing` block.
export const __testing = {
  gatherReflections,
  collectChildPutPageSlugs,
  reverseWriteRefs,
};
