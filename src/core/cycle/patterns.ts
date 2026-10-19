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
 *   - Existing pattern pages are rewritten through put_page with the
 *     revision get_page returned as expected_revision, appended to with
 *     add_timeline_entry, or skipped (#6779: a put_page without the revision
 *     is refused revision_required).
 */

import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { boundedBodyPrefixSql } from '../page-window/bounded-lead.ts';
import type { PhaseResult, PhaseError } from '../cycle.ts';
import { DEFAULT_PRIVATE_QUEUE_LEASE_MS, MinionQueue } from '../minions/queue.ts';
import { isQueueQuotaExceededError } from '../minions/admission.ts';
import { waitForCompletionRenewing, TimeoutError } from '../minions/wait-for-completion.ts';
import type { MinionJobInput, MinionJobStatus, SubagentHandlerData } from '../minions/types.ts';
import { serializeMarkdown } from '../markdown.ts';
import { truncateUtf8 } from '../text-safe.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
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
import { reportFileHolds, reverseWriteDreamRefs } from './derived-write-through.ts';
import { stampDreamProvenance } from './dream-provenance.ts';
import { probeChatModelWithKey } from '../ai/chat-key-probe.ts';
import { normalizeModelId } from '../model-id.ts';
import { throwIfAborted } from '../abort-check.ts';
import { resolveCycleDate } from './cycle-date.ts';
import { clearPatternsSourceDeaths, patternsBreakerSkip } from './dream-breaker.ts';
import { dedupePatternClaimSources, withClaimSources } from './pattern-claim-sources.ts';
import { publishOrHold } from '../persistence/accepted-pending.ts';
import { derivedMaintenanceTransaction, isExternalTier, type DerivationDeclaration } from '../trust/taint.ts';
import { storedTrustTier, type TaintInput } from '../trust/tier.ts';
import { patternsDerivation, type Derivation } from './dream-taint.ts';
import { ItemRun } from '../item-failure.ts';
import { beginGroundingRun, finishGroundingRun, groundingHeld, withGroundingStatus, type GroundingReport, type GroundingRun } from './pattern-grounding.ts';

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
   * #6297: the operator named this phase (`gbrain dream --phase patterns`). A
   * direct run, like `--once`, is not held to `dream.patterns.min_interval_hours`;
   * in-cycle runs (autopilot, bare `gbrain dream`) are.
   */
  direct?: boolean;
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
import { patternsCadenceKey, patternsCadenceSkip, patternsChildReadBudgetBytes, recordPatternsLastRun, sizePatternsRun } from './patterns-plan.ts';
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
  let config: PatternsConfig, evidenceKey: string, cadenceKey: string, reflections: ReflectionRef[];
  let retried: AppendRetry | null = null;
  try {
    throwIfAborted(opts.signal, '[dream] patterns');
    config = await loadPatternsConfig(engine);

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
    evidenceKey = source ? `${LAST_EVIDENCE_KEY}.${opts.sourceId ?? 'default'}.${source.incarnation}` : LAST_EVIDENCE_KEY;
    cadenceKey = await patternsCadenceKey(engine, opts.sourceId ?? 'default');

    // Gather reflections within lookback window.
    reflections = await gatherReflections(engine, config.lookbackDays, config.sourceSlugPrefix, opts.sourceId ?? 'default');
    // GBRA-130 A-23: before any gate can skip the pass, so a failed append never waits on new evidence or a paid child.
    if (!opts.dryRun) retried = await retryPendingAppends(engine, opts, opts.sourceId ?? 'default');
  } catch (e) {
    return failed(makeError('InternalError', 'PATTERNS_PHASE_FAIL',
      e instanceof Error ? (e.message || 'patterns phase threw') : String(e)));
  }
  // #5575 ENG-3: an external_untrusted reflection never shares a prompt with the
  // owner's reflections. External reflections get their own pass (only with
  // enough evidence of their own), and that pass's pattern pages are external.
  const external = reflections.filter(r => isExternalTier(r.taint?.tier ?? 'unknown'));
  const owner = await runPatternsPass(engine, opts, config, reflections.filter(r => !external.includes(r)), { evidence: evidenceKey, cadence: cadenceKey });
  if (!external.length) return withAppendRetry(owner, retried);
  const externalPass = external.length >= config.minEvidence
    ? await runPatternsPass(engine, opts, config, external, { evidence: `${evidenceKey}.external`, cadence: `${cadenceKey}.external` }) : null;
  return withAppendRetry(mergeExternalPass(owner, externalPass, external.length), retried);
}

