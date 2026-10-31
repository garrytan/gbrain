/**
 * ingest.ts — the transcripts-import core (cathedral-4).
 *
 * Engine-facing, CLI-free: `gbrain transcripts ingest` parses flags and
 * calls runTranscriptsIngest; e2e tests call it directly. Pipeline per
 * session (ATOMICITY = SESSION, never file — a multi-session file commits
 * the sessions that pass and skips the ones that fail; idempotent re-runs
 * complete the rest):
 *
 *   detect → adapter.parse (AsyncGenerator, per-session) → since/limit
 *   filters → redactSession (fail-closed) → renderSessionParts →
 *   importFromContent per part (embed OFF unless opted in) →
 *   putRawData(baseSlug) → stale-part reconciliation (delete parts past the
 *   rendered count).
 *
 * Layout (Wave B): the stored pages decide how a session renders
 * (`storedTranscriptLayout`). A session with no split pages is one page
 * under the page ceiling; a session already split keeps its parts and their
 * grouping. Nothing merges a split session implicitly.
 *
 * Error taxonomy:
 *   - per-FILE: unreadable / unknown format / symlink → counted, run continues.
 *   - per-SESSION: every failure `classifyItemFailure` calls the item's
 *     (a coordinator refusal, an oversize part, an encoding error) is
 *     recorded on the session with its typed code; the file continues.
 *   - PENDING: a part whose write the coordinator accepted but has not
 *     published within the wait is a pending session: never an error, never
 *     imported, and it keeps the scan unclean. Its request id is derived from
 *     the source, slug, revision and content, so a rerun waits on the same
 *     write instead of admitting a duplicate; a write that ended without
 *     committing is retried under the next attempt's id.
 *   - RUN-LEVEL: run-scoped failures (connection lost, a failed transaction,
 *     the writer unavailable, an abort) stop the run unchanged, and so does
 *     the ItemRun breaker (`item_failures_systemic`) when most sessions fail.
 *
 * Watermark: the RESULT carries `cleanScan` (no errors anywhere, no limit
 * truncation) + `maxSessionTs`; the COMMAND advances the `--since last`
 * checkpoint only on a clean scan — a truncated or partially-failed run
 * must never skip work permanently.
 */

import type { BrainEngine } from '../engine.ts';
import { randomUUID } from 'node:crypto';
import { importFromContent } from '../import-file.ts';
import type { OperationContext } from '../ops/contract.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { initializeLocalPersistence, pendingAwareResponse, requestPrincipalForContext, submitPageMutation } from '../persistence/page-mutations.ts';
import { waitForWrite } from '../persistence/service.ts';
import { isTerminal, type WriteRequest } from '../persistence/model.ts';
import { clientRequestUuid } from '../persistence/preconditions.ts';
import { digest } from '../persistence/digest.ts';
import { classifyItemFailure, ItemRun } from '../item-failure.ts';
import { unchangedPutPage } from '../persistence/put-page-screen.ts';
import { canonicalJson } from '../remediation-step.ts';
import type { FileDiagnostics, ParsedSession, TranscriptAdapter, TranscriptFormat } from './types.ts';
import { detectAdapter, type DetectResult } from './detect.ts';
import {
  loadImportRedactionPatterns,
  PAGE_CEILING_FILL,
  PART_TARGET_BYTES,
  redactSession,
  renderPartContent,
  renderSessionParts,
  transcriptPartId,
  type RedactedSession,
  type RenderedPart,
  type RenderSessionResult,
  type TranscriptLayout,
} from './render.ts';
import { readPageBodyPolicy } from '../page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import { effectiveBytesBlock } from '../import-screen.ts';
import { RECONCILE_SAFETY_KEYS } from '../persistence/reconcile-safety.ts';
import { ATOMS_SCAN_HASH_KEY } from '../utils.ts';

export interface IngestActivePack {
  page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }>;
}

