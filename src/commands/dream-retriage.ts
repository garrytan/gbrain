/**
 * `gbrain dream retriage` (#4152) — re-score the corpus and reconcile the
 * synth-v2 job backlog against the triage gate.
 *
 * Two halves, both optional:
 *   1. Re-judge: sweep the discovered corpus through runTriagePass
 *      (`--force` ignores the cache; `--since` treats older verdicts as
 *      stale; `--dry-run` performs ZERO judge calls and reads cached scores
 *      only). Spend-gated: prints an upfront estimate and asks for
 *      confirmation above ~$5 (`--yes` skips; `--max-usd` soft-stops).
 *   2. `--reconcile-queue` (opt-in — cancels queued work): parse every
 *      waiting/delayed/paused `dream:synth-v2:*` job across ALL queues (the
 *      live backlog largely sits in dead per-run `dream-inline-*` queues no
 *      worker will ever drain), match (basename, hash16) to discovered
 *      transcripts, then:
 *        - matched below threshold      → cancel (frontier job not worth it)
 *        - matched above, stale queue   → cancel as `converted_for_resubmit`
 *          (cancelled rows release their idempotency slot, so the next cycle
 *          re-adds them into ITS live private drain — this is what actually
 *          migrates the backlog, outside-voice C1)
 *        - matched above, live queue    → keep
 *        - matched but unscored         → keep (never cancel on no data)
 *        - unmatched                    → keep unless `--cancel-unmatched`
 *        - key-source ≠ data.source_id  → skip + count (C9 hardening)
 *      Cancellation is best-effort: status is re-checked immediately before
 *      each cancel and rows that turned `active` are skipped; the residual
 *      claim-vs-cancel race matches cancelJob's own BullMQ-style contract.
 *
 * `--audit-rejects <n>` (C6): re-judges N stride-sampled (deterministic) below-threshold files with
 * the SYNTHESIS model and reports the disagreement rate — the operator-run
 * calibration loop for `dream.triage.threshold`.
 *
 * Exit codes: 0 success (even when nothing cancelled), 1 missing corpus
 * config / engine, 2 usage error.
 */

import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type { BrainEngine, DreamVerdict } from '../core/engine.ts';
import {
  loadSynthConfig,
  runTriagePass,
  parseSynthV2Key,
  makeJudgeClient,
  judgeSignificance,
  isTriageCacheValid,
  dreamInlineQueueAgeMs,
  DREAM_INLINE_LIVE_GRACE_MS,
  CHARS_PER_TOKEN,
  type TriageFileReport,
} from '../core/cycle/synthesize.ts';
import { discoverTranscripts } from '../core/cycle/transcript-discovery.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import { canonicalLookup } from '../core/model-pricing.ts';
import { SPEND_CONFIRM_USD, UNPRICED_CONFIRM_FILES } from './dream-retriage-constants.ts';

interface RetriageArgs {
  help: boolean;
  threshold: number | null;
  since: Date | null;
  force: boolean;
  reconcileQueue: boolean;
  cancelUnmatched: boolean;
  dryRun: boolean;
  limit: number | null;
  source: string | null;
  json: boolean;
  yes: boolean;
  maxUsd: number | null;
  auditRejects: number | null;
}

class UsageError extends Error {}

