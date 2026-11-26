/**
 * gbrain's opt-in usage telemetry, client side (docs/guides/telemetry.md).
 *
 * Off unless the person answered yes. After an off answer, or with GBRAIN_TELEMETRY=off,
 * nothing here writes a file or opens a connection. Before any answer, setup
 * and upgrade events wait in a local pending file that is sent only after a
 * yes and deleted on off.
 * At anonymous or community tier:
 *   - setup, upgrade, doctor and consent events append to events.jsonl
 *     (kept 30 days, at most 500);
 *   - command, operation, error-code and crash counts collect in memory and
 *     land in counts/<day>.json, one bucket per transport, build and traffic
 *     source, each folded into one
 *     daily_rollup per finished day at send time;
 *   - a detached gbrain telemetry sync posts at most once per 6 hours, up to
 *     100 events and 45,000 bytes, with a 10 s timeout.
 * Every field passes an allowlist: fixed values from enums.json, versions by
 * pattern, error codes from the registry and names from gbrain's own command
 * and operation tables, checked by the callers. Nothing from a page, a query,
 * a path or an error message is ever a field. Files live under
 * <GBRAIN_HOME>/.gbrain/telemetry, mode 0600, written by atomic rename.
 */
import { randomUUID } from 'crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { configDir, isThinClient, loadConfigFileOnly, type GBrainConfig } from '../config.ts';
import { VERSION } from '../../version.ts';
import { isNewerVersion } from '../semver.ts';
import enumsJson from './enums.json';
import { telemetryEndpoint } from './endpoint.ts';

export type Tier = 'off' | 'anonymous' | 'community';
export type Transport = 'none' | 'stdio' | 'http';
type Row = Record<string, unknown>;
type CountMap = Record<string, number>;
interface Bucket { command_counts?: CountMap; operation_counts?: CountMap; error_code_counts?: CountMap; crash_counts?: CountMap }
/** Keyed by transport|version|source, the build and traffic source that counted them. */
type DayCounts = Record<string, Bucket>;

/** epoch moves on every consent change and forget; a write captured under an older epoch is dropped. */
export interface Settings { tier: Tier; installation_id?: string; answered_at?: string; last_run_version?: string; epoch?: number }
interface State { last_attempt_at?: string; last_sent_at?: string; last_status?: number | 'offline'; client_errors?: number }

export const ENUMS: Record<string, readonly string[]> = enumsJson;
const IDENT_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const VERSION_RE = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(\.[0-9]{1,6})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const DAY_MS = 86_400_000;
export const SYNC_INTERVAL_MS = 6 * 3_600_000;
export const MAX_BATCH_EVENTS = 100;
export const MAX_BATCH_BYTES = 45_000;
const EVENT_TTL_MS = 30 * DAY_MS;
const MAX_QUEUED_EVENTS = 500;
const MAX_SENT_RECORDS = 20;
const DROP_AFTER_CLIENT_ERRORS = 3;
const LOCK_STALE_MS = 30_000;
const TRANSPORTS: readonly Transport[] = ['none', 'stdio', 'http'];
const COUNT_KEYS = ['command_counts', 'operation_counts', 'error_code_counts', 'crash_counts'] as const;

export function telemetryDir(): string {
  return join(configDir(), 'telemetry');
}
const file = (name: string) => join(telemetryDir(), name);

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}
function readJsonAt<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
const readJson = <T>(name: string, fallback: T) => readJsonAt(file(name), fallback);
const writeJson = (name: string, value: unknown) => writeAtomic(file(name), `${JSON.stringify(value)}\n`);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function acquire(name: string, attempts: number): string | null {
  const path = file(name);
  mkdirSync(telemetryDir(), { recursive: true, mode: 0o700 });
  for (let i = 0; i < attempts; i++) {
    try {
      closeSync(openSync(path, 'wx', 0o600));
      return path;
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
      } catch { /* gone already */ }
      if (i + 1 < attempts) sleepSync(20);
    }
  }
  return null;
}
function release(path: string): void {
  try { unlinkSync(path); } catch { /* gone already */ }
}
function withQueueLock(fn: () => void): void {
  const lock = acquire('queue.lock', 5);
  if (!lock) return;
  try { fn(); } finally { release(lock); }
}
/**
 * Read-modify-write of settings.json on a fresh read under queue.lock, so two
 * writers never overwrite each other's change (an upgrade note never undoes a
 * concurrent `telemetry off`). `change` returns null to write nothing. Without
 * the lock an optional write is skipped; a required one (a consent choice, a
 * confirmed forget) is written anyway.
 */
