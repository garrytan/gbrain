/**
 * apple loops — open-loop (unanswered mail) tracking over Apple Mail threads, reusing the Google engine.
 *
 * Reused unchanged: the zero-LLM thread-state machine (`applyThreadLoopVerdict`: grace windows, turn flips,
 * noise/list/auto-submitted exclusion, mutes, counterparty resolution, `open_loops` upserts), grace-hold
 * recording (`loop-catchup.ts`), the structural extraction eligibility gate and the
 * revision-keyed `loops_extract` queue. Apple-specific, here: the adapter from Mail
 * messages to the detector's thread shape, the owner-identity rule, the consent gates and the freshness rule.
 *
 * Apple policy (also in docs/guides/apple-connect.md):
 *  - Identity: `a_mail_owner_addresses` only. No guessing from the account label or the Sent mailbox.
 *    Without it nothing is detected and the feature is `unavailable: identity_missing` (never "clean").
 *  - Labels: Mail has no Gmail labels, so none are fabricated (no SENT/CATEGORY_* ids). The detector sees
 *    `labelIds: []`; machine/list mail comes from the reader's header verdicts, and a message the reader did
 *    not classify refuses its thread (fail closed; the run is not fresh).
 *  - Gmail label exclusions (`loops.extraction_exclude_labels`) cannot be evaluated on Mail: when set, paid
 *    extraction for Apple is withheld (`excluded_label_unsupported`); deterministic tracking is unaffected.
 *  - Deterministic tracking makes no model call. Paid extraction needs BOTH `loops.extraction_enabled` and the
 *    source's `a_loops_extract_consent`, checked at enqueue and again in the job handler.
 *  - Freshness is stamped only by a Mail sweep that was complete and detected loops in the same run.
 */
import type { BrainEngine } from '../engine.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { applyThreadLoopVerdict } from '../google/loop-detect.ts';
import { recordGraceVerdict, type LoopsEnqueueReport } from '../google/loop-catchup.ts';
import { enqueueAppleCandidates } from './loops-enqueue.ts';
import { NO_EXCLUSION, excludedLabelTokens } from '../google/loops-exclusion.ts';
import { LOOPS_EXTRACT_WINDOW_DAYS, isLoopsExtractionEnabled, loopExtractionEligibility } from '../google/loops-extract.ts';
import type { GmailThreadData } from '../google/types.ts';
import { closeThreadLoops } from '../loops/loops-store.ts';
import { groupMailThreads } from './render.ts';
import { compactMailMessage, pageLoopMessages, toLoopThread } from './loop-evidence.ts';
export { compactMailMessage, toLoopThread, APPLE_LOOPS_BODY_CAP } from './loop-evidence.ts';
import { appleLoopsAvailability, appleOwnerDigest } from './loops-status.ts';
import { parseAppleSourceConfig } from './source-config.ts';
import type { AppleLoopMessage, AppleMailLoopsState, AppleMailMessage, AppleSourceConfig, AppleSourceState } from './types.ts';

const DAY_MS = 86_400_000;
export const APPLE_LOOPS_THREAD_CAP = 100;
export const APPLE_LOOPS_MESSAGES_PER_THREAD = 12;

/** Per-run loop bookkeeping the sweep hands to the post-save enqueue. */
export interface AppleLoopsRun {
  candidates: Array<{ slug: string; threadId: string; newestMs: number }>;
  eligibility: Record<string, number>;
  withheld: Record<string, number>;
  /** Why tracking did not finish; empty = a complete run. */
  gaps: string[];
}

export const newAppleLoopsRun = (): AppleLoopsRun => ({ candidates: [], eligibility: {}, withheld: {}, gaps: [] });

// ── State ────────────────────────────────────────────────────────────────────

/** Bounded recent-message diagnostic cache (listed wins). NEVER detection or recovery authority. */
export function mergeLoopThreads(state: AppleMailLoopsState, listed: Map<string, AppleLoopMessage[]>, nowMs: number): void {
  const threads = state.threads ??= {};
  for (const [id, fresh] of listed) {
    const byId = new Map((threads[id] ?? []).map((m) => [m.id, m]));
    for (const m of fresh) byId.set(m.id, m);
    threads[id] = [...byId.values()].sort((a, b) => a.ms - b.ms || (a.id < b.id ? -1 : 1)).slice(-APPLE_LOOPS_MESSAGES_PER_THREAD);
  }
  const floor = nowMs - LOOPS_EXTRACT_WINDOW_DAYS * DAY_MS;
  const newest = (id: string): number => threads[id]!.reduce((n, m) => Math.max(n, m.ms), 0);
  for (const id of Object.keys(threads)) if (newest(id) < floor) delete threads[id];
  const ids = Object.keys(threads);
  if (ids.length > APPLE_LOOPS_THREAD_CAP) for (const id of ids.sort((a, b) => newest(a) - newest(b)).slice(0, ids.length - APPLE_LOOPS_THREAD_CAP)) delete threads[id];
}

