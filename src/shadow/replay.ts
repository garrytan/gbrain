/**
 * Shadow replay (docs/guides/shadow-replay.md): replays a sealed capture epoch on PGLite and Rust copies seeded from
 * one snapshot of the brain when the epoch began, and compares the arms with each other, never with the live brain.
 *
 * The parent (`gbrain engine shadow replay`) holds a lock, checks the purge log, seals the current epoch, starts the
 * next one, replays the sealed one in a child, deletes the sealed epoch's recording and copies, and seeds the new
 * epoch's copies. The child (`__replay-child <run dir>`) gets an allowlisted environment with a throwaway home and no
 * provider keys, blocks every network connection except Unix sockets in its run
 * directory, opens only the run's work copies, replays committed transaction groups and single calls in order, runs a
 * read-back sweep over every page a replayed write named, and writes a content-free report: operation, field path
 * (keys outside a fixed schema list are hashed) and keyed hashes. Run metadata (times, durations) stays out of the
 * compared report, so two replays of the same epoch on the same copies write identical reports.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, cpSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { join, resolve, sep } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { withCallerAccess } from '../core/search/private-visibility.ts';
import { canonicalJson, decodeValue, encodeValue, escapedObject } from './codec.ts';
import type { CaptureRecord } from './capture.ts';
import { ReplayError } from './replay-errors.ts';
import { SHADOW_READ_MEMBERS } from './reads.ts';
import { RUST_ENGINE_MEMBERS } from '../core/rust-engine/members.ts';

export const REPLAY_REPORT_VERSION = 1;
export const REPLAY_CALL_TIMEOUT_MS = 60_000;
/** Pages the read-back sweep reads; past it the report says `incomplete` (counts.sweep_skipped). */
export const SWEEP_LIMIT = 5_000;
export type ArmName = 'pglite' | 'rust';
export const ARM_ORDER: readonly ArmName[] = ['pglite', 'rust'];

/** The run file the parent writes for the child. */
export interface RunSpec {
  version: 1;
  epoch: string;
  brain_key: string;
  /** Hex key for the keyed hashes (from capture/key, 0600). */
  hmac_key: string;
  arms: { pglite: string; rust: string };
  rust_dir?: string;
  cut: { before: number; after: number | null };
  seed_losses_present: boolean;
  segments: string;
  /** Recording processes still alive when the epoch was sealed: their last buffered calls may be missing. */
  tail_unverified?: number;
  /** Ids (UUIDs) the seed copied into every arm: stored values, compared literally, never normalized. */
  seeded_ids?: string;
}

export type Outcome = { ok: true; value: unknown } | { ok: false; code: string };

export type DiffClass = 'match' | 'capability_missing' | 'differs' | 'differs_seed_loss'
  /** Every arm failed the same way on a call that succeeded on the live brain (a replay that is not faithful, e.g. a
   * conditional write whose expected revision was generated after the snapshot). Never counted as a match. */
  | 'replay_diverged';

export interface ReportDiff { ref: string; member: string; path: string[]; class: DiffClass; hashes: Partial<Record<ArmName, string>> }

export interface ReplayReport {
  schema_version: 1;
  epoch: string;
  arms: ArmName[];
  seed_losses_present: boolean;
  coverage: 'complete' | 'incomplete';
  counts: Record<string, number>;
  by_class: Partial<Record<DiffClass, number>>;
  diffs: ReportDiff[];
}

// ---- comparison -------------------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?$/;

/** The value as a JSON caller sees it (Date -> ISO text, bigint -> text, typed array -> array), as the CLI and MCP print. */
export function jsonView(enc: unknown): unknown {
  if (enc === null || typeof enc !== 'object') return enc;
  if (Array.isArray(enc)) return enc.map(jsonView);
  const r = enc as Record<string, unknown>;
  const plain = escapedObject(r);
  if (plain) { const out: Record<string, unknown> = {}; for (const k of Object.keys(plain)) out[k] = jsonView(plain[k]); return out; }
  if (typeof r.$date === 'string') return r.$date;
  if (typeof r.$bigint === 'string') return r.$bigint;
  if (typeof r.$number === 'string') return null;
  if (typeof r.$typed === 'string' && Array.isArray(r.v)) return r.v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(r)) out[k] = jsonView(r[k]);
  return out;
}

