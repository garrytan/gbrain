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
import { parseCorpusTurns, type CorpusTurn } from './corpus-turns.ts';
import { CORPUS_PROGRESS_LOCK_SUFFIX, CORPUS_PROGRESS_SUFFIX, parseWbFileName } from './corpus-segments.ts';

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
  lease: { owner: string; at: number } | null;
}

export interface CorpusWindowRun {
  status: 'complete' | 'partial' | 'aborted' | 'contended' | 'changed';
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

function isFileStat(v: unknown): v is CorpusFileStat {
  const s = v as CorpusFileStat;
  return !!s && typeof s === 'object' && Number.isFinite(s.size) && Number.isFinite(s.mtime_ms) && Number.isFinite(s.ino);
}

function parseProgress(text: string): CorpusProgress | null {
  let p: CorpusProgress;
  try { p = JSON.parse(text) as CorpusProgress; } catch { return null; }
  if (!p || typeof p !== 'object' || p.version !== 1 || !Number.isSafeInteger(p.generation)) return null;
  if (!Array.isArray(p.turns) || !p.turns.every((t) => t && typeof t.sha256 === 'string')) return null;
  if (p.continuation !== null && !(p.continuation && typeof p.continuation.turn_sha256 === 'string'
    && Number.isSafeInteger(p.continuation.stripped_offset))) return null;
  if (p.finished !== null && !isFileStat(p.finished)) return null;
  if (!p.totals || !Array.isArray(p.entity_slugs)) return null;
  return p;
}

/** The progress sidecar, or null when absent or unparseable (replayed safely). I/O errors throw. */
export async function readCorpusProgress(full: string): Promise<CorpusProgress | null> {
  try {
    return parseProgress(await readFile(full + CORPUS_PROGRESS_SUFFIX, 'utf8'));
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
 * How a corpus file that HAS an `.ingested` sidecar stands:
 *   'done'           — its `.progress` finished this exact file (stat match);
 *   'changed'        — rewritten since; re-enter (turn hashes decide resume);
 *   'legacy'         — finished before `.progress` existed and not rewritten
 *                      since (the sidecar is newer than the file): adopt;
 *   'legacy_changed' — finished before `.progress` existed, rewritten after.
 * Writeback turn files are immutable single turns: always 'done'.
 */
export async function finishedCorpusFileState(
  full: string,
  name: string,
): Promise<'done' | 'changed' | 'legacy' | 'legacy_changed'> {
  if (parseWbFileName(name)) return 'done';
  const st = await stat(full);
  const progress = await readCorpusProgress(full);
  if (progress) return sameCorpusFileStat(progress.finished, corpusFileStat(st)) ? 'done' : 'changed';
  const ingested = await stat(full + '.ingested');
  return ingested.mtimeMs >= st.mtimeMs ? 'legacy' : 'legacy_changed';
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

/**
 * Extract up to `maxWindows` non-empty windows of `raw` (the snapshot whose
 * stat is `fileStat`), committing `.progress` after each one. `complete`
 * means every window of this snapshot is done (the caller may write
 * `.ingested`); `partial` means the cap stopped it; `aborted` means the
 * signal or budget fired (nothing uncommitted is recorded); `contended`
 * means another extractor holds the lease or advanced the progress first.
 * Transport errors throw after the lease is released.
 */
export async function runCorpusWindows(opts: {
  full: string;
  raw: string;
  fileStat: CorpusFileStat;
  maxWindows: number;
  extract: (text: string) => Promise<PipelineResult>;
  overBudget: () => boolean;
  signal: AbortSignal;
}): Promise<CorpusWindowRun> {
  const { full, fileStat, signal } = opts;
  const owner = `${process.pid}:${randomUUID()}`;
  const now = Date.now();
  let state = await updateProgress(full, (cur) => {
    if (cur?.lease && cur.lease.owner !== owner && now - cur.lease.at < CORPUS_PROGRESS_LEASE_STALE_MS) return null;
    return { ...(cur ?? freshProgress()), lease: { owner, at: now } };
  });
  const turns = parseCorpusTurns(opts.raw);
  if (!state) {
    const cur = await readCorpusProgress(full).catch(() => null);
    const remaining = planCorpusWindows(turns, resumePoint(turns, cur), MAX_TURN_TEXT_CHARS, retiredTurns(cur)).filter((w) => w.text).length;
    return { status: 'contended', windowsDone: 0, windowsRemaining: remaining, result: resultOf(cur ?? { ...freshProgress(), generation: 0 }) };
  }

  let cursor = resumePoint(turns, state);
  const windows = planCorpusWindows(turns, cursor, MAX_TURN_TEXT_CHARS, retiredTurns(state));
  let done = 0;
  let status: CorpusWindowRun['status'] = 'complete';
  let holding = true;
  try {
    for (let w = 0; w < windows.length; w++) {
      const win = windows[w];
      if (win.text) {
        if (done >= opts.maxWindows) { status = 'partial'; break; }
        if (opts.overBudget() || signal.aborted) { status = 'aborted'; break; }
      }
      const r = win.text ? await opts.extract(win.text) : null;
      if (signal.aborted) { status = 'aborted'; break; }
      const finishedTurns = turns.slice(cursor.turn, win.endOffset === null ? win.endTurn + 1 : win.endTurn);
      const isLast = w === windows.length - 1;
      const expectGen = state.generation;
      const expectLast = lastSha(state);
      const advances = finishedTurns.length > 0 || (win.endOffset ?? 0) > cursor.offset;
      const next: CorpusProgress | null = await updateProgress(full, (cur) => {
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
      if (!next) { status = 'contended'; break; }
      state = next;
      if (r) done++;
      if (isLast) holding = false;
      cursor = win.endOffset === null ? { turn: win.endTurn + 1, offset: 0 } : { turn: win.endTurn, offset: win.endOffset };
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
 * The sweep's candidate list: files without `.ingested`, plus finished files
 * that changed since `.progress` recorded them (stat compare, no rehash). A
 * pre-window `.ingested` file is adopted at its current turns (budget
 * permitting) so only later growth is extracted. Returns the candidates (at
 * most `batchLimit`) and how many files are already done.
 */
export async function selectCorpusCandidates(
  dir: string,
  txtFiles: string[],
  entrySet: Set<string>,
  batchLimit: number,
  overBudget: () => boolean,
): Promise<{ candidates: string[]; alreadyIngested: number }> {
  const candidates: string[] = [];
  let alreadyIngested = 0;
  for (const name of txtFiles) {
    const full = join(dir, name);
    let state: Awaited<ReturnType<typeof finishedCorpusFileState>> | 'new' = 'new';
    if (entrySet.has(name + '.ingested')) {
      state = await finishedCorpusFileState(full, name).catch(() => 'changed' as const);
      if (state === 'legacy' && !overBudget()) await adoptFinishedCorpusFile(full).catch(() => false);
    }
    if (state === 'done' || state === 'legacy') alreadyIngested++;
    else if (candidates.length < batchLimit) candidates.push(name);
  }
  return { candidates, alreadyIngested };
}