/**
 * Called before the Mail read. Marks the whole window for re-reading when the owner set changed (stored loops were computed for another identity); returns whether this run must
 * read the whole window. The mark is cleared only by a complete run.
 */
export function prepareLoopsState(state: AppleSourceState, cfg: AppleSourceConfig): boolean {
  const loops = state.mail_loops ??= {};
  const digest = appleOwnerDigest(cfg.mailOwnerAddresses);
  if (loops.digest !== digest) { loops.digest = digest; loops.reread = true; delete loops.complete_at; delete loops.threads; loops.identity_reconcile = true; }
  return loops.reread === true;
}

// ── Detection ────────────────────────────────────────────────────────────────

export interface TrackInput {
  engine: BrainEngine;
  sourceId: string;
  cfg: AppleSourceConfig;
  state: AppleSourceState;
  log: (msg: string) => void;
  now: () => number;
  signal?: AbortSignal;
  run: AppleLoopsRun;
  /** The messages this run listed. */
  messages: readonly AppleMailMessage[];
  /** thread id → page slug for every thread whose page is in the brain after the render loop. */
  slugByThread: ReadonlyMap<string, string>;
  /** Threads that have a rendered page which did NOT land this run (held, failed, carry-forward refused). */
  notLanded: ReadonlySet<string>;
  /** Threads with an unreadable message: never judged. */
  unavailableThreads: ReadonlySet<string>;
  /**
   * Threads with an outstanding unreadable-message HOLD (the cursor has moved, or may move, past the message): never
   * judged, and Mail coverage stays incomplete until the message is read again. They do not force a whole-window re-read.
   */
  heldThreads?: ReadonlySet<string>;
  /** Threads whose message hold this run settled: re-judged from their durable page even if the listing did not return them. */
  recoveredThreads?: ReadonlySet<string>;
  /** The listing was complete (not truncated, readable) and no mail item failed this run. */
  listingClean: boolean;
}

async function detectOne(input: TrackInput, thread: GmailThreadData, slug: string, owners: Set<string>): Promise<void> {
  const verdict = await applyThreadLoopVerdict(input.engine, input.sourceId, thread, owners, slug, new Date(input.now()), NO_EXCLUSION, async next => {
    if (input.state.mail_loops?.identity_reconcile) {
      const valid = new Set(next.open.map(s => s.loopType));
      if (next.held) valid.add(next.held.spec.loopType);
      const obsolete = (['unanswered_inbound', 'unanswered_outbound'] as const).filter(t => !valid.has(t));
      // Retire old-identity opens BEFORE the shared turn-flip closure can mislabel them as replies.
      if (obsolete.length) await closeThreadLoops(input.engine, input.sourceId, thread.threadId, 'apple_owner_changed', obsolete);
    }
    // Only an actual current open verdict may restore our own identity invalidation. This also
    // handles a returning direction still inside grace when identity_reconcile was cleared.
    // Manual done/drop/mute and genuine reply closures are never eligible.
    for (const spec of next.open) await input.engine.executeRaw(`UPDATE open_loops SET status='open', closed_at=NULL, closed_by=NULL
      WHERE source_id=$1 AND thread_id=$2 AND detector='deterministic_thread' AND closed_by='apple_owner_changed' AND loop_type=$3`,
    [input.sourceId, thread.threadId, spec.loopType]);
  });
  recordGraceVerdict(input.state.mail_loops!, thread, verdict, slug, owners, input.log, NO_EXCLUSION);
  if (verdict.withheld) input.run.withheld[verdict.withheld.reason] = (input.run.withheld[verdict.withheld.reason] ?? 0) + 1;
}

/** Eligibility candidate for the paid lane, recorded only when this source has consented to extraction. */
function noteCandidate(input: TrackInput, thread: GmailThreadData, slug: string, owners: Set<string>): void {
  const newestMs = thread.messages[thread.messages.length - 1]?.internalDateMs ?? 0;
  if (newestMs <= 0 || input.now() - newestMs > LOOPS_EXTRACT_WINDOW_DAYS * DAY_MS) return;
  const v = loopExtractionEligibility(thread, owners, NO_EXCLUSION);
  input.run.eligibility[v.reason] = (input.run.eligibility[v.reason] ?? 0) + 1;
  if (v.eligible && input.cfg.loopsExtractConsent) input.run.candidates.push({ slug, threadId: thread.threadId, newestMs });
}