/**
 * Referential normalization state for one pair of arms. A UUID or timestamp is volatile only when it is not in the
 * recorded inputs and (for timestamps) falls inside the replay window; volatile values must map one to one, in order
 * of first appearance, across the whole run. A wrong stored id or a wrong date outside the window still differs.
 */
export class NormState {
  private a = new Map<string, number>();
  private b = new Map<string, number>();
  private n = 0;
  constructor(readonly known: ReadonlySet<string>, readonly window: { from: number; to: number }) {}

  volatile(s: string): boolean {
    if (this.known.has(s) || this.known.has(s.toLowerCase())) return false;
    if (UUID_RE.test(s)) return true;
    if (!ISO_RE.test(s)) return false;
    const t = Date.parse(s);
    // A time the seed copied or a call passed in (any spelling of the same instant) is a stored value, never noise.
    return Number.isFinite(t) && !this.known.has(timeKey(t)) && t >= this.window.from && t <= this.window.to;
  }

  same(x: string, y: string): boolean {
    if (!this.volatile(x) || !this.volatile(y) || UUID_RE.test(x) !== UUID_RE.test(y)) return x === y;
    // Ids pair one to one, equal ones included: after A=A, A=B is a difference. Equal times just match: two writes in
    // one millisecond share a time on one arm and not on the other, so times pair one to one only when they differ.
    if (x === y && !UUID_RE.test(x)) return true;
    const ix = this.a.get(x);
    const iy = this.b.get(y);
    if (ix === undefined && iy === undefined) { this.n++; this.a.set(x, this.n); this.b.set(y, this.n); return true; }
    return ix !== undefined && ix === iy;
  }
}

/** The first path where `b` differs from `a`, or null when equal under `norm`. */
/** A diff path: numbers are array positions, strings are object keys (so a key spelled like `[0]` is still a key). */
export type DiffPath = Array<string | number>;

export function firstDiff(a: unknown, b: unknown, norm: NormState, path: DiffPath = []): DiffPath | null {
  if (typeof a === 'string' && typeof b === 'string') return norm.same(a, b) ? null : path;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b) ? null : path;
  if (Array.isArray(a) !== Array.isArray(b)) return path;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    for (let i = 0; i < Math.max(a.length, bb.length); i++) {
      if (i >= a.length || i >= bb.length) return [...path, i];
      const d = firstDiff(a[i], bb[i], norm, [...path, i]);
      if (d) return d;
    }
    return null;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort()) {
    if (!(k in ra) || !(k in rb)) return [...path, k];
    const d = firstDiff(ra[k], rb[k], norm, [...path, k]);
    if (d) return d;
  }
  return null;
}

const CAPABILITY_CODES = new Set(['engine_capability_missing', 'raw_sql_missing']);

function outcomeDiff(a: Outcome, b: Outcome, norm: NormState): DiffPath | null {
  if (!a.ok || !b.ok) return !a.ok && !b.ok && a.code === b.code ? null : ['$outcome'];
  return firstDiff(a.value, b.value, norm);
}

/** Classifies one replayed call: PGLite is the reference (two arms show that they differ, not which is wrong). */
export function classify(out: Partial<Record<ArmName, Outcome>>, norms: { rust: NormState }, seedLoss: boolean):
  { cls: DiffClass; path: DiffPath } {
  const p = out.pglite!;
  const r = out.rust!;
  const pr = outcomeDiff(p, r, norms.rust);
  if (!pr) return { cls: 'match', path: [] };
  if (!r.ok && CAPABILITY_CODES.has(r.code)) return { cls: 'capability_missing', path: pr };
  return { cls: seedLoss ? 'differs_seed_loss' : 'differs', path: pr };
}

// ---- units ------------------------------------------------------------------------------------------------------

export type Unit =
  | { kind: 'call'; rec: CaptureRecord; t0: number; t1: number; order: string }
  | { kind: 'tx'; member: string; children: Unit[]; t0: number; t1: number; order: string };

export interface UnitPlan { units: Unit[]; counts: Record<string, number> }

