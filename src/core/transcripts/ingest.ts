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
 *   putRawData(baseSlug) → stale-part reconciliation (delete part > of).
 *
 * Error taxonomy:
 *   - per-FILE: unreadable / unknown format / symlink → counted, run continues.
 *   - per-SESSION: scan failure, oversize part, adapter throw → counted,
 *     file continues.
 *   - RUN-LEVEL (fail-closed integrity): importFromContent duplicate-lookup
 *     or read-back failures and putRawData misses rethrow and abort the run.
 *     Heuristic seam: import errors matching /too large/ stay per-session.
 *
 * Watermark: the RESULT carries `cleanScan` (no errors anywhere, no limit
 * truncation) + `maxSessionTs`; the COMMAND advances the `--since last`
 * checkpoint only on a clean scan — a truncated or partially-failed run
 * must never skip work permanently.
 */

import type { BrainEngine } from '../engine.ts';
import { importFromContent } from '../import-file.ts';
import type { TranscriptAdapter, TranscriptFormat } from './types.ts';
import { detectAdapter } from './detect.ts';
import {
  loadImportRedactionPatterns,
  redactSession,
  renderSessionParts,
} from './render.ts';

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
  /** Per-part import statuses (dry-run: 'planned'). */
  statuses: Array<'imported' | 'skipped' | 'error' | 'planned'>;
  redactions: number;
  imperatives: number;
  error?: string;
}

export interface IngestFileOutcome {
  path: string;
  format?: TranscriptFormat;
  sessions: IngestSessionOutcome[];
  skippedLines: number;
  drift: boolean;
  /** Adapter degraded to a bounded read (e.g. codex head+tail) — part of the file was never scanned. */
  truncated: boolean;
  error?: string;
}

