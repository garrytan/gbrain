/**
 * corpus-segments.ts — Cathedral 5 (checkpoint compaction): content-addressed
 * pre-compaction corpus segments + the per-session ledger + the session-end
 * exact-set coverage decision.
 *
 * ENGINE-FREE, pure fs given a corpus dir — usable from the engine-free hook
 * command AND (lazily) from the OpenClaw context engine's compact() step.
 *
 * Identity model (codex round 2):
 *   - Segment filename = `<sessionId>.seg-<sha256_24(redactedText)>.txt` —
 *     PURELY content-addressed, no ordinal. A retry of identical content maps
 *     to the same name (idempotent; a stale `.ingested` sidecar on that name
 *     means the same bytes were already extracted — a correct skip, never a
 *     collision). Segments end in `.txt` ON PURPOSE: the serve sweep's corpus
 *     pass picks them up with zero changes (the extraction backstop).
 *   - Ledger `<sessionId>.ledger.json` = append-only array of {hash, ts},
 *     entry order is the only ordinal (manifest metadata, never filenames).
 *     Writes are atomic tmp+rename; unreadable/unparseable ⇒ treated as
 *     absent (fail-open — the consumer falls back to full-transcript
 *     behavior, at-least-once).
 *   - Crash ordering: segment rename FIRST, ledger append SECOND. A crash
 *     between leaves an orphan segment (sweep still extracts it; session-end
 *     sees the ledger gap and falls back to full-file).
 *
 * Coverage (session-end): for each non-empty boundary window in the caller's
 * OWN parse, recompute the window's redacted-segment hash and require it in
 * the ledger SET (count equality alone can be fooled by a duplicated boundary
 * masking a missed one). Ledger-superset is fine — a banked segment whose
 * window scrolled out of the parse tail is still covered.
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WindowTurn } from './entity-salience.ts';
import { toCorpusText } from '../transcripts/claude-code-jsonl.ts';
import { mapOpenclawLine } from '../transcripts/openclaw.ts';

/** Length of the hex content-hash slice in segment filenames. */
/**
 * 24 hex chars = 96 bits (adversarial review: the original 48-bit truncation
 * let an attacker who influences conversation content birthday-collide two
 * windows offline in ~2^24 hashes — the second window would map to an
 * existing filename and silently never be banked. 96 bits puts the collision
 * work at ~2^48 hashes; filenames stay well under SAFE_CORPUS_BASENAME's 240
 * cap). Parsers accept 12–64 hex so pre-widening segments still match.
 */
const SEGMENT_HASH_LEN = 24;

/**
 * Filename-component sanitizer (pre-landing review, security): session ids
 * reach the filename builders from MULTIPLE trust planes (the hook sanitizes
 * its own, but the OpenClaw engine's params.sessionId and IPC-supplied ids
 * are host-shaped) — enforce the safe charset HERE so every caller is
 * covered structurally. Matches hook.ts's sanitizeSessionId charset.
 */
function safeIdComponent(id: string): string {
  const s = String(id).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
  return s && !/^\.+$/.test(s) ? s : 'unknown';
}

export interface SegmentLedgerEntry {
  hash: string;
  ts: string;
}

export function segmentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, SEGMENT_HASH_LEN);
}

export function segmentFileName(sessionId: string, hash: string): string {
  return `${safeIdComponent(sessionId)}.seg-${hash.replace(/[^0-9a-f]/g, '')}.txt`;
}

export function ledgerFileName(sessionId: string): string {
  return `${safeIdComponent(sessionId)}.ledger.json`;
}

/** Receipt sidecar suffix (harvest link candidates persisted before manifest
 * publish). Lives HERE so the engine-free hook lane can GC orphaned receipts
 * without importing the engine-typed harvest module. */
export const HARVEST_RECEIPT_SUFFIX = '.receipt.json';

/**
 * Inverse of `segmentFileName`: `{sessionId, hash}` when `name` is a corpus
 * checkpoint segment, null for any other corpus file. The returned sessionId
 * is the SANITIZED filename component — exactly the key the compact lanes
 * bank the manifest under. Accepts 12–64 hex (pre-widening segments parse).
 */
export function parseSegmentFileName(
  name: string,
): { sessionId: string; hash: string } | null {
  const m = /^(.+)\.seg-([0-9a-f]{12,64})\.txt$/.exec(name);
  return m ? { sessionId: m[1], hash: m[2] } : null;
}

/**
 * The pre-compaction window: turns since the last PRIOR boundary (at compact
 * time the current boundary is not yet in the file), optionally capped to the
 * newest `maxTurns` (the OpenClaw arm caps at 40; the claude lane passes no
 * cap — its window is already bounded by the parse tail).
 */
export function sliceBoundaryWindow(
  turns: WindowTurn[],
  boundaryTurnIndexes: number[],
  opts: { maxTurns?: number } = {},
): WindowTurn[] {
  const from = boundaryTurnIndexes.length ? boundaryTurnIndexes[boundaryTurnIndexes.length - 1] : 0;
  const win = turns.slice(from);
  return opts.maxTurns && win.length > opts.maxTurns ? win.slice(-opts.maxTurns) : win;
}