/** Groups records into replay units: single calls and committed transaction groups, in end-time order. */
export function buildUnits(records: CaptureRecord[], cut: RunSpec['cut']): UnitPlan {
  const counts: Record<string, number> = { records: records.length, gaps: 0, after_gap: 0, rolled_back: 0, orphaned: 0, pre_cut: 0, boundary: 0, replayed: 0 };
  const byProc = new Map<string, CaptureRecord[]>();
  for (const r of records) { const l = byProc.get(r.proc) ?? []; l.push(r); byProc.set(r.proc, l); }
  const top: Unit[] = [];
  for (const [proc, recs] of byProc) {
    recs.sort((x, y) => x.seq - y.seq);
    const open = new Map<string, Extract<Unit, { kind: 'tx' }>>();
    let gapSeen = false;
    for (const r of recs) {
      const order = `${String(r.t1).padStart(15, '0')}:${proc}:${String(r.seq).padStart(10, '0')}`;
      if (r.kind === 'gap') { counts.gaps += r.count ?? 1; gapSeen = true; continue; }
      if (gapSeen) counts.after_gap++;
      if (r.kind === 'tx' && r.phase === 'begin') { open.set(r.tx!, { kind: 'tx', member: r.member ?? 'transaction', children: [], t0: r.t0, t1: r.t1, order }); continue; }
      if (r.kind === 'tx') {
        const g = open.get(r.tx!);
        open.delete(r.tx!);
        if (!g) { counts.orphaned++; continue; }
        if (r.phase !== 'committed') { counts.rolled_back++; continue; }
        g.t1 = r.t1; g.order = order;
        if (r.parent_tx) { const parent = open.get(r.parent_tx); if (parent) parent.children.push(g); else counts.orphaned++; }
        else top.push(g);
        continue;
      }
      const unit: Unit = { kind: 'call', rec: r, t0: r.t0, t1: r.t1, order };
      if (r.tx) { const g = open.get(r.tx); if (g) g.children.push(unit); else counts.orphaned++; }
      else top.push(unit);
    }
    counts.orphaned += open.size;
  }
  top.sort((x, y) => (x.order < y.order ? -1 : x.order > y.order ? 1 : 0));
  const units: Unit[] = [];
  for (const u of top) {
    if (u.t1 < cut.before) counts.pre_cut++;
    else if (cut.after === null || u.t0 <= cut.after) counts.boundary++;
    else { units.push(u); counts.replayed++; }
  }
  return { units, counts };
}

// ---- running on an arm ------------------------------------------------------------------------------------------

function errCode(e: unknown): string {
  const c = (e as { code?: unknown })?.code;
  return typeof c === 'string' ? c : 'error';
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'replay_timeout' })), ms); })]);
  } finally { clearTimeout(timer); }
}

async function callOn(engine: BrainEngine, rec: CaptureRecord): Promise<Outcome> {
  const fn = (engine as unknown as Record<string, unknown>)[rec.member!];
  if (typeof fn !== 'function') return { ok: false, code: 'member_missing' };
  const args = decodeValue(rec.args) as unknown[];
  const run = () => Promise.resolve((fn as Function).apply(engine, args));
  try {
    const value = await withTimeout(rec.access ? withCallerAccess(decodeValue(rec.access) as object, run) : run(), REPLAY_CALL_TIMEOUT_MS);
    return { ok: true, value: jsonView(encodeValue(value)) };
  } catch (e) {
    return { ok: false, code: errCode(e) };
  }
}

/** Runs a unit on one arm and returns the outcome of every call in it, in order. */
export async function runUnit(engine: BrainEngine, unit: Unit): Promise<Array<{ member: string; out: Outcome; liveOk?: boolean }>> {
  if (unit.kind === 'call') return [{ member: unit.rec.member!, out: await callOn(engine, unit.rec), liveOk: unit.rec.ok }];
  const outs: Array<{ member: string; out: Outcome; liveOk?: boolean }> = [];
  const body = async (tx: BrainEngine) => {
    for (const child of unit.children) outs.push(...await runUnit(tx, child));
  };
  try {
    await (engine as unknown as Record<string, Function>)[unit.member === 'transactionDirect' ? 'transactionDirect' : 'transaction']!.call(engine, body);
  } catch (e) {
    outs.push({ member: unit.member, out: { ok: false, code: errCode(e) } });
  }
  return outs;
}

// ---- report -----------------------------------------------------------------------------------------------------

/** Field names a report may show as they are; any other key (a frontmatter key, say) is shown only as a keyed hash. */
const SCHEMA_KEYS = new Set(('$outcome slug source_id title type compiled_truth timeline frontmatter tags content_hash id page_id created_at updated_at '
  + 'deleted_at effective_date effective_date_source chunk_index chunk_text chunk_source embedding model token_count score from_slug to_slug link_type '
  + 'context link_source origin_slug origin_field date summary source detail fact entity_slug kind visibility confidence valid_from valid_until expired_at '
  + 'superseded_by consolidated_at row_num source_markdown_slug status count total page_count chunk_count link_count tag_count timeline_entry_count '
  + 'embedded_count pages_by_type revision version body_storage search_vector stale public_read context_text').split(' '));

