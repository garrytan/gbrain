/**
 * checkpoint-harvest.ts — Cathedral 5: the serve-side prompt harvest of a
 * compaction-boundary corpus segment. Fire-and-forget from the context_pack
 * IPC handler (the ack never waits on the LLM); the maintenance sweep's
 * corpus pass is the backstop by construction (segments are plain `.txt`
 * files in the corpus dir), so every skip below is safe.
 *
 * Discipline (sweep pass 3, shared fencing):
 *   claim (acquireCorpusClaim, O_EXCL) → `.ingested` re-check under claim →
 *   capability gate THEN kill switch → dream-output guard →
 *   window 1 of the turn-boundary windows (corpus-windows.ts; an existing
 *   `.progress` means window 1 is done) under a 60s abort → POST-check
 *   (the pipeline returns normally with partial results on abort — an
 *   aborted run writes NOTHING and releases the claim: retryable) →
 *   RECEIPT sidecar (link candidates) → idempotent manifest publish from
 *   the receipt (each slug verified via source-scoped getPage; a link that
 *   resolves to nothing is a lie and is skipped) → `.ingested` LAST, or, when
 *   windows remain, the receipt is released and the sweep finishes the tail.
 * A transient manifest failure leaves receipt + released claim; the retry
 * re-publishes from the receipt WITHOUT re-extracting (no duplicate spend,
 * no lost links).
 *
 * Serve lifecycle: the background-work registry's drain is CLI-exit-only by
 * documented contract, so serve calls `shutdownCheckpointHarvest()` before
 * `engine.disconnect()` — aborting the in-flight harvest and dropping the
 * queue (the #1762 hazard class: a fire-and-forget DB writer surviving
 * engine disconnect busy-loops the single-writer lock).
 *
 * Telemetry: `checkpoint-harvest` events on the hooks heartbeat JSONL —
 * counts + reason codes ONLY, never slugs/fact text [S3#7].
 */

import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { CapabilityReport } from '../capability.ts';
import { acquireCorpusClaim, CORPUS_CLAIM_SUFFIX, CORPUS_INGESTED_SUFFIX } from '../sweep.ts';
import { appendCheckpointManifest } from './session-state.ts';
import { corpusFileSessionId, corpusTextForExtraction, readSegmentLedger, selfCaptureSidecarJson, HARVEST_RECEIPT_SUFFIX } from './corpus-segments.ts';
import { corpusFileStat, readCorpusProgress, runCorpusWindows } from './corpus-windows.ts';
import { isClaudeCliSelfSessionId } from '../ai/providers/claude-cli-scratch.ts';
import { writeHeartbeat } from './hook-heartbeat.ts';
import { OperationError } from '../ops/contract.ts';

/** Bounded queue — overflow is a typed skip; the sweep backstop extracts later. */
export const HARVEST_QUEUE_CAP = 8;
/** Per-file abort so a hung provider can't wedge the FIFO. */
export const HARVEST_JOB_TIMEOUT_MS = 60_000;
/**
 * #5557: a writeback turn whose facts preflight still finds the canonical
 * writer busy after its own wait (`writer_lock_unavailable`, thrown before any
 * model call) is re-queued after each of these delays in turn; past the last
 * one it ends as an error. A Git effect holds that lock through its commit and
 * its push.
 */
export const HARVEST_WRITER_BUSY_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];
/** Receipt sidecar suffix — canonical home is corpus-segments (engine-free,
 * so the hook's GC can reap orphaned receipts); re-exported for callers. */
export { HARVEST_RECEIPT_SUFFIX };

export interface HarvestJob {
  engine: BrainEngine;
  sourceId: string;
  /** Harness session id — manifest lane + fact provenance. */
  sessionId: string;
  /** Absolute corpus dir (resolved by the CALLER the serve way). */
  corpusDir: string;
  /** Segment BASENAME (already validated by the IPC handler). */
  file: string;
  /**
   * Ambient-writeback lane (WP4): 'writeback' jobs carry a single gated user
   * turn (`.wb-` files) — extra serve-side gate on `memory.auto_writeback`
   * (a stale hook-side file-plane read never extracts against operator
   * intent: off ⇒ terminal `.ingested {skipped:'writeback_off'}`),
   * salient-mode notability filter, NO manifest publish (turn files have no
   * segment ledger), and the `writeback` heartbeat event. Default 'compact'.
   */
  lane?: 'compact' | 'writeback';
  /** TEST SEAM: capability report override (sweep PassCtx precedent). */
  capabilities?: CapabilityReport;
  /** TEST SEAM: per-job abort budget override (default HARVEST_JOB_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Busy-writer re-queues already spent on this job; set by the pump only (#5557). */
  writerBusyRetries?: number;
}

