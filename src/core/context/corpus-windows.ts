/**
 * corpus-windows.ts — #5887: windowed fact extraction of session-corpus files.
 *
 * The extractor reads at most MAX_TURN_TEXT_CHARS (8,000) characters per
 * call, so a long transcript passed whole lost everything after its head.
 * Here a corpus file (`toCorpusText` output: `[user]` / `[assistant]` blocks
 * separated by blank lines) is cut into windows that each fit the extractor:
 *
 *   - Turns are found only at the exact `\n\n[user]\n` / `\n\n[assistant]\n`
 *     markers `toCorpusText` emits (plus a marker at offset 0).
 *   - Each whole user turn is paste-stripped FIRST (#5812), then the stripped
 *     text is windowed, so a paste that crosses a window boundary never leaks.
 *   - Windows hold whole turns; a turn longer than a window is split, and every
 *     continuation repeats its `[role]` header, so assistant text is never read
 *     as the user's own words.
 *
 * Progress lives in `<file>.progress` (never deleted by the hook's resume
 * rewrite; GC'd with the `.txt`): a generation counter, the hashes of finished
 * turns, an optional continuation into a split turn, the file stat of the
 * snapshot that finished, and a lease. A rewrite (append, compaction
 * remainder, same-size or shorter replacement) resumes at the first turn
 * whose hash is not recorded. Every write is compare-and-set under an O_EXCL
 * lock file: a commit lands only when the generation, the last recorded turn
 * hash and the lease owner still match and the progress grows. The lease stops
 * a second sweep (whose claim the hook deleted on rewrite) from extracting a
 * window the first sweep is still working on. Callers keep the existing
 * `.in-progress` claim discipline; this module never touches claims.
 */

import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_TURN_TEXT_CHARS } from '../facts/extract.ts';
import type { runFactsPipeline } from '../facts/backstop.ts';
import { withAIInvocationGuard } from '../ai/invocation-guard.ts';
import { parseCorpusTurns, type CorpusTurn } from './corpus-turns.ts';
import {
  CORPUS_FAILURE_SUFFIX, CORPUS_NON_TERMINAL_SKIPS, CORPUS_PROGRESS_LOCK_SUFFIX, CORPUS_PROGRESS_SUFFIX, CORPUS_WINDOW_FAILURE_CAP,
  corpusFileCompletion, corpusFileFinished, parseCorpusProgress, parseWbFileName, readCorpusFailure, type CorpusFailureRecord,
} from './corpus-segments.ts';

export { parseCorpusTurns, type CorpusTurn };

/** Per-file window cap per sweep; longer files converge over later sweeps. */
export const CORPUS_WINDOWS_PER_SWEEP = 8;
/** Cross-file window total per sweep (override: GBRAIN_CORPUS_WINDOWS_PER_SWEEP). */
export const CORPUS_WINDOWS_PER_SWEEP_TOTAL = 32;
/** A lease older than this belongs to a dead extractor (matches the claim's hour). */
export const CORPUS_PROGRESS_LEASE_STALE_MS = 60 * 60 * 1000;

const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 40;
const LOCK_RETRY_MS = 25;
const MAX_RECORDED_TURNS = 20_000;
const MAX_ENTITY_SLUGS = 500;

type PipelineResult = Awaited<ReturnType<typeof runFactsPipeline>>;


export interface CorpusWindow {
  text: string;
  /** Index of the last turn this window touches. */
  endTurn: number;
  /** Offset into that turn's body where the window stops; null when the turn finished. */
  endOffset: number | null;
}

export interface CorpusFileStat {
  size: number;
  mtime_ms: number;
  ino: number;
}

export interface CorpusProgress {
  version: 1;
  generation: number;
  turns: Array<{ start: number; end: number; sha256: string }>;
  continuation: { turn_sha256: string; stripped_offset: number } | null;
  windows_done: number;
  /** Stat of the snapshot whose every window finished; null while windows remain. */
  finished: CorpusFileStat | null;
  totals: { inserted: number; duplicate: number; superseded: number };
  entity_slugs: string[];
  skipped_reason?: string;
  /** #6091: hashes of turns captured or retired under writeback off; never extracted wherever they sit. */
  retired_turns?: string[];
  /**
   * #6268: the source (and its incarnation) this file's windows were
   * extracted into, bound by the first window run. A resume under another
   * source or a recreated source is refused (`source_changed`).
   */
  source?: CorpusProgressSource | null;
  lease: { owner: string; at: number } | null;
}