export function redactPath(path: DiffPath, key: Buffer): string[] {
  return path.map(p => (typeof p === 'number' ? `[${p}]` : SCHEMA_KEYS.has(p) ? p : `#${keyedHash(key, p).slice(0, 8)}`));
}

export function keyedHash(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex').slice(0, 16);
}

/** Volatile ids and times inside longer text. */
const TOKEN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/gi;

/** The outcome as hashed in a report: ids and times the replay itself produced (see NormState) read as one placeholder. */
function outcomeText(o: Outcome | undefined, norm: NormState): string {
  const stable = (v: unknown): unknown => typeof v === 'string'
    ? (norm.volatile(v) ? '<volatile>' : v.replace(TOKEN_RE, t => (norm.volatile(t) ? '<volatile>' : t)))
    : Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stable(x)])) : v;
  return !o ? 'absent' : o.ok ? canonicalJson(stable(o.value)) : `threw:${o.code}`;
}

/** The sorted, deterministic report document. */
export function renderReport(spec: RunSpec, arms: ArmName[], counts: Record<string, number>, diffs: ReportDiff[], torn: number): ReplayReport {
  const by: Partial<Record<DiffClass, number>> = {};
  for (const d of diffs) by[d.class] = (by[d.class] ?? 0) + 1;
  by.match = counts.compared_calls! - diffs.length;
  return {
    schema_version: REPLAY_REPORT_VERSION, epoch: spec.epoch, arms, seed_losses_present: spec.seed_losses_present,
    coverage: counts.gaps || counts.orphaned || counts.sweep_skipped || counts.writes_not_swept || counts.recorders_alive_at_seal
      || counts.sweep_failed || counts.sweep_truncated || counts.records_over_memory || torn ? 'incomplete' : 'complete',
    counts: Object.fromEntries(Object.entries({ ...counts, torn_segments: torn }).sort()), by_class: by, diffs,
  };
}

export function reportMarkdown(r: ReplayReport): string {
  const lines = [`# Shadow replay report`, '', `Epoch ${r.epoch}. Arms: ${r.arms.join(', ')}. Coverage: ${r.coverage}.`,
    r.seed_losses_present ? 'The seed had losses on the Rust arm, so a Rust difference may be a copy difference.' : '', '', '| class | calls |', '|---|---|',
    ...Object.entries(r.by_class).sort().map(([k, v]) => `| ${k} | ${v} |`), '', '| count | value |', '|---|---|',
    ...Object.entries(r.counts).map(([k, v]) => `| ${k} | ${v} |`), ''];
  if (r.by_class.replay_diverged) lines.push('replay_diverged: every arm refused a call that succeeded on the live brain; the replay was not faithful there (often a conditional write whose expected revision was created after the snapshot), so those calls prove nothing either way.', '');
  if (r.arms.length === 2) lines.push('With two arms a difference shows that PGLite and Rust disagree, not which one is wrong.', '');
  lines.push('| member | field path | class | count |', '|---|---|---|---|');
  const groups = new Map<string, number>();
  for (const d of r.diffs) { const k = `${d.member}\t${d.path.join('.')}\t${d.class}`; groups.set(k, (groups.get(k) ?? 0) + 1); }
  for (const [k, n] of [...groups].sort()) { const [m, p, c] = k.split('\t'); lines.push(`| ${m} | ${p || '(whole result)'} | ${c} | ${n} |`); }
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') + '\n';
}

/** The summary that may leave the machine: operation, field path and keyed hash, grouped with counts. Nothing else. */
export function redactedSummary(r: ReplayReport): unknown {
  const groups = new Map<string, { member: string; path: string; class: DiffClass; hash: string; count: number }>();
  for (const d of r.diffs) {
    const hash = d.hashes.rust ?? '';
    const k = `${d.member}|${d.path.join('.')}|${d.class}|${hash}`;
    const g = groups.get(k);
    if (g) g.count++; else groups.set(k, { member: d.member, path: d.path.join('.'), class: d.class, hash, count: 1 });
  }
  return { schema_version: 1, coverage: r.coverage, arms: r.arms, by_class: r.by_class, differences: [...groups.values()].sort((a, b) => (a.member + a.path < b.member + b.path ? -1 : 1)) };
}