interface HarvestReceipt {
  session_id: string;
  seg: string;
  links: string[];
  ts: string;
}

const queue: HarvestJob[] = [];
let inFlight = false;
let shuttingDown = false;
let currentAbort: AbortController | null = null;
/** Resolves when the pump goes idle — the shutdown join point. */
let idleResolve: (() => void) | null = null;
/** Busy-writer retries waiting on their delay (#5557); shutdown clears them. */
const pendingRetries = new Map<ReturnType<typeof setTimeout>, HarvestJob>();
let writerBusyRetryDelays: readonly number[] = HARVEST_WRITER_BUSY_RETRY_DELAYS_MS;
/** Error reasons already written to stderr by this serve run (#5557). */
const loggedErrorReasons = new Set<string>();

export type HarvestAck = { status: 'scheduled' } | { status: 'skipped'; reason: string };

/**
 * Enqueue a segment harvest. O(1), synchronous — the IPC ack never waits on
 * the LLM. Duplicate (same file already queued) and overflow are typed skips.
 */
export function scheduleCheckpointHarvest(job: HarvestJob): HarvestAck {
  if (shuttingDown) return { status: 'skipped', reason: 'shutting_down' };
  if ([...queue, ...pendingRetries.values()].some((q) => q.file === job.file && q.corpusDir === job.corpusDir)) {
    return { status: 'skipped', reason: 'already_queued' };
  }
  // F9/OV2-4 cost posture: per-session prompt-harvest cap for the writeback
  // lane, enforced HERE (the single serve process owns the queue; in-memory,
  // serve-restart resets — documented). Overflow is an ACK-only skip: the wb
  // file REMAINS on disk and the sweep's corpus pass batch-extracts it later
  // — freshness lost, nothing dropped.
  if (job.lane === 'writeback' && (wbSessionCounts.get(job.sessionId) ?? 0) >= WRITEBACK_SESSION_CAP) {
    return { status: 'skipped', reason: 'session_cap' };
  }
  if (queue.length >= HARVEST_QUEUE_CAP) return { status: 'skipped', reason: 'queue_full' };
  if (job.lane === 'writeback') {
    // Budget burns only on a real enqueue — a queue_full rejection retries
    // free via the sweep. Bounded map: evict the OLDEST entries (Map keeps
    // insertion order) rather than clear() — a wholesale clear would re-arm
    // the spend cap of every capped session under session churn (security
    // review, this wave). Serve restarts still reset (documented).
    if (wbSessionCounts.size >= WB_SESSION_MAP_MAX && !wbSessionCounts.has(job.sessionId)) {
      for (const key of wbSessionCounts.keys()) {
        if (wbSessionCounts.size < WB_SESSION_MAP_MAX) break;
        wbSessionCounts.delete(key);
      }
    }
    // delete-before-set makes the map LRU: a bare .set() on an existing key
    // keeps its ORIGINAL insertion slot, so the busiest long-lived session
    // would be evicted first — re-arming exactly the budget the eviction
    // policy exists to preserve (adversarial review, this wave).
    const burned = (wbSessionCounts.get(job.sessionId) ?? 0) + 1;
    wbSessionCounts.delete(job.sessionId);
    wbSessionCounts.set(job.sessionId, burned);
  }
  queue.push(job);
  void pump();
  return { status: 'scheduled' };
}

/** Per-session prompt-harvest budget for the writeback lane (F9/OV2-4). */
export const WRITEBACK_SESSION_CAP = 30;
/** Size bound for the per-session counter map — oldest-first eviction, so an
 * ACTIVE session's burned budget survives churn (a stale evicted session that
 * comes back gets a fresh budget, the accepted residual). */
