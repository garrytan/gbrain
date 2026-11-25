/**
 * The shadow restore drill (swap criterion 10, first half; plan c-ts, docs/designs/RUST_ENGINE.md "Eval gates" and the
 * recovery drills). `gbrain engine shadow drill` copies the SHADOW's Rust store at one committed generation through the
 * brain's owner (`snapshotStore`, src/core/rust-engine/store-snapshot.ts), checks the copy without opening it normally
 * (`verifyStoreDir`), opens the copy once, deletes the scratch space and records the result in
 * `<shadow dir>/drills/backup.json`. It never pauses the shadow: the owner keeps following while the copy runs.
 *
 * Two phases, kept apart in the record (review F1): phase 1 judges the immutable copy at generation N (a normal open
 * would upgrade, repair and start the keyword builder, each a commit); phase 2 opens a throwaway copy the normal way,
 * runs one keyword search and counts pages, and records the generation after that open as `post_open`.
 *
 * Cleanup (review F2): scratch space is deleted only after the owner says the copy has ended (`snapshotStatus` is not
 * `running`). A drill that cannot show that leaves `drills/pending.json`; status then reads `cleanup_pending`, never a
 * pass, and the next drill clears it once the owner reports the copy ended or the owner is gone.
 *
 * This is the ONLINE LOGICAL proof (`method: "online_logical"`). It is never the above-cap physical-copy proof the
 * design requires for a store over the 8 GiB archive cap (that is backup restore's isolated fixture); a store over the
 * cap records `over_archive_cap: true` and the method, and nothing else.
 *
 * Records carry codes, counts and ids, never a key, a value, a path of the brain's content or an error message.
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { BACKUP_ARCHIVE_MAX_BYTES } from '../core/backup/archive.ts';
import { flushDirectory } from '../core/fs-durable.ts';
import { withRequestSignal } from '../core/request-signal.ts';
import type { BrainEngine } from '../core/engine.ts';
import { loadedAddonPath, type RustEngineAddonLoad } from '../core/rust-engine/addon-loader.ts';
import { resolveHardExcludes } from '../core/search/source-boost.ts';
import type { SnapshotStatus, SnapshotStoreOptions } from '../core/rust-engine/store-snapshot.ts';
import type { StoreSnapshotManifest, StoreVerifyReport } from '../core/rust-engine/store.ts';
import { backupRecordPath, drillsDir, DRILL_METHOD, DRILL_VERSION, pendingPath } from './drill-status.ts';
import { pinDir, type DirPin } from './eval-gates.ts';
import { isEnglishStopword } from './english-stopwords.ts';
import { readEpoch } from './evidence-epoch.ts';
import { readSeedRecord } from './seed.ts';

const GIB = 1024 ** 3;
/** Free space the drill needs beyond twice the store file: the copy and the pages the owner keeps for it. */
export const DRILL_MARGIN_BYTES = 2 * GIB;

/** Why a drill did not pass (a code, never a message). */
export type DrillReason =
  | 'no_seed' | 'no_epoch' | 'no_store' | 'addon_unavailable' | 'disk_space' | 'drill_running' | 'cleanup_pending'
  | 'snapshot_busy' | 'snapshot_cancelled' | 'snapshot_disk_pressure' | 'snapshot_age_budget' | 'snapshot_failed'
  | 'copy_mismatch' | 'copy_integrity' | 'copy_unreadable' | 'open_failed' | 'search_failed' | 'cleanup_failed' | 'drill_error'
  | 'addon_mismatch' | 'no_probe_term' | 'shadow_gone';