/** One patterns child over one partition of the reflections; `keys` are that partition's evidence watermark and cadence stamp. */
async function runPatternsPass(engine: BrainEngine, opts: PatternsPhaseOpts, config: PatternsConfig,
  reflections: ReflectionRef[], keys: { evidence: string; cadence: string }): Promise<PhaseResult> {
  const start = Date.now();
  let ownedPrivateQueue: { queue: MinionQueue; name: string } | null = null;
  try {
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
      const stampMs = Date.parse((await engine.getConfig(keys.evidence)) ?? '');
      if (Number.isFinite(stampMs) && newestEvidenceMs <= stampMs) {
        return skipped(
          'no_new_evidence',
          `${reflections.length} reflections in window, none newer than last completed run ` +
          `(${new Date(stampMs).toISOString()}); pass --once to force`,
        );
      }
    }

    // #6297: an in-cycle run waits dream.patterns.min_interval_hours after the partition's last completed run.
    const cadence = opts.once || opts.direct ? null : await patternsCadenceSkip(engine, keys.cadence);
    if (cadence) return cadence;
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
    // Anthropic keys set via `gbrain config set anthropic_api_key`. Unknown
    // provider/model or any keyed provider without its key skips cheaply
    // (#6705: probeChatModelWithKey, not the lazy probeChatModel, so a keyless
    // non-Anthropic model never submits a subagent that fails at dispatch).
    // (Takeover of PR #2279's intent by @brettdavies.)
    const maintenance = await maintenancePreflight(engine, opts.sourceId ?? 'default', opts.brainDir);
    const probe = probeChatModelWithKey(normalizeModelId(config.model));
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
    // #5575 ENG-3: decided at prompt-build time from exactly the reflections in the prompt.
    const derivation = patternsDerivation(submitted);
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
      ...await patternsChildReadBudgetBytes(engine).then(bytes => bytes ? { read_budget_bytes: bytes } : {}), // #6297: get_page results past it come back summarized
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
    let errorText: string | null = null;
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
      errorText = final.error_text ?? null;
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

    await recordPatternsLastRun(engine, { duration_ms: Date.now() - submittedAt, reflections: submitted.length, outcome, error_text: errorText }); // #6177: every child, timed out or failed too
    if (outcome === 'completed') await engine.setConfig(keys.cadence, new Date().toISOString()); // #6297: cadence counts from completed runs
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
    const { putPageRefs, appends, writtenRefs, appendedUnverified } = await collectPatternOutputs(engine, job.id, cycleSourceId, config.outputSlugPrefix);

    // #6052: `finalized` leaves out outputs whose managed publication is held (pending or contended); `held` counts them.
    const { quoteVerify, finalized, held, grounding } = await stampPatternOutputs(engine, maintenance, putPageRefs, appends, submitted, derivation, config, cycleSourceId, cycleDate, opts.signal);
    const fileHolds: string[] = [];
    const reverseWriteCount = maintenance ? await verifyMaintenanceOutputs(engine, maintenance, finalized)
      : await reverseWriteRefs(engine, opts.brainDir, writtenRefs, cycleSourceId, opts.signal, fileHolds);
    const details = { reflections_considered: submitted.length, reflections_selected: selected, plan_basis: plan.basis, patterns_written: finalized.length,
      ...(quoteVerify ? { quote_verify: quoteVerify } : {}), reverse_write_count: reverseWriteCount, publish_deferred: held, ...grounding.details, ...(fileHolds.length ? { file_holds: fileHolds } : {}),
      timeline_appends: appends.length, appended_unverified: appendedUnverified, child_outcome: outcome, job_id: job.id };
    const appendedNote = appends.length > 0 ? `; ${appends.length} timeline entr${appends.length === 1 ? 'y' : 'ies'} appended${quoteVerify ? ' (quote-verified)' : ''}` : '';

    // #2782: the phase status must reflect the child outcome. Pre-fix this
    // returned status:ok even when the subagent timed out (e.g. no
    // subagent-capable worker slot free for the whole wait window) and zero
    // pattern pages were written — a silent no-op for days.
    if (outcome !== 'completed') {
      if (finalized.length === 0 && appends.length === 0 && appendedUnverified === 0) {
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
        summary: `${finalized.length} pattern page(s) written${appendedNote} but subagent job ${job.id} ended '${outcome}'`,
        details,
      };
    }
    // A held output is unfinished: warn and leave the evidence watermark unstamped so the next cycle retries.
    if (held > 0) return { phase: 'patterns', status: 'warn', duration_ms: 0, details,
      summary: `${finalized.length} pattern page(s) written${appendedNote}; ${held} publication(s) held by the writer (pending or contended), retried next cycle` };

    // #4879: stamp the EVIDENCE watermark (not now()) only on a completed
    // child — fail/warn/timeout above must retry next tick. A reflection
    // edited between gather and here has updated_at > stamp, so the next run
    // still fires. Zero writes stamps too: the model saw this evidence and
    // named nothing; re-running it is exactly the spend bug.
    await engine.setConfig(keys.evidence, new Date(newestEvidenceMs).toISOString());

    return reportFileHolds(withGroundingStatus(ok(`${writtenRefs.length} pattern page(s) written/updated${appendedNote} (${outcome})`, details), grounding), fileHolds, 'page');
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
  /** #5575: the reflection page's stored tier; never part of the submission key. */
  taint?: TaintInput;
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
    id: number | string; slug: string; title: string | null; compiled_truth: string | null; updated_at: string | Date; seat: string | null; trust_tier: string | null;
  }>(
    `SELECT id, slug, title, ${boundedBodyPrefixSql('pages')} AS compiled_truth, updated_at, frontmatter->>'seat' AS seat, trust_tier
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
    taint: { table: 'pages', id: Number(r.id), tier: storedTrustTier(r.trust_tier) },
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
- Use \`search\` to check whether a similar pattern page already exists. If no, create a new one.
- If one exists, keep its slug. Skip it when its cited evidence already covers the pattern. Otherwise read it with \`get_page\` and write the merged page back with \`put_page\`, passing the \`revision\` get_page returned as \`expected_revision\` (a \`put_page\` without it is refused \`revision_required\`). When the read comes back summarized (\`read_budget_exhausted\`), do not rewrite the page: append the new evidence with \`add_timeline_entry\` or skip it.
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
 * publications all landed, the number of pages whose publication is held for a later cycle, and the grounding
 * report (pattern-grounding.ts): a page whose grounding failed is neither stamped nor counted as written.
 */
async function stampPatternOutputs(engine: BrainEngine, maintenance: MaintenanceAuthority | null, written: Array<{ slug: string; source_id: string }>,
  appends: TimelineAppend[], reflections: ReflectionRef[], derivation: Derivation & { declaration: DerivationDeclaration },
  config: { outputSlugPrefix: string; sourceSlugPrefix: string }, sourceId: string, cycleDate: string, signal?: AbortSignal) {
  const heldSlugs = new Set<string>();
  const run = await beginGroundingRun(engine, sourceId);
  const pages = await groundPatternPages(engine, maintenance, written, reflections, config.outputSlugPrefix, sourceId, cycleDate, signal, heldSlugs, derivation, run);
  const appended = await groundTimelineAppends(engine, maintenance, appends, reflections, sourceId, cycleDate, signal, heldSlugs, derivation, run);
  const grounding = await finishGroundingRun(engine, run);
  const outputs = [...written, ...[...new Set(appends.map(a => a.slug))].map(slug => ({ slug, source_id: sourceId }))]
    .filter(ref => ref.source_id !== sourceId || !grounding.failedSlugs.has(ref.slug));
  await stampProvenance(engine, maintenance, outputs.filter(ref => ref.slug.startsWith(`${config.outputSlugPrefix}/`)), cycleDate, config.sourceSlugPrefix, sharedSeat(reflections), signal, heldSlugs, derivation);
  // Holds are recorded for this cycle's source only, so a ref in any other source is never excused from verification.
  const finalized = outputs.filter(ref => ref.source_id !== sourceId || !heldSlugs.has(ref.slug));
  return { quoteVerify: pages ? { ...pages, ...(appended ? { timeline_appends: appended } : {}) } : null, finalized, held: heldSlugs.size, grounding };
}

type AppendRetry = { report: GroundingReport; stats: { pages: number; entries: number; quarantined: number; repaired: number }; fileHolds: string[] };

/**
 * GBRA-130 A-23: ground the timeline appends earlier runs failed to ground (pattern-grounding.ts), each page against
 * the reflections its entries were appended under and written back at their derivation, then reverse-write (or verify
 * the managed publication of) the pages that grounded. A page held at its current content is not attempted. Null when
 * nothing is pending.
 */
async function retryPendingAppends(engine: BrainEngine, opts: PatternsPhaseOpts, sourceId: string): Promise<AppendRetry | null> {
  const run = await beginGroundingRun(engine, sourceId);
  const slugs = Object.keys(run.pending);
  if (slugs.length === 0) return null;
  const hashes = new Map((await engine.executeRaw<{ slug: string; content_hash: string | null }>(
    'SELECT slug, content_hash FROM pages WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL', [sourceId, slugs]))
    .map(r => [r.slug, r.content_hash ?? null]));
  const due = slugs.filter(slug => !groundingHeld(run, slug, hashes.get(slug) ?? null, run.pending));
  const maintenance = due.length ? await maintenancePreflight(engine, sourceId, opts.brainDir) : null;
  const cycleDate = opts.cycleDate ?? await resolveCycleDate(engine);
  const heldSlugs = new Set<string>();
  const stats = { pages: 0, entries: 0, quarantined: 0, repaired: 0 };
  for (const slug of due) {
    const { appends, reflections } = run.pending[slug]!;
    const grounded = await groundTimelineAppends(engine, maintenance, appends, reflections, sourceId, cycleDate, opts.signal, heldSlugs, patternsDerivation(reflections), run);
    if (!grounded) break;
    stats.pages++;
    stats.entries += grounded.entries;
    stats.quarantined += grounded.quarantined;
    stats.repaired += grounded.repaired;
  }
  const report = await finishGroundingRun(engine, run);
  const rewritten = [...run.appendsResolved.keys()].filter(slug => !heldSlugs.has(slug)).map(slug => ({ slug, source_id: sourceId }));
  const fileHolds: string[] = [];
  if (rewritten.length) {
    if (maintenance) await verifyMaintenanceOutputs(engine, maintenance, rewritten);
    else await reverseWriteRefs(engine, opts.brainDir, rewritten, sourceId, opts.signal, fileHolds);
  }
  return { report, stats, fileHolds };
}

/**
 * The pending-append retry rides on the phase result: its failures lead `grounding_failed`; a pass that grounded
 * already lists every hold, else the retry's held appends are listed. A failed or held retry warns, even when the
 * pass skipped.
 */
function withAppendRetry(result: PhaseResult, retried: AppendRetry | null): PhaseResult {
  if (!retried) return result;
  return reportFileHolds(withGroundingRetry(result, retried), retried.fileHolds, 'page');
}

function withGroundingRetry(result: PhaseResult, retried: AppendRetry): PhaseResult {
  const { report, stats } = retried;
  const passGrounded = Array.isArray(result.details.grounding_held);
  const failed = [...report.details.grounding_failed, ...((result.details.grounding_failed ?? []) as GroundingReport['details']['grounding_failed'])];
  const held = passGrounded ? result.details.grounding_held as GroundingReport['details']['grounding_held']
    : report.details.grounding_held.filter(h => h.timeline_appends);
  const details = { ...result.details, timeline_append_retry: stats, grounding_failed: failed, grounding_held: held };
  const retryHeld = passGrounded ? 0 : held.length;
  if (!report.details.grounding_failed.length && !retryHeld) return { ...result, details };
  return { ...result, details, status: result.status === 'ok' || result.status === 'skipped' ? 'warn' : result.status,
    summary: `${result.summary}; timeline-append retry: ${report.details.grounding_failed.length} page(s) failed, ${retryHeld} held (details.grounding_failed, details.grounding_held)` };
}

async function stampProvenance(engine: BrainEngine, maintenance: MaintenanceAuthority | null,
  refs: Array<{ slug: string; source_id: string }>, cycleDate: string, sourceSlugPrefix: string, seat: string | undefined, signal: AbortSignal | undefined,
  heldSlugs: Set<string>, derivation: Derivation & { declaration: DerivationDeclaration }): Promise<void> {
  const reason = `derived from reflections under ${sourceSlugPrefix}/; raw traces live on the cited reflection pages`;
  // A pattern earns a seat only while its reflections share one, so a pattern without one drops a seat an earlier run stamped.
  if (!maintenance) return stampDreamProvenance(engine, refs.map(ref => ({ ...ref, raw_trace_exempt_reason: reason, seat: seat ?? null, derivation })), cycleDate, signal);
  for (const ref of refs) {
    throwIfAborted(signal, '[dream] patterns provenance');
    // A page whose grounding publish is held must not be stamped over the pending revision.
    if (heldSlugs.has(ref.slug)) continue;
    if (await publishOrHold(() => stampMaintenancePage(engine, maintenance, ref.slug, cycleDate, undefined, reason, seat ?? null, derivation.declaration))) heldSlugs.add(ref.slug);
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
 * `derivation` (#5575) is the pass's taint: a page this run wrote is written back at that tier. With `grounding`
 * (GBRA-130 A-23) one page whose write-back fails is recorded there and the loop moves on (run-scoped errors and a
 * systemic run still throw), and a leftover page held at its current content is skipped.
 */
export async function groundPatternPages(engine: BrainEngine, maintenance: MaintenanceAuthority | null, refs: Array<{ slug: string; source_id: string }>,
  reflections: ReflectionRef[], outputSlugPrefix: string, sourceId: string, cycleDate: string, signal?: AbortSignal, heldSlugs?: Set<string>,
  derivation?: Derivation & { declaration: DerivationDeclaration }, grounding?: GroundingRun):
  Promise<{ pages: number; quarantined: number; repaired: number } | null> {
  const { dreamQuoteVerifyEnabled, groundSource, verifyBody } = await import('./synthesize-verify.ts');
  if (!await dreamQuoteVerifyEnabled(engine)) return null;
  const leftover = (await engine.executeRaw<{ slug: string; content_hash: string | null }>(
    `SELECT slug, content_hash FROM pages WHERE source_id = $1 AND slug LIKE $2 AND deleted_at IS NULL
       AND frontmatter->>'dream_generated' = 'true' AND frontmatter->>'quote_verified_at' IS NULL`, [sourceId, `${outputSlugPrefix}/%`]))
    .filter(r => !grounding || !groundingHeld(grounding, r.slug, r.content_hash ?? null));
  const slugs = [...new Set([...refs.map(r => r.slug).filter(slug => slug.startsWith(`${outputSlugPrefix}/`)), ...leftover.map(r => r.slug)])];
  if (slugs.length === 0) return { pages: 0, quarantined: 0, repaired: 0 };
  const sources = await loadGroundingSources(engine, sourceId, reflections, groundSource);
  const stats = { pages: 0, quarantined: 0, repaired: 0 };
  const { serializePageToMarkdown } = await import('../markdown.ts');
  const run = grounding ? new ItemRun('patterns.ground_pages') : null;
  for (const slug of slugs) {
    throwIfAborted(signal, '[dream] patterns quote verify');
    let contentHash: string | null = null;
    try {
      const derived = derivation && refs.some(r => r.slug === slug) ? derivation : undefined;
      const snapshot = await engine.readPageSnapshot(slug, { sourceId });
      if (!snapshot) continue;
      contentHash = snapshot.page.content_hash ?? null;
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
      await writeGroundedPage(engine, maintenance, snapshot, serializePageToMarkdown(page, snapshot.tags), sourceId, heldSlugs, derived);
      run?.succeed();
      grounding?.grounded.add(slug);
    } catch (error) {
      if (!run || !grounding) throw error;
      grounding.failed.push({ ...run.fail(slug, error), content_hash: contentHash, timelineAppend: false });
    }
  }
  return stats;
}

/**
 * The full reflection pages a run read, grounded for quote verification. A segmented reflection is read back
 * through the segment reader (its body columns are NULL); one over the single-string ceiling is not a grounding
 * source, so a quote only it holds goes to unverified_claims, and the skip is logged.
 */
async function loadGroundingSources<T>(engine: BrainEngine, sourceId: string, reflections: Array<{ slug: string }>,
  groundSource: (path: string, content: string, opts: { tolerant: boolean }) => T): Promise<T[]> {
  const sourcePages = await engine.executeRaw<{ id: number; slug: string; body_storage: string | null; body_bytes: number | string | null; compiled_truth: string | null; timeline: string | null }>(
    'SELECT id, slug, body_storage, body_bytes, compiled_truth, timeline FROM pages WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL',
    [sourceId, reflections.map(r => r.slug)]);
  const sources: T[] = [];
  for (const p of sourcePages) {
    let body = { compiled_truth: p.compiled_truth ?? '', timeline: p.timeline ?? '' };
    if (p.body_storage === 'segmented') {
      if (Number(p.body_bytes ?? 0) > PAGE_MAX_BYTES) {
        process.stderr.write(`[dream] patterns quote verify: reflection ${p.slug} is a segmented page over ${PAGE_MAX_BYTES} bytes; it is not a grounding source.\n`);
        continue;
      }
      body = await (await import('../page-body/ingest.ts')).materializeSegmentedBody(engine, Number(p.id), sourceId);
    }
    sources.push(groundSource(p.slug, `${body.compiled_truth}\n\n${body.timeline}`, { tolerant: true }));
  }
  return sources;
}

/** Write a grounded page back at its read revision: a managed maintenance publish (held when pending or contended), else an import. */
async function writeGroundedPage(engine: BrainEngine, maintenance: MaintenanceAuthority | null, snapshot: { page: Page; revision: string },
  content: string, sourceId: string, heldSlugs?: Set<string>, derived?: Derivation & { declaration: DerivationDeclaration },
  removedEntries: TimelineAppend['entry'][] = []): Promise<void> {
  const slug = snapshot.page.slug;
  if (maintenance) {
    const { publishMaintenancePage } = await import('../persistence/prepared-maintenance.ts');
    const publish = () => publishMaintenancePage(engine, maintenance, slug, content, { expectedRevision: snapshot.revision,
      ...(derived ? { derivation: derived.declaration } : {}) });
    if (!heldSlugs) await publish();
    else if (await publishOrHold(publish)) heldSlugs.add(slug);
    return;
  }
  const [{ importFromContent }, { isAvailable }] = await Promise.all([import('../import-file.ts'), import('../ai/gateway.ts')]);
  // A managed publish projects timeline rows from the Markdown; an import does not, so a removed entry's row goes here.
  const write = async (tx: BrainEngine) => {
    const result = await importFromContent(tx, slug, content, { noEmbed: !isAvailable('embedding'), sourceId, preserveGateMarkers: true });
    for (const e of removedEntries) {
      await tx.executeRaw('DELETE FROM timeline_entries WHERE page_id = $1 AND event_page_id IS NULL AND date = $2::date AND source = $3 AND summary = $4',
        [snapshot.page.id, e.date, e.source, e.summary]);
    }
    return result;
  };
  if (!derived) await (removedEntries.length ? engine.transaction(write) : write(engine));
  else await derivedMaintenanceTransaction(engine, derived, async tx => ({ result: await write(tx), rows: [{ table: 'pages' as const, id: snapshot.page.id, sourceId }] }));
}

/**
 * #6302: quote-verify only the entries a patterns child appended with add_timeline_entry (on pages it did not
 * put_page) against this run's reflections. A failing entry leaves the timeline for frontmatter `unverified_claims`
 * (a materialized marker line in front of it goes with it); a near or normalized quote is repaired in place. Every
 * other byte of the page, earlier verified content and its stored claim sources included, is kept, and an entry no
 * longer on the page is skipped. Returns null when dream.quote_verify is off. Holds, derivation and `grounding` as
 * groundPatternPages, except that every call of one run shares the run's breaker, a failed page carries its entries and
 * reflections (pattern-grounding.ts stores them for a later run) and a page whose entries are settled (written back,
 * unchanged or gone, and not held) has them resolved.
 */
export async function groundTimelineAppends(engine: BrainEngine, maintenance: MaintenanceAuthority | null, appends: TimelineAppend[],
  reflections: Array<{ slug: string; taint?: TaintInput }>, sourceId: string, cycleDate: string, signal?: AbortSignal, heldSlugs?: Set<string>,
  derivation?: Derivation & { declaration: DerivationDeclaration }, grounding?: GroundingRun): Promise<{ entries: number; quarantined: number; repaired: number; segmented_skipped: number } | null> {
  const { dreamQuoteVerifyEnabled, groundSource, verifyBody } = await import('./synthesize-verify.ts');
  if (!await dreamQuoteVerifyEnabled(engine)) return null;
  const stats = { entries: 0, quarantined: 0, repaired: 0, segmented_skipped: 0 };
  if (appends.length === 0) return stats;
  const sources = await loadGroundingSources(engine, sourceId, reflections, groundSource);
  const { serializePageToMarkdown } = await import('../markdown.ts');
  const [{ materializedSnapshot }, { bodyUnread }] = await Promise.all([import('../persistence/segmented-apply.ts'), import('../page-body/page-shape.ts')]);
  const run = grounding ? (grounding.appendRun ??= new ItemRun('patterns.ground_timeline_appends')) : null;
  for (const slug of [...new Set(appends.map(a => a.slug))]) {
    throwIfAborted(signal, '[dream] patterns timeline quote verify');
    let contentHash: string | null = null;
    const slugAppends = appends.filter(a => a.slug === slug);
    const resolve = () => {
      if (!grounding || heldSlugs?.has(slug)) return;
      const resolved = grounding.appendsResolved.get(slug) ?? new Set<string>();
      for (const a of slugAppends) resolved.add(a.requestId);
      grounding.appendsResolved.set(slug, resolved);
    };
    try {
      // A segmented page within the single-string ceiling is read back as strings; over it, its appends stay as written (counted, logged).
      const snapshot = await materializedSnapshot(engine, await engine.readPageSnapshot(slug, { sourceId }));
      if (!snapshot) { resolve(); continue; }
      contentHash = snapshot.page.content_hash ?? null;
      if (bodyUnread(snapshot.page)) {
        stats.segmented_skipped++;
        process.stderr.write(`[dream] patterns quote verify: ${slug} is a segmented page over the single-string ceiling; its timeline appends were not verified.\n`);
        resolve();
        continue;
      }
      let timeline = snapshot.page.timeline ?? '';
      const quarantined: Array<Record<string, unknown>> = [];
      const removed: TimelineAppend['entry'][] = [];
      for (const append of slugAppends) {
        const at = timeline.indexOf(append.block);
        if (at < 0) continue;
        stats.entries++;
        const verified = verifyBody(append.block, sources, { checks: 'quotes' });
        if (verified.quarantined.length > 0) {
          stats.quarantined += verified.quarantined.length;
          quarantined.push(...verified.quarantined.map(c => ({ ...c, detected_at: cycleDate })));
          timeline = removeTimelineBlock(timeline, at, append.block.length, append.marker);
          removed.push(append.entry);
        } else if (verified.changed) {
          stats.repaired += verified.normalized + verified.near;
          timeline = timeline.slice(0, at) + verified.body + timeline.slice(at + append.block.length);
        }
      }
      if (timeline === (snapshot.page.timeline ?? '')) { resolve(); continue; }
      const frontmatter = quarantined.length
        ? withClaimSources(snapshot.page.frontmatter as Record<string, unknown>, quarantined, sources.map(x => x.path)).frontmatter
        : snapshot.page.frontmatter;
      await writeGroundedPage(engine, maintenance, snapshot, serializePageToMarkdown({ ...snapshot.page, timeline, frontmatter }, snapshot.tags),
        sourceId, heldSlugs, derivation, removed);
      run?.succeed();
      resolve();
    } catch (error) {
      if (!run || !grounding) throw error;
      grounding.failed.push({ ...run.fail(slug, error), content_hash: contentHash, timelineAppend: true,
        inputs: { appends: slugAppends, reflections: reflections.map(r => ({ slug: r.slug, ...(r.taint ? { taint: r.taint } : {}) })) } });
    }
  }
  return stats;
}

/** Cut one entry block (and the materialized marker line in front of it, when present) out of a timeline. */
function removeTimelineBlock(timeline: string, at: number, length: number, marker: string): string {
  let before = timeline.slice(0, at);
  let after = timeline.slice(at + length);
  if (before.endsWith(`${marker}\n`)) before = before.slice(0, -(marker.length + 1));
  if (after.startsWith('\n')) after = after.slice(1);
  else if (before.endsWith('\n')) before = before.slice(0, -1);
  return before + after;
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

/**
 * What a patterns child wrote: its put_page refs, the timeline entries it newly published on other pages under the
 * output prefix (#6302), every changed page as a ref, and the deprecated `appended_unverified` count.
 */
async function collectPatternOutputs(engine: BrainEngine, jobId: number, sourceId: string, outputSlugPrefix: string) {
  const putPageRefs = await collectChildPutPageSlugs(engine, [jobId], sourceId);
  const appends = (await collectChildTimelineAppends(engine, [jobId], sourceId))
    .filter(a => a.slug.startsWith(`${outputSlugPrefix}/`) && !putPageRefs.some(ref => ref.slug === a.slug));
  const writtenRefs = [...putPageRefs, ...[...new Set(appends.map(a => a.slug))].map(slug => ({ slug, source_id: sourceId }))];
  return { putPageRefs, appends, writtenRefs, appendedUnverified: await countChildTimelineAppends(engine, [jobId]) };
}

/** #6302: one entry a patterns child newly published with add_timeline_entry. */
export interface TimelineAppend { slug: string; requestId: string; block: string; marker: string; entry: { date: string; source: string; summary: string } }

/**
 * #6302: the timeline entries the given children newly published, selected by their write receipts, not by tool
 * completion: the request committed with outcome status `ok` (an entry already on the page commits as `skipped`).
 * A replayed call returns its original receipt, so each request id counts once, and two requests for one entry
 * identity (slug, date, source, summary) count once. The entry block is rendered from the call's input.
 */
async function collectChildTimelineAppends(engine: BrainEngine, childIds: number[], sourceId = 'default'): Promise<TimelineAppend[]> {
  if (childIds.length === 0) return [];
  const rows = await engine.executeRaw<{ request_id: string; slug: string; input: unknown }>(
    `SELECT r.request_id::text AS request_id, r.slug, e.input
       FROM subagent_tool_executions e
       JOIN persistence_requests r ON r.request_id::text = COALESCE(e.input->>'request_id', (e.input #>> '{}')::jsonb->>'request_id')
      WHERE e.job_id = ANY($1::int[]) AND e.tool_name = 'brain_add_timeline_entry'
        AND r.operation = 'add_timeline_entry' AND r.source_id = $2 AND r.state = 'committed' AND r.outcome->>'status' = 'ok'
      ORDER BY e.id`,
    [childIds, sourceId],
  );
  const out: TimelineAppend[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const input = (typeof row.input === 'string' ? JSON.parse(row.input) : row.input) as Record<string, unknown>;
    if (input.slug !== row.slug) continue;
    const rendered = renderTimelineEntry({ date: String(input.date), summary: String(input.summary ?? ''),
      source: String(input.source ?? ''), detail: String(input.detail ?? '') }, row.slug);
    if (!rendered) continue;
    const identity = [row.slug, rendered.canonical.date, rendered.canonical.source, rendered.canonical.summary].join('\0');
    if (seen.has(row.request_id) || seen.has(identity)) continue;
    seen.add(row.request_id).add(identity);
    out.push({ slug: row.slug, requestId: row.request_id, block: rendered.block, marker: materializedMarker(rendered.canonical), entry: rendered.canonical });
  }
  return out;
}

/** Completed `brain_add_timeline_entry` calls of the given children: the deprecated `appended_unverified` alias (#6302). */
async function countChildTimelineAppends(engine: BrainEngine, childIds: number[]): Promise<number> {
  if (childIds.length === 0) return 0;
  const [row] = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM subagent_tool_executions
      WHERE job_id = ANY($1::int[]) AND tool_name = 'brain_add_timeline_entry' AND status = 'complete'`,
    [childIds],
  );
  return Number(row?.n ?? 0);
}

// ── Reverse-write ────────────────────────────────────────────────────

import { renderTimelineEntry } from '../timeline-write-through.ts';
import { materializedMarker } from '../timeline-marker.ts';

/** Reverse-render each pattern page to its markdown file (`reverseWriteDreamRefs`, #6982); holds go to `held`. */
async function reverseWriteRefs(engine: BrainEngine, brainDir: string, refs: Array<{ slug: string; source_id: string }>,
  nativeSourceId = 'default', signal?: AbortSignal, held?: string[]): Promise<number> {
  return reverseWriteDreamRefs(engine, brainDir, refs, { phase: 'patterns', nativeSourceId, signal, held, render: renderPageToMarkdown });
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

/**
 * #5575: the owner pass is the phase result; the external pass (null when
 * its reflections were below min_evidence) rides in `details.external_pass`
 * and its pages count toward `patterns_written`. An owner pass skipped for
 * lack of owner evidence takes the external pass's status; a failed or
 * warned external pass turns an ok owner pass into a warning.
 */
function mergeExternalPass(owner: PhaseResult, external: PhaseResult | null, externalReflections: number): PhaseResult {
  const details = { ...owner.details, reflections_external: externalReflections,
    patterns_written: Number(owner.details.patterns_written ?? 0) + Number(external?.details.patterns_written ?? 0),
    ...(external ? { external_pass: { status: external.status, summary: external.summary, details: external.details,
      ...(external.error ? { error: external.error } : {}) } } : {}) };
  if (!external) return { ...owner, details };
  const summary = `${owner.summary}; external reflections pass: ${external.summary}`;
  if (owner.status === 'skipped') return { ...external, summary, details };
  const degraded = owner.status === 'ok' && (external.status === 'fail' || external.status === 'warn');
  return { ...owner, summary, details, ...(degraded ? { status: 'warn' as const } : {}) };
}

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
  buildPatternsPrompt,
  collectChildTimelineAppends,
  countChildTimelineAppends,
  gatherReflections,
  collectChildPutPageSlugs,
  reverseWriteRefs,
};