/** All boundary windows + the post-last-boundary remainder, in turns-index space. */
export function splitByBoundaries(
  turns: WindowTurn[],
  boundaryTurnIndexes: number[],
): { windows: WindowTurn[][]; remainder: WindowTurn[] } {
  const windows: WindowTurn[][] = [];
  let prev = 0;
  for (const idx of boundaryTurnIndexes) {
    windows.push(turns.slice(prev, idx));
    prev = idx;
  }
  return { windows, remainder: turns.slice(prev) };
}

/**
 * Render a window to redacted corpus text. Returns null when the secret
 * scanner is unavailable — a SEGMENT is never written unscanned (unlike the
 * session-end full-corpus write, which degrades-and-writes because the corpus
 * dir is 0700-local; a segment skip is safe — session-end's coverage check
 * fails for that window and the full fallback carries the text).
 */
export async function renderSegmentText(
  turns: WindowTurn[],
): Promise<{ text: string; redactions: number } | null> {
  if (!turns.length) return { text: '', redactions: 0 };
  const text = toCorpusText(turns);
  try {
    const scan = await import('../secret-scan.ts');
    const redacted = scan.redactFindings(text);
    return { text: redacted.text, redactions: redacted.redactions.length };
  } catch {
    return null;
  }
}

/** Read the ledger. Fail-open: absent/unreadable/malformed ⇒ []. */
export function readSegmentLedger(dir: string, sessionId: string): SegmentLedgerEntry[] {
  try {
    const raw = readFileSync(join(dir, ledgerFileName(sessionId)), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is SegmentLedgerEntry =>
        !!e && typeof e === 'object' &&
        typeof (e as SegmentLedgerEntry).hash === 'string' &&
        typeof (e as SegmentLedgerEntry).ts === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Append a hash to the ledger (atomic tmp+rename; single writer per session ⇒
 * last-writer-wins is safe). Idempotent: an already-present hash is NOT
 * re-appended. Returns the entry's 1-based ordinal (the manifest's `n`).
 * Throws only on write failure — callers treat that as a degraded segment.
 */
export function appendSegmentLedger(dir: string, sessionId: string, hash: string): number {
  const entries = readSegmentLedger(dir, sessionId);
  const existing = entries.findIndex((e) => e.hash === hash);
  if (existing !== -1) return existing + 1;
  entries.push({ hash, ts: new Date().toISOString() });
  const p = join(dir, ledgerFileName(sessionId));
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(entries) + '\n', { mode: 0o600 });
  renameSync(tmp, p);
  return entries.length;
}

/**
 * Atomically write a content-addressed segment. Same content ⇒ same name ⇒
 * `existed: true` and NO rewrite (sidecar lifecycle stays untouched by
 * construction). Throws on fs failure.
 */
export function writeSegment(
  dir: string,
  sessionId: string,
  text: string,
): { file: string; hash: string; existed: boolean } {
  const hash = segmentHash(text);
  const file = join(dir, segmentFileName(sessionId, hash));
  if (existsSync(file)) return { file, hash, existed: true };
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  return { file, hash, existed: false };
}

/**
 * Exact-set coverage: TRUE iff every NON-EMPTY boundary window's recomputed
 * redacted hash is present in the ledger (empty windows were skipped at
 * compact time by design — covered by construction). Scanner unavailable or
 * no boundaries-with-ledger-mismatch ⇒ FALSE (caller falls back to the
 * full-transcript write; at-least-once, never loss).
 */
export async function coverageComplete(
  dir: string,
  sessionId: string,
  turns: WindowTurn[],
  boundaryTurnIndexes: number[],
): Promise<boolean> {
  if (!boundaryTurnIndexes.length) return false;
  const ledger = new Set(readSegmentLedger(dir, sessionId).map((e) => e.hash));
  if (!ledger.size) return false;
  const { windows } = splitByBoundaries(turns, boundaryTurnIndexes);
  for (const win of windows) {
    if (!win.length) continue;
    const rendered = await renderSegmentText(win);
    if (!rendered) return false;
    if (!rendered.text.trim()) continue;
    if (!ledger.has(segmentHash(rendered.text))) return false;
  }
  return true;
}

/**
 * Tail-capable openclaw boundary reader (cathedral 5): the import adapter
 * REJECTS over-cap files and whole-file-reads under the cap — too heavy for
 * a compaction boundary — so this reads the newest `maxBytes`, drops the
 * partial first line on tail reads, and delegates line→message mapping to
 * the mapper EXPORTED from the adapter (the dated SPEC_TARGET stays the
 * single source of truth). Boundary positions in turns-index space, exactly
 * like the claude-code parser. Returns null when nothing maps (not an
 * openclaw session file) or on fs errors — callers fail open.
 */
export function readOpenclawBoundaryTail(
  path: string,
  opts: { maxBytes?: number } = {},
): { turns: WindowTurn[]; boundaryTurnIndexes: number[] } | null {
  const maxBytes = Math.max(1, Math.floor(opts.maxBytes ?? 2 * 1024 * 1024));
  let raw: string;
  try {
    const size = statSync(path).size;
    if (size <= maxBytes) {
      raw = readFileSync(path, 'utf8');
    } else {
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        const n = readSync(fd, buf, 0, maxBytes, size - maxBytes);
        raw = buf.subarray(0, n).toString('utf8');
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    return null;
  }
  const turns: WindowTurn[] = [];
  const boundaryTurnIndexes: number[] = [];
  let mappedAnything = false;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(t);
    } catch {
      continue; // includes a tail read's partial first line
    }
    const mapped = mapOpenclawLine(entry);
    if (mapped.kind === 'session') {
      mappedAnything = true;
    } else if (mapped.kind === 'boundary') {
      mappedAnything = true;
      boundaryTurnIndexes.push(turns.length);
    } else if (mapped.kind === 'message') {
      mappedAnything = true;
      turns.push({ role: mapped.message.role, text: mapped.message.text });
    }
  }
  return mappedAnything ? { turns, boundaryTurnIndexes } : null;
}

