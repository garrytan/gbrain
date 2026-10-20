/**
 * v0.32 — Per-source last-run cursor for `gbrain recall --since-last-run`.
 *
 * Two cursor variants per source (Codex round 2 #8):
 *   'briefing' → ~/.gbrain/recall-cursors/<source>.json
 *   'watch'    → ~/.gbrain/recall-cursors/<source>.watch.json
 *
 * Standalone `--since-last-run` reads + writes the briefing cursor. `--watch`
 * ticks write only the watch cursor. Operator who quits a watch session does
 * not lose their briefing position.
 *
 * Atomic write: unique tmp filename per call (Codex round 1 #7), rename(2)
 * into place. Failure is non-fatal (stderr warn + return). Read failures
 * (missing / corrupt JSON / future-shifted timestamp) return null; caller
 * falls back to the documented 24h default.
 *
 * #6945: the record stays schema_version 1. After a full --limit window it
 * also carries after_created_at/after_id, the keyset of the newest fact shown,
 * and last_run_iso holds that fact's created_at. Files without the keyset
 * (all older ones) read as an inclusive wall-clock cursor; an older gbrain
 * reading a keyset file uses last_run_iso. Either way the worst case is a
 * repeat, never a skipped fact.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gbrainPath } from './config.ts';

export type CursorVariant = 'briefing' | 'watch';

interface CursorRecord {
  schema_version: 1;
  last_run_iso: string;
  /** Written only after a full --limit window: the keyset of the newest delivered row (#6945). */
  after_created_at?: string;
  after_id?: number;
}

/** The `(created_at, id)` of a delivered fact, created_at at column (microsecond) precision. */
export interface RecallResumePoint {
  createdAt: string;
  id: number;
}

/**
 * Where `--since-last-run` picks up: `since` (inclusive wall clock) and, when
 * the last run filled its window, `resumeAfter`, the row to page strictly past.
 */
export interface RecallCursor {
  since: Date;
  resumeAfter: RecallResumePoint | null;
}

const CURSOR_DIR_SEGMENT = 'recall-cursors';

function cursorPath(sourceId: string, variant: CursorVariant): string {
  const basename = variant === 'watch' ? `${sourceId}.watch.json` : `${sourceId}.json`;
  return gbrainPath(CURSOR_DIR_SEGMENT, basename);
}

/**
 * Read the cursor for a (source, variant). Returns null on:
 *  - missing file (first run)
 *  - corrupt JSON / unexpected shape
 *  - timestamp parses but lands in the future (clock-skew sanity check)
 * Each null-return path emits a stderr warn (except missing-file, which is
 * the normal first-run case).
 */
export function readCursor(sourceId: string, variant: CursorVariant = 'briefing'): Date | null {
  const path = cursorPath(sourceId, variant);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    process.stderr.write(`[recall] cursor unreadable at ${path}: ${(e as Error).message}\n`);
    return null;
  }
  let rec: CursorRecord;
  try {
    rec = JSON.parse(raw) as CursorRecord;
  } catch {
    process.stderr.write(`[recall] cursor JSON corrupt at ${path}; falling back to default window\n`);
    return null;
  }
  if (rec.schema_version !== 1 || typeof rec.last_run_iso !== 'string') {
    process.stderr.write(`[recall] cursor shape unexpected at ${path}; falling back to default window\n`);
    return null;
  }
  const ms = Date.parse(rec.last_run_iso);
  if (!Number.isFinite(ms)) {
    process.stderr.write(`[recall] cursor timestamp unparseable at ${path}; falling back to default window\n`);
    return null;
  }
  const now = Date.now();
  if (ms > now + 60_000) {
    process.stderr.write(`[recall] cursor timestamp is in the future at ${path}; falling back to default window\n`);
    return null;
  }
  return new Date(ms);
}

/**
 * readCursor plus the stored keyset; null exactly when readCursor is null.
 * The keyset counts only when it is well formed and names the same
 * millisecond as the validated last_run_iso (writePagedCursor writes both
 * from one row). Anything else drops it, leaving the inclusive wall-clock
 * cursor, which can re-deliver rows but never skip them.
 */
export function readRecallCursor(sourceId: string, variant: CursorVariant = 'briefing'): RecallCursor | null {
  const since = readCursor(sourceId, variant);
  if (!since) return null;
  let rec: Partial<CursorRecord>;
  try {
    rec = JSON.parse(readFileSync(cursorPath(sourceId, variant), 'utf8')) as Partial<CursorRecord>;
  } catch {
    return { since, resumeAfter: null };
  }
  const { after_created_at: createdAt, after_id: id } = rec;
  const trusted = typeof createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(createdAt)
    && Date.parse(createdAt) === since.getTime() && Number.isSafeInteger(id) && id! >= 0;
  return { since, resumeAfter: trusted ? { createdAt, id: id! } : null };
}

/**
 * Write the cursor for a (source, variant). Atomic via mkdirSync(recursive)
 * + write-to-tmp + rename(2). Tmp filename includes pid + random suffix so
 * concurrent processes don't clobber each other's tmp files (Codex round 1
 * #7 regression guard).
 *
 * Failure is non-fatal: stderr warn and return. The cursor advance is a
 * best-effort durability hint, not a correctness invariant.
 */
export function writeCursor(sourceId: string, t: Date, variant: CursorVariant = 'briefing'): void {
  writeRecord(sourceId, variant, { schema_version: 1, last_run_iso: t.toISOString() });
}

/**
 * Record a full --limit window: the next run pages strictly after
 * `resumeAfter`. last_run_iso is that row's created_at (to the millisecond),
 * so a reader that ignores the keyset only re-delivers from there.
 */
export function writePagedCursor(sourceId: string, variant: CursorVariant, resumeAfter: RecallResumePoint): void {
  writeRecord(sourceId, variant, {
    schema_version: 1,
    last_run_iso: new Date(Date.parse(resumeAfter.createdAt)).toISOString(),
    after_created_at: resumeAfter.createdAt,
    after_id: resumeAfter.id,
  });
}

function writeRecord(sourceId: string, variant: CursorVariant, rec: CursorRecord): void {
  const path = cursorPath(sourceId, variant);
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    process.stderr.write(`[recall] cursor mkdir failed at ${dir}: ${(e as Error).message}\n`);
    return;
  }
  const suffix = `${process.pid}.${randomBytes(6).toString('hex')}`;
  const tmp = `${path}.tmp.${suffix}`;
  try {
    writeFileSync(tmp, JSON.stringify(rec) + '\n', { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`[recall] cursor write failed at ${tmp}: ${(e as Error).message}\n`);
    return;
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    process.stderr.write(`[recall] cursor rename failed at ${path}: ${(e as Error).message}\n`);
    // Best-effort cleanup of the orphaned tmp file.
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * Test-only export. Returns the full cursor path for a (source, variant).
 * Exposed so tests can poke at the file directly to seed corrupt / stale states.
 */
export function _cursorPathForTests(sourceId: string, variant: CursorVariant = 'briefing'): string {
  return cursorPath(sourceId, variant);
}