export interface TranscriptsIngestOpts {
  /** Files to import (post-glob, pre-detection). */
  paths: string[];
  /** Explicit format wins over detection. */
  format?: TranscriptFormat;
  /** Parse + redact + render + report; ZERO engine writes. */
  dryRun?: boolean;
  /** Max sessions imported this run (session granularity; truncation ⇒ not a clean scan). */
  limit?: number;
  /** Only sessions whose LAST message is strictly newer than this ISO. */
  sinceIso?: string;
  /** Resolved source id — threads through import, raw-data, reconciliation. */
  sourceId: string;
  /** Embedding opt-in (default OFF: bulk imports defer to the embed backfill). */
  embed?: boolean;
  /**
   * gbrain#4149: explicit byte-cap OVERRIDE threaded to every adapter's
   * parse. Undefined = each adapter keeps its own format-specific default
   * (Hermes 512MB store guard, 50MB jsonl cap, ...) — the override exists
   * for legitimate oversized stores, not to replace the defaults.
   */
  maxBytes?: number;
  activePack?: IngestActivePack;
  /**
   * The CLI's trusted-local operation context. On a writer-claimed brain each
   * rendered part is submitted as a `put_page` write request through it; the
   * direct importer is refused there. Without it the direct importer runs.
   */
  context?: OperationContext;
  /** Test seam for the redaction user-pattern file. */
  userPatternsPath?: string;
  /** Adapter registry override (tests). */
  adapters?: TranscriptAdapter[];
  /** Called once per processed file (progress ticks). */
  onFileDone?: (done: number, total: number, path: string) => void;
  /**
   * Called once per SESSION — the liveness signal for multi-session stores
   * (one hermes state.db can hold thousands of sessions between file ticks).
   */
  onSession?: (sessionId: string) => void;
}

export interface IngestSessionOutcome {
  sessionId: string;
  harness: TranscriptFormat;
  baseSlug: string;
  parts: number;
  /** Per-part import statuses (dry-run: 'planned'; 'pending': accepted, not yet published). */
  statuses: Array<'imported' | 'skipped' | 'error' | 'planned' | 'pending'>;
  redactions: number;
  imperatives: number;
  error?: string;
  /** The typed code of `error` (classifyItemFailure). */
  code?: string;
  /** Request ids of accepted writes still publishing: the session lands on a later run without a new admission. */
  pending?: string[];
  /** C-19: a session with no timestamps is skipped (never fabricated), not errored. */
  skipped?: 'no_timestamp';
}

export interface IngestFileOutcome {
  path: string;
  format?: TranscriptFormat;
  sessions: IngestSessionOutcome[];
  skippedLines: number;
  drift: boolean;
  /** E-N4: assistant turns parsed with zero user turns (counted in driftFiles). */
  userTurnsMissing?: boolean;
  /** #6741: a Codex sub-agent rollout with no user turn by design (counted in subagentRollouts, not drift). */
  subagentRollout?: boolean;
  /** Adapter degraded to a bounded read (e.g. codex head+tail) — part of the file was never scanned. */
  truncated: boolean;
  error?: string;
  /** The filesystem error code when the file could not be read (ENOENT, EACCES, ...). */
  errno?: string;
}

/** The per-file refusal: what was refused and the next step. Nothing of a refused file is imported; other files in the run are unaffected. */
function detectRefusal(detected: Extract<DetectResult, { ok: false }>): string {
  if (detected.reason === 'unknown_format') return `unknown format (tried: ${detected.tried.join(', ')}); pass an explicit format flag`;
  if (detected.reason === 'symlink') return 'symlink: transcript import never follows a symlink; pass the real file path instead. This file was not imported.';
  const errno = detected.errno ?? 'unknown error';
  const step = errno === 'ENOENT' ? 'the path does not exist; check it and retry'
    : errno === 'EACCES' || errno === 'EPERM' ? 'ask the file owner to grant read access, then retry this file with the same format'
    : 'retry this file once the filesystem error clears';
  return `unreadable (${errno}): ${step}. This file was not imported.`;
}

export interface TranscriptsIngestResult {
  files: IngestFileOutcome[];
  pages: { imported: number; skipped: number; errored: number; planned: number; pending: number };
  sessionsSeen: number;
  sessionsImported: number;
  sessionsFiltered: number;
  sessionsErrored: number;
  /** Sessions with an accepted write still publishing (not imported, not errored; the scan is not clean). */
  sessionsPending: number;
  /** Sessions with no timestamps at all: reported, not imported, not an error (C-19). */
  sessionsSkippedNoTimestamp: number;
  redactions: number;
  imperatives: number;
  partsDeleted: number;
  driftFiles: number;
  /** #6741: Codex sub-agent rollouts with no user turns by design; understood, so they keep the scan clean. */
  subagentRollouts: number;
  /** Files whose adapter reported a truncated (partially-unscanned) read. */
  truncatedFiles: number;
  erroredFiles: number;
  /** EVERY slug the run touched — imported AND hash-skipped (--facts targets all). */
  slugsTouched: string[];
  /** True ⇔ no file/session errors and no limit truncation: watermark may advance. */
  cleanScan: boolean;
  /** Newest session last-message ISO seen (imported or filtered). */
  maxSessionTs: string;
}