function updateSettings(change: (s: Settings) => Settings | null, required: boolean): Settings | null {
  const lock = acquire('queue.lock', 50);
  if (!lock && !required) return null;
  try {
    const next = change(readSettings());
    if (next) writeJson('settings.json', next);
    return next;
  } finally {
    if (lock) release(lock);
  }
}

export function forcedOff(): boolean {
  return process.env.GBRAIN_TELEMETRY?.trim().toLowerCase() === 'off';
}
export function readSettings(): Settings {
  const s = readJson<Partial<Settings>>('settings.json', {});
  return { ...s, tier: s.tier === 'anonymous' || s.tier === 'community' ? s.tier : 'off' };
}
export function currentTier(): Tier {
  return forcedOff() ? 'off' : readSettings().tier;
}

const epochOf = (s: Settings) => s.epoch ?? 0;
/** Whether data captured at `epoch` may still be written or sent: the tier is on and no consent change or forget came since. */
const stillConsented = (epoch: number) => {
  const s = readSettings();
  return !forcedOff() && s.tier !== 'off' && epochOf(s) === epoch;
};

let tierCache: { dir: string; tier: Tier; epoch: number; at: number } | null = null;
function cachedTier(): { tier: Tier; epoch: number } {
  const now = Date.now();
  const dir = telemetryDir();
  if (!tierCache || tierCache.dir !== dir || now - tierCache.at > 60_000) tierCache = { dir, tier: currentTier(), epoch: epochOf(readSettings()), at: now };
  return tierCache;
}

const SENDABLE_FILES = ['events.jsonl', 'counts', 'sent.jsonl'];
/** Called under queue.lock from a settings change, so no send or count flush lands between the change and the delete. */
function clearFiles(names: readonly string[]): void {
  pending = {};
  for (const name of names) rmSync(file(name), { recursive: true, force: true });
}

/**
 * The person's answer. Off deletes everything queued, held and sent; switching
 * between anonymous and community deletes what was queued under the old tier,
 * so nothing recorded under one answer goes out under another. A yes records
 * one consent event.
 */
export function setTier(tier: Tier): Settings {
  const next = updateSettings((s) => {
    const n: Settings = { ...s, tier, answered_at: new Date().toISOString() };
    if (tier === 'community' && !n.installation_id) n.installation_id = randomUUID();
    if (tier !== 'off') n.last_run_version ??= VERSION;
    if (tier === 'off' || (s.tier !== 'off' && s.tier !== tier)) {
      n.epoch = epochOf(s) + 1;
      clearFiles(tier === 'off' ? [...SENDABLE_FILES, 'pending.jsonl'] : SENDABLE_FILES);
    }
    return n;
  }, true)!;
  tierCache = null;
  if (tier !== 'off') {
    releaseHeld();
    recordEvent({ event_type: 'consent', answer: tier });
  }
  return next;
}