// ---- child ------------------------------------------------------------------------------------------------------

/** Blocks network connections: fetch, TLS and TCP always; Unix sockets except paths inside `allowDir`. */
export function blockNetwork(allowDir: string): void {
  const refuse = () => Object.assign(new Error('shadow_replay_network_blocked: the replay child opens no network connection'), { code: 'shadow_replay_network_blocked' });
  globalThis.fetch = (async () => { throw refuse(); }) as unknown as typeof fetch;
  const allowed = (args: unknown[]): boolean => {
    const a = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0]; // Bun's net.connect passes [options, callback]
    const opts = (a && typeof a === 'object' ? a : typeof a === 'string' && !/^\d+$/.test(a) ? { path: a } : { port: a, host: args[1] }) as { path?: string; host?: string };
    if (!opts.path) return false;
    const p = resolve(opts.path); const d = resolve(allowDir);
    return p === d || p.startsWith(d + sep); // inside the run folder, never a same-prefix sibling
  };
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    if (!allowed(args)) throw refuse();
    return (origConnect as Function).apply(this, args);
  } as typeof origConnect;
  (tls as { connect: unknown }).connect = () => { throw refuse(); };
  const bun = (globalThis as { Bun?: Record<string, unknown> }).Bun;
  if (bun) {
    const origBunConnect = bun.connect as ((o: { hostname?: string; unix?: string }) => unknown) | undefined;
    try {
      bun.connect = (o: { hostname?: string; unix?: string }) => {
        if (!allowed([o.unix ? { path: o.unix } : { host: o.hostname }])) throw refuse();
        return origBunConnect!(o);
      };
    } catch { /* read-only on this runtime: net and fetch stay blocked */ }
  }
}

function writeOwnerOnly(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The source a call's arguments name (`sourceId` in an options object, or a row's `source_id`), else undefined. */
function sourceOf(args: unknown[]): string | undefined {
  for (const a of args) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
    const r = a as { sourceId?: unknown; source_id?: unknown };
    if (typeof r.sourceId === 'string') return r.sourceId;
    if (typeof r.source_id === 'string') return r.source_id;
  }
  return undefined;
}

const SLUG_FIELDS = ['slug', 'from_slug', 'to_slug', 'page_slug'] as const;
/** Capabilities whose writes change a page the sweep reads back. */
const PAGE_CAPS = new Set(['pages', 'page_body', 'links', 'timeline', 'tags', 'chunks', 'page_versions']);

/** The (source, slug) pairs one row names: `slug`, `from_slug`, `to_slug`, `page_slug`, with the row's own source. */
function rowSlugs(row: Record<string, unknown>, fallbackSource: string | null): Array<[string | null, string]> {
  const src = typeof row.source_id === 'string' ? row.source_id : typeof row.sourceId === 'string' ? row.sourceId : fallbackSource;
  const out: Array<[string | null, string]> = [];
  for (const f of SLUG_FIELDS) {
    const v = row[f];
    if (typeof v !== 'string' || !/^[^\s]{1,300}$/.test(v)) continue;
    const s = f === 'from_slug' && typeof row.from_source_id === 'string' ? row.from_source_id : f === 'to_slug' && typeof row.to_source_id === 'string' ? row.to_source_id : src;
    out.push([s, v]);
  }
  return out;
}

/** Engine members whose page source is the plain second argument: `(slug, sourceId, ...)`. */
/** Writes no sweep read covers yet (page_aliases): counted as not read back, so the report says incomplete. */
const UNSWEPT_MEMBERS = new Set(['setPageAliases', 'replaceDerivedAliases']);
/** Writes to page version history: the sweep reads no version rows, so each one makes the report incomplete. */
const VERSION_WRITES = new Set(['createVersion', 'revertToVersion']);
/** Chunk seals: the sweep cannot read the seal stamp (`chunker_version`) the same way on both arms yet, so each one makes the report incomplete. */
const SEAL_WRITES = new Set(['sealChunks', 'setChunkerVersion']);
const POSITIONAL_SOURCE_MEMBERS = new Set(['refreshPageBody', 'replaceDerivedAliases', 'setPageAliases', 'updatePageContextualRetrievalState']);

/**
 * Collects the (source, slug) pairs a replayed write named, for the read-back sweep, as JSON keys: a slug argument, a
 * row with slug fields, or every row of a batch. Returns how many page-changing writes named no page it could find
 * (those writes are not read back, and the report says its coverage is incomplete).
 */