function parseRetriageArgs(args: string[]): RetriageArgs {
  const out: RetriageArgs = {
    help: false,
    threshold: null,
    since: null,
    force: false,
    reconcileQueue: false,
    cancelUnmatched: false,
    dryRun: false,
    limit: null,
    source: null,
    json: false,
    yes: false,
    maxUsd: null,
    auditRejects: null,
  };
  const takeValue = (flag: string, i: number): string => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--help': case '-h': out.help = true; break;
      case '--force': out.force = true; break;
      case '--reconcile-queue': out.reconcileQueue = true; break;
      case '--cancel-unmatched': out.cancelUnmatched = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--json': out.json = true; break;
      case '--yes': out.yes = true; break;
      case '--threshold': {
        const v = Number(takeValue(a, i)); i++;
        if (!Number.isFinite(v) || v < 0 || v > 1) throw new UsageError('--threshold must be a number in [0,1]');
        out.threshold = v;
        break;
      }
      case '--since': {
        const raw = takeValue(a, i); i++;
        const ms = Date.parse(raw);
        if (Number.isNaN(ms)) throw new UsageError(`--since could not parse date: ${raw}`);
        out.since = new Date(ms);
        break;
      }
      case '--limit': {
        const v = parseInt(takeValue(a, i), 10); i++;
        if (!Number.isFinite(v) || v < 1) throw new UsageError('--limit must be a positive integer');
        out.limit = v;
        break;
      }
      case '--source': case '--source-id': {
        out.source = takeValue(a, i); i++;
        break;
      }
      case '--max-usd': {
        const v = Number(takeValue(a, i)); i++;
        if (!Number.isFinite(v) || v <= 0) throw new UsageError('--max-usd must be a positive number');
        out.maxUsd = v;
        break;
      }
      case '--audit-rejects': {
        const v = parseInt(takeValue(a, i), 10); i++;
        if (!Number.isFinite(v) || v < 1) throw new UsageError('--audit-rejects must be a positive integer');
        out.auditRejects = v;
        break;
      }
      default:
        throw new UsageError(`unknown flag for dream retriage: ${a}`);
    }
  }
  if (out.cancelUnmatched && !out.reconcileQueue) {
    throw new UsageError('--cancel-unmatched requires --reconcile-queue');
  }
  // CX2: a corpus scan truncated by --limit would misclassify every file outside
  // the slice as "unmatched" — combining it with --cancel-unmatched would
  // mass-cancel valid backlog.
  if (out.cancelUnmatched && out.limit !== null) {
    throw new UsageError('--cancel-unmatched cannot combine with --limit: a truncated scan misclassifies files as unmatched');
  }
  return out;
}

function printRetriageHelp(): void {
  console.log(`gbrain dream retriage — re-score the corpus, reconcile the synth backlog

USAGE
  gbrain dream retriage [flags]

FLAGS
  --threshold <0..1>   Gate override for this sweep (default: dream.triage.threshold)
  --since <date>       Treat verdicts judged before <date> as stale (re-judge)
  --force              Re-judge every discovered file regardless of cache
  --limit <n>          Only consider the first n discovered transcripts
  --dry-run            Zero judge calls, zero cancels; report from cached scores
  --reconcile-queue    Cancel waiting synth jobs per the gate (opt-in; see below)
  --cancel-unmatched   With --reconcile-queue: also cancel jobs whose file no
                       longer matches any discovered transcript
  --source <id>        Scope queue reconciliation to one source's jobs
  --yes                Skip the spend confirmation
  --max-usd <n>        Soft-stop judging when the ESTIMATED spend crosses n
                       (estimate-based; every judge attempt counts, including
                       unreliable responses; may overshoot by up to the
                       configured concurrency; requires a priced model; also
                       bounds --audit-rejects)
  --audit-rejects <n>  Re-judge n stride-sampled (deterministic) below-threshold
                       files with the SYNTHESIS model; report the disagreement
                       rate. Skipped under --dry-run. Counted in the spend gate.
  --json               Machine-readable output
  --help               This text

NOTES
  --cancel-unmatched cannot combine with --limit (a truncated corpus scan
  would misclassify everything outside the slice as unmatched), and refuses
  to run when discovery finds zero transcripts (a corpus-mount outage must
  not erase the queued retry frontier). dream-inline-* queues younger than
  1h are treated as possibly LIVE (a running cycle's drain) and are never
  cancelled — they count as kept_live_queue. Running retriage while a cycle
  is active may double-judge some cache misses (benign: last write wins).

RECONCILE SEMANTICS
  matched + score <  threshold                  cancel
  matched + score >= threshold, dead dream-inline-* queue (older than 1h)
                                                cancel (converted_for_resubmit —
                                                next cycle re-adds it into a live drain)
  matched + score >= threshold, live queue      keep
  matched, no reliable score                    keep
  unmatched / unparseable key                   keep (cancel with --cancel-unmatched)
  legacy dream:synth: (v1) keys                 never touched

Cancelled rows release their idempotency slot, so lowering the threshold
later cleanly re-submits the work.`);
}

interface QueueCandidate {
  id: number;
  queue: string;
  status: string;
  idempotency_key: string;
  source_id: string;
}