export interface DrillRecord {
  version: typeof DRILL_VERSION;
  drill_id: string;
  method: typeof DRILL_METHOD;
  epoch_id: string;
  seed_id: string;
  op_id: string | null;
  via: 'owner_ipc' | 'in_process' | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  snapshot_ms: number | null;
  restore_ms: number | null;
  store_bytes: number | null;
  snapshot_bytes: number | null;
  generation: number | null;
  engine_format_version: number | null;
  over_archive_cap: boolean;
  /** SHA-256 of the addon file this drill verified and opened the copy with; it must equal the evidence epoch's. */
  addon_sha256: string | null;
  free_bytes_initial: number | null;
  free_bytes_low_water: number | null;
  /** Tags and relations whose digests the verifier compared against the manifest. */
  compared: { tags: number; relations: number } | null;
  mismatches: string[];
  post_open: { generation_after: number | null; keyword_state: string | null; pages: number | null; search_hits: number | null } | null;
  scratch_deleted: boolean;
  pass: boolean;
  reason: DrillReason | null;
}

/** The owner as the drill sees it: one copy at a time, and what became of an operation. */
export interface DrillOwner {
  via: 'owner_ipc' | 'in_process';
  snapshot(target: string, options: SnapshotStoreOptions): Promise<SnapshotStatus & { manifest: StoreSnapshotManifest; free_bytes: { initial: number; low: number } }>;
  status(opId: string): Promise<SnapshotStatus>;
  /** True only when the owner process is certainly gone (a refused connect), so a copy it ran has ended. */
  ownerGone(): Promise<boolean>;
  close(): Promise<void>;
}

export interface OpenCheck { pages: number; searchHits: number | null }

export interface DrillDeps {
  loadAddon?: () => Promise<RustEngineAddonLoad>;
  openOwner?: (addon: object, storePath: string, live?: () => boolean) => Promise<DrillOwner>;
  verify?: (addon: object, dir: string, expected: StoreSnapshotManifest) => Promise<StoreVerifyReport>;
  /** Reads what the copy holds after phase 2's open (no manifest); null when it cannot. */
  verifyAfter?: (addon: object, dir: string) => Promise<StoreVerifyReport | null>;
  /** Phase 2: opens the copy the normal way, searches once and counts pages. */
  openCopy?: (addon: object, dir: string, expectKeywordHit: boolean, live?: () => boolean) => Promise<OpenCheck>;
  /** The SHA-256 of the addon file the loader opened (child.ts `addonFileSha256`); null when it cannot be read. */
  addonSha256?: (addon: object) => string | null;
  statfs?: (path: string) => { bavail: number | bigint; bsize: number | bigint };
  now?: () => number;
  id?: () => string;
  /** Test seams for the owner's copy (batch size and pause). */
  snapshotOptions?: Pick<SnapshotStoreOptions, 'batchBytes' | 'batchDelayMs' | 'pollMs' | 'maxAgeMs' | 'minReserveBytes'>;
  /** How long to wait for an owner to report a copy ended before leaving it pending, and how often to ask. */
  endedWaitMs?: number;
  endedPollMs?: number;
  signal?: AbortSignal;
}

const lockPath = (dir: string): string => join(drillsDir(dir), 'drill.lock');
const historyPath = (dir: string): string => join(drillsDir(dir), 'history.jsonl');
const takeoverPath = (dir: string): string => join(drillsDir(dir), 'drill.lock.takeover');

interface Pending { version: 1; op_id: string; drill_id: string; scratch: string; started_at: string }

function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

/** `scratch` from a pending record is deleted only when it is a drill scratch directory under this shadow's drills dir. */
function ownScratch(dir: string, scratch: string): boolean {
  const root = resolve(drillsDir(dir)) + sep;
  const path = resolve(scratch);
  return path.startsWith(root) && /^scratch-[A-Za-z0-9._-]+$/.test(path.slice(root.length));
}

export function readPending(dir: string): Pending | null {
  try {
    const v = JSON.parse(readFileSync(pendingPath(dir), 'utf8')) as Pending;
    return v && v.version === 1 && typeof v.op_id === 'string' && typeof v.scratch === 'string' ? v : null;
  } catch { return null; } // silent-read-ok: an unreadable pending record is handled by the caller as `cleanup_pending` (the file exists)
}

const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** Writes `body` to a private file and hard-links it to `path`: `path` appears complete or not at all. False when it exists. */
function publishExclusive(path: string, body: string): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    try { unlinkSync(tmp); } catch { /* the link, if made, is the file */ }
  }
}