/**
 * The whole compact-time segment step (cathedral 5, durability first): slice
 * the since-last-boundary window → per-step deadline degrades → redacted
 * render (never written unscanned) → content-addressed write → ledger append
 * (segment FIRST, ledger SECOND — crash between leaves a sweep-harvestable
 * orphan and a session-end full-fallback). Returns a typed status CODE for
 * the heartbeat plus the segment basename to flush over IPC when banked.
 * Never throws.
 */
export async function bankCompactSegment(
  dir: string,
  sessionId: string,
  allTurns: WindowTurn[],
  boundaryTurnIndexes: number[],
  opts: { remainingMs: () => number; minScanMs: number; minWriteMs: number; maxTurns?: number },
): Promise<{ segment: string; flushCorpusFile?: string; hash?: string; ordinal?: number }> {
  try {
    const windowTurns = sliceBoundaryWindow(allTurns, boundaryTurnIndexes, {
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
    });
    if (windowTurns.length === 0) return { segment: 'empty_window' };
    if (opts.remainingMs() < opts.minScanMs) return { segment: 'deadline_scan' };
    const rendered = await renderSegmentText(windowTurns);
    if (!rendered) return { segment: 'scan_unavailable' };
    if (!rendered.text.trim()) return { segment: 'empty_window' };
    if (opts.remainingMs() < opts.minWriteMs) return { segment: 'deadline_write' };
    const w = writeSegment(dir, sessionId, rendered.text);
    const ordinal = appendSegmentLedger(dir, sessionId, w.hash);
    return {
      segment: w.existed ? 'segment_dup' : 'segment_banked',
      flushCorpusFile: segmentFileName(sessionId, w.hash),
      hash: w.hash,
      ordinal,
    };
  } catch (e) {
    const name = e instanceof Error ? e.name || 'Error' : 'Error';
    return { segment: `segment_${name.toLowerCase()}` };
  }
}

/**
 * Session-end corpus-mode decision (cathedral 5 dedup contract): when every
 * non-empty boundary window is ledger-covered, only the post-last-boundary
 * remainder needs the corpus write; an EMPTY remainder means everything is
 * already segment-banked (skip the write). Any mismatch ⇒ full fallback.
 * Never throws.
 */
export async function decideCorpusMode(
  dir: string,
  sessionId: string,
  turns: WindowTurn[],
  boundaryTurnIndexes: number[],
): Promise<{ mode: 'full' | 'full_fallback' | 'remainder' | 'skip_covered'; turns: WindowTurn[] }> {
  if (!boundaryTurnIndexes.length) return { mode: 'full', turns };
  try {
    if (await coverageComplete(dir, sessionId, turns, boundaryTurnIndexes)) {
      const remainder = splitByBoundaries(turns, boundaryTurnIndexes).remainder;
      return remainder.length === 0
        ? { mode: 'skip_covered', turns: remainder }
        : { mode: 'remainder', turns: remainder };
    }
  } catch {
    /* fall through to full_fallback */
  }
  return { mode: 'full_fallback', turns };
}

/**
 * GC companion for the corpus dir (extends the hook's `.txt`-only GC): remove
 * ledgers past the retention window, and remove ORPHANED sidecars whose base
 * `.txt` is gone (previously they lived forever). Best-effort per file; never
 * throws.
 */
export function gcCorpusArtifacts(
  dir: string,
  maxAgeMs: number,
  sidecarSuffixes: string[],
): void {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (name.endsWith('.ledger.json')) {
          if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
          continue;
        }
        // Crashed atomic writers strand `*.tmp-<pid>` files nothing else
        // reaps (adversarial review) — age them out with the ledgers.
        if (/\.tmp-\d+$/.test(name)) {
          if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
          continue;
        }
        for (const suffix of sidecarSuffixes) {
          if (!name.endsWith(suffix)) continue;
          const base = p.slice(0, -suffix.length);
          if (!existsSync(base)) rmSync(p, { force: true });
          break;
        }
      } catch {
        /* per-file best effort */
      }
    }
  } catch {
    /* GC never breaks the caller */
  }
}
