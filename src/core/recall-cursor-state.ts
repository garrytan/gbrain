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
 * Write the cursor for a (source, variant). Atomic via mkdirSync(recursive)
 * + write-to-tmp + rename(2). Tmp filename includes pid + random suffix so
 * concurrent processes don't clobber each other's tmp files (Codex round 1
 * #7 regression guard).
 *
 * Failure is non-fatal: stderr warn and return. The cursor advance is a
 * best-effort durability hint, not a correctness invariant.
 */
export function writeCursor(sourceId: string, t: Date, variant: CursorVariant = 'briefing'): void {
  const path = cursorPath(sourceId, variant);
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    process.stderr.write(`[recall] cursor mkdir failed at ${dir}: ${(e as Error).message}\n`);
    return;
  }
  const rec: CursorRecord = { schema_version: 1, last_run_iso: t.toISOString() };
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
