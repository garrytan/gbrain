/**
 * corpus-source.ts — #6268 (W13 P3.4, R14): the one source a captured
 * session's corpus files belong to.
 *
 * Every corpus writer (the engine-free hook, the OpenClaw context engine)
 * stamps the session's source into each file NAME and writes it into the
 * spool subdirectory (`corpus-segments.ts` CORPUS_SPOOL_SUBDIR). The source
 * is resolved ONCE per session and frozen in `<sessionId>.source.json` beside
 * the session's spool files: later captures of the same session reuse it even
 * when the environment, dotfile or brain config changed in between.
 *
 * Resolution order at write time (engine-free): GBRAIN_SOURCE, then the
 * `.gbrain-source` dotfile walked up from the session's cwd. When neither
 * fires, the record stays unresolved (it keeps the cwd) and files are stamped
 * CORPUS_UNRESOLVED_STAMP; a lane that holds the brain may freeze it later:
 * the serve's own bound source when the hook reaches it over IPC (what an
 * unpinned hook's IPC requests already resolve to), or, at sweep time, the
 * brain's resolution chain for the recorded cwd (tiers 4-6, the client-side
 * tiers already ran). A frozen source is never changed except by nobody: the
 * operator mapping fills only unresolved records.
 *
 * Extraction side (`resolveCorpusFileSource`, engine-holding callers): a
 * spool file uses its stamp (unresolved ⇒ the frozen record); a top-level
 * legacy file is held unless durable evidence names its source (a legacy
 * writeback stamp, a frozen spool record for the same session, or a brain with
 * exactly one source). The source must exist and be active, and the first
 * engine resolution binds the source's incarnation to the session: a source
 * deleted and recreated under the same id holds the session's files.
 *
 * ENGINE-FREE at module load: the engine-side helper takes the engine as an
 * argument and lazy-imports the resolver.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import {
  CORPUS_UNRESOLVED_STAMP,
  SESSION_SOURCE_LOCK_SUFFIX,
  SESSION_SOURCE_SUFFIX,
  corpusFileSessionId,
  corpusFileStamp,
  corpusSpoolDir,
  isCorpusSourceStamp,
  parseWbFileName,
  sessionSourceFileName,
} from './corpus-segments.ts';

export type SessionSourceTier = 'env' | 'dotfile' | 'serve' | 'engine' | 'operator';

export interface SessionSourceRecord {
  version: 1;
  session_id: string;
  /** Null while unresolved. */
  source_id: string | null;
  tier: SessionSourceTier | null;
  /** The session's working directory at first capture (the deferred resolver's input). */
  cwd: string | null;
  harness: string;
  created_at: string;
  resolved_at: string | null;
  /** `sources.incarnation` bound at the first engine-side resolution. */
  source_incarnation: string | null;
}

const LOCK_ATTEMPTS = 40;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;

function recordPath(spoolDir: string, sessionId: string): string {
  return join(spoolDir, sessionSourceFileName(sessionId));
}

function isValidRealSource(id: unknown): id is string {
  return isCorpusSourceStamp(id) && id !== CORPUS_UNRESOLVED_STAMP;
}

function parseRecord(raw: string): SessionSourceRecord | null {
  let r: SessionSourceRecord;
  try { r = JSON.parse(raw) as SessionSourceRecord; } catch { return null; }
  if (!r || typeof r !== 'object' || r.version !== 1 || typeof r.session_id !== 'string') return null;
  if (r.source_id !== null && !isValidRealSource(r.source_id)) return null;
  return r;
}

/** The session's record; null when absent or not a valid v1 record (an invalid record is never guessed). */
export function readSessionSource(spoolDir: string, sessionId: string): SessionSourceRecord | null {
  try {
    return parseRecord(readFileSync(recordPath(spoolDir, sessionId), 'utf8'));
  } catch {
    return null;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Compare-and-set under an O_EXCL lock: `next` sees the current record and
 * returns its replacement, or null to keep it. Returns the record that stands
 * afterwards (null when none exists or the lock stayed busy). Never throws.
 */
function updateSessionSource(
  spoolDir: string,
  sessionId: string,
  next: (cur: SessionSourceRecord | null) => SessionSourceRecord | null,
): SessionSourceRecord | null {
  const path = recordPath(spoolDir, sessionId);
  const lock = join(spoolDir, sessionSourceFileName(sessionId).slice(0, -SESSION_SOURCE_SUFFIX.length) + SESSION_SOURCE_LOCK_SUFFIX);
  try { mkdirSync(spoolDir, { recursive: true, mode: 0o700 }); } catch { return null; }
  let locked = false;
  for (let i = 0; i < LOCK_ATTEMPTS && !locked; i++) {
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      locked = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return readSessionSource(spoolDir, sessionId);
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
        else sleepSync(LOCK_RETRY_MS);
      } catch { /* lock vanished: retry */ }
    }
  }
  if (!locked) return readSessionSource(spoolDir, sessionId);
  try {
    const cur = readSessionSource(spoolDir, sessionId);
    const proposed = next(cur);
    if (!proposed) return cur;
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(proposed) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
    return proposed;
  } catch {
    return readSessionSource(spoolDir, sessionId);
  } finally {
    rmSync(lock, { force: true });
  }
}