/**
 * Session's last message timestamp, NORMALIZED to Z-form ISO ('' when none
 * carry one). Normalization matters because since/watermark comparisons are
 * lexicographic: an offset-form ISO (+07:00) string-sorts after a real-time
 * newer Z-form and would poison the watermark. UNPARSEABLE timestamps are
 * SKIPPED, never passed through — a single hostile/corrupt value like a
 * letter-leading string would otherwise become the watermark and since-filter
 * every real session forever.
 */
function lastMessageTs(messages: Array<{ timestamp: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const raw = messages[i].timestamp;
    if (!raw) continue;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) continue;
    return d.toISOString();
  }
  return '';
}

export async function runTranscriptsIngest(
  engine: BrainEngine,
  opts: TranscriptsIngestOpts,
): Promise<TranscriptsIngestResult> {
  const result: TranscriptsIngestResult = {
    files: [],
    pages: { imported: 0, skipped: 0, errored: 0, planned: 0, pending: 0 },
    sessionsSeen: 0,
    sessionsImported: 0,
    sessionsFiltered: 0,
    sessionsErrored: 0,
    sessionsPending: 0,
    sessionsSkippedNoTimestamp: 0,
    redactions: 0,
    imperatives: 0,
    partsDeleted: 0,
    driftFiles: 0,
    subagentRollouts: 0,
    truncatedFiles: 0,
    erroredFiles: 0,
    slugsTouched: [],
    cleanScan: true,
    maxSessionTs: '',
  };
  let limitTruncated = false;

  // Redaction patterns compile ONCE per run — loadPatterns re-reads and
  // recompiles the pattern file on every call, which a bulk import would
  // otherwise repeat thousands of times.
  const redactionPatterns = loadImportRedactionPatterns(opts.userPatternsPath);
  const coordinator = !opts.dryRun && opts.context && await managedPersistenceEnabled(engine) ? opts.context : null;
  const items = new ItemRun('transcripts.ingest_session');
  // Read with the first session that renders. A dry run reads nothing from the brain: it plans every session as a
  // new one-page session at the default ceiling.
  let pageCeiling: number | undefined;

  const total = opts.paths.length;
  let done = 0;
  let newWorkSessions = 0;

  for (const path of opts.paths) {
    if (limitTruncated) break;
    const fileOutcome: IngestFileOutcome = {
      path,
      sessions: [],
      skippedLines: 0,
      drift: false,
      truncated: false,
    };
    result.files.push(fileOutcome);

    const detected = detectAdapter(path, {
      explicitFormat: opts.format,
      adapters: opts.adapters,
    });
    if (!detected.ok) {
      fileOutcome.error = detectRefusal(detected);
      if (detected.errno) fileOutcome.errno = detected.errno;
      result.erroredFiles++;
      result.cleanScan = false;
      done++;
      opts.onFileDone?.(done, total, path);
      continue;
    }
    fileOutcome.format = detected.adapter.format;

    // gbrain#4149: thread the explicit cap override; omit the opts object
    // entirely when unset so adapters keep their native defaults.
    const gen = opts.maxBytes != null
      ? detected.adapter.parse(path, { maxBytes: opts.maxBytes })
      : detected.adapter.parse(path);
    try {
      let step = await gen.next();
      while (!step.done) {
        if (limitTruncated) {
          // Stop consuming; the generator's finally blocks clean up.
          await gen.return?.(undefined as never);
          break;
        }
        const session = step.value;
        result.sessionsSeen++;
        opts.onSession?.(session.meta.sessionId);
        const lastTs = lastMessageTs(session.messages);
        if (lastTs && lastTs > result.maxSessionTs) result.maxSessionTs = lastTs;

        if (opts.sinceIso && lastTs && lastTs <= opts.sinceIso) {
          result.sessionsFiltered++;
          step = await gen.next();
          continue;
        }
        // The limit counts NEW WORK only (sessions with a non-skipped part).
        // Counting hash-skipped re-scans would make batched backfill loop
        // over the same already-imported prefix forever: every run would
        // burn the limit on free re-scans and truncate before new sessions.
        if (opts.limit !== undefined && newWorkSessions >= opts.limit) {
          limitTruncated = true;
          result.cleanScan = false;
          await gen.return?.(undefined as never);
          break;
        }

        const outcome: IngestSessionOutcome = {
          sessionId: session.meta.sessionId,
          harness: session.meta.harness,
          baseSlug: '',
          parts: 0,
          statuses: [],
          redactions: 0,
          imperatives: 0,
        };
        fileOutcome.sessions.push(outcome);

        // C-19: a session with no timestamps can never render (provenance is
        // never fabricated), so retrying it is pointless; report the skip and
        // keep the scan clean instead of freezing the --since checkpoint.
        if (!session.meta.startedAt && !session.messages.some(m => m.timestamp)) {
          outcome.skipped = 'no_timestamp';
          result.sessionsSkippedNoTimestamp++;
          step = await gen.next();
          continue;
        }

        try {
          const redacted = redactSession(session, {
            userPatternsPath: opts.userPatternsPath,
            patterns: redactionPatterns,
          });
          outcome.redactions = redacted.redactionCount;
          outcome.imperatives = redacted.imperativesFlagged;
          pageCeiling ??= opts.dryRun ? Math.floor(PAGE_MAX_BYTES * PAGE_CEILING_FILL) : await transcriptPageCeiling(engine);
          const stored = opts.dryRun
            ? { layout: 'single' as const, partTargetBytes: pageCeiling, existingSlug: null }
            : await storedTranscriptLayout(engine, opts.sourceId ?? 'default', session.meta, pageCeiling);
          const rendered = renderSessionParts(redacted, { sourcePath: path, layout: stored.layout, partTargetBytes: stored.partTargetBytes });
          if (stored.existingSlug) adoptExistingBaseSlug(rendered, stored.existingSlug);
          outcome.baseSlug = rendered.baseSlug;
          outcome.parts = rendered.parts.length;

          if (opts.dryRun) {
            outcome.statuses = rendered.parts.map(() => 'planned' as const);
            result.pages.planned += rendered.parts.length;
            // #4762: a planned session is new work too, so the --limit gate
            // above truncates the preview like the real run. A dry run cannot
            // see hash-skips or a stored split layout (no engine reads), so `--dry-run --limit N` shows
            // the first N eligible sessions — an upper bound on what the write
            // path would import.
            newWorkSessions++;
          } else if (await importSession(engine, opts, { coordinator, items, path, session, redacted, rendered, outcome, result })) {
            newWorkSessions++;
          }
          if (outcome.pending) {
            result.sessionsPending++;
            result.cleanScan = false;
          } else {
            items.succeed();
            result.sessionsImported++;
            result.redactions += outcome.redactions;
            result.imperatives += outcome.imperatives;
          }
        } catch (err) {
          // Run-scoped failures and a tripped breaker leave through here unchanged.
          const failure = items.fail(session.meta.sessionId, err);
          if (failure.scope === 'pending') {
            (outcome.pending ??= []).push(failure.requestId!);
            result.sessionsPending++;
          } else {
            outcome.error = failure.message;
            outcome.code = failure.code;
            result.sessionsErrored++;
          }
          result.cleanScan = false;
        }

        step = await gen.next();
      }
      if (step.done && step.value) applyFileDiagnostics(step.value, fileOutcome, result);
    } catch (err) {
      if (classifyItemFailure(err).scope === 'run') throw err;
      fileOutcome.error = err instanceof Error ? err.message : String(err);
      result.erroredFiles++;
      result.cleanScan = false;
    }

    done++;
    opts.onFileDone?.(done, total, path);
  }

  if (opts.dryRun) result.cleanScan = false; // dry-runs never advance watermarks
  return result;
}