const oneOf = (key: string, v: unknown) => (typeof v === 'string' && ENUMS[key].includes(v) ? v : undefined);
const matching = (re: RegExp) => (v: unknown) => (typeof v === 'string' && re.test(v) ? v : undefined);
const intIn = (lo: number, hi: number) => (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
function countMap(keyOk: (k: string) => boolean) {
  return (v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const out: CountMap = {};
    for (const [k, c] of Object.entries(v as Row)) {
      if (keyOk(k) && typeof c === 'number' && Number.isInteger(c) && c > 0) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  };
}
const FIELDS: Record<string, (v: unknown) => unknown> = {
  event_type: v => oneOf('event_type', v),
  gbrain_version: matching(VERSION_RE),
  os: v => oneOf('os', v) ?? 'other',
  arch: v => oneOf('arch', v) ?? 'other',
  bun_version: matching(/^[0-9]{1,3}\.[0-9]{1,3}$/),
  install_method: v => oneOf('install_method', v),
  deployment: v => oneOf('deployment', v),
  git_backed: v => (typeof v === 'boolean' ? v : undefined),
  source: v => oneOf('source', v),
  harness: v => oneOf('harness', v),
  step: v => oneOf('step', v),
  outcome: v => oneOf('outcome', v),
  error_code: matching(IDENT_RE),
  embedding: v => oneOf('embedding', v),
  duration_s: intIn(0, 86_400),
  from_version: matching(VERSION_RE),
  to_version: matching(VERSION_RE),
  channel: v => oneOf('channel', v),
  score_band: v => oneOf('score_band', v),
  failing_checks: v => {
    const ids = Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string' && IDENT_RE.test(c)).slice(0, 10) : [];
    return ids.length ? ids : undefined;
  },
  mode: v => oneOf('mode', v),
  brain_size_band: v => oneOf('brain_size_band', v),
  rollup_day: matching(DAY_RE),
  transport: v => oneOf('transport', v),
  command_counts: countMap(k => IDENT_RE.test(k)),
  operation_counts: countMap(k => IDENT_RE.test(k)),
  error_code_counts: countMap(k => IDENT_RE.test(k)),
  crash_counts: countMap(k => ENUMS.crash_class.includes(k)),
  answer: v => oneOf('answer', v),
};

/** Keeps only allowlisted fields with allowed values; null when the event has no type or version. */
export function sanitize(e: Row): Row | null {
  const out: Row = {};
  for (const [k, v] of Object.entries(e)) {
    const check = FIELDS[k];
    if (!check || v === undefined || v === null) continue;
    const kept = check(v);
    if (kept !== undefined) out[k] = kept;
  }
  return out.event_type && out.gbrain_version ? out : null;
}

export function deploymentOf(cfg: GBrainConfig | null, transport: Transport = 'none'): string {
  if (transport === 'http') return 'self_hosted_http';
  if (isThinClient(cfg)) {
    let host = '';
    try { host = new URL(cfg?.remote_mcp?.mcp_url ?? '').hostname; } catch { /* unknown */ }
    return /(^|\.)gbrain\.io$/.test(host) ? 'thin_client_hosted' : 'thin_client_self_hosted';
  }
  if (cfg?.engine === 'pglite') return 'local_pglite';
  if (cfg?.engine === 'postgres') return 'local_postgres';
  return 'unknown';
}

function installMethod(): string {
  const exec = process.execPath ?? '';
  if (!/[/\\](bun|node)(\.exe)?$/.test(exec)) return 'release_binary';
  const entry = (process.argv[1] ?? '').replace(/\\/g, '/');
  if (entry.includes('/install/global/node_modules/')) return 'bun_global';
  if (entry.includes('/node_modules/')) return 'npm';
  if (existsSync(join(import.meta.dir, '..', '..', '..', '.git'))) return 'git_clone';
  return 'unknown';
}

function trafficSource(): string {
  const label = oneOf('source', process.env.GBRAIN_TELEMETRY_SOURCE?.trim());
  if (label) return label;
  if (process.env.NODE_ENV === 'test') return 'test';
  if (process.env.CI) return 'ci';
  return 'live';
}

function environmentFields(transport: Transport = 'none'): Row {
  const bun = /^([0-9]+)\.([0-9]+)/.exec(typeof Bun !== 'undefined' ? Bun.version : '');
  return {
    gbrain_version: VERSION,
    os: process.platform,
    arch: process.arch,
    bun_version: bun ? `${bun[1]}.${bun[2]}` : undefined,
    install_method: installMethod(),
    deployment: deploymentOf(loadConfigFileOnly(), transport),
    source: trafficSource(),
  };
}

const hourStamp = (now: number) => new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString();
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

function readQueue(): Row[] {
  let text = '';
  try { text = readFileSync(file('events.jsonl'), 'utf8'); } catch { return []; } // silent-read-ok: no queue file is an empty queue, and an unreadable one sends nothing
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Row]; } catch { return []; }
  });
}
const freshAt = (now: number) => (e: Row) => typeof e.ts === 'string' && now - Date.parse(e.ts) < EVENT_TTL_MS;
const writeQueue = (rows: Row[]) => writeAtomic(file('events.jsonl'), rows.map(r => `${JSON.stringify(r)}\n`).join(''));

