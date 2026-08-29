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
 *   runFactsPipeline under a 60s abort → `signal.aborted` POST-check
 *   (the pipeline returns normally with partial results on abort — an
 *   aborted run writes NOTHING and releases the claim: retryable) →
 *   RECEIPT sidecar (link candidates) → idempotent manifest publish from
 *   the receipt (each slug verified via source-scoped getPage; a link that
 *   resolves to nothing is a lie and is skipped) → `.ingested` LAST.
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
import { readSegmentLedger, HARVEST_RECEIPT_SUFFIX } from './corpus-segments.ts';
import { writeHeartbeat } from './hook-heartbeat.ts';

/** Bounded queue — overflow is a typed skip; the sweep backstop extracts later. */
export const HARVEST_QUEUE_CAP = 8;
/** Per-file abort so a hung provider can't wedge the FIFO. */
export const HARVEST_JOB_TIMEOUT_MS = 60_000;
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
  /** TEST SEAM: capability report override (sweep PassCtx precedent). */
  capabilities?: CapabilityReport;
  /** TEST SEAM: per-job abort budget override (default HARVEST_JOB_TIMEOUT_MS). */
  timeoutMs?: number;
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

export type HarvestAck = { status: 'scheduled' } | { status: 'skipped'; reason: string };

/**
 * Enqueue a segment harvest. O(1), synchronous — the IPC ack never waits on
 * the LLM. Duplicate (same file already queued) and overflow are typed skips.
 */
export function scheduleCheckpointHarvest(job: HarvestJob): HarvestAck {
  if (shuttingDown) return { status: 'skipped', reason: 'shutting_down' };
  if (queue.some((q) => q.file === job.file && q.corpusDir === job.corpusDir)) {
    return { status: 'skipped', reason: 'already_queued' };
  }
  if (queue.length >= HARVEST_QUEUE_CAP) return { status: 'skipped', reason: 'queue_full' };
  queue.push(job);
  void pump();
  return { status: 'scheduled' };
}

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
}

/** TEST SEAM: resolves once the queue is fully drained. */
export async function __drainCheckpointHarvestForTests(): Promise<void> {
  while (inFlight || queue.length > 0) {
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
  let links: number | undefined;
  try {
    const r = await runOne(job);
    outcome = r.outcome;
    reason = r.reason;
    inserted = r.inserted;
    duplicate = r.duplicate;
    links = r.links;
  } catch (e) {
    outcome = 'error';
    reason = e instanceof Error ? (e.name || 'Error').toLowerCase() : 'error';
  } finally {
    inFlight = false;
    await writeHeartbeat({
      ts: new Date().toISOString(),
      event: 'checkpoint-harvest',
      outcome,
      ...(reason ? { reason } : {}),
      duration_ms: Date.now() - t0,
      ...(inserted !== undefined ? { inserted } : {}),
      ...(duplicate !== undefined ? { duplicate } : {}),
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

    // Receipt retry path (codex round 2): extraction already happened; the
    // manifest publish failed transiently. Re-publish WITHOUT re-extracting.
    let receipt = await readReceipt(receiptPath);
    let counts: { inserted: number; duplicate: number } | null = null;

    if (!receipt) {
      // Gates in the pinned sweep order: capability THEN kill switch. A
      // gate-skip releases the claim and writes NO sidecar — when the gate
      // opens later, the sweep (which applies the same gates) extracts.
      const caps = job.capabilities ?? (await import('../capability.ts')).detectCapabilities();
      if (!caps.extraction.available) return { outcome: 'degraded', reason: 'keyless' };
      const { isFactsExtractionEnabled } = await import('../facts/extract.ts');
      if (!(await isFactsExtractionEnabled(job.engine))) {
        return { outcome: 'degraded', reason: 'extraction_disabled' };
      }

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
      let r: Awaited<ReturnType<typeof runFactsPipeline>>;
      try {
        r = await runFactsPipeline(raw, {
          engine: job.engine,
          sourceId: job.sourceId,
          sessionId: job.sessionId,
          source: 'hook:compact',
          mode: 'inline',
          remote: false,
          abortSignal: abort.signal,
          // visibility deliberately unset → resolveDefaultVisibility [ENG-8]
        });
      } finally {
        clearTimeout(timer);
        currentAbort = null;
      }
      // POST-check (codex round 2): runFactsPipeline returns normally with
      // PARTIAL results on abort. An aborted run writes NOTHING (no receipt,
      // no .ingested) and releases the claim — fully retryable.
      if (abort.signal.aborted) return { outcome: 'degraded', reason: 'aborted' };

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