export interface CorpusProgressSource {
  id: string;
  incarnation: string;
}

export interface CorpusWindowRun {
  /**
   * #6786 `unavailable`: the extractor answered a non-terminal skip (no
   * servable model); nothing was recorded for that window. #6785 `backoff` /
   * `dead_lettered`: the next window failed after its model call before and
   * waits out its retry delay, or reached CORPUS_WINDOW_FAILURE_CAP.
   */
  status: 'complete' | 'partial' | 'aborted' | 'contended' | 'changed' | 'source_changed' | 'unavailable' | 'backoff' | 'dead_lettered';
  windowsDone: number;
  windowsRemaining: number;
  /** Cumulative across every sweep that worked on this file. */
  result: PipelineResult;
}

let invalidKnobWarned = false;

/**
 * The cross-file window total for one sweep. `GBRAIN_CORPUS_WINDOWS_PER_SWEEP`
 * overrides it with a positive integer; anything else falls back to the
 * default with one warning per process.
 */
export function resolveCorpusWindowsPerSweepTotal(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = () => {},
): number {
  const raw = env.GBRAIN_CORPUS_WINDOWS_PER_SWEEP;
  if (raw === undefined || raw.trim() === '') return CORPUS_WINDOWS_PER_SWEEP_TOTAL;
  const n = Number(raw.trim());
  if (Number.isSafeInteger(n) && n > 0) return n;
  if (!invalidKnobWarned) {
    invalidKnobWarned = true;
    warn(`[sweep] GBRAIN_CORPUS_WINDOWS_PER_SWEEP=${JSON.stringify(raw)} is not a positive integer; using ${CORPUS_WINDOWS_PER_SWEEP_TOTAL}`);
  }
  return CORPUS_WINDOWS_PER_SWEEP_TOTAL;
}

/** TEST SEAM: re-arm the once-per-process invalid-knob warning. */
export function __resetCorpusWindowsWarningForTests(): void {
  invalidKnobWarned = false;
}