function freshRecord(sessionId: string, cwd: string | null, harness: string): SessionSourceRecord {
  return {
    version: 1, session_id: sessionId, source_id: null, tier: null, cwd, harness,
    created_at: new Date().toISOString(), resolved_at: null, source_incarnation: null,
  };
}

/** The engine-free tiers (GBRAIN_SOURCE, then the cwd's dotfile walk); null when neither names a real source. */
async function engineFreeSessionSource(cwd: string | null): Promise<{ sourceId: string; tier: SessionSourceTier } | null> {
  const { resolveSourceIdEngineFree } = await import('../source-resolver.ts');
  let id: string | null;
  try {
    id = resolveSourceIdEngineFree(null, cwd ?? process.cwd());
  } catch {
    return null;
  }
  if (!isValidRealSource(id)) return null;
  const env = process.env.GBRAIN_SOURCE;
  return { sourceId: id, tier: env && env === id ? 'env' : 'dotfile' };
}

/**
 * The session's stamp for its next corpus file, freezing the source on first
 * use. An existing record wins over a fresh resolution (frozen at session
 * start). Never throws: any failure stamps the file unresolved.
 */
export async function openSessionSource(
  corpusDir: string,
  sessionId: string,
  opts: { cwd: string | null; harness: string },
): Promise<{ stamp: string; record: SessionSourceRecord | null }> {
  try {
    const spool = corpusSpoolDir(corpusDir);
    const existing = readSessionSource(spool, sessionId);
    if (existing) return { stamp: existing.source_id ?? CORPUS_UNRESOLVED_STAMP, record: existing };
    const resolved = await engineFreeSessionSource(opts.cwd);
    const record = updateSessionSource(spool, sessionId, (cur) => cur ? null : {
      ...freshRecord(sessionId, opts.cwd, opts.harness),
      ...(resolved ? { source_id: resolved.sourceId, tier: resolved.tier, resolved_at: new Date().toISOString() } : {}),
    });
    return { stamp: record?.source_id ?? CORPUS_UNRESOLVED_STAMP, record };
  } catch {
    return { stamp: CORPUS_UNRESOLVED_STAMP, record: null };
  }
}

/**
 * Freeze an UNRESOLVED (or missing) record to `sourceId`. A record that
 * already names a source keeps it. Returns the record that stands.
 */
export function freezeSessionSource(
  corpusDir: string,
  sessionId: string,
  sourceId: string,
  tier: SessionSourceTier,
  defaults: { cwd?: string | null; harness?: string; onlyExisting?: boolean } = {},
): SessionSourceRecord | null {
  const spool = corpusSpoolDir(corpusDir);
  if (!isValidRealSource(sourceId)) return readSessionSource(spool, sessionId);
  if (defaults.onlyExisting) {
    const existing = readSessionSource(spool, sessionId);
    if (!existing || existing.source_id) return existing;
  }
  return updateSessionSource(spool, sessionId, (cur) => {
    if (cur?.source_id || (defaults.onlyExisting && !cur)) return null;
    return { ...(cur ?? freshRecord(sessionId, defaults.cwd ?? null, defaults.harness ?? 'unknown')), source_id: sourceId, tier, resolved_at: new Date().toISOString() };
  });
}

/** Bind the source incarnation once; a record bound to another incarnation stays as it is. */
function bindIncarnation(spoolDir: string, sessionId: string, sourceId: string, incarnation: string): SessionSourceRecord | null {
  return updateSessionSource(spoolDir, sessionId, (cur) =>
    cur && cur.source_id === sourceId && cur.source_incarnation === null ? { ...cur, source_incarnation: incarnation } : null);
}

export type CorpusFileLocation = 'spool' | 'legacy';

export type CorpusSourceHold =
  | 'corpus_source_unresolved'
  | 'corpus_legacy_unstamped'
  | 'corpus_stamp_missing'
  | 'corpus_source_missing'
  | 'corpus_source_archived'
  | 'corpus_source_incarnation_changed';

export type CorpusFileSource =
  | { ok: true; sourceId: string; incarnation: string; via: 'stamp' | 'session_record' | 'sole_source' }
  | { ok: false; reason: CorpusSourceHold };

/**
 * The source a corpus file's facts, links and manifest belong to, or the
 * typed reason it is held (no sidecar: the file waits for evidence or an
 * operator mapping). Never the caller's pass source.
 */