const WB_SESSION_MAP_MAX = 200;
const wbSessionCounts = new Map<string, number>();

/** Shutdown grace: don't let a transport that ignores the abort signal hold
 * serve's exit — the claim's staleness window + the sweep backstop make an
 * abandoned in-flight job safe to orphan (pre-landing review, perf). */
export const HARVEST_SHUTDOWN_GRACE_MS = 5000;

/**
 * Abort the in-flight harvest, drop the queue, and wait for the pump to go
 * idle — bounded by HARVEST_SHUTDOWN_GRACE_MS. Serve's shutdown path calls
 * this BEFORE engine.disconnect().
 */
export async function shutdownCheckpointHarvest(): Promise<void> {
  shuttingDown = true;
  queue.length = 0;
  clearPendingRetries();
  try {
    currentAbort?.abort();
  } catch {
    /* noop */
  }
  if (inFlight) {
    await new Promise<void>((resolve) => {
      idleResolve = resolve;
      const t = setTimeout(resolve, HARVEST_SHUTDOWN_GRACE_MS);
      if (typeof (t as { unref?: () => void }).unref === 'function') {
        (t as unknown as { unref: () => void }).unref();
      }
    });
  }
}

/** TEST SEAM: reset module state between tests. */
export function __resetCheckpointHarvestForTests(): void {
  queue.length = 0;
  inFlight = false;
  shuttingDown = false;
  currentAbort = null;
  idleResolve = null;
  wbSessionCounts.clear();
  clearPendingRetries();
  writerBusyRetryDelays = HARVEST_WRITER_BUSY_RETRY_DELAYS_MS;
  loggedErrorReasons.clear();
}

/** TEST SEAM: busy-writer retry delays (null restores the defaults). */
export function __setWriterBusyRetryDelaysForTests(delays: readonly number[] | null): void {
  writerBusyRetryDelays = delays ?? HARVEST_WRITER_BUSY_RETRY_DELAYS_MS;
}