/** Queue one event. Never throws; does nothing at tier off. */
export function recordEvent(fields: Row): void {
  try {
    const settings = readSettings();
    if (forcedOff() || settings.tier === 'off') {
      if (HELD_TYPES.has(String(fields.event_type)) && awaitingAnswer()) holdForAnswer(fields);
      return;
    }
    const clean = sanitize({ ...environmentFields(), ...fields });
    if (!clean) return;
    const now = Date.now();
    withQueueLock(() => {
      if (!stillConsented(epochOf(settings))) return;
      const kept = readQueue().filter(freshAt(now)).slice(-(MAX_QUEUED_EVENTS - 1));
      writeQueue([...kept, { qid: randomUUID(), ts: hourStamp(now), ...clean }]);
    });
  } catch { /* silent-read-ok: telemetry never breaks a command, and a failed read sends nothing */ }
}

/**
 * Before the person answers, setup and upgrade events wait in pending.jsonl
 * (at most 50, 7 days). A yes moves them into the queue; off deletes them.
 * Nothing in that file is sent unless the person says yes, and nothing is
 * held when no gbrain home exists yet (a refused setup creates no directory).
 */
const HELD_TYPES = new Set(['setup', 'upgrade']);
const MAX_HELD_EVENTS = 50;
const HELD_TTL_MS = 7 * DAY_MS;

export function awaitingAnswer(): boolean {
  return !forcedOff() && !readSettings().answered_at;
}

function readHeld(now: number): Row[] {
  let text = '';
  try { text = readFileSync(file('pending.jsonl'), 'utf8'); } catch { return []; } // silent-read-ok: no held file holds nothing, and an unreadable one releases nothing
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Row]; } catch { return []; }
  }).filter(e => typeof e.ts === 'string' && now - Date.parse(e.ts) < HELD_TTL_MS);
}

function holdForAnswer(fields: Row): void {
  if (!existsSync(configDir())) return;
  const clean = sanitize({ ...environmentFields(), ...fields });
  if (!clean) return;
  const now = Date.now();
  withQueueLock(() => {
    if (readSettings().answered_at) return;
    const kept = readHeld(now).slice(-(MAX_HELD_EVENTS - 1));
    writeAtomic(file('pending.jsonl'), [...kept, { qid: randomUUID(), ts: hourStamp(now), ...clean }].map(r => `${JSON.stringify(r)}\n`).join(''));
  });
}

function releaseHeld(): void {
  const now = Date.now();
  withQueueLock(() => {
    const held = readHeld(now);
    if (held.length) writeQueue([...readQueue().filter(freshAt(now)), ...held].slice(-MAX_QUEUED_EVENTS));
    rmSync(file('pending.jsonl'), { force: true });
  });
}

export function heldEvents(now = Date.now()): Row[] {
  return readSettings().answered_at ? [] : readHeld(now);
}