const readLock = (dir: string): string | null => { try { return readFileSync(lockPath(dir), 'utf8'); } catch { return null; } }; // silent-read-ok: no readable lock is never taken over
const lockHolder = (text: string): number => { try { return Number((JSON.parse(text) as { pid?: unknown }).pid); } catch { return NaN; } }; // silent-read-ok: an unreadable lock has no holder, and is never stolen

/**
 * Takes the drill lock. The lock file appears whole (written to a private file, then linked), so a reader never sees it
 * half written. A lock held by a live process, a lock that cannot be read and one that is gone are never taken. A lock
 * whose holder process is dead is taken over only through `drill.lock.takeover`, created exclusively: the taker re-reads
 * the lock under it and removes it only if it is still the very text it judged dead, so two takers can never both
 * enter, and a lock another drill just created is never removed. A takeover file a crash left behind keeps the drill
 * refused (`drill_running`) until it is removed by hand. The release removes the lock only while it is still ours.
 */
function takeLock(dir: string, now: number): (() => void) | null {
  const body = JSON.stringify({ pid: process.pid, at: now, token: randomBytes(8).toString('hex') });
  const release = (): void => { try { if (readLock(dir) === body) unlinkSync(lockPath(dir)); } catch { /* already gone */ } }; // silent-read-ok: a lock that is already gone is released
  if (publishExclusive(lockPath(dir), body)) return release;
  const seen = readLock(dir);
  if (seen === null) return null;
  const pid = lockHolder(seen);
  if (!Number.isInteger(pid) || pidAlive(pid)) return null;
  if (!publishExclusive(takeoverPath(dir), body)) return null;
  try {
    if (readLock(dir) !== seen) return null;
    unlinkSync(lockPath(dir));
    return publishExclusive(lockPath(dir), body) ? release : null;
  } finally {
    try { unlinkSync(takeoverPath(dir)); } catch { /* ours; already gone */ }
  }
}

/**
 * The drill lock for `stop --delete`: a delete never runs under a drill (a drill's opens create the directories they find
 * missing), and no first drill starts under a delete. The drills directory is created if it is not there yet (never the
 * shadow root: a missing root means nothing is left to protect), so the one real lock excludes a drill that has not run
 * before. The caller's `done(true)` after the shadow is deleted releases the lock and only then removes the drills
 * directory (`stop` leaves it), so the lock is held until nothing a drill admits on is left. Null: a drill holds the lock.
 */