function writtenSlugs(units: Unit[], into: Set<string>): number {
  let unresolved = 0;
  for (const u of units) {
    if (u.kind === 'tx') { unresolved += writtenSlugs(u.children, into); continue; }
    const m = u.rec.member!;
    if (m in SHADOW_READ_MEMBERS || /^(get|list|search|find|count|read|resolve)/.test(m)) continue;
    const args = (decodeValue(u.rec.args) as unknown[]) ?? [];
    if (UNSWEPT_MEMBERS.has(m) || (POSITIONAL_SOURCE_MEMBERS.has(m) && typeof args[1] !== 'string')) { unresolved++; continue; } // not read back
    const source = (POSITIONAL_SOURCE_MEMBERS.has(m) ? args[1] as string : sourceOf(args)) ?? null;
    const first = args[0];
    const pairs: Array<[string | null, string]> = [];
    if (typeof first === 'string' && /^[^\s]{1,300}$/.test(first)) pairs.push([source, first]);
    if (m === 'updateSlug' && typeof args[1] === 'string') pairs.push([source, args[1]]); // a rename is read back at its new slug too
    for (const a of args) {
      if (Array.isArray(a)) { for (const row of a) if (row && typeof row === 'object') pairs.push(...rowSlugs(row as Record<string, unknown>, source)); }
      else if (a && typeof a === 'object') pairs.push(...rowSlugs(a as Record<string, unknown>, source));
    }
    for (const p of pairs) into.add(JSON.stringify(p));
    if (VERSION_WRITES.has(m) || SEAL_WRITES.has(m)) unresolved++; // its page is read back, its version rows or seal stamp are not
    if (!pairs.length && PAGE_CAPS.has((RUST_ENGINE_MEMBERS as Record<string, string>)[m] ?? '')) unresolved++;
  }
  return unresolved;
}

/** The known-set key of an instant, so every spelling of a stored time matches it. */
export const timeKey = (ms: number) => `t:${ms}`;

function collectKnown(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    if (UUID_RE.test(value)) into.add(value);
    else if (ISO_RE.test(value)) { into.add(value); const t = Date.parse(value); if (Number.isFinite(t)) into.add(timeKey(t)); }
    return;
  }
  if (value && typeof value === 'object') for (const v of Object.values(value)) collectKnown(v, into);
}

/** The most segment text one replay loads; records past it are counted and make the report incomplete. */
export const REPLAY_READ_BYTES = 512 * 1024 * 1024;
export const TIMELINE_SWEEP_LIMIT = 10_000;

/**
 * Reads one segment line by line in 1 MiB blocks (a segment may exceed the runtime's longest string), appending its
 * records to `into` while `budget` lasts; records past the budget are counted as skipped. A torn last line (no
 * newline: a crash mid-write) is skipped and reported.
 */
export function streamSegment(path: string, into: CaptureRecord[], budget: { left: number }): { torn: boolean; skipped: number } {
  const fd = openSync(path, 'r');
  const block = Buffer.alloc(1024 * 1024);
  let rest = Buffer.alloc(0);
  let skipped = 0;
  const take = (line: Buffer) => {
    if (!line.length) return;
    if (budget.left < line.length) { skipped++; return; }
    budget.left -= line.length;
    try { into.push(JSON.parse(line.toString('utf8')) as CaptureRecord); } catch { skipped++; } // silent-read-ok: an unreadable line is counted (the report says incomplete), never replayed
  };
  try {
    for (;;) {
      const n = readSync(fd, block, 0, block.length, null);
      if (n <= 0) break;
      let buf = Buffer.concat([rest, block.subarray(0, n)]);
      let at: number;
      while ((at = buf.indexOf(10)) >= 0) { take(buf.subarray(0, at)); buf = buf.subarray(at + 1); }
      rest = Buffer.from(buf);
    }
  } finally { closeSync(fd); }
  return { torn: rest.length > 0, skipped };
}

export interface ChildDeps {
  openArm(arm: ArmName, spec: RunSpec, runDir: string): Promise<BrainEngine>;
  /** Default blockNetwork; in-process tests pass a no-op so the test runner keeps its own network. */
  blockNetwork?: (allowDir: string) => void;
}