/**
 * Writes one rendered session: every part (through the coordinator or the
 * direct importer), then the session's raw metadata and its stale
 * higher-numbered parts. A part the coordinator accepted but has not
 * published leaves the session pending while its other parts still go; the
 * metadata and the reconciliation wait for a run where every part landed.
 * Returns whether the session was new work (a part that was not skipped).
 */
async function importSession(engine: BrainEngine, opts: TranscriptsIngestOpts, run: {
  coordinator: OperationContext | null; items: ItemRun; path: string; session: ParsedSession; redacted: RedactedSession;
  rendered: RenderSessionResult; outcome: IngestSessionOutcome; result: TranscriptsIngestResult;
}): Promise<boolean> {
  const { coordinator, items, path, session, redacted, rendered, outcome, result } = run;
  // The RESOLVED base slug: identity dedup can resolve part 1 to an
  // EXISTING page under a different slug (same session id, changed
  // title or corrected start date) — raw-data writes and stale-part
  // reconciliation must follow the page that actually exists, or
  // every re-run aborts on a nonexistent slug. The caller adopted the
  // stored slug (storedTranscriptLayout read it).
  let resolvedBaseSlug = rendered.baseSlug;
  for (const part of rendered.parts) {
    let r: { slug: string; status: 'imported' | 'skipped' | 'error' };
    try {
      await preserveForeignFrontmatter(engine, opts.sourceId ?? 'default', part);
      const provenance = { source_kind: `transcript:${session.meta.harness}`, source_uri: path, ingested_via: 'cli:transcripts-ingest' };
      r = coordinator
        ? await submitTranscriptPart(coordinator, engine, opts.sourceId, part, provenance)
        : await importFromContent(engine, part.slug, part.content, {
          noEmbed: !opts.embed,
          sourceId: opts.sourceId,
          activePack: opts.activePack,
          ...provenance,
        });
    } catch (err) {
      if (classifyItemFailure(err).scope !== 'pending') throw err;
      (outcome.pending ??= []).push(items.fail(`${session.meta.sessionId}#p${part.part}`, err).requestId!);
      outcome.statuses.push('pending');
      result.pages.pending++;
      continue;
    }
    outcome.statuses.push(r.status);
    if (r.status === 'imported') result.pages.imported++;
    else if (r.status === 'skipped') result.pages.skipped++;
    else result.pages.errored++;
    const actualSlug = r.slug || part.slug;
    if (part.part === 1 && actualSlug) resolvedBaseSlug = actualSlug;
    result.slugsTouched.push(actualSlug);
  }
  if (outcome.pending) return true;

  // importFromContent RETURNS status 'error' (it does not throw)
  // for e.g. frontmatter-parse failures. A page that never landed
  // is a session error and must freeze the watermark — otherwise
  // a since-last run permanently skips content that never imported.
  if (outcome.statuses.includes('error')) {
    throw new Error(
      `page import returned error status for session ${session.meta.sessionId}`,
    );
  }

  const allSkipped =
    outcome.statuses.length > 0 && outcome.statuses.every((s) => s === 'skipped');

  // Session metadata rides the base page's raw_data — the REDACTED
  // copy, never the original (secrets in titles/cwd would otherwise
  // bypass the page-body redaction). On all-skipped re-runs the
  // write is HEALED, not assumed: a prior run can have committed
  // the pages and then died before putRawData, and hash-skips
  // would otherwise make that hole permanent.
  if (redacted.session.meta.raw) {
    const rawSource = `transcript:${session.meta.harness}`;
    // Skipped re-runs COMPARE, never assume: existence alone is
    // not freshness — a private pattern added AFTER the first
    // import must refresh the stored copy, and a prior run can
    // have died before this write. Content-equal rows skip the
    // write so healthy re-runs stay write-free.
    let needsRaw = true;
    if (allSkipped) {
      // Active rows only: `allSkipped` means the import hash check
      // (which reads ACTIVE rows) just matched every page, so the
      // base page is alive here by construction — a tombstoned
      // page never reaches this branch (it reads as missing and is
      // re-imported, see the "resurrects the page" e2e). No
      // includeDeleted flag: the probe must never read through a
      // soft-delete the hash check did not.
      const existing = await engine.getRawData(resolvedBaseSlug, rawSource, {
        sourceId: opts.sourceId,
      });
      // Key-order-insensitive compare: JSONB hands keys back in
      // its own canonical order, so a plain JSON.stringify never
      // matched the freshly built object and every healthy re-run
      // rewrote the row.
      needsRaw =
        existing.length === 0 ||
        canonicalJson(existing[0].data) !==
          canonicalJson(JSON.parse(JSON.stringify(redacted.session.meta.raw)));
    }
    if (needsRaw) {
      await engine.putRawData(resolvedBaseSlug, rawSource, redacted.session.meta.raw, {
        sourceId: opts.sourceId,
      });
    }
  }

  // Stale-part reconciliation: a session whose content shrank leaves
  // higher-numbered part pages behind — delete them, or a stale part
  // stays searchable forever. It never merges a split session: the
  // layout came from the stored pages, so a split session renders as
  // parts at its stored part size and growth never lowers their count. ENUMERATED via one SQL
  // query (never a sequential probe: a crash mid-delete leaves
  // holes that a first-miss or bounded-miss probe walks past) and
  // run on EVERY pass including all-skipped re-runs, because a
  // prior run can have died between the page writes and this step.
  const partRows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages
     WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE $2`,
    [opts.sourceId, `${resolvedBaseSlug}-p%`],
  );
  for (const row of partRows) {
    const suffix = row.slug.slice(resolvedBaseSlug.length);
    const m = /^-p(\d+)$/.exec(suffix);
    const num = m ? Number(m[1]) : NaN;
    if (Number.isFinite(num) && num > rendered.parts.length) {
      // #5235: on a managed brain the stale part goes through the coordinator like the parts
      // themselves, bound to its revision; the direct delete is refused there.
      if (coordinator) await deleteStaleTranscriptPart(coordinator, engine, opts.sourceId, row.slug);
      else await engine.deletePage(row.slug, { sourceId: opts.sourceId });
      result.partsDeleted++;
    }
  }
  return !allSkipped;
}

/**
 * A writer-claimed brain refuses the direct importer, so a rendered part is
 * submitted as a `put_page` write request: the same importer runs behind the
 * coordinator, naming the current revision so a replacement is never a blind
 * overwrite (no revision means create-only). Embedding is deferred there, as
 * for every coordinated page write. #6741 B: a part whose publication would
 * change nothing takes no admission (put-page-screen.ts), so an unchanged
 * re-ingest burns no permanent request id. A part whose earlier write is
 * still publishing waits on that write (transcriptPartRequest) instead of
 * admitting a second one.
 */
async function submitTranscriptPart(
  ctx: OperationContext,
  engine: BrainEngine,
  sourceId: string,
  part: RenderedPart,
  provenance: { source_kind: string; source_uri: string; ingested_via: string },
): Promise<{ slug: string; status: 'imported' | 'skipped' | 'error' }> {
  const snapshot = await engine.readPageSnapshot(part.slug, { sourceId, includeDeleted: true });
  const params = { slug: part.slug, content: part.content, source_id: sourceId, ...provenance,
    ...(snapshot?.revision ? { expected_revision: snapshot.revision } : {}) };
  if (await unchangedPutPage(ctx, params, snapshot)) return { slug: part.slug, status: 'skipped' };
  const { requestId, prior } = await transcriptPartRequest(ctx, sourceId, part.slug, params);
  const receipt = prior
    ? pendingAwareResponse(ctx, await waitForWrite(ctx.engine, prior, ctx.config, ctx.writeWaitMs))
    : await submitPageMutation(ctx, { operation: 'put_page', params: { ...params, request_id: requestId } });
  const slug = typeof receipt.slug === 'string' && receipt.slug ? receipt.slug : part.slug;
  if (receipt.state !== 'committed') return { slug, status: 'error' };
  return { slug, status: receipt.noop === true || receipt.status === 'skipped' ? 'skipped' : 'imported' };
}

/** Attempts read per journal lookup while finding a part's current request. */
const PART_ATTEMPT_PAGE = 8;

/**
 * One part's write keeps one request identity across runs. The id is derived
 * from the source, slug, expected revision and content, so a rerun while that
 * write is still queued or publishing gets it back (`prior`) and waits on it;
 * a committed one is replayed only while the live page is still the one it
 * produced (same source incarnation, same revision). A committed write whose
 * page has since been deleted and purged, or rewritten, is passed over like a
 * write that ended without committing (conflict, failed, cancelled): the part
 * is submitted under the next attempt's id, so a cleared cause or an absent
 * page gets a fresh, normally admitted write instead of an old receipt.
 */
async function transcriptPartRequest(ctx: OperationContext, sourceId: string, slug: string, params: Record<string, unknown>):
  Promise<{ requestId: string; prior: WriteRequest | null }> {
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  const base = `transcript-${digest({ source_id: sourceId, slug, expected_revision: params.expected_revision ?? null, content: params.content }).slice(0, 40)}`;
  for (let first = 0; ; first += PART_ATTEMPT_PAGE) {
    const names = Array.from({ length: PART_ATTEMPT_PAGE }, (_, i) => `${base}-${first + i}`);
    const rows = await ctx.engine.executeRaw<WriteRequest>(
      'SELECT * FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=ANY($3::uuid[])',
      [principal.kind, principal.id, names.map(clientRequestUuid)]);
    const byId = new Map(rows.map(row => [String(row.request_id).toLowerCase(), row]));
    for (const requestId of names) {
      const prior = byId.get(clientRequestUuid(requestId)) ?? null;
      if (!prior || !isTerminal(prior)) return { requestId, prior };
      if (prior.state !== 'committed') continue;
      const live = await ctx.engine.readPageSnapshot(slug, { sourceId });
      if (live?.sourceIncarnation === prior.source_incarnation && live.revision === prior.outcome?.revision) return { requestId, prior };
    }
  }
}

/**
 * A stale higher-numbered part on a managed brain: a revision-bound `delete_page` write request (soft delete, recoverable).
 * #6741 C: an internal reconciliation, so it is admitted as background work: against a worktree in recovery it is
 * refused before any receipt (admission-origin.ts) and the session errors, instead of each run taking a new request id.
 * That refusal (owner_unavailable) pauses background work only, so it is this session's error, never the run's:
 * foreground parts of every other session are still admitted.
 */
async function deleteStaleTranscriptPart(ctx: OperationContext, engine: BrainEngine, sourceId: string, slug: string): Promise<void> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot) return;
  const receipt = await submitPageMutation({ ...ctx, admissionOrigin: 'background' }, { operation: 'delete_page', params: { slug, source_id: sourceId, expected_revision: snapshot.revision, request_id: randomUUID() } })
    .catch((err: unknown) => {
      if (classifyItemFailure(err).code !== 'owner_unavailable') throw err;
      throw new Error(`stale part ${slug} was not deleted: ${err instanceof Error ? err.message : String(err)}`);
    });
  if (receipt.state !== 'committed') {
    throw new Error(`stale part ${slug} was not deleted: the coordinator returned ${String(receipt.state)}${receipt.error_code ? ` (${String(receipt.error_code)})` : ''}`);
  }
}

/**
 * The slug embeds the title (and start day) for export formats, so a rename
 * renders a new slug for the same session. Import at the slug the session's
 * pages already live at: the content is then an in-place update. At a new
 * slug, the importer's cross-slug identity dedup skipped it as a duplicate
 * and every message added since the last import was silently dropped.
 */
/**
 * Re-ingest replaces only what the collector renders (#5431): keys another
 * tool or the operator added to an imported conversation page (a review flag,
 * say) are carried onto the re-rendered part. Gate- and phase-owned markers
 * are re-derived from the new content, so they are never carried.
 */
async function preserveForeignFrontmatter(engine: BrainEngine, sourceId: string, part: RenderedPart): Promise<void> {
  const existing = await engine.getPage(part.slug, { sourceId });
  const foreign = Object.entries(existing?.frontmatter ?? {})
    .filter(([key]) => !Object.hasOwn(part.frontmatter, key) && !RE_DERIVED_KEYS.has(key));
  if (foreign.length === 0) return;
  part.content = renderPartContent({ ...part.frontmatter, ...Object.fromEntries(foreign) }, part.body);
}

const RE_DERIVED_KEYS = new Set([...RECONCILE_SAFETY_KEYS, ATOMS_SCAN_HASH_KEY]);

function adoptExistingBaseSlug(rendered: RenderSessionResult, existingSlug: string): void {
  if (existingSlug === rendered.baseSlug) return;
  rendered.baseSlug = existingSlug;
  for (const part of rendered.parts) part.slug = part.part === 1 ? existingSlug : `${existingSlug}-p${part.part}`;
}

/**
 * The body bytes a single-layout session may fill: the page ceiling
 * (`pages.max_bytes`, or the inline ceiling while segmented storage is off)
 * or the content-sanity block line, whichever is lower (a page over the block
 * line would land with embedding skipped), times PAGE_CEILING_FILL for the
 * frontmatter. Read once per run.
 */
async function transcriptPageCeiling(engine: BrainEngine): Promise<number> {
  const [policy, block] = await Promise.all([readPageBodyPolicy(engine), effectiveBytesBlock(engine)]);
  return Math.floor(Math.min(policy.maxBytes, block) * PAGE_CEILING_FILL);
}

/** The provenance the importer stamps on every part it writes (importFromContent and the coordinated put_page). */
const IMPORTER_INGESTED_VIA = 'cli:transcripts-ingest';

/**
 * How a session renders, from what is stored (one query by the part 1 and
 * part 2 identities, which also finds part 1's slug for adoption). The
 * session is split when part 2 is live, or part 1 is live without
 * `of <= 1` (a legacy `of > 1`, or a split part 1 that no longer carries
 * `of`); it then keeps the part size its parts carry (`part_bytes`, else
 * the pre-Wave-B PART_TARGET_BYTES). Otherwise it is one page under the page
 * ceiling. A split session is never re-rendered as one page.
 *
 * `transcript_import` is ordinary frontmatter that any writer can set, so its
 * `of` and `part_bytes` are read only from a part whose LIVE revision the
 * importer wrote. `pages.ingested_via` can't say that: a managed write keeps
 * the first write's stamp (persistence/page-prepare.ts), so a remote put_page
 * over an imported page still reads `cli:transcripts-ingest`. The live
 * revision's writer is the write attribution (`revision_write_request_id`):
 *   - a journaled request wrote it: trusted when that request is the local
 *     CLI's and its own intent carries the importer's provenance (a remote
 *     request's intent is always server-stamped `mcp:<operation>`);
 *   - its request has left the journal: trusted when the revision's principal
 *     is the local CLI and the page carries the importer's stamp;
 *   - no request wrote it (the direct importer on an unmanaged brain, a write
 *     from before attribution): trusted when `ingested_via` is the importer's
 *     or NULL; a remote write is always a journaled request, and on this path
 *     it also replaces the stamp with `mcp:<operation>`.
 * So a remote edit can't choose the layout or the part size. A part 2 is
 * split evidence only under the same rule: its id is derivable from part 1's,
 * so any writer can put a page carrying it anywhere. A split session the
 * importer rewrote still reads as split from part 1 (no `of`), or from a
 * part 2 the importer wrote. One exception keeps a remote edit from merging a
 * split session (deleting its parts): when part 1's own fields are not
 * trusted, a part 2 at part 1's slug plus `-p2` counts whoever wrote it. A `part_bytes` is accepted only between PART_TARGET_BYTES
 * (or the ceiling, when that is lower) and the current ceiling.
 */
async function storedTranscriptLayout(engine: BrainEngine, sourceId: string, meta: ParsedSession['meta'], pageCeiling: number):
  Promise<{ layout: TranscriptLayout; partTargetBytes: number; existingSlug: string | null }> {
  const [first, second] = [transcriptPartId(meta, 1), transcriptPartId(meta, 2)];
  const rows = await engine.executeRaw<{ slug: string; fid: string; ti: unknown; trusted: boolean }>(
    `SELECT p.slug, p.frontmatter->>'id' AS fid, p.frontmatter->'transcript_import' AS ti,
            CASE WHEN p.revision_write_request_id IS NULL THEN p.ingested_via IS NULL OR p.ingested_via = $4
                 WHEN r.id IS NOT NULL THEN r.principal_kind = 'local_cli' AND r.intent->>'ingested_via' IS NOT DISTINCT FROM $4
                 ELSE p.revision_principal_kind IS NOT DISTINCT FROM 'local_cli' AND p.ingested_via IS NOT DISTINCT FROM $4 END AS trusted
       FROM pages p LEFT JOIN persistence_requests r ON r.id = p.revision_write_request_id
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.frontmatter->>'id' IN ($2, $3) ORDER BY p.id`,
    [sourceId, first, second, IMPORTER_INGESTED_VIA],
  );
  const importMeta = (row: { ti: unknown; trusted: boolean } | undefined) => {
    if (!row || row.trusted !== true) return null;
    const ti = typeof row.ti === 'string' ? JSON.parse(row.ti) : row.ti;
    return ti && typeof ti === 'object' ? ti as { of?: unknown; part_bytes?: unknown } : null;
  };
  const partOne = rows.find(row => row.fid === first);
  const partTwo = rows.find(row => row.fid === second && (row.trusted === true
    || (partOne !== undefined && partOne.trusted !== true && row.slug === `${partOne.slug}-p2`)));
  const one = importMeta(partOne);
  const split = partTwo !== undefined || (one !== null && !(Number(one.of) <= 1));
  if (!split) return { layout: 'single', partTargetBytes: pageCeiling, existingSlug: partOne?.slug ?? null };
  const floor = Math.min(PART_TARGET_BYTES, pageCeiling);
  const pinned = [one?.part_bytes, importMeta(partTwo)?.part_bytes]
    .find(v => Number.isSafeInteger(v) && (v as number) >= floor && (v as number) <= pageCeiling) as number | undefined;
  return { layout: 'split', partTargetBytes: pinned ?? floor, existingSlug: partOne?.slug ?? null };
}

/** Fold one file's adapter diagnostics into its outcome and the run result (drift, skipped lines, truncation). */
function applyFileDiagnostics(diag: FileDiagnostics, fileOutcome: IngestFileOutcome, result: TranscriptsIngestResult): void {
  fileOutcome.skippedLines = diag.skippedLines;
  if (diag.bytesRead > 0 && diag.sessions === 0 && !diag.expectedEmpty) {
    fileOutcome.drift = true;
    result.driftFiles++;
    // A drifting file may hold sessions a fixed parser will surface
    // later (torn hermes copy, transient format break) — the shared
    // watermark must not advance past it. expectedEmpty (a grok
    // tool/reasoning-only session) is understood, not drifted.
    result.cleanScan = false;
  }
  if (diag.userTurnsMissing && !fileOutcome.drift) {
    // E-N4: assistant turns parsed but not one user turn — the shape
    // #5163 hid behind (a host renamed its user-turn record). The
    // session still imports, but the file is drift: the watermark holds
    // so a fixed parser re-reads it.
    fileOutcome.drift = true;
    fileOutcome.userTurnsMissing = true;
    result.driftFiles++;
    result.cleanScan = false;
  }
  if (diag.subagentRollout) {
    fileOutcome.subagentRollout = true;
    result.subagentRollouts++;
  }
  if (diag.skippedLines > 0) {
    // Malformed lines can be DROPPED RECORDS (an actively-appended
    // file read mid-write, corruption) — freeze the watermark so a
    // later repair with an older timestamp is still picked up.
    // Re-scans stay cheap via content-hash skip.
    result.cleanScan = false;
  }
  if (diag.truncated) {
    // A bounded read (codex head+tail over an over-budget rollout)
    // skipped a window of the file — advancing the since-watermark
    // over that unscanned window would drop its sessions permanently.
    fileOutcome.truncated = true;
    result.truncatedFiles++;
    result.cleanScan = false;
  }
}