/**
 * Detection from durable page evidence, quiet grace recovery and the freshness stamp. Never throws: a thread that
 * cannot be judged is a gap (the run is not complete), not a sync failure.
 */
export async function trackMailLoops(input: TrackInput): Promise<void> {
  const { cfg, state, log, run } = input;
  const loops = state.mail_loops ??= {};
  const owners = new Set(cfg.mailOwnerAddresses);
  const listed = new Map<string, AppleLoopMessage[]>();
  for (const t of groupMailThreads(input.messages)) {
    const compact = t.messages.map(compactMailMessage).filter((m): m is AppleLoopMessage => m !== null);
    if (compact.length > 0) listed.set(t.threadId, compact);
  }
  mergeLoopThreads(loops, listed, input.now());
  if (loops.coverage_gap) {
    delete loops.complete_at;
    loops.reread = true;
    run.gaps.push('unresolved_coverage');
    log('[apple] unattributed unreadability: no thread may authorize closure until a nonempty whole-window recovery');
    return;
  }

  // The page is the recoverable evidence store. Re-evaluate all imported threads, including quiet
  // grace-held threads and eligible revisions outside the incremental overlap. Cache eviction is irrelevant.
  const held = input.heldThreads ?? new Set<string>();
  const recovered = input.recoveredThreads ?? new Set<string>();
  const pending = new Set(loops.pending_threads ?? []);
  for (const id of input.unavailableThreads) pending.add(id);
  for (const id of input.notLanded) pending.add(id);
  for (const id of held) pending.add(id);
  const rows = await input.engine.executeRaw<{ slug: string; frontmatter: Record<string, unknown> }>(
    `SELECT slug, frontmatter FROM pages WHERE source_id=$1 AND deleted_at IS NULL
      AND frontmatter->>'apple_thread_id' IS NOT NULL`, [input.sourceId]);
  const detected = new Set<string>();
  for (const page of rows) {
    if (input.signal?.aborted) { run.gaps.push('aborted'); break; }
    const id = String(page.frontmatter.apple_thread_id);
    if (input.unavailableThreads.has(id) || input.notLanded.has(id) || held.has(id)) continue;
    // An earlier unavailable/import-failed slice is not repaired by an old stored page alone.
    if (pending.has(id) && !listed.has(id) && !recovered.has(id)) continue;
    const evidence = pageLoopMessages(page.frontmatter);
    const thread = evidence && toLoopThread(id, evidence, cfg.account);
    if (!thread) {
      pending.add(id);
      run.gaps.push('unclassified_messages');
      log('[apple] mail thread has messages the reader did not classify, or incomplete durable evidence; tracking refuses it');
      continue;
    }
    try {
      await detectOne(input, thread, page.slug, owners);
      noteCandidate(input, thread, page.slug, owners);
      detected.add(id);
      pending.delete(id);
    } catch (e) {
      pending.add(id);
      run.gaps.push('detection_failed');
      log(`[apple] loop detection failed (retried from durable pages): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // A missing page is not proof of upstream deletion, even when the recent cache has forgotten it.
  for (const id of Object.keys(loops.loop_grace_holds ?? {})) if (!detected.has(id)) pending.add(id);
  const obligations = await input.engine.executeRaw<{ thread_id: string }>(`SELECT DISTINCT thread_id FROM open_loops
    WHERE source_id=$1 AND status='open' AND detector='deterministic_thread' AND thread_id IS NOT NULL`, [input.sourceId]);
  for (const { thread_id } of obligations) if (!detected.has(thread_id)) pending.add(thread_id);
  // A recovered thread with no page has nothing left to judge; it is no longer pending (a page that failed to land stays so).
  const pages = new Set(rows.map(page => String(page.frontmatter.apple_thread_id)));
  for (const id of recovered) {
    if (!pages.has(id) && !input.notLanded.has(id) && !input.unavailableThreads.has(id) && !held.has(id)) pending.delete(id);
  }
  loops.pending_threads = [...pending].sort();
  // Threads pending ONLY because a message hold keeps them incomplete block freshness but not the cursor's way forward:
  // they are re-judged when the message is read again, not by re-reading the whole window every run.
  const heldOnly = pending.size > 0 && [...pending].every(id => held.has(id));
  if (pending.size > 0) run.gaps.push(heldOnly ? 'held_messages' : 'unresolved_threads');
  if (!input.listingClean) run.gaps.push('mail_listing_partial');
  if (run.gaps.length === 0) {
    loops.complete_at = new Date(input.now()).toISOString();
    delete loops.reread;
    delete loops.identity_reconcile;
    return;
  }
  delete loops.complete_at;
  if (run.gaps.every(gap => gap === 'held_messages' || gap === 'google_routed' || gap === 'disabled_routed')) {
    // The whole window was re-read cleanly and only held messages, Google-hosted mail (Google connector owns it), or disabled
    // Mail accounts remain; nothing more to re-read for these excluded items.
    delete loops.reread;
    log(`[apple] mail loops not fresh this run (${[...new Set(run.gaps)].join(', ')}); coverage stays incomplete until held messages recover and Google/disabled accounts are covered`);
    return;
  }
  loops.reread = true;
  log(`[apple] mail loops not fresh this run (${[...new Set(run.gaps)].join(', ')}); unresolved coverage is retried before freshness`);
}

// ── Extraction (paid) ────────────────────────────────────────────────────────

export interface AppleExtractionPolicy {
  /** Why paid extraction may not run for this source right now, or null. */
  refusal: string | null;
  /** The owner addresses (the model is told who "me" is). */
  owners: string[];
}

/** Used at enqueue and again in the job handler: the Apple consent and every Apple-side exclusion. */
export async function appleExtractionPolicy(engine: BrainEngine, sourceId: string, cfgIn?: AppleSourceConfig): Promise<AppleExtractionPolicy> {
  const [row] = await engine.executeRaw<{ config: unknown; local_path: string | null }>('SELECT config, local_path FROM sources WHERE id = $1 AND archived IS NOT TRUE', [sourceId]);
  const raw = row ? parseSourceConfig(row.config) : null;
  if (!row || raw?.kind !== 'apple') return { refusal: 'apple_source_unavailable', owners: [] };
  const cfg = parseAppleSourceConfig(raw, row.local_path ?? '');
  // A caller snapshot may restrict policy but can NEVER grant consent over the current registered source.
  if (cfgIn) {
    const prior = appleLoopsAvailability(cfgIn);
    if (!prior.available) return { refusal: prior.reason, owners: [] };
    if (!cfgIn.loopsExtractConsent) return { refusal: 'apple_consent_missing', owners: [] };
    if (appleOwnerDigest(cfgIn.mailOwnerAddresses) !== appleOwnerDigest(cfg.mailOwnerAddresses)) return { refusal: 'apple_identity_changed', owners: [] };
  }
  const owners = cfg.mailOwnerAddresses;
  const a = appleLoopsAvailability(cfg);
  if (!a.available) return { refusal: a.reason, owners };
  if (!cfg.loopsExtractConsent) return { refusal: 'apple_consent_missing', owners };
  // Gmail label exclusions cannot be evaluated on Mail threads: fail closed for paid extraction.
  if ((await excludedLabelTokens(engine, {})).length > 0) return { refusal: 'excluded_label_unsupported', owners };
  return { refusal: null, owners };
}

/** Post-save enqueue of eligible threads. Both the global switch and the Apple consent must hold before anything else is called. */
export async function enqueueAppleLoopsExtraction(input: { engine: BrainEngine; sourceId: string; cfg: AppleSourceConfig; run: AppleLoopsRun; log: (m: string) => void }): Promise<LoopsEnqueueReport | undefined> {
  const { engine, sourceId, cfg, run, log } = input;
  if (!appleLoopsAvailability(cfg).available) return undefined;
  if (!cfg.loopsExtractConsent) {
    log('[apple] loops_extract: Apple extraction consent is off (a_loops_extract_consent) — no mail text is sent to a model');
    return { enqueued: 0, deferred: 0, skipped_reason: 'apple_consent_missing' };
  }
  if (!(await isLoopsExtractionEnabled(engine))) {
    log('[apple] loops_extract: extraction disabled (loops.extraction_enabled) — nothing enqueued');
    return { enqueued: 0, deferred: 0, skipped_reason: 'extraction_disabled' };
  }
  const { refusal } = await appleExtractionPolicy(engine, sourceId, cfg);
  if (refusal) {
    log(`[apple] loops_extract: withheld (${refusal})`);
    return { enqueued: 0, deferred: 0, skipped_reason: refusal };
  }
  return enqueueAppleCandidates({ engine, sourceId, candidates: run.candidates, log });
}