/** Replays the run's units on every arm and writes report.json, report.md and summary.json in `<runDir>/out`. */
export async function runReplayChild(runDir: string, deps: ChildDeps, now: () => number = Date.now): Promise<ReplayReport> {
  const spec = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as RunSpec;
  (deps.blockNetwork ?? blockNetwork)(runDir);
  const key = Buffer.from(checkedKey(spec.hmac_key, 'the run spec'), 'hex');
  const records: CaptureRecord[] = [];
  let torn = 0;
  let overMemory = 0;
  const budget = { left: REPLAY_READ_BYTES };
  for (const f of readdirSync(spec.segments).filter(f => f.endsWith('.jsonl')).sort()) {
    const seg = streamSegment(join(spec.segments, f), records, budget);
    if (seg.torn) torn++;
    overMemory += seg.skipped;
  }
  const plan = buildUnits(records, spec.cut);
  const known = new Set<string>();
  for (const r of records) collectKnown(r.args, known);
  if (spec.seeded_ids && existsSync(spec.seeded_ids)) for (const id of JSON.parse(readFileSync(spec.seeded_ids, 'utf8')) as string[]) known.add(id);
  // Only times the replay itself produced are volatile: `to` moves to now before each comparison.
  const window = { from: now(), to: now() };
  const arms = [...ARM_ORDER];
  const engines = {} as Record<ArmName, BrainEngine>;
  try {
    for (const a of arms) engines[a] = await deps.openArm(a, spec, runDir);
    const norms = { rust: new NormState(known, window) };
    const diffs: ReportDiff[] = [];
    let compared = 0;
    const compare = (ref: string, member: string, outs: Partial<Record<ArmName, Outcome>>, liveOk?: boolean) => {
      compared++;
      window.to = now() + 5_000; // a database clock a few seconds ahead of this process still counts as replay time
      let { cls, path }: { cls: DiffClass; path: DiffPath } = classify(outs, norms, spec.seed_losses_present);
      if (cls === 'match' && liveOk === true && arms.every(a => outs[a] && !outs[a]!.ok)) { cls = 'replay_diverged'; path = ['$outcome']; }
      if (cls === 'match') return;
      const hashes: Partial<Record<ArmName, string>> = {};
      for (const a of arms) hashes[a] = keyedHash(key, outcomeText(outs[a], norms.rust));
      diffs.push({ ref, member, path: redactPath(path, key), class: cls, hashes });
    };
    for (const unit of plan.units) {
      const results = {} as Record<ArmName, Array<{ member: string; out: Outcome; liveOk?: boolean }>>;
      for (const a of arms) results[a] = await runUnit(engines[a], unit);
      const n = Math.max(...arms.map(a => results[a].length));
      for (let i = 0; i < n; i++) {
        const outs: Partial<Record<ArmName, Outcome>> = {};
        for (const a of arms) outs[a] = results[a][i]?.out ?? { ok: false, code: 'call_missing' };
        compare(`${keyedHash(key, unit.order)}#${i}`, results.pglite[i]?.member ?? results.rust[i]?.member ?? '?', outs, results.pglite[i]?.liveOk);
      }
    }
    const slugs = new Set<string>();
    const writesNotSwept = writtenSlugs(plan.units, slugs);
    const sweepMembers = ['getPage', 'getTags', 'getLinks', 'getBacklinks', 'getTimeline', 'getChunks'] as const;
    let sweepFailed = 0;
    let sweepTruncated = 0;
    // A read-back that fails on every arm verifies nothing, even when the arms fail the same way.
    const sweepCompare = (ref: string, member: string, outs: Partial<Record<ArmName, Outcome>>) => {
      if (arms.every(a => outs[a] && !outs[a]!.ok)) sweepFailed++;
      compare(ref, member, outs);
    };
    for (const entry of [...slugs].sort().slice(0, SWEEP_LIMIT)) {
      const [sourceId, slug] = JSON.parse(entry) as [string | null, string];
      for (const m of sweepMembers) {
        // Pages are read with their tombstones (a hard delete behind a soft-delete receipt differs); the timeline is
        // read up to its sweep limit, and a page that fills it makes the report incomplete.
        const opts = { ...(sourceId ? { sourceId } : {}), ...(m === 'getChunks' ? { includeEmbedding: true, includeUnsealed: true } : {}),
          ...(m === 'getPage' ? { includeDeleted: true } : {}), ...(m === 'getTimeline' ? { limit: TIMELINE_SWEEP_LIMIT } : {}) };
        const rec = { member: m, args: [slug, opts] } as CaptureRecord;
        const outs: Partial<Record<ArmName, Outcome>> = {};
        for (const a of arms) outs[a] = await callOn(engines[a], rec);
        if (m === 'getTimeline' && arms.some(a => { const o = outs[a]; return o?.ok && Array.isArray(o.value) && o.value.length >= TIMELINE_SWEEP_LIMIT; })) sweepTruncated++;
        sweepCompare(`sweep:${keyedHash(key, entry)}`, `sweep:${m}`, outs);
      }
    }
    if (plan.units.length) {
      const outs: Partial<Record<ArmName, Outcome>> = {};
      for (const a of arms) outs[a] = await callOn(engines[a], { member: 'getStats', args: [] } as unknown as CaptureRecord);
      sweepCompare('sweep:stats', 'sweep:getStats', outs);
    }
    const report = renderReport(spec, arms, { ...plan.counts, compared_calls: compared, swept_pages: Math.min(slugs.size, SWEEP_LIMIT), sweep_skipped: Math.max(0, slugs.size - SWEEP_LIMIT), writes_not_swept: writesNotSwept, recorders_alive_at_seal: spec.tail_unverified ?? 0, sweep_failed: sweepFailed, sweep_truncated: sweepTruncated, records_over_memory: overMemory }, diffs, torn);
    const out = join(runDir, 'out');
    mkdirSync(out, { recursive: true, mode: 0o700 });
    writeOwnerOnly(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    writeOwnerOnly(join(out, 'report.md'), reportMarkdown(report));
    writeOwnerOnly(join(out, 'summary.json'), JSON.stringify(redactedSummary(report), null, 2) + '\n');
    return report;
  } finally {
    for (const a of arms) await engines[a]?.disconnect().catch(() => undefined);
  }
}

// ---- parent helpers ---------------------------------------------------------------------------------------------

/** The environment the child gets: nothing but these names, with a throwaway home. Never a provider key. */
export const CHILD_ENV_ALLOW = ['PATH', 'TZ', 'LANG', 'LC_ALL', 'TMPDIR', 'GBRAIN_RUST_ENGINE_ADDON'] as const;

export function childEnv(parentEnv: Record<string, string | undefined>, runHome: string): Record<string, string> {
  const env: Record<string, string> = { HOME: runHome, GBRAIN_HOME: runHome, GBRAIN_SHADOW_CHILD: '1', GBRAIN_SHADOW_CAPTURE: 'off' };
  for (const name of CHILD_ENV_ALLOW) { const v = parentEnv[name]; if (v) env[name] = v; }
  return env;
}

/** The per-brain key for keyed hashes, created on first use (0600). */
export function hmacKey(cap: string): string {
  const path = join(cap, 'key');
  if (!existsSync(path)) {
    // Written whole or not at all: a 0600 temp file in the same folder, flushed to disk, then renamed into place.
    mkdirSync(cap, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeSync(fd, randomBytes(32).toString('hex')); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(tmp, path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } finally { rmSync(tmp, { force: true }); }
  }
  return checkedKey(readFileSync(path, 'utf8').trim(), path);
}

/** A hash key must be exactly 32 bytes (64 hex characters): a shorter or empty one would make summary hashes guessable. */
export function checkedKey(key: string, where: string): string {
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new ReplayError('shadow_replay_key_invalid', `${where} holds ${key.length} characters, not 64 hex characters`);
  return key;
}

/** Copies a sealed epoch's segments and base copies into a new run directory; returns the run's paths. */
export function prepareRun(runDir: string, segmentsFrom: string, base: string): { pglite: string; rust: string; segments: string; home: string; seededIds?: string } {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const work = join(runDir, 'work');
  const segments = join(runDir, 'segments');
  const home = join(runDir, 'home');
  for (const d of [work, segments, home]) mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const f of readdirSync(segmentsFrom).filter(f => f.endsWith('.jsonl'))) cpSync(join(segmentsFrom, f), join(segments, f));
  cpSync(join(base, 'pglite'), join(work, 'pglite'), { recursive: true });
  cpSync(join(base, 'rust'), join(work, 'rust'), { recursive: true });
  const ids = join(base, 'seeded-ids.json');
  if (existsSync(ids)) cpSync(ids, join(work, 'seeded-ids.json'));
  return { pglite: join(work, 'pglite'), rust: join(work, 'rust'), segments, home, ...(existsSync(ids) ? { seededIds: join(work, 'seeded-ids.json') } : {}) };
}

export function removeRun(path: string): void { rmSync(path, { recursive: true, force: true }); }

export { ReplayError };