export function takeDrillLockForDelete(dir: string, now: number = Date.now()): ((deleted: boolean) => void) | null {
  const nothing = (): ((deleted: boolean) => void) => () => undefined;
  try { mkdirSync(drillsDir(dir), { mode: 0o700 }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return nothing();
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  let release: (() => void) | null;
  try { release = takeLock(dir, now); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return nothing(); // the shadow went while we looked
    throw e;
  }
  if (!release) return null;
  return deleted => {
    release!();
    if (!deleted) return;
    rmSync(drillsDir(dir), { recursive: true, force: true });
    try { rmdirSync(dir); } catch { /* a new run's files appeared: they stay */ }
  };
}

/** Removes `backup.json` and syncs the drills directory; false when the record is still there (or its removal cannot be confirmed). */
function invalidateRecord(dir: string): boolean {
  try { rmSync(backupRecordPath(dir), { force: true }); } catch { return false; } // silent-read-ok: a record that cannot be removed is the false return
  try { flushDirectory(drillsDir(dir)); } catch { return false; } // silent-read-ok: a removal that cannot be synced is not durable: the caller refuses
  return !existsSync(backupRecordPath(dir));
}

/** Removes the pending record only while it is still the one for `opId`: never another drill's. */
function removePendingIf(dir: string, opId: string): void {
  if (readPending(dir)?.op_id === opId) rmSync(pendingPath(dir), { force: true });
}

/** SHA-256 of the addon file the loader opened, as the shadow child records it in the epoch (child.ts `addonFileSha256`; the same `loadedAddonPath`). */
export function addonFileSha256(addon: object): string | null {
  const path = loadedAddonPath(addon, process.env.GBRAIN_RUST_ENGINE_ADDON);
  if (!path) return null;
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; } // silent-read-ok: null is the typed marker; the drill refuses on it
}

const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

/**
 * Waits until the owner reports operation `opId` ended (any state but `running`; `unknown` means the owner never ran it
 * or has restarted, so no copy of it is left running) or is certainly gone. False when it is still running at the deadline.
 */
async function copyEnded(owner: DrillOwner, opId: string, waitMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    // Each owner request is bounded by what is left of the deadline (at least four polls, so a wait of zero still lets one
    // answer come back): an owner that stops answering counts as "still running", never as a reason to wait on it forever.
    const budget = Math.max(deadline - Date.now(), pollMs * 4);
    try {
      const status = await within(owner.status(opId), budget);
      if (status !== TIMED_OUT && status.state !== 'running') return true;
    } catch { if ((await within(owner.ownerGone().catch(() => false), budget)) === true) return true; } // silent-read-ok: a status call that fails is retried until the deadline
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

const TIMED_OUT = Symbol('timed_out');

/** The promise's value, or TIMED_OUT when it has not settled within `ms`. A rejection after the timeout is swallowed by the race. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>(done => { timer = setTimeout(() => done(TIMED_OUT), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

const snapshotReason = (error: unknown): DrillReason => {
  const e = error as { code?: unknown; reason?: unknown };
  if (e?.code === 'rust_snapshot_stopped' && typeof e.reason === 'string') {
    if (e.reason === 'busy' || e.reason === 'cancelled' || e.reason === 'disk_pressure' || e.reason === 'age_budget') return `snapshot_${e.reason}`;
  }
  return 'snapshot_failed';
};

/** The Rust owner of `storePath` as the drill uses it: a client of the shadow's child, or this process when the store is free. */
async function openRealOwner(addon: object, storePath: string, live: () => boolean = () => true): Promise<DrillOwner> {
  const [{ openRustEngine }, { forwardWholeOperation }, { snapshotStatus, snapshotStore }, { socketHasLiveListener }, { ownerSocketPath }] = await Promise.all([
    import('../core/rust-engine.ts'), import('../core/rust-engine/owner-ipc/whole-op.ts'), import('../core/rust-engine/store-snapshot.ts'),
    import('../core/context/resolve-ipc.ts'), import('../core/rust-engine/owner-ipc/protocol.ts'),
  ]);
  // The imports above are an await: the check runs after them, right before the connect that creates missing directories.
  if (!live()) throw new Error('the shadow is gone: the store is not opened');
  const engine = openRustEngine({ addon: addon as Parameters<typeof openRustEngine>[0]['addon'], databasePath: storePath });
  await engine.connect({ database_path: storePath } as never);
  return {
    via: engine.ownerRole === 'client' ? 'owner_ipc' : 'in_process',
    snapshot: async (target, options) => (forwardWholeOperation(engine, 'snapshotStore', [target, options]) ?? snapshotStore(engine, target, options)) as never,
    status: async opId => (await forwardWholeOperation<SnapshotStatus>(engine, 'snapshotStatus', [opId])) ?? snapshotStatus(opId),
    ownerGone: async () => !(await socketHasLiveListener(ownerSocketPath(storePath))),
    close: () => engine.disconnect(),
  };
}

async function verifyCopy(addon: object, dir: string, expected: StoreSnapshotManifest): Promise<StoreVerifyReport> {
  const { verifyStoreDir } = await import('../core/rust-engine/store.ts');
  return verifyStoreDir(addon, dir, expected);
}

/** How many pages the probe reads chunks from, and how many distinct words it tries before it gives up. */
const PROBE_PAGES = 20;
const PROBE_TRIES = 24;

/** What the probe needs from the opened copy (a `BrainEngine` serves it; tests pass a fake). */
export type ProbeEngine = Pick<BrainEngine, 'getStats' | 'listPages' | 'getChunks' | 'searchKeyword'>;

/**
 * Phase 2's check on an opened copy: the page count, and one keyword search. The word comes from the copy's own stored
 * chunks, from pages the search can see (not under a hard-excluded slug prefix), read in the page's own source; the
 * longest letter-only words that are not engine stop words go first (english-stopwords.ts, checked against the Rust list);
 * the engine itself decides which one is indexed, so a word the tokenizer drops is skipped, never a failure of the copy. The first word with a hit passes. A copy with
 * pages and no word that answers (or no word at all) is `no_probe_term`: a named non-pass, because a populated copy that
 * ran no search proves nothing about its index. When the index is not complete a miss is allowed, but a query must run.
 */
export async function probeCopy(engine: ProbeEngine, expectKeywordHit: boolean): Promise<OpenCheck> {
  const pages = (await engine.getStats()).page_count;
  if (pages === 0) return { pages, searchHits: null };
  const excluded = resolveHardExcludes();
  const words = new Set<string>();
  // The exclusion runs in the listing, before its limit: pages the search never shows cannot fill the page budget.
  for (const page of await engine.listPages({ limit: PROBE_PAGES, excludeSlugPrefixes: excluded })) {
    if (excluded.some(prefix => page.slug.startsWith(prefix))) continue;
    for (const chunk of await engine.getChunks(page.slug, { sourceId: page.source_id })) {
      for (const w of chunk.chunk_text.split(/[^\p{L}\p{N}]+/u)) if (/^\p{L}{4,24}$/u.test(w) && !isEnglishStopword(w)) words.add(w.toLowerCase());
    }
  }
  // Stop words are dropped before the budget, so they cannot use up the tries a word the engine indexes needs.
  const tries = [...words].sort((x, y) => y.length - x.length).slice(0, PROBE_TRIES);
  let last: number | null = null;
  for (const word of tries) {
    const hits = (await engine.searchKeyword(word, { limit: 5 })).length;
    last = hits;
    if (hits > 0) return { pages, searchHits: hits };
  }
  if (last !== null && !expectKeywordHit) return { pages, searchHits: 0 };
  throw Object.assign(new Error('no word of the copy is answered by its keyword search'), { drillReason: 'no_probe_term' });
}

async function openCopyReal(addon: object, dir: string, expectKeywordHit: boolean, live: () => boolean = () => true): Promise<OpenCheck> {
  const { openRustEngine } = await import('../core/rust-engine.ts');
  if (!live()) throw new Error('the shadow or its copy is gone: not opened');
  const engine = openRustEngine({ addon: addon as Parameters<typeof openRustEngine>[0]['addon'], databasePath: dir });
  await engine.connect({ database_path: dir } as never);
  try {
    return await probeCopy(engine, expectKeywordHit);
  } finally {
    await engine.disconnect();
  }
}

/** Runs one drill. Never throws for a drill that failed: the failure is the record. Refusals before any copy return a record too. */
export async function runBackupDrill(dir: string, deps: DrillDeps = {}): Promise<DrillRecord> {
  const now = deps.now ?? Date.now;
  const started = now();
  const drillId = (deps.id ?? (() => randomBytes(6).toString('hex')))();
  const seed = readSeedRecord(dir);
  const epoch = readEpoch(dir);
  const rec: DrillRecord = {
    version: DRILL_VERSION, drill_id: drillId, method: DRILL_METHOD, epoch_id: epoch?.epoch_id ?? '', seed_id: seed?.seed_id ?? '', op_id: null, via: null,
    started_at: new Date(started).toISOString(), finished_at: '', duration_ms: 0, snapshot_ms: null, restore_ms: null, store_bytes: null, snapshot_bytes: null,
    generation: null, engine_format_version: null, over_archive_cap: false, addon_sha256: null, free_bytes_initial: null, free_bytes_low_water: null, compared: null,
    mismatches: [], post_open: null, scratch_deleted: true, pass: false, reason: null,
  };
  // The shadow directory this drill started in (taken once admission has found its files) and its drills directory. A
  // drill never creates the shadow root: when `stop --delete` removed it (or a new one took its place) while the drill ran,
  // nothing is published and the drill is `shadow_gone`, the same rule the ledger and usage writers follow.
  // Both are held open (see `pinDir`) until the drill returns, so a directory deleted and recreated at the same path is told apart.
  let rootPin: DirPin | null = null;
  let drillsPin: DirPin | null = null;
  const shadowLive = (): boolean => rootPin !== null && rootPin.live() && drillsPin !== null && drillsPin.live();
  const releasePins = (): void => { rootPin?.close(); drillsPin?.close(); };
  let published = false;
  const finish = (reason: DrillReason | null, persist: boolean): DrillRecord => {
    const gone = persist && !shadowLive();
    const final = gone ? 'shadow_gone' : reason;
    rec.finished_at = new Date(now()).toISOString();
    rec.duration_ms = now() - started;
    rec.pass = final === null;
    rec.reason = final;
    if (persist && !gone) {
      try {
        // The history first: a pass is published only by `backup.json`, the one file status reads.
        appendFileSync(historyPath(dir), JSON.stringify(rec) + '\n', { mode: 0o600 });
        writeAtomic(backupRecordPath(dir), JSON.stringify(rec, null, 2) + '\n');
        published = true;
      } catch {
        rec.pass = false;
        rec.reason = shadowLive() ? 'drill_error' : 'shadow_gone';
        // This drill's result could not be written, so an earlier pass in `backup.json` must not stand for it: take it away
        // (the pending marker below stays too, so status reads an unfinished copy until a later drill publishes).
        if (shadowLive()) { try { rmSync(backupRecordPath(dir), { force: true }); } catch { /* the pending marker keeps status from reading a pass */ } }
      }
    }
    return rec;
  };

  // Admission: nothing is written until these hold. A refusal is returned, not recorded as a drill.
  if (!seed) return finish('no_seed', false);
  if (!epoch) return finish('no_epoch', false);
  const storePath = join(dir, 'store');
  const records = join(storePath, 'records.redb');
  if (!existsSync(records)) return finish('no_store', false);
  rec.store_bytes = statSync(records).size;
  rec.over_archive_cap = rec.store_bytes > BACKUP_ARCHIVE_MAX_BYTES;
  // Free space is read again, after a copy an earlier drill left behind is cleared: that copy holds the very space the
  // check needs, so refusing on it first would keep it forever. Without a pending copy the check stays up front.
  const freeSpace = (): number => { const stats = (deps.statfs ?? (path => statfsSync(path)))(dir); return Number(stats.bavail) * Number(stats.bsize); };
  const needBytes = 2 * rec.store_bytes + DRILL_MARGIN_BYTES;
  const hadPending = existsSync(pendingPath(dir));
  rec.free_bytes_initial = freeSpace();
  if (!hadPending && rec.free_bytes_initial < needBytes) return finish('disk_space', false);
  const load = await (deps.loadAddon ?? (async () => (await import('./addon.ts')).loadRustEngineAddonOffline()))();
  if (!load.ok) return finish('addon_unavailable', false);
  // The copy is verified and opened with the addon loaded here: it must be the addon the evidence epoch started on, or
  // this pass would describe a different candidate. An unknown digest, or an epoch that never knew its addon, refuses too.
  rec.addon_sha256 = (deps.addonSha256 ?? addonFileSha256)(load.addon);
  const epochAddon = epoch.inputs.rust_addon_sha256;
  if (rec.addon_sha256 === null || epochAddon === null || epochAddon === 'unreadable' || rec.addon_sha256 !== epochAddon) return finish('addon_mismatch', false);
  // The holds and the lock are taken together: a failure on the way (a full disk, a read-only drills directory) releases the
  // holds already taken, and once the lock is taken the `finally` below releases both.
  let release: (() => void) | null = null;
  try {
    rootPin = pinDir(dir);
    try { mkdirSync(drillsDir(dir), { mode: 0o700 }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { releasePins(); return finish('shadow_gone', false); }
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    drillsPin = pinDir(drillsDir(dir));
    release = takeLock(dir, now());
  } catch (e) {
    releasePins();
    throw e;
  }
  if (!release) { releasePins(); return finish('drill_running', false); }
  // The lock is held through the whole drill, the write of its result and the removal of its pending marker, on every path:
  // an older drill that is slow to publish must not be overtaken by a newer one and then overwrite its result.
  try {
    const opId = `drill-${drillId}`;
    const scratch = join(drillsDir(dir), `scratch-${drillId}`);
    const restored = join(scratch, 'restored');
    let owner: DrillOwner | null = null;
    let reason: DrillReason | null = null;
    let ended = true;
    let wrotePending = false;
    const waitMs = deps.endedWaitMs ?? 30_000;
    const pollMs = deps.endedPollMs ?? 250;
    try {
      // An open creates the directories it finds missing (the owner election, its lock file, the store): so a shadow that
      // `stop --delete` removed is never opened, and the store is checked right before the open.
      if (!shadowLive()) return finish('shadow_gone', true);
      if (!existsSync(records)) return finish('no_store', false);
      owner = await (deps.openOwner ?? openRealOwner)(load.addon, storePath, () => shadowLive() && existsSync(records));
      rec.via = owner.via;

      // A copy an earlier drill left behind: its scratch goes only after the owner says that copy ended.
      if (existsSync(pendingPath(dir))) {
        const old = readPending(dir);
        if (!old || !(await copyEnded(owner, old.op_id, 0, pollMs))) return finish('cleanup_pending', false);
        if (ownScratch(dir, old.scratch)) rmSync(old.scratch, { recursive: true, force: true });
        if (existsSync(old.scratch)) return finish('cleanup_failed', false);
        // The old marker is the only thing that keeps an earlier pass from standing for a drill that never published (its
        // write and its removal of the old record can both have failed): the old record goes first, durably, or the marker stays.
        if (!invalidateRecord(dir)) return finish('cleanup_failed', false);
        removePendingIf(dir, old.op_id);
      }
      if (hadPending && freeSpace() < needBytes) return finish('disk_space', false);

      // Phase 1 (immutable): the owner's copy at one generation, then the verifier on the closed copy.
      rec.op_id = opId;
      mkdirSync(scratch, { mode: 0o700 });
      const pending: Pending = { version: 1, op_id: opId, drill_id: drillId, scratch, started_at: rec.started_at };
      writeAtomic(pendingPath(dir), JSON.stringify(pending) + '\n');
      wrotePending = true;
      const t1 = now();
      let manifest: StoreSnapshotManifest | null = null;
      let keywordState: string | null = null;
      try {
        const send = (): ReturnType<DrillOwner['snapshot']> => owner!.snapshot(restored, { opId, ...(deps.snapshotOptions ?? {}) });
        const done = await (deps.signal ? withRequestSignal(deps.signal, send) : send());
        manifest = done.manifest;
        rec.free_bytes_initial = done.free_bytes.initial;
        rec.free_bytes_low_water = done.free_bytes.low;
      } catch (error) {
        reason = snapshotReason(error);
        ended = await copyEnded(owner, opId, waitMs, pollMs);
      }
      rec.snapshot_ms = now() - t1;
      if (manifest) {
        rec.generation = manifest.generation;
        rec.engine_format_version = manifest.engine_format_version;
        rec.snapshot_bytes = manifest.bytes;
        const t2 = now();
        try {
          const report = await (deps.verify ?? verifyCopy)(load.addon, restored, manifest);
          rec.compared = { tags: Object.keys(manifest.tags).length, relations: Object.keys(manifest.relations ?? {}).length };
          rec.mismatches = report.mismatches;
          if (report.verdict === 'integrity') reason = 'copy_integrity';
          else if (report.verdict !== 'ok' || (report.keyword_index && !report.keyword_index.ok)) reason = 'copy_mismatch';
          keywordState = report.keyword_index?.state ?? null;
        } catch { reason = 'copy_unreadable'; } // silent-read-ok: the reason code is the record
        // Phase 2 (open check): a normal open of the throwaway copy, kept apart from the evidence above.
        if (reason === null) {
          try {
            // `finish` reads a gone shadow as shadow_gone; each open also checks again after its own imports, before it connects.
            const copyLive = (): boolean => shadowLive() && existsSync(restored);
            if (!copyLive()) throw new Error('the shadow or its copy is gone: not opened');
            const check = await (deps.openCopy ?? openCopyReal)(load.addon, restored, keywordState === 'complete', copyLive);
            if (check.pages > 0 && check.searchHits === null) throw Object.assign(new Error('no search ran on a populated copy'), { drillReason: 'no_probe_term' });
            const after = await (deps.verifyAfter ?? verifyAfterOpen)(load.addon, restored);
            rec.post_open = { generation_after: after?.generation ?? null, keyword_state: after?.keyword_index?.state ?? keywordState, pages: check.pages, search_hits: check.searchHits };
          } catch (error) {
            reason = (error as { drillReason?: DrillReason }).drillReason ?? 'open_failed';
          }
        }
        rec.restore_ms = now() - t2;
      }
    } catch { reason ??= 'drill_error'; } // silent-read-ok: the reason code is the record
    finally {
      if (owner) await owner.close().catch(() => undefined);
      if (ended) {
        try { rmSync(scratch, { recursive: true, force: true }); } catch { /* checked below */ }
        rec.scratch_deleted = !existsSync(scratch);
      } else {
        rec.scratch_deleted = false;
      }
    }
    if (!rec.scratch_deleted) reason ??= 'cleanup_failed';
    const result = finish(reason, true);
    // The pending marker goes only once the copy is gone AND this drill's result is durable (or the shadow itself is gone and
    // nothing can be published): a failed write must not leave the earlier record as the one status reads.
    if (rec.scratch_deleted && wrotePending && (published || result.reason === 'shadow_gone')) removePendingIf(dir, opId);
    return result;
  } finally {
    release();
    releasePins();
  }
}

async function verifyAfterOpen(addon: object, dir: string): Promise<StoreVerifyReport | null> {
  try {
    const { verifyStoreDir } = await import('../core/rust-engine/store.ts');
    return await verifyStoreDir(addon, dir);
  } catch { return null; } // silent-read-ok: `generation_after` stays null; the drill's verdict does not depend on it
}

export function renderDrill(r: DrillRecord): string[] {
  const mb = (n: number | null): string => (n === null ? 'n/a' : `${(n / 1024 / 1024).toFixed(1)} MiB`);
  const lines = [`Restore drill ${r.drill_id} (${r.method}): ${r.pass ? 'passed' : `did not pass (${r.reason})`}`];
  lines.push(`  store ${mb(r.store_bytes)}, copy ${mb(r.snapshot_bytes)} at generation ${r.generation ?? 'n/a'}, ${r.duration_ms} ms (copy ${r.snapshot_ms ?? 'n/a'} ms, check ${r.restore_ms ?? 'n/a'} ms)`);
  if (r.compared) lines.push(`  compared ${r.compared.tags} tag digests and ${r.compared.relations} relation digests; mismatches: ${r.mismatches.length ? r.mismatches.join(', ') : 'none'}`);
  if (r.post_open) lines.push(`  after a normal open: ${r.post_open.pages ?? 'n/a'} pages, keyword index ${r.post_open.keyword_state ?? 'n/a'}, search hits ${r.post_open.search_hits ?? 'n/a'}, generation ${r.post_open.generation_after ?? 'n/a'}`);
  lines.push(`  scratch deleted: ${r.scratch_deleted ? 'yes' : 'NO (pending; a later drill clears it once the owner reports the copy ended)'}`);
  if (r.over_archive_cap) lines.push('  the store is over the 8 GiB archive cap: this online drill is not the physical-copy proof that size needs');
  return lines;
}