let pending: DayCounts = {};
let pendingEpoch = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function bump(transport: Transport, map: (typeof COUNT_KEYS)[number], key: string): void {
  try {
    if (!IDENT_RE.test(key) && map !== 'crash_counts') return;
    const consent = cachedTier();
    if (consent.tier === 'off') return;
    if (consent.epoch !== pendingEpoch) {
      pending = {};
      pendingEpoch = consent.epoch;
    }
    const bucket = (pending[`${transport}|${VERSION}|${trafficSource()}`] ??= {});
    const counts = (bucket[map] ??= {});
    counts[key] = (counts[key] ?? 0) + 1;
    if (!flushTimer) {
      flushTimer = setTimeout(flushCounts, 60_000);
      flushTimer.unref?.();
    }
  } catch { /* silent-read-ok: telemetry never breaks a command, and a failed read sends nothing */ }
}
/** Callers pass only names from gbrain's command table. */
export const countCommand = (name: string) => bump('none', 'command_counts', name);
/** Callers pass only names from gbrain's operation table. */
export const countOperation = (name: string, transport: Transport) => bump(transport, 'operation_counts', name);
/** Callers pass only codes from the error registry. */
export const countErrorCode = (code: string) => bump('none', 'error_code_counts', code);
export const countCrash = (className: unknown) => bump('none', 'crash_counts', oneOf('crash_class', className) ?? 'other');

/** Writes the in-memory counts to today's counts file. */
export function flushCounts(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const batch = pending;
  const epoch = pendingEpoch;
  pending = {};
  if (!Object.keys(batch).length) return;
  try {
    const path = join(file('counts'), `${dayOf(Date.now())}.json`);
    withQueueLock(() => {
      if (!stillConsented(epoch)) return;
      const stored = readJsonAt<DayCounts>(path, {});
      for (const [bucketKey, add] of Object.entries(batch)) {
        const into = (stored[bucketKey] ??= {});
        for (const key of COUNT_KEYS) {
          for (const [name, n] of Object.entries(add[key] ?? {})) {
            const counts = (into[key] ??= {});
            counts[name] = (counts[name] ?? 0) + n;
          }
        }
      }
      writeAtomic(path, JSON.stringify(stored));
    });
  } catch { /* silent-read-ok: telemetry never breaks a command, and a failed read sends nothing */ }
}

function countDays(): string[] {
  try {
    return readdirSync(file('counts')).map(f => f.replace(/\.json$/, '')).filter(d => DAY_RE.test(d)).sort();
  } catch { // silent-read-ok: no counts folder holds no finished days
    return [];
  }
}

export interface Batch { events: Row[]; qids: string[]; buckets: Array<[string, string]>; bytes: number }

/** The exact JSON array the next send would post: queued events first, then finished days' rollups. */
export function buildBatch(settings: Settings = readSettings(), now = Date.now()): Batch {
  const today = dayOf(now);
  const oldest = dayOf(now - EVENT_TTL_MS);
  const id = settings.tier === 'community' && settings.installation_id && UUID_RE.test(settings.installation_id) ? settings.installation_id : undefined;
  const stamp = (ts: unknown, row: Row): Row => ({ v: 1, ts, ...row, tier: settings.tier, ...(id ? { installation_id: id } : {}) });
  const candidates: Array<{ row: Row; qid?: string; bucket?: [string, string] }> = [];
  for (const e of readQueue().filter(freshAt(now))) {
    const clean = sanitize(e);
    if (clean) candidates.push({ row: stamp(e.ts, clean), qid: String(e.qid) });
  }
  for (const day of countDays().filter(d => d < today && d > oldest)) {
    const stored = readJsonAt<DayCounts>(join(file('counts'), `${day}.json`), {});
    for (const [bucketKey, counts] of Object.entries(stored)) {
      const [transport, version, source] = bucketKey.split('|') as [Transport, string, string];
      if (!TRANSPORTS.includes(transport) || !version || !source) continue;
      const clean = sanitize({ ...environmentFields(transport), gbrain_version: version, source, ...counts, event_type: 'daily_rollup', rollup_day: day, transport });
      if (!clean || clean.gbrain_version !== version || clean.source !== source || !COUNT_KEYS.some(k => clean[k])) continue;
      candidates.push({ row: stamp(`${day}T12:00:00.000Z`, clean), bucket: [day, bucketKey] });
    }
  }
  const batch: Batch = { events: [], qids: [], buckets: [], bytes: 2 };
  for (const c of candidates) {
    const size = Buffer.byteLength(JSON.stringify(c.row)) + 1;
    if (batch.events.length >= MAX_BATCH_EVENTS || batch.bytes + size > MAX_BATCH_BYTES) break;
    batch.events.push(c.row);
    batch.bytes += size;
    if (c.qid) batch.qids.push(c.qid);
    if (c.bucket) batch.buckets.push(c.bucket);
  }
  return batch;
}