/** TEST SEAM: resolves once the queue is fully drained, pending retries included. */
export async function __drainCheckpointHarvestForTests(): Promise<void> {
  while (inFlight || queue.length > 0 || pendingRetries.size > 0) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function pump(): Promise<void> {
  if (inFlight) return;
  const job = queue.shift();
  if (!job) {
    idleResolve?.();
    idleResolve = null;
    return;
  }
  inFlight = true;
  const t0 = Date.now();
  let outcome: 'ok' | 'degraded' | 'error' = 'ok';
  let reason: string | undefined;
  let inserted: number | undefined;
  let duplicate: number | undefined;
  let superseded: number | undefined;
  let links: number | undefined;
  try {
    const r = await runOne(job);
    outcome = r.outcome;
    reason = r.reason;
    inserted = r.inserted;
    duplicate = r.duplicate;
    superseded = r.superseded;
    links = r.links;
  } catch (e) {
    ({ outcome, reason } = classifyHarvestFailure(job, e));
  } finally {
    inFlight = false;
    await writeHeartbeat({
      ts: new Date().toISOString(),
      // The writeback lane heartbeats under its own event so doctor's
      // backstop counters never conflate the two lanes (OV-A11).
      event: job.lane === 'writeback' ? 'writeback' : 'checkpoint-harvest',
      outcome,
      ...(reason ? { reason } : {}),
      duration_ms: Date.now() - t0,
      ...(inserted !== undefined ? { inserted } : {}),
      ...(duplicate !== undefined ? { duplicate } : {}),
      ...(superseded !== undefined ? { superseded } : {}),
      ...(links !== undefined ? { links } : {}),
      // trim:false — serve is a long-lived high-frequency writer; its
      // read→tmp→rename trim would clobber concurrent hook appends.
    }, { trim: false });
    if (!shuttingDown) void pump();
    else {
      idleResolve?.();
      idleResolve = null;
    }
  }
}

function clearPendingRetries(): void {
  for (const timer of pendingRetries.keys()) clearTimeout(timer);
  pendingRetries.clear();
}

/**
 * A writeback turn refused because the canonical writer stayed busy is
 * re-queued; any other failure is an error that keeps its code. A compact
 * segment is never re-queued: its first window already wrote `.progress`, which
 * a retry reads as window 1 done, so the error stands and the sweep resumes it.
 */
function classifyHarvestFailure(job: HarvestJob, e: unknown): { outcome: 'degraded' | 'error'; reason: string } {
  if (job.lane === 'writeback' && isWriterBusy(e) && requeueWhileWriterBusy(job)) {
    return { outcome: 'degraded', reason: 'writer_busy_requeued' };
  }
  const reason = harvestErrorReason(e);
  logFirstHarvestError(job, reason, e);
  return { outcome: 'error', reason };
}

/** The facts preflight refused because the canonical writer stayed busy; nothing was extracted. */
function isWriterBusy(e: unknown): boolean {
  return e instanceof OperationError && e.code === 'writer_lock_unavailable';
}

/**
 * Schedules the job's next attempt after its busy-writer delay; false once the
 * delays are spent or serve is stopping. The retry skips the admission checks:
 * the job was admitted (and counted against its session cap) once already.
 */
function requeueWhileWriterBusy(job: HarvestJob): boolean {
  const spent = job.writerBusyRetries ?? 0;
  const delay = writerBusyRetryDelays[spent];
  if (delay === undefined || shuttingDown) return false;
  const timer = setTimeout(() => {
    pendingRetries.delete(timer);
    if (shuttingDown) return;
    queue.push({ ...job, writerBusyRetries: spent + 1 });
    void pump();
  }, delay);
  (timer as { unref?: () => void }).unref?.();
  pendingRetries.set(timer, job);
  return true;
}

/** A heartbeat reason is a short machine code, the shape hook.ts's reasonCode() enforces. */
const HEARTBEAT_REASON_CODE = /^[A-Za-z0-9_.:-]{1,48}$/;

/**
 * The error name plus its `code`, or else its `reason` (FactsExtractionError):
 * `operationerror:writer_lock_unavailable`, `factsextractionerror:provider_error`.
 * A composite past the reason-code shape falls back to the bare name.
 */
function harvestErrorReason(e: unknown): string {
  if (!(e instanceof Error)) return 'error';
  const name = (e.name || 'Error').toLowerCase();
  const { code, reason } = e as { code?: unknown; reason?: unknown };
  const detail = typeof code === 'string' ? code : typeof reason === 'string' ? reason : null;
  const composite = detail === null ? name : `${name}:${detail.toLowerCase()}`;
  if (HEARTBEAT_REASON_CODE.test(composite)) return composite;
  return HEARTBEAT_REASON_CODE.test(name) ? name : 'error';
}

/** The heartbeat keeps counts and codes only; the first failure of each reason also reaches serve's stderr. */
function logFirstHarvestError(job: HarvestJob, reason: string, e: unknown): void {
  if (loggedErrorReasons.has(reason)) return;
  loggedErrorReasons.add(reason);
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[checkpoint-harvest] ${job.lane ?? 'compact'} harvest failed (${reason}): ${message.slice(0, 300)} `
    + '(logged once per serve run; later failures with this reason are counted in the hooks heartbeat only)');
}

/** `<sessionId>.seg-<hash12>.txt` → hash12 ('' when the name has no hash part). */
function segHashFromName(file: string): string {
  const m = /\.seg-([0-9a-f]+)\.txt$/.exec(file);
  return m ? m[1] : '';
}

async function runOne(job: HarvestJob): Promise<{
  outcome: 'ok' | 'degraded' | 'error';
  reason?: string;
  inserted?: number;
  duplicate?: number;
  superseded?: number;
  links?: number;
}> {
  const full = join(job.corpusDir, job.file);
  const claimPath = full + CORPUS_CLAIM_SUFFIX;
  const receiptPath = full + HARVEST_RECEIPT_SUFFIX;
  const ingestedPath = full + CORPUS_INGESTED_SUFFIX;

  if (!(await acquireCorpusClaim(claimPath))) {
    return { outcome: 'degraded', reason: 'claimed_elsewhere' };
  }
  try {
    // Re-check under the claim (sweep discipline — closes the double-spend gap).
    if (await stat(ingestedPath).then(() => true, () => false)) {
      return { outcome: 'ok', reason: 'already_ingested' };
    }

    if (job.lane === 'writeback') return await runWritebackTurn(job, full, ingestedPath);

    // Receipt retry path (codex round 2): extraction already happened; the
    // manifest publish failed transiently. Re-publish WITHOUT re-extracting.
    let receipt = await readReceipt(receiptPath);
    let counts: { inserted: number; duplicate: number } | null = null;
    // #5887: the harvest extracts window 1 only; when more remains, `.progress`
    // stands in for `.ingested` and the sweep finishes the tail.
    let windowsPending = receipt !== null && (await readCorpusProgress(full))?.finished === null;

    if (!receipt) {
      // An existing `.progress` means window 1 is done (an earlier harvest or
      // the sweep wrote it): never re-extract it here.
      if (await readCorpusProgress(full)) return { outcome: 'ok', reason: 'windows_pending' };
      // Gates in the pinned sweep order: capability THEN kill switch. A
      // gate-skip releases the claim and writes NO sidecar — when the gate
      // opens later, the sweep (which applies the same gates) extracts.
      const { extractionAvailableForEngine } = await import('../facts/extraction-availability.ts');
      if (!(await extractionAvailableForEngine(job.engine, job.capabilities))) {
        return { outcome: 'degraded', reason: 'keyless' };
      }
      const { isFactsExtractionEnabled } = await import('../facts/extract.ts');
      if (!(await isFactsExtractionEnabled(job.engine))) {
        return { outcome: 'degraded', reason: 'extraction_disabled' };
      }

      const fileStat = corpusFileStat(await stat(full));
      const raw = await readFile(full, 'utf-8');
      const { isDreamOutput } = await import('../cycle/transcript-discovery.ts');
      const { runFactsPipeline } = await import('../facts/backstop.ts');
      if (isDreamOutput(raw)) {
        await writeFile(
          ingestedPath,
          JSON.stringify({ ingested_at: new Date().toISOString(), skipped: 'dream_output' }) + '\n',
        );
        return { outcome: 'ok', reason: 'dream_output' };
      }

      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), job.timeoutMs ?? HARVEST_JOB_TIMEOUT_MS);
      currentAbort = abort;
      let run: Awaited<ReturnType<typeof runCorpusWindows>>;
      try {
        // Paste stripping happens per turn inside the window planner (#5812).
        run = await runCorpusWindows({
          full, raw, fileStat, maxWindows: 1, overBudget: () => false, signal: abort.signal,
          extract: (text) => runFactsPipeline(text, {
            engine: job.engine,
            sourceId: job.sourceId,
            sessionId: job.sessionId,
            source: 'hook:compact',
            mode: 'inline',
            remote: false,
            abortSignal: abort.signal,
            // visibility deliberately unset → resolveDefaultVisibility [ENG-8]
          }),
        });
      } finally {
        clearTimeout(timer);
        currentAbort = null;
      }
      // POST-check (codex round 2): runFactsPipeline returns normally with
      // PARTIAL results on abort. An aborted run writes NOTHING (no receipt,
      // no .ingested, no progress) and releases the claim — fully retryable.
      if (abort.signal.aborted || run.status === 'aborted') return { outcome: 'degraded', reason: 'aborted' };
      if (run.status === 'contended') return { outcome: 'degraded', reason: 'claimed_elsewhere' };
      windowsPending = run.status !== 'complete';
      const r = run.result;

      counts = { inserted: r.inserted, duplicate: r.duplicate };
      receipt = {
        session_id: job.sessionId,
        seg: segHashFromName(job.file),
        links: r.entity_slugs,
        ts: new Date().toISOString(),
      };
      await writeFile(receiptPath, JSON.stringify(receipt) + '\n', { mode: 0o600 });
    }

    // Idempotent manifest publish from the receipt: bank ONLY links whose
    // entity page resolves via a SOURCE-SCOPED read (the existence check
    // doubles as the title lookup; null/throw ⇒ skip that link).
    const verified: Array<{ slug: string; title: string }> = [];
    for (const slug of receipt.links) {
      try {
        const page = await job.engine.getPage(slug, { sourceId: job.sourceId });
        if (page) verified.push({ slug, title: page.title || slug });
      } catch {
        /* transient or missing — a non-resolvable link is never banked */
      }
    }
    if (verified.length) {
      const ledger = readSegmentLedger(job.corpusDir, receipt.session_id);
      const n = Math.max(1, ledger.findIndex((e) => e.hash === receipt.seg) + 1);
      const published = await appendCheckpointManifest(
        job.engine, job.sourceId, null, receipt.session_id, verified,
        { seg: receipt.seg, n },
      );
      if (!published) {
        // Publish failed (returns false, never throws): keep the receipt —
        // the ONLY durable copy of the links — write NO `.ingested`, release
        // the claim. The retry re-publishes from the receipt without
        // re-extracting. Writing `.ingested` here would delete the links.
        return { outcome: 'degraded', reason: 'manifest_failed' };
      }
    }

    if (windowsPending) {
      // Window 1's links are banked and `.progress` is written: release the
      // receipt; the sweep extracts the remaining windows and writes `.ingested`.
      await rm(receiptPath, { force: true }).catch(() => {});
      return {
        outcome: 'ok',
        reason: 'windows_pending',
        ...(counts ? { inserted: counts.inserted, duplicate: counts.duplicate } : {}),
        links: verified.length,
      };
    }

    // `.ingested` LAST — the sweep now skips this segment; the receipt has
    // served its purpose and is removed (GC would otherwise orphan-reap it).
    await writeFile(
      ingestedPath,
      JSON.stringify({
        ingested_at: new Date().toISOString(),
        ...(counts ? { facts_inserted: counts.inserted, facts_duplicate: counts.duplicate } : { from_receipt: true }),
        links_banked: verified.length,
      }) + '\n',
    );
    await rm(receiptPath, { force: true }).catch(() => {});

    return {
      outcome: 'ok',
      ...(counts ? { inserted: counts.inserted, duplicate: counts.duplicate } : {}),
      links: verified.length,
    };
  } finally {
    await rm(claimPath, { force: true }).catch(() => {});
  }
}

/**
 * Writeback-lane extraction (WP4): one gated user turn. Distinct from the
 * compact lane in exactly four ways — the AUTHORITATIVE serve-side
 * `memory.auto_writeback` gate (off ⇒ TERMINAL `.ingested` sidecar, so a
 * stale hook-side file-plane read never extracts against operator intent —
 * and the sweep respects the same sidecar), the salient-mode notability
 * filter, `source: 'hook:writeback'`, and NO manifest publish (turn files
 * have no segment ledger). Claim/ingested lifecycle is the caller's
 * (runOne's) shared discipline. wb-file state machine (OV2-10): a
 * genuinely-resolved gate-off ⇒ terminal sidecar; keyless /
 * extraction_disabled / abort / plane-drift / invalid-mode / non-transport
 * extraction skip ⇒ NO sidecar (claim released, file remains — the sweep
 * retries when the gate opens or the config re-coheres); success ⇒
 * `.ingested` with persisted counts.
 */
async function runWritebackTurn(job: HarvestJob, full: string, ingestedPath: string): Promise<{
  outcome: 'ok' | 'degraded' | 'error';
  reason?: string;
  inserted?: number;
  duplicate?: number;
  superseded?: number;
}> {
  // #5820: a turn banked from gbrain's own claude-cli session (an older
  // binary's Stop hook, or a child that still ran user hooks) is terminal
  // here exactly as in the sweep — extracting it would spawn another
  // claude-cli call that banks again.
  if (isClaudeCliSelfSessionId(corpusFileSessionId(job.file))) {
    await writeFile(ingestedPath, selfCaptureSidecarJson());
    return { outcome: 'ok', reason: 'self_capture' };
  }
  const { resolveWritebackConfig } = await import('../facts/writeback-config.ts');
  const { loadConfig } = await import('../config.ts');
  // Gate semantics ({gate:true}): a config READ FAILURE is OFF but NOT
  // terminal — skip with no sidecar (claim releases, sweep retries when the
  // DB returns). Same for PLANE DRIFT (DB row absent while the file mirror
  // says enabled — a failed dual-write is not operator intent) and for an
  // UNRECOGNIZED mode value (a typo is not a decision). Only a
  // genuinely-resolved OFF writes the terminal sidecar: that one is intent.
  // The gate resolves BEFORE the capability/kill-switch checks: an
  // operator's OFF must retire the banked turn even on a keyless or
  // extraction-disabled brain — otherwise the file lingers eligible and a
  // later re-enable would extract turns the operator already revoked
  // (codex re-review, this wave).
  const wb = await resolveWritebackConfig(job.engine, loadConfig(), { gate: true });
  if (wb.read_error) return { outcome: 'degraded', reason: 'gate_unreadable' };
  if (!wb.enabled && (wb.plane_drift || !wb.mode_valid)) {
    return { outcome: 'degraded', reason: wb.plane_drift ? 'writeback_plane_drift' : 'writeback_mode_invalid' };
  }
  if (!wb.enabled) {
    const { writebackOffSidecarJson } = await import('./corpus-segments.ts');
    await writeFile(ingestedPath, writebackOffSidecarJson());
    return { outcome: 'ok', reason: 'writeback_off' };
  }
  const { extractionAvailableForEngine } = await import('../facts/extraction-availability.ts');
  if (!(await extractionAvailableForEngine(job.engine, job.capabilities))) {
    return { outcome: 'degraded', reason: 'keyless' };
  }
  const { isFactsExtractionEnabled } = await import('../facts/extract.ts');
  if (!(await isFactsExtractionEnabled(job.engine))) {
    return { outcome: 'degraded', reason: 'extraction_disabled' };
  }

  const raw = await readFile(full, 'utf-8');
  const { runFactsPipeline } = await import('../facts/backstop.ts');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), job.timeoutMs ?? HARVEST_JOB_TIMEOUT_MS);
  currentAbort = abort;
  let r: Awaited<ReturnType<typeof runFactsPipeline>>;
  try {
    r = await runFactsPipeline(corpusTextForExtraction(job.file, raw), {
      engine: job.engine,
      sourceId: job.sourceId,
      sessionId: job.sessionId,
      source: 'hook:writeback',
      mode: 'inline',
      remote: false,
      abortSignal: abort.signal,
      notabilityFilter: wb.mode === 'salient' ? 'medium-and-up' : 'all',
      // visibility deliberately unset → resolveDefaultVisibility [ENG-8] —
      // the backstop inherits extract_facts' contract, never widened (req 6).
    });
  } finally {
    clearTimeout(timer);
    currentAbort = null;
  }
  if (abort.signal.aborted) return { outcome: 'degraded', reason: 'aborted' };
  if (r.skipped_reason) {
    // Non-transport extraction skip (refusal / content_filter /
    // malformed_output / non_terminal_stop / chat_unavailable): NOT terminal
    // — no sidecar, so the sweep's corpus pass retries the file exactly once
    // more and records the final outcome in ITS sidecar. Sidecaring here
    // would turn a transient moderation/format hiccup into silent permanent
    // loss of the banked turn (adversarial review, this wave). Transport
    // failures already throw (FactsExtractionError) and land in runOne's
    // catch with the same no-sidecar result.
    return { outcome: 'degraded', reason: `extract_skipped_${r.skipped_reason}` };
  }

  await writeFile(
    ingestedPath,
    JSON.stringify({
      ingested_at: new Date().toISOString(),
      facts_inserted: r.inserted,
      facts_duplicate: r.duplicate,
      facts_superseded: r.superseded,
      lane: 'writeback',
    }) + '\n',
  );
  return { outcome: 'ok', inserted: r.inserted, duplicate: r.duplicate, superseded: r.superseded };
}

async function readReceipt(path: string): Promise<HarvestReceipt | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as HarvestReceipt;
    if (
      parsed && typeof parsed === 'object' &&
      typeof parsed.session_id === 'string' &&
      typeof parsed.seg === 'string' &&
      Array.isArray(parsed.links)
    ) {
      return { ...parsed, links: parsed.links.filter((l): l is string => typeof l === 'string') };
    }
    return null;
  } catch {
    return null;
  }
}