export interface TranscriptsIngestResult {
  files: IngestFileOutcome[];
  pages: { imported: number; skipped: number; errored: number; planned: number };
  sessionsSeen: number;
  sessionsImported: number;
  sessionsFiltered: number;
  sessionsErrored: number;
  redactions: number;
  imperatives: number;
  partsDeleted: number;
  driftFiles: number;
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

const RUN_ABORT_MARKER = 'transcripts-ingest run abort';

function isPerSessionImportError(err: unknown): boolean {
  return err instanceof Error && /too large/i.test(err.message);
}

export async function runTranscriptsIngest(
  engine: BrainEngine,
  opts: TranscriptsIngestOpts,
): Promise<TranscriptsIngestResult> {
  const result: TranscriptsIngestResult = {
    files: [],
    pages: { imported: 0, skipped: 0, errored: 0, planned: 0 },
    sessionsSeen: 0,
    sessionsImported: 0,
    sessionsFiltered: 0,
    sessionsErrored: 0,
    redactions: 0,
    imperatives: 0,
    partsDeleted: 0,
    driftFiles: 0,
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
      fileOutcome.error =
        detected.reason === 'unknown_format'
          ? `unknown format (tried: ${detected.tried.join(', ')}); pass an explicit format flag`
          : detected.reason;
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

        try {
          const redacted = redactSession(session, {
            userPatternsPath: opts.userPatternsPath,
            patterns: redactionPatterns,
          });
          outcome.redactions = redacted.redactionCount;
          outcome.imperatives = redacted.imperativesFlagged;
          const rendered = renderSessionParts(redacted, { sourcePath: path });
          outcome.baseSlug = rendered.baseSlug;
          outcome.parts = rendered.parts.length;

          if (opts.dryRun) {
            outcome.statuses = rendered.parts.map(() => 'planned' as const);
            result.pages.planned += rendered.parts.length;
          } else {
            // The RESOLVED base slug: identity dedup can resolve part 1 to an
            // EXISTING page under a different slug (same session id, changed
            // title or corrected start date) — raw-data writes and stale-part
            // reconciliation must follow the page that actually exists, or
            // every re-run aborts on a nonexistent slug.
            let resolvedBaseSlug = rendered.baseSlug;
            for (const part of rendered.parts) {
              try {
                const r = await importFromContent(engine, part.slug, part.content, {
                  noEmbed: !opts.embed,
                  sourceId: opts.sourceId,
                  activePack: opts.activePack,
                  source_kind: `transcript:${session.meta.harness}`,
                  source_uri: path,
                  ingested_via: 'cli:transcripts-ingest',
                });
                outcome.statuses.push(r.status);
                if (r.status === 'imported') result.pages.imported++;
                else if (r.status === 'skipped') result.pages.skipped++;
                else result.pages.errored++;
                const actualSlug = r.slug || part.slug;
                if (part.part === 1 && actualSlug) resolvedBaseSlug = actualSlug;
                result.slugsTouched.push(actualSlug);
              } catch (err) {
                if (isPerSessionImportError(err)) throw err; // → per-session catch
                const e = new Error(
                  `${RUN_ABORT_MARKER}: import integrity failure on ${part.slug}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
                (e as { cause?: unknown }).cause = err;
                throw e;
              }
            }

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
            if (!allSkipped) newWorkSessions++;

            // Session metadata rides the base page's raw_data — the REDACTED
            // copy, never the original (secrets in titles/cwd would otherwise
            // bypass the page-body redaction). On all-skipped re-runs the
            // write is HEALED, not assumed: a prior run can have committed
            // the pages and then died before putRawData, and hash-skips
            // would otherwise make that hole permanent.
            if (redacted.session.meta.raw) {
              try {
                const rawSource = `transcript:${session.meta.harness}`;
                // Skipped re-runs COMPARE, never assume: existence alone is
                // not freshness — a private pattern added AFTER the first
                // import must refresh the stored copy, and a prior run can
                // have died before this write. Content-equal rows skip the
                // write so healthy re-runs stay write-free.
                let needsRaw = true;
                if (allSkipped) {
                  const existing = await engine.getRawData(resolvedBaseSlug, rawSource, {
                    sourceId: opts.sourceId,
                  });
                  needsRaw =
                    existing.length === 0 ||
                    JSON.stringify(existing[0].data) !== JSON.stringify(redacted.session.meta.raw);
                }
                if (needsRaw) {
                  await engine.putRawData(resolvedBaseSlug, rawSource, redacted.session.meta.raw, {
                    sourceId: opts.sourceId,
                  });
                }
              } catch (err) {
                const e = new Error(
                  `${RUN_ABORT_MARKER}: putRawData failed for ${resolvedBaseSlug}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
                (e as { cause?: unknown }).cause = err;
                throw e;
              }
            }

            // Stale-part reconciliation: a session that shrank or re-split
            // leaves higher-numbered part pages behind — delete them, or a
            // stale part stays searchable forever. ENUMERATED via one SQL
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
                await engine.deletePage(row.slug, { sourceId: opts.sourceId });
                result.partsDeleted++;
              }
            }
          }
          result.sessionsImported++;
          result.redactions += outcome.redactions;
          result.imperatives += outcome.imperatives;
        } catch (err) {
          if (err instanceof Error && err.message.startsWith(RUN_ABORT_MARKER)) throw err;
          outcome.error = err instanceof Error ? err.message : String(err);
          result.sessionsErrored++;
          result.cleanScan = false;
        }

        step = await gen.next();
      }
      if (step.done && step.value) {
        const diag = step.value;
        fileOutcome.skippedLines = diag.skippedLines;
        if (diag.bytesRead > 0 && diag.sessions === 0) {
          fileOutcome.drift = true;
          result.driftFiles++;
          // A drifting file may hold sessions a fixed parser will surface
          // later (torn hermes copy, transient format break) — the shared
          // watermark must not advance past it.
          result.cleanScan = false;
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
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(RUN_ABORT_MARKER)) throw err;
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