/** Under queue.lock: what a send settled leaves the queue, unless a consent change or forget came during the send. */
function removeSent(batch: Batch, now: number, epoch: number, sentWith?: number): void {
  withQueueLock(() => {
    if (!stillConsented(epoch)) return;
    if (sentWith) recordSent(batch.events, sentWith, now);
    const sent = new Set(batch.qids);
    writeQueue(readQueue().filter(e => !sent.has(String(e.qid)) && freshAt(now)(e)));
    const oldest = dayOf(now - EVENT_TTL_MS);
    for (const day of countDays()) {
      const path = join(file('counts'), `${day}.json`);
      if (day <= oldest) { rmSync(path, { force: true }); continue; }
      const gone = batch.buckets.filter(([d]) => d === day).map(([, t]) => t);
      if (!gone.length) continue;
      const stored = readJsonAt<DayCounts>(path, {});
      for (const t of gone) delete stored[t];
      if (Object.keys(stored).length) writeAtomic(path, JSON.stringify(stored));
      else rmSync(path, { force: true });
    }
  });
}

function recordSent(events: Row[], http: number, now: number): void {
  let lines: string[] = [];
  try { lines = readFileSync(file('sent.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { /* silent-read-ok: the first send has no record yet */ }
  lines.push(JSON.stringify({ sent_at: new Date(now).toISOString(), http, events }));
  writeAtomic(file('sent.jsonl'), `${lines.slice(-MAX_SENT_RECORDS).join('\n')}\n`);
}

export function sentRecords(): Row[] {
  try {
    return readFileSync(file('sent.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Row);
  } catch { // silent-read-ok: no record file means nothing was sent
    return [];
  }
}

export function syncDue(now = Date.now()): boolean {
  const last = readJson<State>('state.json', {}).last_attempt_at;
  return !last || !(now - Date.parse(last) < SYNC_INTERVAL_MS);
}

/** True when a background send would have something to do: tier on, an endpoint, the 6-hour window open and a non-empty queue. */
export function shouldSpawnSync(now = Date.now()): boolean {
  try {
    if (currentTier() === 'off' || !telemetryEndpoint() || !syncDue(now)) return false;
    const today = dayOf(now);
    return (existsSync(file('events.jsonl')) && statSync(file('events.jsonl')).size > 0) || countDays().some(d => d < today);
  } catch { // silent-read-ok: a failed check starts no send
    return false;
  }
}

export type SyncStatus = 'off' | 'blocked' | 'busy' | 'too_soon' | 'empty' | 'sent' | 'kept' | 'dropped';
export interface SyncOutcome { status: SyncStatus; http?: number; events?: number }

/**
 * One send. A 2xx clears what was sent; a 429, a 5xx or no connection keeps it
 * for the next window; any other 4xx keeps it twice and drops it the third time.
 */
export async function syncTelemetry(opts: { force?: boolean; now?: number } = {}): Promise<SyncOutcome> {
  if (currentTier() === 'off') return { status: 'off' };
  const endpoint = telemetryEndpoint();
  if (!endpoint) return { status: 'blocked' };
  flushCounts();
  const lock = acquire('sync.lock', 1);
  if (!lock) return { status: 'busy' };
  try {
    const now = opts.now ?? Date.now();
    if (!opts.force && !syncDue(now)) return { status: 'too_soon' };
    let settings = readSettings();
    if (forcedOff() || settings.tier === 'off') return { status: 'off' };
    if (settings.tier === 'community' && !settings.installation_id) {
      settings = updateSettings(s => (s.tier === 'community' && !s.installation_id ? { ...s, installation_id: randomUUID() } : null), true) ?? readSettings();
      if (settings.tier === 'off') return { status: 'off' };
    }
    const epoch = epochOf(settings);
    const batch = buildBatch(settings, now);
    if (!batch.events.length) {
      removeSent(batch, now, epoch);
      return { status: 'empty' };
    }
    const state = readJson<State>('state.json', {});
    writeJson('state.json', { ...state, last_attempt_at: new Date(now).toISOString() });
    let http = 0;
    try {
      const res = await fetch(`${endpoint.url}/functions/v1/gbrain-telemetry-ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: endpoint.key },
        body: JSON.stringify(batch.events),
        signal: AbortSignal.timeout(10_000),
      });
      http = res.status;
      await res.arrayBuffer().catch(() => undefined);
    } catch { /* silent-read-ok: offline or timed out keeps the batch for the next window */ }
    const base = { ...readJson<State>('state.json', {}), last_attempt_at: new Date(now).toISOString(), last_status: http || ('offline' as const) };
    if (http >= 200 && http < 300) {
      removeSent(batch, now, epoch, http);
      writeJson('state.json', { ...base, last_sent_at: new Date(now).toISOString(), client_errors: 0 });
      return { status: 'sent', http, events: batch.events.length };
    }
    if (http >= 400 && http < 500 && http !== 429) {
      const errors = (base.client_errors ?? 0) + 1;
      if (errors >= DROP_AFTER_CLIENT_ERRORS) {
        removeSent(batch, now, epoch);
        writeJson('state.json', { ...base, client_errors: 0 });
        return { status: 'dropped', http, events: batch.events.length };
      }
      writeJson('state.json', { ...base, client_errors: errors });
      return { status: 'kept', http, events: batch.events.length };
    }
    writeJson('state.json', base);
    return { status: 'kept', ...(http ? { http } : {}), events: batch.events.length };
  } finally {
    release(lock);
  }
}

export type ForgetStatus = 'no_id' | 'blocked' | 'busy' | 'forgotten' | 'failed';

/**
 * Asks the server to delete this install's row and blank its id on stored
 * events, then deletes the local id, the local queue and the record of past
 * sends (it names the old id), so nothing recorded
 * under the old id goes out under a new one. Works at any tier and ignores the
 * send window; refuses while a send holds sync.lock, so no in-flight post can
 * land after the server forgot the id. The tier is unchanged.
 */
export async function forgetInstallation(): Promise<{ status: ForgetStatus; http?: number; events_cleared?: number }> {
  const settings = readSettings();
  if (!settings.installation_id) return { status: 'no_id' };
  const endpoint = telemetryEndpoint();
  if (!endpoint) return { status: 'blocked' };
  const lock = acquire('sync.lock', 1);
  if (!lock) return { status: 'busy' };
  try {
    let res: Response;
    try {
      res = await fetch(`${endpoint.url}/functions/v1/gbrain-telemetry-ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: endpoint.key },
        body: JSON.stringify({ forget: settings.installation_id }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return { status: 'failed' };
    }
    const body = (await res.json().catch(() => ({}))) as Row;
    if (!res.ok || body.forgotten !== true) return { status: 'failed', http: res.status };
    updateSettings(({ installation_id: _gone, ...rest }) => {
      clearFiles(SENDABLE_FILES);
      return { ...rest, epoch: epochOf(rest as Settings) + 1 };
    }, true);
    tierCache = null;
    return { status: 'forgotten', http: res.status, events_cleared: typeof body.events_cleared === 'number' ? body.events_cleared : 0 };
  } finally {
    release(lock);
  }
}

export type PulseResult = { ok: true; stale: boolean; data: Row } | { ok: false; reason: 'blocked' | 'offline' | 'unavailable'; http?: number };

/** The public aggregate. Any answer that is not a fresh "ok" is reported as such, never as zeros. */
export async function fetchPulse(): Promise<PulseResult> {
  const endpoint = telemetryEndpoint();
  if (!endpoint) return { ok: false, reason: 'blocked' };
  let res: Response;
  try {
    res = await fetch(`${endpoint.url}/functions/v1/gbrain-telemetry-pulse`, { headers: { apikey: endpoint.key }, signal: AbortSignal.timeout(10_000) });
  } catch {
    return { ok: false, reason: 'offline' };
  }
  const data = (await res.json().catch(() => null)) as Row | null;
  if (!res.ok || !data || data.status !== 'ok') return { ok: false, reason: 'unavailable', http: res.status };
  return { ok: true, stale: data.stale === true, data };
}

/**
 * The first run of a newer version at tier on records one upgrade event. An
 * older build running after a newer one (the old `gbrain upgrade` process
 * finishing after its post-upgrade child, or two installs sharing one
 * GBRAIN_HOME) records nothing and never moves last_run_version back.
 */
export function noteRunVersion(channel?: string): void {
  try {
    if (currentTier() === 'off') return;
    const settled = (s: Settings) => s.last_run_version === VERSION || (!!s.last_run_version && isNewerVersion(VERSION, s.last_run_version));
    if (settled(readSettings())) return;
    let from: string | undefined;
    updateSettings((s) => {
      if (s.tier === 'off' || settled(s)) return null;
      from = s.last_run_version;
      return { ...s, last_run_version: VERSION };
    }, false);
    if (from && VERSION_RE.test(from)) {
      recordEvent({ event_type: 'upgrade', from_version: from, to_version: VERSION, outcome: 'success', channel: oneOf('channel', channel) ?? 'unknown' });
    }
  } catch { /* silent-read-ok: telemetry never breaks a command, and a failed read sends nothing */ }
}

export function scoreBand(score: number): string {
  if (score < 30) return '0-29';
  if (score < 50) return '30-49';
  if (score < 70) return '50-69';
  if (score < 90) return '70-89';
  return '90-100';
}
export function sizeBand(pages: number | null): string | undefined {
  if (pages === null || !Number.isFinite(pages) || pages < 0) return undefined;
  if (pages === 0) return '0';
  if (pages < 100) return '1-99';
  if (pages < 1000) return '100-999';
  if (pages < 10_000) return '1k-9.9k';
  return '10k+';
}

/** At most one doctor event per day: the score band, up to 10 failing check ids and the brain size band. */
export function recordDoctor(input: { score: number; failing: readonly string[]; pages: number | null; mode?: 'manual' | 'autopilot' | 'alert' }): void {
  try {
    if (currentTier() === 'off') return;
    const today = dayOf(Date.now());
    if (readJson<{ day?: string }>('doctor.json', {}).day === today) return;
    writeJson('doctor.json', { day: today });
    recordEvent({ event_type: 'doctor', score_band: scoreBand(input.score), failing_checks: [...input.failing], brain_size_band: sizeBand(input.pages), mode: input.mode ?? 'manual' });
  } catch { /* silent-read-ok: telemetry never breaks a command, and a failed read sends nothing */ }
}

export function harnessOf(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return oneOf('harness', name.replace(/-/g, '_')) ?? 'other';
}

export interface TelemetryStatus {
  tier: Tier;
  forced_off_by_env: boolean;
  answered: boolean;
  installation_id: string | null;
  queued_events: number;
  held_events: number;
  count_days: number;
  last_attempt_at: string | null;
  last_sent_at: string | null;
  last_status: number | 'offline' | null;
  endpoint: string | null;
  dir: string;
}

export function telemetryStatus(now = Date.now()): TelemetryStatus {
  const settings = readSettings();
  const state = readJson<State>('state.json', {});
  const endpoint = telemetryEndpoint();
  let host: string | null = null;
  try { host = endpoint ? new URL(endpoint.url).host : null; } catch { host = null; }
  return {
    tier: currentTier(),
    forced_off_by_env: forcedOff(),
    answered: !!settings.answered_at,
    installation_id: settings.installation_id ?? null,
    queued_events: readQueue().filter(freshAt(now)).length,
    held_events: heldEvents(now).length,
    count_days: countDays().length,
    last_attempt_at: state.last_attempt_at ?? null,
    last_sent_at: state.last_sent_at ?? null,
    last_status: state.last_status ?? null,
    endpoint: host,
    dir: telemetryDir(),
  };
}
