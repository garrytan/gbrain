/**
 * loops-enqueue — how a Gmail sweep hands threads to the open-loop engine:
 * the per-thread deterministic detection hook and the post-sweep
 * `loops_extract` enqueue (peeled from google-source.ts).
 */
import type { GmailThreadData } from './types.ts';
import type { ThreadLoopVerdict } from './loop-detect.ts';
import { pendingLoopsExtractDepth, type LoopsEnqueueReport } from './loop-catchup.ts';
import { myAddressSet, type GoogleSyncDeps } from './sweep-shared.ts';
import type { GmailClient } from './google-clients.ts';
import { excludedLabelTokens, NO_EXCLUSION, resolveExcludedLabels, storeLoopsExclusion, type LoopsExclusionPolicy } from './loops-exclusion.ts';

/**
 * #5445: resolves the source's loop exclusion labels once per sweep (one
 * `getLabels` call when anything is configured), stores the resolution for
 * the job handler and the hold publication, and names every unresolved
 * label on stderr. A failed label list resolves id tokens only, so names
 * stay unresolved and the sweep fails closed for new paid extraction.
 */
export async function resolveSweepExclusion(deps: Pick<GoogleSyncDeps, 'engine' | 'sourceId' | 'cfg' | 'opts' | 'log'>, gmail: Pick<GmailClient, 'getLabels'>): Promise<LoopsExclusionPolicy> {
  const tokens = await excludedLabelTokens(deps.engine, deps.cfg);
  if (tokens.length === 0) return NO_EXCLUSION;
  let catalog: Array<{ id: string; name: string }> | null = null;
  try {
    catalog = await gmail.getLabels(deps.opts.signal ? { signal: deps.opts.signal } : {});
  } catch (e) {
    deps.log(`[google] loop exclusion: could not read the account's labels (${e instanceof Error ? e.message : String(e)}); label names stay unresolved this sweep`);
  }
  const policy = resolveExcludedLabels(tokens, catalog);
  if (policy.unresolved.length > 0) {
    deps.log(`[google] loop exclusion: ${policy.unresolved.map((t) => JSON.stringify(t)).join(', ')} ${policy.unresolved.length === 1 ? 'is not a label' : 'are not labels'} of ${deps.cfg.account}; ` +
      'no new loop extraction runs for this source until the names resolve (excluded_label_unresolved)');
  }
  try {
    await storeLoopsExclusion(deps.engine, deps.sourceId, policy);
  } catch (e) {
    deps.log(`[google] loop exclusion: could not store the resolution (${e instanceof Error ? e.message : String(e)})`);
  }
  return policy;
}

/**
 * Enqueue loops_extract jobs for every eligible candidate in this sweep, in
 * both persistence modes (#5867: `--no-extract` gates only the inline
 * link/timeline extract). Every skip logs its reason.
 */
