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
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gbrainPath } from './config.ts';

export type CursorVariant = 'briefing' | 'watch';

interface CursorRecord {
  schema_version: 1;
  last_run_iso: string;
  /**
   * Set only when a run delivered a FULL --limit window: the `(created_at, id)`
   * of the newest row it delivered, at column precision. The next run pages
   * strictly after it, so rows beyond one window are delivered later instead
   * of being skipped. Optional, so older readers keep using last_run_iso
   * (which then trails the keyset and only re-delivers, never skips).
   */
  after_created_at?: string;
  after_id?: number;
}

/** Where `--since-last-run` resumes: rows strictly after `(createdAt, id)`. */
export interface CursorPosition {
  createdAt: string;
  id: number;
}

/** A wall-clock cursor is inclusive (`created_at >= t`): id 0 sorts before every row. */
export function positionFromTime(t: Date): CursorPosition {
  return { createdAt: t.toISOString(), id: 0 };
}

const COLUMN_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

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
 * The resume position for a (source, variant): the paged keyset when the
 * last run delivered a full window, else the wall-clock cursor as an
 * inclusive position. Null exactly when readCursor is null.
 *
 * The keyset is trusted only when it names the same millisecond as the
 * validated last_run_iso (writeCursor stores both from one row). A future,
 * malformed or inconsistent keyset falls back to the inclusive wall-clock
 * cursor, which can only re-deliver rows, never skip them.
 */
export function readCursorPosition(sourceId: string, variant: CursorVariant = 'briefing'): CursorPosition | null {
  const t = readCursor(sourceId, variant);
  if (!t) return null;
  let rec: Partial<CursorRecord>;
  try {
    rec = JSON.parse(readFileSync(cursorPath(sourceId, variant), 'utf8')) as Partial<CursorRecord>;
  } catch {
    return positionFromTime(t);
  }
  if (typeof rec.after_created_at === 'string' && COLUMN_ISO_RE.test(rec.after_created_at)
      && rec.after_created_at.slice(0, 23) === t.toISOString().slice(0, 23)
      && Number.isSafeInteger(rec.after_id) && (rec.after_id as number) >= 0) {
    return { createdAt: rec.after_created_at, id: rec.after_id as number };
  }
  return positionFromTime(t);
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
export function writeCursor(
  sourceId: string,
  t: Date,
  variant: CursorVariant = 'briefing',
  after?: CursorPosition,
): void {
  const path = cursorPath(sourceId, variant);
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    process.stderr.write(`[recall] cursor mkdir failed at ${dir}: ${(e as Error).message}\n`);
    return;
  }
  const rec: CursorRecord = {
    schema_version: 1,
    last_run_iso: t.toISOString(),
    ...(after ? { after_created_at: after.createdAt, after_id: after.id } : {}),
  };
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