export async function resolveCorpusFileSource(
  engine: BrainEngine,
  corpusDir: string,
  name: string,
  location: CorpusFileLocation,
): Promise<CorpusFileSource> {
  const spool = corpusSpoolDir(corpusDir);
  const sessionId = corpusFileSessionId(name);
  const stamp = corpusFileStamp(name);
  let record = readSessionSource(spool, sessionId);
  let candidate: string | null = null;
  let via: 'stamp' | 'session_record' | 'sole_source' = 'stamp';

  if (location === 'spool') {
    if (!stamp) return { ok: false, reason: 'corpus_stamp_missing' };
    if (stamp !== CORPUS_UNRESOLVED_STAMP) candidate = stamp;
    else {
      via = 'session_record';
      if (!record?.source_id && record?.cwd) {
        const { resolveSourceId } = await import('../source-resolver.ts');
        const deferred = await resolveSourceId(engine, null, record.cwd, { skipLocalSignals: true }).catch(() => null);
        if (deferred) record = freezeSessionSource(corpusDir, sessionId, deferred, 'engine');
      }
      candidate = record?.source_id ?? null;
      if (!candidate) return { ok: false, reason: 'corpus_source_unresolved' };
    }
  } else {
    const wbStamp = parseWbFileName(name)?.sourceId;
    if (wbStamp && isValidRealSource(wbStamp)) candidate = wbStamp;
    else if (record?.source_id) {
      candidate = record.source_id;
      via = 'session_record';
    } else {
      const ids = await engine.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id LIMIT 2');
      if (ids.length !== 1) return { ok: false, reason: 'corpus_legacy_unstamped' };
      candidate = ids[0].id;
      via = 'sole_source';
    }
  }

  const rows = await engine.executeRaw<{ incarnation: string; archived: boolean }>(
    'SELECT incarnation::text AS incarnation, archived FROM sources WHERE id = $1', [candidate]);
  if (!rows.length) return { ok: false, reason: 'corpus_source_missing' };
  if (rows[0].archived) return { ok: false, reason: 'corpus_source_archived' };
  const incarnation = rows[0].incarnation;
  if (record?.source_id === candidate) {
    const bound = record.source_incarnation ?? bindIncarnation(spool, sessionId, candidate, incarnation)?.source_incarnation ?? incarnation;
    if (bound !== incarnation) return { ok: false, reason: 'corpus_source_incarnation_changed' };
  }
  return { ok: true, sourceId: candidate, incarnation, via };
}

export interface CorpusSourceHolds {
  /** Top-level files with no `.ingested` sidecar and no evidence of their source. */
  legacy_unstamped: number;
  /** Spool files stamped unresolved whose session record still names no source. */
  unresolved: number;
  /** Session ids among both. */
  sessions: string[];
}

/**
 * Doctor/CLI view of the held files that only an operator mapping can
 * release (a multi-source brain's legacy files and unresolved sessions).
 * Engine-free; `soleSource` is the caller's `SELECT id FROM sources` answer.
 */
export function listCorpusSourceHolds(corpusDir: string, soleSource: boolean): CorpusSourceHolds {
  const out: CorpusSourceHolds = { legacy_unstamped: 0, unresolved: 0, sessions: [] };
  const spool = corpusSpoolDir(corpusDir);
  const sessions = new Set<string>();
  const scan = (dir: string, location: CorpusFileLocation) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    const present = new Set(names);
    for (const name of names) {
      if (!name.endsWith('.txt') || present.has(name + '.ingested')) continue;
      const sid = corpusFileSessionId(name);
      if (readSessionSource(spool, sid)?.source_id) continue;
      if (location === 'spool') {
        if (corpusFileStamp(name) !== CORPUS_UNRESOLVED_STAMP) continue;
        out.unresolved++;
      } else {
        const wb = parseWbFileName(name)?.sourceId;
        if ((wb && isValidRealSource(wb)) || soleSource) continue;
        out.legacy_unstamped++;
      }
      sessions.add(sid);
    }
  };
  scan(spool, 'spool');
  scan(corpusDir, 'legacy');
  out.sessions = [...sessions].sort();
  return out;
}

/**
 * Operator mapping (`gbrain sweep --assign-corpus`): freeze every held
 * session (or one) to `sourceId`. Frozen records are never changed.
 * Returns the sessions that now name `sourceId` because of this call.
 */
export function assignCorpusSessions(corpusDir: string, sessionIds: string[], sourceId: string): string[] {
  const assigned: string[] = [];
  for (const sid of sessionIds) {
    const before = readSessionSource(corpusSpoolDir(corpusDir), sid);
    if (before?.source_id) continue;
    const after = freezeSessionSource(corpusDir, sid, sourceId, 'operator');
    if (after?.source_id === sourceId && after.tier === 'operator') assigned.push(sid);
  }
  return assigned;
}