function isHigh(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLow(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

/** Cut point in (from, max]: a newline, else a space, in the window's back half; never inside a surrogate pair. */
function cutPoint(body: string, from: number, max: number): number {
  if (max >= body.length) return body.length;
  const floor = from + Math.floor((max - from) / 2);
  const newline = body.lastIndexOf('\n', max - 1);
  if (newline >= floor) return newline + 1;
  const space = body.lastIndexOf(' ', max - 1);
  if (space >= floor) return space + 1;
  return isHigh(body.charCodeAt(max - 1)) && isLow(body.charCodeAt(max)) ? max - 1 : max;
}

/**
 * Plan every remaining window from `from`. Whole turns are packed together;
 * a turn that does not fit a fresh window is split with its header repeated.
 * A window whose text is empty only records empty (paste-only) turns as done.
 */
export function planCorpusWindows(
  turns: CorpusTurn[],
  from: { turn: number; offset: number },
  maxChars: number = MAX_TURN_TEXT_CHARS,
  skip: ReadonlySet<string> = new Set(),
): CorpusWindow[] {
  const windows: CorpusWindow[] = [];
  let parts: string[] = [];
  let len = 0;
  let last: { turn: number; offset: number | null } = { turn: from.turn - 1, offset: null };
  const flush = (): void => {
    windows.push({ text: parts.join('\n\n'), endTurn: last.turn, endOffset: last.offset });
    parts = [];
    len = 0;
  };
  for (let t = from.turn; t < turns.length; t++) {
    const { header, body } = turns[t];
    let offset = t === from.turn ? Math.min(from.offset, body.length) : 0;
    if (offset >= body.length || skip.has(turns[t].sha256)) {
      last = { turn: t, offset: null };
      continue;
    }
    while (offset < body.length) {
      const sep = parts.length ? 2 : 0;
      const room = maxChars - len - sep - header.length;
      const rest = body.length - offset;
      if (rest <= room) {
        parts.push(header + body.slice(offset));
        len += sep + header.length + rest;
        last = { turn: t, offset: null };
        break;
      }
      if (parts.length && (header.length + rest <= maxChars || room < maxChars / 4)) {
        flush();
        continue;
      }
      const cut = cutPoint(body, offset, offset + room);
      parts.push(header + body.slice(offset, cut));
      len += sep + header.length + (cut - offset);
      offset = cut;
      last = { turn: t, offset: cut < body.length ? cut : null };
      flush();
    }
  }
  if (parts.length) flush();
  else if (last.turn >= from.turn && last.turn > (windows.at(-1)?.endTurn ?? from.turn - 1)) flush();
  return windows;
}

/** Where extraction resumes: the first turn whose hash is not recorded. */
export function resumePoint(turns: CorpusTurn[], progress: CorpusProgress | null): { turn: number; offset: number } {
  if (!progress) return { turn: 0, offset: 0 };
  const done = new Set(progress.turns.map((t) => t.sha256));
  let turn = 0;
  while (turn < turns.length && done.has(turns[turn].sha256)) turn++;
  const cont = progress.continuation;
  const offset = cont && turn < turns.length && turns[turn].sha256 === cont.turn_sha256
    ? Math.min(cont.stripped_offset, turns[turn].body.length)
    : 0;
  return { turn, offset };
}

/** The progress sidecar, or null when absent or unparseable (replayed safely). I/O errors throw. */
export async function readCorpusProgress(full: string): Promise<CorpusProgress | null> {
  try {
    return parseCorpusProgress(await readFile(full + CORPUS_PROGRESS_SUFFIX, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** The earliest file time trusted as when a session was written. */
const MIN_FACT_TIME_MS = Date.UTC(2000, 0, 1);
/** Clock skew a future file time may carry and still be trusted. */
const FACT_TIME_SKEW_MS = 60_000;

export type CorpusFactTime = { at: Date } | { rejected: 'invalid' | 'before_2000' | 'future' };

/**
 * #6159: the session file's write time as the time its facts happened. A time
 * that is not finite, before 2000 or more than a minute ahead of now is not
 * trusted, and the caller dates the facts at extraction instead.
 */
export function corpusFactTime(mtimeMs: number, nowMs: number = Date.now()): CorpusFactTime {
  if (!Number.isFinite(mtimeMs)) return { rejected: 'invalid' };
  if (mtimeMs < MIN_FACT_TIME_MS) return { rejected: 'before_2000' };
  if (mtimeMs > nowMs + FACT_TIME_SKEW_MS) return { rejected: 'future' };
  return { at: new Date(mtimeMs) };
}

export function corpusFileStat(st: { size: number; mtimeMs: number; ino: number }): CorpusFileStat {
  return { size: st.size, mtime_ms: st.mtimeMs, ino: st.ino };
}

export function sameCorpusFileStat(a: CorpusFileStat | null, b: CorpusFileStat): boolean {
  return !!a && a.size === b.size && a.mtime_ms === b.mtime_ms && a.ino === b.ino;
}

async function acquireLock(lockPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    }
    const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0);
    if (age > LOCK_STALE_MS) await rm(lockPath, { force: true }).catch(() => {});
    else await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
  return false;
}

/**
 * Compare-and-set: under the lock, `next` sees the current progress and
 * returns the replacement, or null to refuse. The generation always advances.
 * Returns the written progress, or null when refused or the lock is busy.
 */
async function updateProgress(
  full: string,
  next: (cur: CorpusProgress | null) => Omit<CorpusProgress, 'generation'> | null,
): Promise<CorpusProgress | null> {
  const lockPath = full + CORPUS_PROGRESS_LOCK_SUFFIX;
  if (!(await acquireLock(lockPath))) return null;
  try {
    const cur = await readCorpusProgress(full);
    const proposed = next(cur);
    if (!proposed) return null;
    const written: CorpusProgress = { ...proposed, generation: (cur?.generation ?? 0) + 1 };
    const path = full + CORPUS_PROGRESS_SUFFIX;
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(written) + '\n', { mode: 0o600 });
    await rename(tmp, path);
    return written;
  } finally {
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

function freshProgress(): Omit<CorpusProgress, 'generation'> {
  return {
    version: 1,
    turns: [],
    continuation: null,
    windows_done: 0,
    finished: null,
    totals: { inserted: 0, duplicate: 0, superseded: 0 },
    entity_slugs: [],
    lease: null,
  };
}

const lastSha = (p: CorpusProgress | null): string | null => p?.turns.at(-1)?.sha256 ?? null;

function resultOf(p: CorpusProgress): PipelineResult {
  return {
    ...p.totals,
    fact_ids: [],
    entity_slugs: [...p.entity_slugs],
    ...(p.skipped_reason ? { skipped_reason: p.skipped_reason as PipelineResult['skipped_reason'] } : {}),
  };
}

/**
 * V6 — record a file finished before windowed extraction as fully extracted
 * at its current turns, so later growth extracts only the appended turns and
 * the head is never re-sent. Writes only when no progress exists yet.
 */
export async function adoptFinishedCorpusFile(full: string): Promise<boolean> {
  const st = corpusFileStat(await stat(full));
  const raw = await readFile(full, 'utf8');
  const after = corpusFileStat(await stat(full));
  if (!sameCorpusFileStat(st, after)) return false;
  const turns = parseCorpusTurns(raw);
  const written = await updateProgress(full, (cur) => cur ? null : {
    ...freshProgress(),
    turns: turns.slice(-MAX_RECORDED_TURNS).map(({ start, end, sha256: h }) => ({ start, end, sha256: h })),
    finished: st,
  });
  return written !== null;
}

/**
 * #6091: record a corpus file as finished WITHOUT extracting it — the capture
 * gate retired it (explicit `memory.auto_writeback off`). `.progress` is
 * finished at the file's current stat with every current turn hash recorded
 * and `skipped_reason`, then the `.ingested` sidecar names the reason. A
 * retire overrides another extractor's lease (its next compare-and-set fails),
 * and a later rewrite of the file (a resumed session) extracts only turns that
 * are not recorded here. Returns false when the file changed mid-read or the
 * progress lock stayed busy (the caller retries on its next pass).
 */
export async function retireCorpusFile(full: string, reason: string = 'writeback_off'): Promise<boolean> {
  const st = corpusFileStat(await stat(full));
  const raw = await readFile(full, 'utf8');
  if (!sameCorpusFileStat(st, corpusFileStat(await stat(full)))) return false;
  const written = await updateProgress(full, (cur) => ({
    ...(cur ?? freshProgress()),
    turns: mergeTurns(cur?.turns ?? [], parseCorpusTurns(raw)),
    retired_turns: mergeRetired(cur, parseCorpusTurns(raw).map((t) => t.sha256)),
    continuation: null,
    finished: st,
    skipped_reason: reason,
    lease: null,
  }));
  if (!written) return false;
  await writeFile(full + '.ingested', JSON.stringify({ ingested_at: new Date().toISOString(), skipped: reason }) + '\n');
  return true;
}

/**
 * #6091: record turns captured under explicit off as done, so extraction of
 * this file resumes past them. Leaves `finished` alone: turns the file holds
 * beyond these still extract. False when the progress lock stayed busy.
 */
export async function retireCorpusTurns(full: string, hashes: readonly string[]): Promise<boolean> {
  const written = await updateProgress(full, (cur) => {
    const known = new Set(cur?.turns.map((t) => t.sha256) ?? []);
    const added = hashes.filter((h) => !known.has(h));
    const retired = new Set(cur?.retired_turns ?? []);
    if (cur && added.length === 0 && hashes.every((h) => retired.has(h))) return null;
    return { ...(cur ?? freshProgress()), turns: [...(cur?.turns ?? []), ...added.map((h) => ({ start: 0, end: 0, sha256: h }))].slice(-MAX_RECORDED_TURNS),
      retired_turns: mergeRetired(cur, hashes) };
  });
  return written !== null || (await readCorpusProgress(full)) !== null;
}

function mergeRetired(cur: CorpusProgress | null, hashes: readonly string[]): string[] {
  return [...new Set([...(cur?.retired_turns ?? []), ...hashes])].slice(-MAX_RECORDED_TURNS);
}

/** #6091: turns that must never reach extraction, wherever a rewrite puts them. */
export function retiredTurns(progress: CorpusProgress | null): ReadonlySet<string> {
  return new Set(progress?.retired_turns ?? []);
}

function mergeTurns(recorded: CorpusProgress['turns'], turns: CorpusTurn[]): CorpusProgress['turns'] {
  const known = new Set(recorded.map((t) => t.sha256));
  const added = turns.filter((t) => !known.has(t.sha256)).map(({ start, end, sha256: h }) => ({ start, end, sha256: h }));
  return [...recorded, ...added].slice(-MAX_RECORDED_TURNS);
}

/** A failed window is retried on the next sweep, then after this delay, doubling per failure (10, 20, 40 minutes). */
export const CORPUS_WINDOW_RETRY_BASE_MS = 10 * 60_000;
/** The failure key of a writeback turn file (one turn, one call). */
export const CORPUS_TURN_FAILURE_KEY = 'turn';

/** Where a window starts: its first turn's hash and the offset into it. Stable while the file only grows. */
function windowKey(turns: CorpusTurn[], at: { turn: number; offset: number }): string {
  return `${turns[at.turn]?.sha256 ?? 'end'}@${at.offset}`;
}

/**
 * #6785: whether the window at `key` may be paid for now. A record for
 * another window or another source incarnation does not apply. A capped
 * window stays stopped, except once when the extraction-config fingerprint
 * changed since its last failure.
 */
export function corpusFailureGate(
  record: CorpusFailureRecord | null,
  key: string,
  incarnation: string | null,
  fingerprint: string | null,
  nowMs: number,
): 'run' | 'backoff' | 'dead_lettered' {
  if (!record || record.key !== key || record.source_incarnation !== incarnation) return 'run';
  if (record.count >= CORPUS_WINDOW_FAILURE_CAP) return rearms(record, fingerprint) ? 'run' : 'dead_lettered';
  if (record.count === 1) return 'run';
  return nowMs < record.last_at + CORPUS_WINDOW_RETRY_BASE_MS * 2 ** (record.count - 2) ? 'backoff' : 'run';
}

function rearms(record: CorpusFailureRecord, fingerprint: string | null): boolean {
  return !record.rearmed && record.fingerprint !== null && fingerprint !== null && record.fingerprint !== fingerprint;
}

/**
 * #6785: whether the file's recorded failing window is backing off or
 * stopped right now. Selection serves these files last, so stopped files
 * never take every batch slot from healthy ones.
 */
export function corpusFileParked(full: string, fingerprint: string | null, nowMs: number): boolean {
  const record = readCorpusFailure(full);
  return !!record && corpusFailureGate(record, record.key, record.source_incarnation, fingerprint, nowMs) !== 'run';
}

/** Whether a failure record's window (`<turn sha256>@<offset>`) still lies at or after `cursor` in `turns`. */
function failureAhead(key: string, turns: CorpusTurn[], cursor: { turn: number; offset: number }): boolean {
  const at = key.lastIndexOf('@');
  const sha = key.slice(0, at);
  const offset = Number(key.slice(at + 1));
  return turns.some((t, i) => t.sha256 === sha && (i > cursor.turn || (i === cursor.turn && offset >= cursor.offset)));
}

/**
 * The key of the window the next run of `full` starts at (the frontier a
 * failure record names), or null when the file or its progress is
 * unreadable. A writeback turn file's key is always CORPUS_TURN_FAILURE_KEY.
 */
export async function corpusFrontierKey(full: string, name: string): Promise<string | null> {
  if (parseWbFileName(name)) return CORPUS_TURN_FAILURE_KEY;
  try {
    const turns = parseCorpusTurns(await readFile(full, 'utf-8'));
    return windowKey(turns, resumePoint(turns, await readCorpusProgress(full)));
  } catch {
    return null;
  }
}

/**
 * #6785: run one extraction; when it throws after a chat model call was
 * admitted (the spend), count a failure against the window at `key`, then
 * rethrow, whatever ended it (a later call the spend guard refused
 * included). A throw before any admitted chat call (a refused first call
 * included), an abort, or capture switched off mid-call (the next sweep
 * retires the file) costs nothing to retry and is not counted. `paid` says
 * whether a chat call was admitted, for a caller that must count a failure
 * after the extraction returned.
 */
export async function extractUnderFailureCount<T>(
  failure: { full: string; record: CorpusFailureRecord | null; key: string; incarnation: string | null; fingerprint: string | null; nowMs: () => number; signal?: AbortSignal },
  extract: () => Promise<T>,
): Promise<{ value: T; paid: boolean }> {
  let paid = false;
  try {
    // Inherit: an outer guard admits first, so this one only sees admitted calls.
    const value = await withAIInvocationGuard(async (call) => {
      if (call.kind === 'chat') paid = true;
      return { settle: async () => {} };
    }, extract, { inherit: true });
    return { value, paid };
  } catch (e) {
    const counts = paid && !failure.signal?.aborted && !(e instanceof Error && e.name === 'AbortError')
      && (e as { code?: unknown } | null)?.code !== 'ambient_capture_off';
    if (counts) {
      await recordCorpusFailure(failure.full, failure.record, failure.key, failure.incarnation, failure.fingerprint, failure.nowMs(), e).catch(() => {});
    }
    throw e;
  }
}

function failureCode(e: unknown): string {
  const { code, reason, name } = (e ?? {}) as { code?: unknown; reason?: unknown; name?: unknown };
  for (const v of [code, reason, name]) if (typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/.test(v)) return v;
  return 'error';
}

/**
 * #6785: count one failed attempt of the window at `key` (caller holds the
 * file's `.in-progress` claim). Another window or incarnation starts a new
 * count; the error label never resets it. A capped window re-armed by a
 * fingerprint change starts over once. Returns the record written.
 */
export async function recordCorpusFailure(
  full: string,
  prev: CorpusFailureRecord | null,
  key: string,
  incarnation: string | null,
  fingerprint: string | null,
  nowMs: number,
  error: unknown,
): Promise<CorpusFailureRecord> {
  const same = !!prev && prev.key === key && prev.source_incarnation === incarnation;
  const rearm = same && prev!.count >= CORPUS_WINDOW_FAILURE_CAP && rearms(prev!, fingerprint);
  const record: CorpusFailureRecord = {
    version: 1,
    key,
    source_incarnation: incarnation,
    count: same && !rearm ? prev!.count + 1 : 1,
    first_at: same ? prev!.first_at : nowMs,
    last_at: nowMs,
    last_code: failureCode(error),
    fingerprint,
    rearmed: same ? prev!.rearmed || rearm : false,
  };
  const path = full + CORPUS_FAILURE_SUFFIX;
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(record) + '\n', { mode: 0o600 });
  await rename(tmp, path);
  return record;
}

/** Remove the failure record once its window committed. */
export async function clearCorpusFailure(full: string): Promise<void> {
  await rm(full + CORPUS_FAILURE_SUFFIX, { force: true });
}

/**
 * #6785/#6786: one writeback turn file (one call, no `.progress`) under the
 * same failure cap and non-terminal rule as a window. `complete` carries the
 * result (the caller writes `.ingested`); `unavailable` records nothing.
 */
export async function runCorpusTurn(opts: {
  full: string;
  signal?: AbortSignal;
  incarnation: string | null;
  failures?: { fingerprint: string | null; now?: () => number };
  /** Incremented before each attempted extraction, thrown or not: the caller's window budget. */
  attempted?: { count: number };
  extract: () => Promise<PipelineResult>;
}): Promise<{ status: 'complete'; result: PipelineResult } | { status: 'unavailable' | 'backoff' | 'dead_lettered' }> {
  const fingerprint = opts.failures?.fingerprint ?? null;
  const clock = opts.failures?.now ?? Date.now;
  const record = readCorpusFailure(opts.full);
  const gate = corpusFailureGate(record, CORPUS_TURN_FAILURE_KEY, opts.incarnation, fingerprint, clock());
  if (gate !== 'run') return { status: gate };
  if (opts.attempted) opts.attempted.count++;
  const { value: result } = await extractUnderFailureCount(
    { full: opts.full, record, key: CORPUS_TURN_FAILURE_KEY, incarnation: opts.incarnation, fingerprint, nowMs: clock, signal: opts.signal },
    opts.extract,
  );
  if (result.skipped_reason && CORPUS_NON_TERMINAL_SKIPS.includes(result.skipped_reason)) return { status: 'unavailable' };
  if (record) await clearCorpusFailure(opts.full).catch(() => {});
  return { status: 'complete', result };
}

/**
 * #6786: a progress whose windows answered a non-terminal skip (pre-#6786
 * builds recorded those turns as done) is rewound to its retired turns, so
 * every other turn is extracted again. The source binding, retired turns,
 * totals and entity links stay.
 */
function rewindNonTerminal(cur: CorpusProgress): Omit<CorpusProgress, 'generation'> {
  if (!cur.skipped_reason || !CORPUS_NON_TERMINAL_SKIPS.includes(cur.skipped_reason)) return cur;
  const retired = retiredTurns(cur);
  const { skipped_reason: _dropped, ...rest } = cur;
  return { ...rest, turns: cur.turns.filter((t) => retired.has(t.sha256)), continuation: null, finished: null };
}

/**
 * Extract up to `maxWindows` non-empty windows of `raw` (the snapshot whose
 * stat is `fileStat`), committing `.progress` after each one. `complete`
 * means every window of this snapshot is done (the caller may write
 * `.ingested`); `partial` means the cap stopped it; `aborted` means the
 * signal or budget fired (nothing uncommitted is recorded); `contended`
 * means another extractor holds the lease or advanced the progress first;
 * `unavailable` means the extractor had no servable model (#6786: nothing is
 * recorded, and a progress a pre-#6786 build finished that way is rewound
 * first). Transport and write errors throw after the lease is released; each
 * one thrown after a model call counts against its window (#6785:
 * `backoff`, then `dead_lettered` at CORPUS_WINDOW_FAILURE_CAP).
 */
export async function runCorpusWindows(opts: {
  full: string;
  raw: string;
  fileStat: CorpusFileStat;
  maxWindows: number;
  extract: (text: string) => Promise<PipelineResult>;
  overBudget: () => boolean;
  signal: AbortSignal;
  /** #6268: the file's resolved source; binds on the first run, refuses a resume under another. */
  source?: CorpusProgressSource;
  /** #6785: the extraction-config fingerprint that may re-arm a capped window once (null: never), and the clock. */
  failures?: { fingerprint: string | null; now?: () => number };
  /** Incremented before each attempted window, thrown or not: the caller's window budget. */
  attempted?: { count: number };
}): Promise<CorpusWindowRun> {
  const { full, fileStat, signal, source } = opts;
  const incarnation = source?.incarnation ?? null;
  const fingerprint = opts.failures?.fingerprint ?? null;
  const clock = opts.failures?.now ?? Date.now;
  const owner = `${process.pid}:${randomUUID()}`;
  const now = Date.now();
  let sourceChanged = false;
  let state = await updateProgress(full, (cur) => {
    if (source && cur?.source && (cur.source.id !== source.id || cur.source.incarnation !== source.incarnation)) {
      sourceChanged = true;
      return null;
    }
    if (cur?.lease && cur.lease.owner !== owner && now - cur.lease.at < CORPUS_PROGRESS_LEASE_STALE_MS) return null;
    return { ...(cur ? rewindNonTerminal(cur) : freshProgress()), ...(source && !cur?.source ? { source } : {}), lease: { owner, at: now } };
  });
  const turns = parseCorpusTurns(opts.raw);
  if (!state) {
    const cur = await readCorpusProgress(full).catch(() => null);
    const remaining = planCorpusWindows(turns, resumePoint(turns, cur), MAX_TURN_TEXT_CHARS, retiredTurns(cur)).filter((w) => w.text).length;
    return { status: sourceChanged ? 'source_changed' : 'contended', windowsDone: 0, windowsRemaining: remaining, result: resultOf(cur ?? { ...freshProgress(), generation: 0 }) };
  }

  let cursor = resumePoint(turns, state);
  const windows = planCorpusWindows(turns, cursor, MAX_TURN_TEXT_CHARS, retiredTurns(state));
  let failure = readCorpusFailure(full);
  let done = 0;
  let status: CorpusWindowRun['status'] = 'complete';
  let holding = true;
  try {
    for (let w = 0; w < windows.length; w++) {
      const win = windows[w];
      const key = windowKey(turns, cursor);
      let r: PipelineResult | null = null;
      let paid = false;
      if (win.text) {
        if (done >= opts.maxWindows) { status = 'partial'; break; }
        if (opts.overBudget() || signal.aborted) { status = 'aborted'; break; }
        const gate = corpusFailureGate(failure, key, incarnation, fingerprint, clock());
        if (gate !== 'run') { status = gate; break; }
        const text = win.text;
        if (opts.attempted) opts.attempted.count++;
        const attempt = await extractUnderFailureCount({ full, record: failure, key, incarnation, fingerprint, nowMs: clock, signal }, () => opts.extract(text));
        r = attempt.value;
        paid = attempt.paid;
        if (r.skipped_reason && CORPUS_NON_TERMINAL_SKIPS.includes(r.skipped_reason)) { status = 'unavailable'; break; }
      }
      if (signal.aborted) { status = 'aborted'; break; }
      const finishedTurns = turns.slice(cursor.turn, win.endOffset === null ? win.endTurn + 1 : win.endTurn);
      const isLast = w === windows.length - 1;
      const expectGen = state.generation;
      const expectLast = lastSha(state);
      const advances = finishedTurns.length > 0 || (win.endOffset ?? 0) > cursor.offset;
      const commit = updateProgress(full, (cur) => {
        if (!advances || !cur || cur.generation !== expectGen || lastSha(cur) !== expectLast || cur.lease?.owner !== owner) return null;
        const slugs = r ? [...new Set([...cur.entity_slugs, ...r.entity_slugs])].slice(-MAX_ENTITY_SLUGS) : cur.entity_slugs;
        return {
          ...cur,
          turns: [...cur.turns, ...finishedTurns.map(({ start, end, sha256: h }) => ({ start, end, sha256: h }))].slice(-MAX_RECORDED_TURNS),
          continuation: win.endOffset === null ? null : { turn_sha256: turns[win.endTurn].sha256, stripped_offset: win.endOffset },
          windows_done: cur.windows_done + (r ? 1 : 0),
          finished: isLast ? fileStat : null,
          totals: r
            ? { inserted: cur.totals.inserted + r.inserted, duplicate: cur.totals.duplicate + r.duplicate, superseded: cur.totals.superseded + r.superseded }
            : cur.totals,
          entity_slugs: slugs,
          ...(r?.skipped_reason ? { skipped_reason: r.skipped_reason } : {}),
          lease: isLast ? null : { owner, at: Date.now() },
        };
      });
      // #6785: a paid window whose progress did not commit is paid again next time; it counts like a thrown one.
      const countUncommitted = (e: unknown) => paid
        ? recordCorpusFailure(full, failure, key, incarnation, fingerprint, clock(), e).catch(() => failure)
        : Promise.resolve(failure);
      let next: CorpusProgress | null;
      try {
        next = await commit;
      } catch (e) {
        await countUncommitted(e);
        throw e;
      }
      if (!next) {
        failure = await countUncommitted({ code: 'corpus_progress_contended' });
        status = 'contended';
        break;
      }
      state = next;
      if (r) done++;
      if (isLast) holding = false;
      cursor = win.endOffset === null ? { turn: win.endTurn + 1, offset: 0 } : { turn: win.endTurn, offset: win.endOffset };
      // This window's record, or one whose window is gone (another incarnation, or its turn no longer ahead), is done.
      if (failure && (failure.key === key || failure.source_incarnation !== incarnation || !failureAhead(failure.key, turns, cursor))) {
        await clearCorpusFailure(full).catch(() => {});
        failure = null;
      }
    }
    if (windows.length === 0) {
      const finished = await updateProgress(full, (cur) =>
        cur && cur.lease?.owner === owner ? { ...cur, finished: fileStat, continuation: null, lease: null } : null);
      if (finished) {
        state = finished;
        holding = false;
      } else status = 'contended';
    }
  } finally {
    if (holding) {
      const released = await updateProgress(full, (cur) =>
        cur && cur.lease?.owner === owner ? { ...cur, lease: null } : null).catch(() => null);
      if (released) state = released;
    }
  }
  const remaining = planCorpusWindows(turns, cursor, MAX_TURN_TEXT_CHARS, retiredTurns(state)).filter((w) => w.text).length;
  // Rewritten while extracting: the snapshot's progress stands, but the file
  // is not done; its new turns wait for the next run.
  if (status === 'complete' && !sameCorpusFileStat(fileStat, corpusFileStat(await stat(full)))) status = 'changed';
  return { status, windowsDone: done, windowsRemaining: status === 'complete' || status === 'changed' ? 0 : remaining, result: resultOf(state) };
}

/**
 * The sweep's candidate list: files without a final `.ingested` (#6786: a
 * `chat_unavailable` sidecar is not final), plus finished files that changed
 * since `.progress` recorded them (stat compare, no rehash). A
 * pre-window `.ingested` file is adopted at its current turns (budget
 * permitting) so only later growth is extracted. Returns the candidates (at
 * most `batchLimit`), the files `parked` says are backing off or stopped
 * (#6785: at most `batchLimit`, served after every candidate so they never
 * starve healthy files), and how many files are already done.
 */
export async function selectCorpusCandidates(
  dir: string,
  txtFiles: string[],
  entrySet: Set<string>,
  batchLimit: number,
  overBudget: () => boolean,
  parked: (full: string) => boolean = () => false,
): Promise<{ candidates: string[]; deferred: string[]; alreadyIngested: number }> {
  const candidates: string[] = [];
  const deferred: string[] = [];
  let alreadyIngested = 0;
  for (const name of txtFiles) {
    const full = join(dir, name);
    let state: ReturnType<typeof corpusFileCompletion> = 'pending';
    if (entrySet.has(name + '.ingested')) {
      try { state = corpusFileCompletion(full, name); } catch { state = 'changed'; }
      if (state === 'legacy' && !overBudget()) await adoptFinishedCorpusFile(full).catch(() => false);
    }
    if (corpusFileFinished(state)) alreadyIngested++;
    else if (entrySet.has(name + CORPUS_FAILURE_SUFFIX) && parked(full)) {
      if (deferred.length < batchLimit) deferred.push(name);
    } else if (candidates.length < batchLimit) candidates.push(name);
  }
  return { candidates, deferred, alreadyIngested };
}