interface ReconcileStats {
  candidates: number;
  cancelled: number;
  converted_for_resubmit: number;
  kept_above_threshold: number;
  kept_unscored: number;
  /** Rows in a dream-inline-* queue younger than the liveness grace — possibly a running cycle's; never cancelled (CX1). */
  kept_live_queue: number;
  unmatched: number;
  unmatched_cancelled: number;
  source_mismatch: number;
  other_source: number;
  already_terminal: number;
  by_source: Record<string, number>;
  by_queue_kind: { dream_inline: number; other: number };
}

/** Per-file cost estimate in USD for one triage judge call; null when the model is unpriced. */
function estimatePerFileUsd(model: string, maxChars: number, maxTokens: number): number | null {
  const pricing = canonicalLookup(model);
  if (!pricing) return null;
  const inputTokens = maxChars / CHARS_PER_TOKEN;
  return (inputTokens / 1_000_000) * pricing.input + (maxTokens / 1_000_000) * pricing.output;
}

async function confirmOnTty(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>(resolve => rl.question(`${prompt} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function runDreamRetriage(engine: BrainEngine | null, args: string[]): Promise<void> {
  let parsed: RetriageArgs;
  try {
    parsed = parseRetriageArgs(args);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`dream retriage: ${e.message} (see: gbrain dream retriage --help)`);
      setCliExitVerdict(2);
      return;
    }
    throw e;
  }
  // IRON RULE: --help short-circuits before any engine-bearing work.
  if (parsed.help) {
    printRetriageHelp();
    return;
  }
  if (engine === null) {
    console.error('gbrain dream retriage requires a connected brain; run `gbrain init` first');
    setCliExitVerdict(1);
    return;
  }

  const config = await loadSynthConfig(engine);
  if (!config.corpusDir) {
    console.error('dream retriage: dream.synthesize.session_corpus_dir is unset — nothing to retriage');
    setCliExitVerdict(1);
    return;
  }
  const threshold = parsed.threshold ?? config.triage.threshold;

  let transcripts = discoverTranscripts({
    corpusDir: config.corpusDir,
    meetingTranscriptsDir: config.meetingTranscriptsDir ?? undefined,
    minChars: config.minChars,
    excludePatterns: config.excludePatterns,
  });
  if (parsed.limit !== null) transcripts = transcripts.slice(0, parsed.limit);

  // ── Half 1: score the corpus (cached reads in --dry-run; judged otherwise) ──
  let reports: TriageFileReport[];
  const byPath = new Map<string, DreamVerdict>();
  let passStats = { judged: 0, cacheHits: 0, unreliable: 0, deferred: 0 };
  // Estimated spend accumulated across the triage sweep AND the reject audit —
  // one budget spans both halves (CX3 + security review).
  let estimatedSpendUsd = 0;

  if (parsed.dryRun) {
    // Zero judge calls: read cached verdicts only. Files without a valid
    // triage-v1 score report as needs_triage.
    reports = [];
    for (const t of transcripts) {
      const cached = await engine.getDreamVerdict(t.filePath, t.contentHash);
      const valid = cached !== null && !parsed.force
        && isTriageCacheValid(cached, config.triage.model, parsed.since ?? undefined);
      if (cached && valid) {
        passStats.cacheHits++;
        byPath.set(t.filePath, cached);
        reports.push({
          filePath: t.filePath,
          worth: cached.score !== null && cached.score >= threshold,
          score: cached.score,
          content_type: cached.content_type,
          reasons: cached.reasons,
          cached: true,
        });
      } else {
        reports.push({
          filePath: t.filePath,
          worth: false,
          score: null,
          content_type: null,
          reasons: ['needs_triage (dry-run performs no judge calls)'],
          cached: false,
          deferred: true,
        });
        passStats.deferred++;
      }
    }
  } else {
    // Spend gate (outside-voice C12): estimate the miss count upfront and
    // confirm above SPEND_CONFIRM_USD unless --yes.
    let missCount = 0;
    for (const t of transcripts) {
      if (parsed.force) { missCount++; continue; }
      const cached = await engine.getDreamVerdict(t.filePath, t.contentHash);
      const valid = cached !== null
        && isTriageCacheValid(cached, config.triage.model, parsed.since ?? undefined);
      if (!valid) missCount++;
    }
    const perFileUsd = estimatePerFileUsd(config.triage.model, config.triage.maxChars, config.triage.maxTokens);
    // CX3: --max-usd is estimate-based; an unpriced model would silently
    // disable the budget the operator explicitly asked for — refuse instead.
    if (parsed.maxUsd !== null && perFileUsd === null) {
      console.error(
        `dream retriage: --max-usd requires a priced model; "${config.triage.model}" has no CANONICAL_PRICING entry`,
      );
      setCliExitVerdict(2);
      return;
    }
    // The frontier audit spends too (security review): fold its worst case
    // into the gated estimate so --audit-rejects can't ride around the gate.
    const auditPerFileUsd = parsed.auditRejects !== null
      ? estimatePerFileUsd(config.model, config.triage.maxChars, config.triage.maxTokens)
      : null;
    // Codex structured review P1: an unpriced SYNTHESIS model would zero out
    // the audit's share of the estimate AND silently disable --max-usd inside
    // the audit loop — refuse the budget flag, and always confirm when the
    // audit spend cannot be estimated.
    const auditUnpriced = parsed.auditRejects !== null && auditPerFileUsd === null;
    if (parsed.maxUsd !== null && auditUnpriced) {
      console.error(
        `dream retriage: --max-usd with --audit-rejects requires a priced synthesis model; ` +
        `"${config.model}" has no CANONICAL_PRICING entry`,
      );
      setCliExitVerdict(2);
      return;
    }
    const auditEstimateUsd = parsed.auditRejects !== null && auditPerFileUsd !== null
      ? parsed.auditRejects * auditPerFileUsd
      : 0;
    // Structured-review round 2 P1: the KNOWN portion of the estimate gates
    // independently of whether the triage model is priced — an unpriced
    // triage model with a large PRICED audit must still confirm on the audit
    // dollars, not slide through the file-count gate on cached rejects.
    const knownEstimateUsd = (perFileUsd ?? 0) * missCount + auditEstimateUsd;
    const estimateUsd = perFileUsd === null ? null : knownEstimateUsd;
    const gateTriggered = knownEstimateUsd > SPEND_CONFIRM_USD
      || (perFileUsd === null && missCount > UNPRICED_CONFIRM_FILES)
      || auditUnpriced; // un-estimable audit spend always confirms
    const auditSuffix = auditUnpriced
      ? ` (audit model "${config.model}" unpriced — audit spend cannot be estimated)`
      : auditEstimateUsd > 0 ? ` (incl. ≤ $${auditEstimateUsd.toFixed(2)} audit)` : '';
    const estimateLine = estimateUsd !== null
      ? `[retriage] ${missCount} file(s) to judge with ${config.triage.model} — estimated ≤ $${estimateUsd.toFixed(2)}${auditSuffix}`
      : `[retriage] ${missCount} file(s) to judge with ${config.triage.model} — no pricing entry for this model (cannot estimate; the ${UNPRICED_CONFIRM_FILES}-file confirmation gate applies)${auditSuffix}`;
    process.stderr.write(estimateLine + '\n');
    if (gateTriggered && !parsed.yes) {
      if (parsed.json || !process.stdin.isTTY) {
        console.error('dream retriage: spend estimate exceeds the confirmation gate; re-run with --yes (non-interactive)');
        setCliExitVerdict(2);
        return;
      }
      const ok = await confirmOnTty(`Proceed with ~$${estimateUsd?.toFixed(2) ?? '?'} of triage spend?`);
      if (!ok) {
        console.error('dream retriage: aborted at spend confirmation');
        setCliExitVerdict(2);
        return;
      }
    }

    // --max-usd soft-stop: estimate-based (usage isn't threaded through the
    // judge seam); stops pulling new misses once attempts × per-file estimate
    // crosses the budget. runTriagePass ticks shouldStop on EVERY judge
    // attempt (CX3 — unreliable responses are paid calls too); may overshoot
    // by up to the configured concurrency. Remaining files report as deferred.
    const shouldStop = parsed.maxUsd !== null && perFileUsd !== null
      ? (): boolean => {
          estimatedSpendUsd += perFileUsd;
          return estimatedSpendUsd >= parsed.maxUsd!;
        }
      : undefined;

    const pass = await runTriagePass(engine, transcripts, {
      model: config.triage.model,
      maxChars: config.triage.maxChars,
      maxTokens: config.triage.maxTokens,
      threshold,
      concurrency: config.triage.concurrency,
      maxMs: 0, // operator sweep runs to completion; --limit / --max-usd bound it
      force: parsed.force,
      staleBefore: parsed.since ?? undefined,
      shouldStop,
    });
    reports = pass.reports;
    for (const [k, v] of pass.byPath) byPath.set(k, v);
    passStats = { judged: pass.judged, cacheHits: pass.cacheHits, unreliable: pass.unreliable, deferred: pass.deferred };
  }

  // ── Half 2: queue reconciliation (opt-in) ──
  let reconcile: ReconcileStats | null = null;
  if (parsed.reconcileQueue) {
    const queue = new MinionQueue(engine);
    const rows = await engine.executeRaw<QueueCandidate>(
      `SELECT id, queue, status, idempotency_key,
              COALESCE(NULLIF(data->>'source_id', ''), 'default') AS source_id
         FROM minion_jobs
        WHERE name = 'subagent'
          AND status IN ('waiting', 'delayed', 'paused')
          AND (idempotency_key LIKE 'dream:synth-v2:%' OR queue LIKE 'dream-inline-%')`,
    );
    // #4250: the queue-LIKE arm pulls in NON-synth children stranded in
    // private per-run queues (patterns mints dream-inline-* queues too).
    // Doctor's orphaned_private_queue check points operators HERE; a repair
    // that can't even select the flagged rows is a dead end. Non-synth rows
    // skip the verdict pipeline and are handled by the dead-inline
    // conversion branch below.
    // Two lookups: membership in the discovered corpus (matched at all?) vs a
    // usable scored verdict. A discovered file with no reliable score is
    // "matched but unscored" — kept, never cancelled on missing data. The
    // '|' join is unambiguous even for basenames containing '|': hash16 is
    // fixed-width hex after the final separator.
    const discoveredKeys = new Set<string>();
    const verdictByKey = new Map<string, DreamVerdict>();
    for (const t of transcripts) {
      const k = `${basename(t.filePath)}|${t.contentHash.slice(0, 16)}`;
      discoveredKeys.add(k);
      const v = byPath.get(t.filePath);
      if (v) verdictByKey.set(k, v);
    }
    // CX2: an empty discovery result alongside a non-empty backlog means the
    // corpus is unreachable (mount outage, permissions, wrong dir) far more
    // often than it means every file was deleted. Refuse to cancel-unmatched
    // in that state — a transient outage must not erase the retry frontier.
    if (parsed.cancelUnmatched && transcripts.length === 0 && rows.length > 0) {
      console.error(
        `dream retriage: discovery found 0 transcripts but ${rows.length} queued job(s) exist; ` +
        'refusing --cancel-unmatched (corpus may be unreachable). Fix discovery or drop the flag.',
      );
      setCliExitVerdict(2);
      return;
    }
    reconcile = {
      candidates: rows.length,
      cancelled: 0,
      converted_for_resubmit: 0,
      kept_above_threshold: 0,
      kept_unscored: 0,
      kept_live_queue: 0,
      unmatched: 0,
      unmatched_cancelled: 0,
      source_mismatch: 0,
      other_source: 0,
      already_terminal: 0,
      by_source: {},
      by_queue_kind: { dream_inline: 0, other: 0 },
    };
    // Codex structured review P2: queue age alone is not liveness — a cycle
    // with several slow sequential children can legitimately exceed the 1h
    // grace. Consult the REAL signal: a live (unexpired) cycle lock means a
    // cycle is running right now, so no dream-inline queue is provably dead.
    // Liveness matches db-lock's model: unexpired TTL OR refreshed within the
    // steal grace (a starved-but-alive holder must keep suppressing repair).
    const { resolveStealGraceSeconds } = await import('../core/db-lock.ts');
    const { LOCK_TTL_MINUTES } = await import('../core/cycle.ts');
    const stealGraceSecs = resolveStealGraceSeconds(LOCK_TTL_MINUTES);
    const liveLocks = await engine.executeRaw<{ id: string; acquired_epoch_ms: string | number | null }>(
      `SELECT id, EXTRACT(EPOCH FROM acquired_at) * 1000 AS acquired_epoch_ms
         FROM gbrain_cycle_locks
        WHERE (ttl_expires_at > NOW()
               OR last_refreshed_at > NOW() - make_interval(secs => ${Number(stealGraceSecs)}))
          AND id LIKE 'gbrain-cycle%'`,
    );
    // Structured-review round 2 P2: cycle locks are per-source
    // (`gbrain-cycle:<source>`) — a cycle running for source A must not
    // suppress conversions for source B indefinitely. Only the legacy bare
    // `gbrain-cycle` lock is global.
    //
    // #4250 ownership correlation (mirrors doctor's orphaned_private_queue):
    // lock existence is NOT queue ownership. A dream-inline queue whose
    // name-embedded birth PREDATES the live lock's acquired_at cannot belong
    // to that holder — an older crashed cycle's queue stays repairable while
    // a new cycle runs. Unknown birth or unparseable acquired_at stays
    // fail-safe possibly-live.
    const lockAcquiredMs = new Map<string, number>(
      liveLocks.map(l => [l.id, Number(l.acquired_epoch_ms ?? Number.NaN)]),
    );
    const globalLockLive = liveLocks.some(l => l.id === 'gbrain-cycle');
    const liveLockSources = new Set(
      liveLocks
        .map(l => (l.id.startsWith('gbrain-cycle:') ? l.id.slice('gbrain-cycle:'.length) : null))
        .filter((s): s is string => s !== null),
    );
    const nowMsForBirth = Date.now();
    /**
     * A live lock suppresses a queue only if it could OWN it: queue born
     * at/after acquisition (or birth/acquisition unknown — fail-safe). The
     * 60s tolerance absorbs host-clock (queue-name Date.now) vs DB-clock
     * (acquired_at NOW()) skew — the maintenance lane mints its queue
     * seconds after acquiring the lock.
     */
    const OWNERSHIP_SKEW_TOLERANCE_MS = 60_000;
    const lockCouldOwnQueue = (lockId: string, queueAgeMs: number | null): boolean => {
      const acquired = lockAcquiredMs.get(lockId);
      if (acquired === undefined) return false; // lock not live
      if (queueAgeMs === null || !Number.isFinite(acquired)) return true; // fail-safe
      return (nowMsForBirth - queueAgeMs) >= acquired - OWNERSHIP_SKEW_TOLERANCE_MS;
    };
    if (liveLocks.length > 0) {
      process.stderr.write(
        `[retriage] live cycle lock(s) detected (${liveLocks.map(l => l.id).join(', ')}); ` +
        `dream-inline queues for those sources are treated as possibly-live — conversions skipped\n`,
      );
    }
    const cancelRow = async (id: number): Promise<'cancelled' | 'already_terminal'> => {
      // Pre-cancel status re-check (C9): a candidate claimed by a live worker
      // between the snapshot SELECT and now is skipped, not killed.
      const fresh = await engine.executeRaw<{ status: string }>(
        `SELECT status FROM minion_jobs WHERE id = $1`, [id],
      );
      const status = fresh[0]?.status;
      if (status !== 'waiting' && status !== 'delayed' && status !== 'paused') return 'already_terminal';
      const r = await queue.cancelJob(id);
      return r ? 'cancelled' : 'already_terminal';
    };
    for (const row of rows) {
      reconcile.by_source[row.source_id] = (reconcile.by_source[row.source_id] ?? 0) + 1;
      const inlineQueueAge = dreamInlineQueueAgeMs(row.queue);
      const isInlineQueue = inlineQueueAge !== null || row.queue.startsWith('dream-inline-');
      if (isInlineQueue) reconcile.by_queue_kind.dream_inline++;
      else reconcile.by_queue_kind.other++;
      // CX1: a dream-inline-* queue younger than the liveness grace may belong
      // to a cycle that is RUNNING right now — its inline drain will claim
      // these rows. Never cancel anything in a possibly-live private queue
      // (unparseable-timestamp names count as possibly-live, fail-safe), and
      // a live cycle lock FOR THIS ROW'S SOURCE marks its inline queues
      // possibly-live regardless of age (structured-review P2: slow
      // sequential children can outlive the grace; round 2: per-source, so a
      // busy source A never suppresses source B's cleanup indefinitely).
      const lockLiveForRow =
        (globalLockLive && lockCouldOwnQueue('gbrain-cycle', inlineQueueAge))
        || (liveLockSources.has(row.source_id) && lockCouldOwnQueue(`gbrain-cycle:${row.source_id}`, inlineQueueAge));
      const possiblyLiveQueue = isInlineQueue
        && (lockLiveForRow || inlineQueueAge === null || inlineQueueAge <= DREAM_INLINE_LIVE_GRACE_MS);
      if (possiblyLiveQueue) {
        reconcile.kept_live_queue++;
        continue;
      }

      if (parsed.source !== null && row.source_id !== parsed.source) {
        reconcile.other_source++;
        continue;
      }
      const key = parseSynthV2Key(row.idempotency_key);
      if (!key) {
        // #4250: a NON-synth child (e.g. patterns) stranded in a provably-dead
        // dream-inline queue has no verdict to consult and will never be
        // claimed — convert it like the C1 branch below so doctor's
        // orphaned_private_queue repair path actually repairs. The
        // possibly-live filter above already kept anything a running cycle
        // could own. Non-inline rows keep the unmatched bookkeeping.
        if (isInlineQueue && (row.status === 'waiting' || row.status === 'delayed')) {
          if (!parsed.dryRun) {
            const outcome = await cancelRow(row.id);
            if (outcome === 'cancelled') reconcile.converted_for_resubmit++;
            else reconcile.already_terminal++;
          } else {
            reconcile.converted_for_resubmit++; // dry-run: would convert
          }
        } else {
          reconcile.unmatched++;
        }
        continue;
      }
      // C9 hardening: the key's encoded source must agree with the payload's
      // source_id — never cancel on a disagreement.
      if ((key.source || 'default') !== row.source_id) {
        reconcile.source_mismatch++;
        continue;
      }
      const matchKey = `${key.basename}|${key.hash16}`;
      const verdict = verdictByKey.get(matchKey);
      if (!verdict || verdict.score === null) {
        // Unmatched file OR matched-but-unscored (deferred/degraded): only the
        // truly-unmatched are cancellable, and only behind --cancel-unmatched.
        const isMatchedUnscored = discoveredKeys.has(matchKey);
        if (isMatchedUnscored) {
          reconcile.kept_unscored++;
        } else if (parsed.cancelUnmatched) {
          // Structured-review P2: the dry-run preview must count would-cancel
          // unmatched rows the same way the below-threshold branch does — a
          // destructive preview that understates its impact is worse than none.
          if (parsed.dryRun) {
            reconcile.unmatched_cancelled++; // dry-run: would cancel
          } else {
            const outcome = await cancelRow(row.id);
            if (outcome === 'cancelled') reconcile.unmatched_cancelled++;
            else reconcile.already_terminal++;
          }
        } else {
          reconcile.unmatched++;
        }
        continue;
      }
      if (verdict.score < threshold) {
        if (!parsed.dryRun) {
          const outcome = await cancelRow(row.id);
          if (outcome === 'cancelled') reconcile.cancelled++;
          else reconcile.already_terminal++;
        } else {
          reconcile.cancelled++; // dry-run: would cancel
        }
        continue;
      }
      // Above threshold. C1: a row stranded in a provably-dead per-run
      // dream-inline-* queue (older than the liveness grace, no live cycle
      // lock — the possibly-live case was already kept above) will never be
      // claimed — cancel it so the next cycle's queue.add re-creates it in a
      // live drain (the cancelled row releases its idempotency slot).
      // `delayed` counts too (structured-review P2): a transient-failure
      // retry parked in a dead queue has no worker to promote or drain it.
      if (isInlineQueue && (row.status === 'waiting' || row.status === 'delayed')) {
        if (!parsed.dryRun) {
          const outcome = await cancelRow(row.id);
          if (outcome === 'cancelled') reconcile.converted_for_resubmit++;
          else reconcile.already_terminal++;
        } else {
          reconcile.converted_for_resubmit++; // dry-run: would convert
        }
        continue;
      }
      reconcile.kept_above_threshold++;
    }
  }

  // ── --audit-rejects (C6): frontier second opinion on N stride-sampled rejects ──
  let audit: { sampled: number; disagreements: number; disagreement_rate: number | null } | null = null;
  if (parsed.auditRejects !== null && parsed.dryRun) {
    // Loud no-op instead of a silently-null audit field (maintainability review).
    process.stderr.write('[retriage] --audit-rejects skipped under --dry-run (the audit spends frontier-model calls)\n');
  }
  if (parsed.auditRejects !== null && !parsed.dryRun) {
    const rejects = reports.filter(r => r.score !== null && r.score < threshold);
    // Deterministic stride-sample over the rejects in discovery order — no
    // randomness, so repeated audits compare like with like.
    const sample: TriageFileReport[] = [];
    const stride = Math.max(1, Math.floor(rejects.length / parsed.auditRejects));
    for (let i = 0; i < rejects.length && sample.length < parsed.auditRejects; i += stride) sample.push(rejects[i]);
    const frontier = makeJudgeClient(config.model);
    if (!frontier) {
      process.stderr.write(`[retriage] --audit-rejects: no reachable provider for ${config.model}; skipping audit\n`);
    } else {
      const byFilePath = new Map(transcripts.map(t => [t.filePath, t]));
      const auditPerFileUsd = estimatePerFileUsd(config.model, config.triage.maxChars, config.triage.maxTokens);
      let disagreements = 0;
      let judged = 0;
      for (const r of sample) {
        const t = byFilePath.get(r.filePath);
        if (!t) continue;
        // --max-usd spans the audit too (CX3): stop before the next frontier
        // call would cross the budget.
        if (parsed.maxUsd !== null && auditPerFileUsd !== null
            && estimatedSpendUsd + auditPerFileUsd > parsed.maxUsd) {
          process.stderr.write(`[retriage] --audit-rejects stopped at --max-usd $${parsed.maxUsd.toFixed(2)} (audited ${judged})\n`);
          break;
        }
        try {
          const second = await judgeSignificance(frontier, t, config.model, {
            maxChars: config.triage.maxChars,
            maxTokens: config.triage.maxTokens,
          });
          estimatedSpendUsd += auditPerFileUsd ?? 0;
          if (second.unreliable) continue;
          judged++;
          if (second.score >= threshold) disagreements++;
        } catch {
          // A failed call is still an attempt — count its estimated cost.
          estimatedSpendUsd += auditPerFileUsd ?? 0;
          // Audit is best-effort; a failed second opinion is skipped.
        }
      }
      audit = {
        sampled: judged,
        disagreements,
        disagreement_rate: judged > 0 ? Math.round((disagreements / judged) * 1000) / 1000 : null,
      };
    }
  }

  const passCount = reports.filter(r => r.worth).length;
  const summary = {
    discovered: transcripts.length,
    threshold,
    pass: passCount,
    below_threshold: reports.filter(r => r.score !== null && !r.worth).length,
    needs_triage: reports.filter(r => r.deferred).length,
    retriaged: passStats.judged,
    cache_hits: passStats.cacheHits,
    unreliable: passStats.unreliable,
    deferred: passStats.deferred,
    dry_run: parsed.dryRun,
    queue: reconcile,
    audit,
  };

  if (parsed.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const would = parsed.dryRun ? ' (dry-run: no cancels performed)' : '';
    console.log(`[retriage] ${summary.discovered} discovered | ${summary.pass} pass @ threshold ${threshold} | ` +
      `${summary.below_threshold} below | ${summary.needs_triage} need triage | ` +
      `${summary.retriaged} judged, ${summary.cache_hits} cached, ${summary.unreliable} unreliable`);
    if (reconcile) {
      console.log(`[retriage] queue: ${reconcile.candidates} candidates | ${reconcile.cancelled} cancelled | ` +
        `${reconcile.converted_for_resubmit} converted for resubmit | ${reconcile.kept_above_threshold} kept | ` +
        `${reconcile.kept_unscored} unscored kept | ${reconcile.kept_live_queue} live-queue kept | ${reconcile.unmatched} unmatched | ` +
        `${reconcile.source_mismatch} source-mismatch skipped | ${reconcile.already_terminal} already terminal${would}`);
      const bySource = Object.entries(reconcile.by_source).map(([s, n]) => `${s}=${n}`).join(', ');
      if (bySource) console.log(`[retriage] queue by source: ${bySource} | stale dream-inline queues: ${reconcile.by_queue_kind.dream_inline}`);
    }
    if (audit) {
      console.log(`[retriage] reject audit: ${audit.sampled} re-judged by ${config.model}, ` +
        `${audit.disagreements} disagreements (rate ${audit.disagreement_rate ?? 'n/a'})`);
    }
  }
}