export async function enqueueLoopsExtraction(deps: GoogleSyncDeps): Promise<LoopsEnqueueReport> {
  const report: LoopsEnqueueReport = { enqueued: 0, deferred: 0, skipped_reason: null };
  // #5445: an unresolved exclusion never reaches the queue; the report names
  // the real reason rather than the empty candidate list it produced.
  if (deps.exclusion.unresolved.length > 0) {
    deps.log('[google] loops_extract: exclusion labels unresolved — nothing enqueued this sweep (excluded_label_unresolved)');
    return { ...report, skipped_reason: 'excluded_label_unresolved' };
  }
  if (deps.extractCandidates.length === 0) {
    deps.log('[google] loops_extract: no eligible thread in this sweep; nothing to enqueue');
    return { ...report, skipped_reason: 'no_candidates' };
  }
  try {
    const { isLoopsExtractionEnabled, LOOPS_EXTRACT_JOB, LOOPS_EXTRACT_ENQUEUE_CEILING } = await import('./loops-extract.ts');
    if (!(await isLoopsExtractionEnabled(deps.engine))) {
      deps.log(`[google] loops_extract: extraction disabled (loops.extraction_enabled) — skipped enqueue of ${deps.extractCandidates.length} eligible thread(s)`);
      return { ...report, skipped_reason: 'extraction_disabled' };
    }
    // No chat provider (keyless install, outage) → enqueue NOTHING. A job the
    // handler cannot run would fail-and-die and burn its revision-keyed
    // idempotency slot for nothing; the eligible threads stay unconsumed and
    // re-candidate on their next touch or on `sync --full` once a provider is
    // configured. One line per sweep names the reason — never silent.
    const { isAvailable } = await import('../ai/gateway.ts');
    if (!isAvailable('chat')) {
      deps.log(
        `[google] loops_extract: chat provider unavailable (no configured chat model / API key) — ` +
          `skipped enqueue of ${deps.extractCandidates.length} eligible thread(s); they are queued on ` +
          `their next touch (or \`gbrain sync --source ${deps.sourceId} --full\`) once a provider is configured`,
      );
      return { ...report, skipped_reason: 'chat_unavailable' };
    }
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(deps.engine);
    // EVERY eligible candidate is enqueued (up to a generous safety ceiling).
    // The queue is the backlog; the worker's concurrency is the rate limit.
    //
    // This used to keep only the newest LOOPS_EXTRACT_MAX_PER_SWEEP and log
    // the rest as "deferring … (they re-candidate on next touch)". That was
    // silent data loss, not deferral: a thread only re-candidates when the
    // thread CHANGES, so a dropped thread that nobody writes to again was
    // never extracted at all. `maxWaiting` was a second, subtler leak — the
    // queue evaluates it AFTER the idempotency-key lookup, so a brand-new key
    // could be coalesced onto some unrelated thread's waiting job and return
    // a row its own payload was never registered against.
    //
    // Newest first only orders the enqueue, so the freshest threads reach the
    // worker first. The ceiling (10x the old cap) is a spend backstop for
    // pathological sweeps — and it is a WAITING-DEPTH budget, not just a
    // per-sweep count: with a stalled worker, repeated pathological sweeps
    // would otherwise stack another ceiling's worth of waiting jobs each.
    // Jobs already waiting shrink this sweep's budget; overflow is a
    // DEFERRAL (the backlog still covers older revisions, and a deferred
    // thread re-candidates on its next touch), logged loudly either way.
    //
    // The depth is PER SOURCE (payload `sourceId`, the key this enqueue
    // writes): a brain-wide count let one Google account's stalled backlog
    // pin every other source's budget at 0 forever.
    // One candidate per page revision: a thread re-landed in one sweep is queued once.
    const ordered = [...new Map(deps.extractCandidates.map((c) => [`${c.slug}:${c.newestMs}`, c])).values()].sort((a, b) => b.newestMs - a.newestMs);
    // Depth = every PENDING row, not just 'waiting': during a provider outage
    // each claimed job fails and parks as 'delayed' (retry backoff), and rows
    // in flight are 'active'. Counting 'waiting' alone read ~0 mid-outage and
    // let every sweep stack another ceiling's worth of jobs on the backlog.
    // Fail-open: a missing table / transient error must never block enqueue.
    const waitingDepth = await pendingLoopsExtractDepth(deps.engine, deps.sourceId);
    const budget = Math.max(0, LOOPS_EXTRACT_ENQUEUE_CEILING - waitingDepth);
    const picked = ordered.slice(0, budget);
    const dropped = ordered.length - picked.length;
    if (dropped > 0) {
      deps.log(
        `[google] loops_extract enqueue budget (ceiling ${LOOPS_EXTRACT_ENQUEUE_CEILING}, ` +
          `${waitingDepth} already pending): enqueuing ${picked.length}, ` +
          `deferring ${dropped} oldest eligible thread(s) — a deferred thread is next ` +
          `enqueued when it changes, so a persistent backlog needs worker attention`,
      );
    }
    for (const c of picked) {
      await queue.add(
        LOOPS_EXTRACT_JOB,
        { slug: c.slug, sourceId: deps.sourceId, threadId: c.threadId, newestMs: c.newestMs },
        {
          priority: 5,
          // Page-revision keyed: a re-sweep of an unchanged thread is a no-op,
          // and this is now the ONLY dedupe mechanism in play (no maxWaiting —
          // its cap-hit coalesce loses brand-new keys, see above).
          idempotency_key: `loops:${deps.sourceId}:${c.slug}:${c.newestMs}`,
        },
      );
    }
    deps.log(`[google] loops_extract: enqueued ${picked.length} eligible thread(s)`);
    return { enqueued: picked.length, deferred: dropped, skipped_reason: null };
  } catch (e) {
    deps.log(`[google] loops_extract enqueue failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ...report, skipped_reason: 'enqueue_failed' };
  }
}

/** Loop detection hook — wired to loop-detect.ts (Phase 4); tolerant when absent. */
export async function applyLoopDetection(
  deps: GoogleSyncDeps,
  thread: GmailThreadData,
  pageSlug: string,
): Promise<ThreadLoopVerdict | null> {
  try {
    const { applyThreadLoopVerdict } = await import('./loop-detect.ts');
    return await applyThreadLoopVerdict(deps.engine, deps.sourceId, thread, myAddressSet(deps.entry), pageSlug, new Date(), deps.exclusion);
  } catch (e) {
    // Detection must never fail a sync; it re-runs on the next touch.
    deps.log(`[google] loop detection failed for ${thread.threadId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
