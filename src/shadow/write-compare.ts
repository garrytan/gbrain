/**
 * Write comparisons, the part both processes share (swap criterion 5; docs/designs/RUST_ENGINE.md, "What is compared", Writes).
 *
 * A pilot covers ONLY putPage, deletePage, addLink, addLinksBatch and removeLink. For a sampled one the serving process copies the
 * rows the write touches from the primary (the preimage) and sends them with the write; the shadow child seeds a SCRATCH Rust store
 * with them, applies the same write there (never to the live shadow store, never to the primary) and compares typed read-backs
 * of the changed rows. Every sampled write of another family is `capability_missing`, by family. Fail closed: a write
 * whose preimage could not be read or loaded, or that failed on one side, is `uncomparable` and never `comparable`.
 *
 * Counts live in `write-comparisons.json`, written only through the locked tally below; `status` reads them.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flushDirectory, flushFile } from '../core/fs-durable.ts';
import { readEpoch, withLock } from './evidence-epoch.ts';
import { memberKind, WRITE_MAP } from './write-map.ts';

export const PILOT_WRITES: ReadonlySet<string> = new Set(['putPage', 'deletePage', 'addLink', 'addLinksBatch', 'removeLink']);
/** Most pages and links one sampled write copies; a bigger write is `uncomparable` (preimage_too_large). */
export const MAX_PRE_PAGES = 40;
export const MAX_PRE_LINKS = 200;

export type WriteOutcome = 'comparable' | 'unexplained_difference' | 'uncomparable' | 'capability_missing';
export interface PageRef { source: string; slug: string }
/** Text-valued rows of the primary as the seed reads them (seed.ts `relationRead`). */
export interface PreImage { sources: Array<Record<string, string | null>>; pages: Array<Record<string, string | null>>; links: Array<Record<string, string | null>> }
/** What the serving process sends for one sampled write: a full sample (`pre`, `post`), or just its outcome (`outcome`, `reason`/`family`). */
export interface WriteEvent { t: 'write'; op: string; outcome?: WriteOutcome; reason?: string; family?: string; /** Earlier samples the pipe refused (counted uncomparable, `send_shed`). */ dropped?: number; args?: unknown[]; pre?: PreImage; post?: unknown; moved?: boolean; /** Calls the transaction made on the page after the write that change a compared column, replayed in order (`updatePageContextualRetrievalState`). */ then?: unknown[][] }

const ref = (slug: unknown, source: unknown): PageRef | null =>
  (typeof slug === 'string' && slug ? { source: typeof source === 'string' && source ? source : 'default', slug: slug.toLowerCase() } : null);

/** Where each pilot write takes its options: `putPage(slug, page, opts)`, `deletePage(slug, opts)`, `addLink(from, to, context, type, source, originSlug, originField, opts)`, `removeLink(from, to, type, source, opts)`. */
const OPTS_AT: Record<string, number> = { putPage: 2, deletePage: 1, addLink: 7, removeLink: 4 };

/** The pages a pilot write names (both link ends and the origin page of a link), by source and slug. An omitted origin source is `default` on both engines, whatever the from-source. */
export function pageRefs(op: string, args: any[]): PageRef[] {
  const o = (args[OPTS_AT[op] ?? 1] ?? {}) as Record<string, unknown>;
  const all = op === 'addLinksBatch'
    ? (args[0] as any[]).flatMap((l) => [ref(l.from_slug, l.from_source_id), ref(l.to_slug, l.to_source_id), ref(l.origin_slug, l.origin_source_id)])
    : op === 'addLink' ? [ref(args[0], o.fromSourceId), ref(args[1], o.toSourceId), ref(args[5], o.originSourceId)]
    : op === 'removeLink' ? [ref(args[0], o.fromSourceId), ref(args[1], o.toSourceId)]
    : [ref(args[0], o.sourceId)];
  return [...new Map(all.filter((r): r is PageRef => r !== null).map((r) => [`${r.source}\0${r.slug}`, r])).values()];
}

/** What a pilot write itself changes: the pages it writes or deletes, and the links it adds or removes (from, to, and the type and source it names; one it leaves out matches any). An added link also names its origin page: `null` is no origin, which only a row with no origin matches; a removal leaves `origin` out and matches any. */
export function footprint(op: string, args: any[]): { pages: PageRef[]; links: Array<{ from: PageRef; to: PageRef; type?: string; source?: string; origin?: PageRef | null }> } {
  const o = (args[OPTS_AT[op] ?? 1] ?? {}) as Record<string, unknown>;
  const link = (from: PageRef | null, to: PageRef | null, type?: unknown, source?: unknown, origin?: PageRef | null) => (from && to ? [{ from, to, type: typeof type === 'string' ? type : undefined, source: typeof source === 'string' ? source : undefined, origin }] : []);
  if (op === 'addLinksBatch') return { pages: [], links: (args[0] as any[]).flatMap((l) => link(ref(l.from_slug, l.from_source_id), ref(l.to_slug, l.to_source_id), l.link_type, l.link_source, ref(l.origin_slug, l.origin_source_id))) };
  if (op === 'addLink') return { pages: [], links: link(ref(args[0], o.fromSourceId), ref(args[1], o.toSourceId), args[3], args[4], ref(args[5], o.originSourceId)) };
  if (op === 'removeLink') return { pages: [], links: link(ref(args[0], o.fromSourceId), ref(args[1], o.toSourceId), args[2], args[3]) };
  return { pages: pageRefs(op, args), links: [] };
}

type Row = Record<string, string | null>;
/** Job-queue state the seed read joins in beside a page (not page content): background workers move it, and that is not another writer's edit. */
const JOB_COLUMNS = new Set(['projection_job_revision', 'projection_job_reason', 'projection_job_updated_at']);
const sameRow = (a: Row, b: Row): boolean => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => JOB_COLUMNS.has(k) || a[k] === b[k]);

/**
 * The data fence for a brain other processes can write (Postgres): true when the copied rows changed in a way the write does not explain, so the sample
 * is uncomparable (`moved`). Every row copied before the write that lies outside its footprint must be the same afterwards, and no link may have appeared
 * that the write did not add. PGLite skips this: its single-writer file lock means no other process can write between the copy and the read-back.
 * Where it runs and completes it decides alone (write-capture.ts): the serving process's own write counter no longer also marks the sample, so a same-process write to a copied row is caught here only.
 * Open gap: another process (or call) editing the very rows the write changes is not seen here; it can show as a difference, never as a match.
 */
export function movedOutsideFootprint(op: string, args: any[], pre: PreImage, now: PreImage): boolean {
  const fp = footprint(op, args);
  const key = (r: PageRef): string => `${r.source}\0${r.slug}`;
  const ids = new Map<string, string | null>([...pre.pages, ...now.pages].map((p) => [`${p.source_id}\0${p.slug}`, p.id ?? null]));
  const ownPages = new Set(fp.pages.map((r) => ids.get(key(r))));
  const own = fp.links.map((l) => ({ from: ids.get(key(l.from)), to: ids.get(key(l.to)), type: l.type, source: l.source, origin: l.origin === undefined ? undefined : l.origin ? ids.get(key(l.origin)) ?? null : null }));
  const ownLink = (l: Row): boolean => own.some((w) => w.from === l.from_page_id && w.to === l.to_page_id && (w.type === undefined || w.type === l.link_type) && (w.source === undefined || w.source === l.link_source) && (w.origin === undefined || w.origin === (l.origin_page_id ?? null)))
    || (op === 'deletePage' && (ownPages.has(l.from_page_id) || ownPages.has(l.to_page_id)));
  const after = (rows: Row[]): Map<string | null, Row> => new Map(rows.map((r) => [r.id ?? null, r]));
  const pagesNow = after(now.pages); const linksNow = after(now.links);
  const preLinks = new Set(pre.links.map((l) => l.id));
  const known = new Set([...pre.pages.map((p) => p.id), ...ownPages]); // only links between pages that were copied (or written) count: the re-read reaches further than the copy did
  return pre.pages.some((p) => !ownPages.has(p.id ?? null) && !(pagesNow.has(p.id ?? null) && sameRow(p, pagesNow.get(p.id ?? null)!)))
    || pre.links.some((l) => !ownLink(l) && !(linksNow.has(l.id ?? null) && sameRow(l, linksNow.get(l.id ?? null)!)))
    || now.links.some((l) => !preLinks.has(l.id) && !ownLink(l) && known.has(l.from_page_id) && known.has(l.to_page_id));
}

/** Every page a read-back looks at: the write's own pages and every page in the preimage. */
export const pageSet = (targets: PageRef[], pre: PreImage): PageRef[] =>
  [...new Map([...targets, ...pre.pages.map((p) => ({ source: p.source_id ?? 'default', slug: p.slug ?? '' }))].map((r) => [`${r.source}\0${r.slug}`, r])).values()];

/** The typed read-back both engines answer: the written pages, and the links among the pages in `set`. */
export async function readBack(engine: Record<string, any>, targets: PageRef[], set: PageRef[]): Promise<{ pages: unknown[]; links: unknown[] }> {
  const pages = await Promise.all(targets.map((r) => engine.getPage(r.slug, { sourceId: r.source, includeDeleted: true })));
  const keys = new Set(set.map((r) => `${r.source}\0${r.slug}`));
  const links: unknown[] = [];
  for (const r of set) {
    for (const l of await engine.getLinks(r.slug, { sourceId: r.source }) as any[]) {
      if (keys.has(`${l.from_source_id}\0${l.from_slug}`) && keys.has(`${l.to_source_id}\0${l.to_slug}`)) links.push(l);
    }
  }
  return { pages, links };
}

/** Fields each engine generates itself (ids, clocks, a random revision): never compared. */
const GENERATED = new Set(['id', 'knowledge_revision', 'created_at', 'updated_at', 'ingested_at', 'salience_touched_at', 'text_projection_revision']);

/** One comparable text for an encoded read-back: generated fields dropped, a soft delete kept as a flag, links sorted. */
export function readBackText(encoded: any): string {
  const page = (p: any): unknown => (p ? Object.fromEntries(Object.entries(p).filter(([k]) => !GENERATED.has(k)).map(([k, v]) => [k, k === 'deleted_at' ? v !== null : v]).sort(([a], [b]) => (a as string) < (b as string) ? -1 : 1)) : null);
  const link = (l: any): string => JSON.stringify(Object.entries(l).sort(([a], [b]) => (a < b ? -1 : 1)));
  return JSON.stringify({ pages: (encoded.pages as unknown[]).map(page), links: (encoded.links as unknown[]).map(link).sort() });
}

/** The family a sampled write that the pilot does not cover is counted under (never a pilot member's own family). */
export function writeFamily(op: string): string {
  const kind = memberKind(op);
  if (kind === 'raw') return 'raw_sql';
  const table = kind === 'mapped' ? WRITE_MAP[op]!.tables[0]! : 'unmapped';
  return table === 'pages' || table === 'links' ? `${table}:${op}` : table;
}

export interface WriteTallyFile {
  version: 1; epoch_id: string; updated_at: string;
  comparable: number; unexplained_difference: number; uncomparable: number; capability_missing: number;
  capability_missing_by_family: Record<string, number>; uncomparable_by_reason: Record<string, number>;
  /** Pids of children whose replay has no verdict written yet. A pid leaves only by its own verdict or when it is dead (counted `unexplained_difference`); while any stands, status reads no evidence. */
  in_flight: number[];
  /** The last batch number of each child (`<pid>.<nonce>`) this file has taken: a save that may have landed is added once. */
  applied?: Record<string, number>;
  /** Bytes of each serving process's `write-lost.<pid>.jsonl` this file has taken (the lost samples counted `uncomparable`): a line is added once. */
  lost_applied?: Record<string, number>;
}
export const writeTallyPath = (dir: string): string => join(dir, 'write-comparisons.json');
const OUTCOMES = ['comparable', 'unexplained_difference', 'uncomparable', 'capability_missing'] as const;
const blank = (epoch: string): WriteTallyFile => ({ version: 1, epoch_id: epoch, updated_at: '', comparable: 0, unexplained_difference: 0, uncomparable: 0, capability_missing: 0, capability_missing_by_family: {}, uncomparable_by_reason: {}, in_flight: [] });
const count = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 0;
const counts = (m: unknown): boolean => typeof m === 'object' && m !== null && Object.values(m).every(count);

/** The tally file as written: null when there is none, and a throw when there is one that is not a tally (it is never read as empty and written over). */
function loadTally(dir: string): WriteTallyFile | null {
  let text: string;
  try { text = readFileSync(writeTallyPath(dir), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  const f = JSON.parse(text) as WriteTallyFile;
  if (!(f?.version === 1 && typeof f.epoch_id === 'string' && OUTCOMES.every((o) => count(f[o])) && counts(f.capability_missing_by_family) && counts(f.uncomparable_by_reason) && (f.applied === undefined || counts(f.applied)) && (f.lost_applied === undefined || counts(f.lost_applied)) && Array.isArray(f.in_flight) && f.in_flight.every(Number.isInteger))) throw new Error('not a write tally');
  return f;
}

/** The counts under `epochId`, or null when there are none (no file, an unreadable one, or another epoch's). */
export function readWriteTally(dir: string, epochId: string | null): WriteTallyFile | null {
  try { const f = loadTally(dir); return f && epochId !== null && f.epoch_id === epochId ? f : null; } catch { return null; } // silent-read-ok: no readable tally is no count; the status shows zero and criterion 5 stays missing
}

/** Samples the serving process lost (a refused send, a read-back abandoned at disconnect) are never written into the tally by that process (a locked write could stall it): each is one `{epoch_id, reason}` line appended, with no lock, to its own file; the owner child folds them in. True only when the line and its directory entry are flushed to disk; false otherwise. */
export const lostPath = (dir: string, pid: number): string => join(dir, `write-lost.${pid}.jsonl`);
export function recordLost(dir: string, epoch: string, reason: string): boolean {
  const path = lostPath(dir, process.pid);
  try { appendFileSync(path, JSON.stringify({ epoch_id: epoch, reason }) + '\n', { flag: 'a', mode: 0o600 }); flushFile(path); flushDirectory(dir); return true; } catch { return false; } // silent-read-ok: false is the answer, never a pass: the sampler then carries the count on its next line
}
/** The lost lines past what `applied` took, per file: the complete lines' end offset and the reasons of this epoch's (another epoch's are retired and skipped; a line that is not readable, or an unfinished one whose writer is dead, counts as `lost_unreadable`). */
function readLost(dir: string, epoch: string, applied: Record<string, number> = {}): Array<{ name: string; end: number; reasons: string[]; unreadable?: true }> {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => /^write-lost\.\d+\.jsonl$/.test(n)); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : [{ name: '', end: 0, reasons: [], unreadable: true }]; } // a directory that is gone has nothing to fold; one that cannot be listed is unresolved, never empty
  return names.flatMap((name) => {
    try {
      const buf = readFileSync(join(dir, name)); const from = applied[name] ?? 0; const cut = buf.lastIndexOf(10) + 1;
      const open = buf.length > Math.max(cut, from); // bytes after the last newline: a line still being appended, or one a crash cut short
      const end = open && !running(Number(/\d+/.exec(name)![0])) ? buf.length : cut; // its writer is gone: it ends as one lost_unreadable (its offset moves past it); while the writer lives it is unresolved
      if (end <= from && !open) return [];
      const reasons = buf.subarray(from, end).toString('utf8').split('\n').filter(Boolean).flatMap((l) => { try { const e = JSON.parse(l); return e?.epoch_id === epoch ? [String(e.reason)] : []; } catch { return ['lost_unreadable']; } });
      return [{ name, end: Math.max(end, from), reasons, ...(open && end < buf.length ? { unreadable: true as const } : {}) }];
    } catch { return [{ name, end: 0, reasons: [], unreadable: true }]; } // a file that cannot be read stays unfolded and unresolved: status reads it as no evidence
  });
}
/** Lost samples of `epoch` that no tally has taken yet: status reads any as no evidence, like a standing in-flight mark. */
export function unfoldedLost(dir: string, epoch: string | null, taken?: Record<string, number>): number { return epoch === null ? 0 : readLost(dir, epoch, taken).reduce((n, l) => n + l.reasons.length + (l.unreadable ? 1 : 0), 0); }

const MAX_KEYS = 64;
const bump = (map: Record<string, number>, key: string, n: number): void => { const k = key in map || Object.keys(map).length < MAX_KEYS ? key : 'other'; map[k] = (map[k] ?? 0) + n; };
function applyVerdict(file: WriteTallyFile, outcome: WriteOutcome, key: string | undefined, n: number): void {
  file[outcome] += n;
  const name = typeof key === 'string' && /^[A-Za-z][A-Za-z0-9_:]{0,59}$/.test(key) ? key : 'other'; // a name, never text that could hold content
  if (outcome === 'capability_missing') bump(file.capability_missing_by_family, name, n);
  if (outcome === 'uncomparable') bump(file.uncomparable_by_reason, name, n);
}
const running = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/**
 * The write tally (swap criterion 5). The file changes only inside one cross-process lock, as a read-modify-write of THIS child's unsaved verdicts
 * (`pending` batches) onto what the file holds now: a held snapshot is never written back, so nothing another child saved can be overwritten. Only the child that owns the Rust store has an epoch (one fixed id for its life: `epoch()` is the owner's `curEpoch`, null for a client), so a client child records nothing and a retired epoch's results can never be added to another epoch's file (a save also refuses a file whose manifest epoch is not this child's). A save
 * is the temp file flushed, renamed over the file and the directory flushed; only then do its batches count as saved. A save that fails, at any point
 * (even after the rename, where it may have landed), keeps its batches, and `applied` (the last batch number of this child the file has taken) makes the
 * retry add each batch once. A replay publishes its pid in `in_flight` (`begin`, true only when that is durable on disk; the caller refuses the replay on
 * false) and only its own verdict, or the recovery of a dead pid, removes it. A mark whose replay never wrote a verdict is one that could have been
 * a mismatch, so a dead pid's counts `unexplained_difference`: a hard kill during a replay fails criterion 5 for the epoch.
 */
export class WriteTally {
  private pending: Array<{ seq: number; delta: WriteTallyFile; ending: boolean }> = [];
  private sealed = 0; // the first `sealed` pending batches were in a save that may have landed: never added to, until a durable save takes them
  private seq = 0;
  private readonly id: string;
  constructor(private readonly dir: string, private readonly epoch: () => string | null, private readonly alive: () => boolean = () => existsSync(dir), private readonly pid: number = process.pid) { this.id = `${pid}.${randomBytes(4).toString('hex')}`; }
  /** One locked read-modify-write: dead pids recovered, then this child's unsaved batches, then `change`. False when nothing was saved (the batches are kept). `fresh`: a mark under this pid is from an earlier process that had it. */
  private update(change?: (file: WriteTallyFile) => void, fresh = false): boolean {
    const epoch = this.epoch();
    if (epoch === null || !this.alive()) return false;
    const batches = this.pending; let renamed = false;
    try {
      withLock(join(this.dir, 'write-comparisons.lock'), () => {
        if (readEpoch(this.dir)?.epoch_id !== epoch) throw new Error('not the current epoch'); // a child of a retired epoch must not replace the current epoch's file
        const saved = loadTally(this.dir);
        const file = saved?.epoch_id === epoch ? saved : blank(epoch);
        file.applied ??= {};
        const dead = file.in_flight.filter((p) => (p === this.pid ? fresh : !running(p)));
        for (const p of dead) applyVerdict(file, 'unexplained_difference', undefined, 1);
        file.in_flight = file.in_flight.filter((p) => !dead.includes(p));
        for (const id of Object.keys(file.applied)) if (id !== this.id && !running(Number.parseInt(id, 10))) delete file.applied[id];
        const todo = batches.filter((b) => b.seq > (file.applied![this.id] ?? 0));
        const lost = readLost(this.dir, epoch, file.lost_applied).filter((l) => l.end > (file.lost_applied?.[l.name] ?? 0)); // the serving processes' lost samples, taken once under the same lock
        if (!change && !dead.length && !todo.length && !lost.length) return;
        file.lost_applied ??= {};
        for (const l of lost) { for (const r of l.reasons) applyVerdict(file, 'uncomparable', r, 1); file.lost_applied[l.name] = l.end; }
        for (const b of todo) {
          for (const o of OUTCOMES) file[o] += b.delta[o];
          for (const [k, n] of Object.entries(b.delta.capability_missing_by_family)) bump(file.capability_missing_by_family, k, n);
          for (const [k, n] of Object.entries(b.delta.uncomparable_by_reason)) bump(file.uncomparable_by_reason, k, n);
          if (b.ending) file.in_flight = file.in_flight.filter((p) => p !== this.pid);
          file.applied[this.id] = b.seq;
        }
        change?.(file);
        file.updated_at = new Date().toISOString();
        const tmp = `${writeTallyPath(this.dir)}.${this.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(file) + '\n', { mode: 0o600 });
        flushFile(tmp);
        renameSync(tmp, writeTallyPath(this.dir)); renamed = true;
        flushDirectory(this.dir);
      });
      this.pending = []; this.sealed = 0;
      return true;
    } catch { if (renamed) this.sealed = batches.length; return false; } // silent-read-ok: false is the answer, never a pass: begin() refuses the replay, and note() keeps the unsaved batches for the next save
  }
  /** Publishes this pid as having a replay in flight. True only when that is durable on disk: on false the replay must not run. */
  begin(): boolean { return this.update((file) => { if (!file.in_flight.includes(this.pid)) file.in_flight.push(this.pid); }); }
  /** At child start: counts the marks of dead processes (and of an earlier process with this pid), and saves any verdict still unsaved. */
  recover(): void { this.update(undefined, true); }
  /** One more try to save batches an earlier save could not take (true when nothing is left unsaved). */
  save(): boolean { return this.update(); }
  /** Counts one outcome; `ends` is a replay's own verdict, which removes its mark. */
  note(outcome: WriteOutcome, key?: string, n = 1, ends = false): void {
    const epoch = this.epoch();
    if (epoch === null || !this.alive()) return;
    let batch = this.pending.at(-1);
    if (!batch || this.pending.length === this.sealed) this.pending.push(batch = { seq: ++this.seq, delta: blank(epoch), ending: false });
    applyVerdict(batch.delta, outcome, key, n);
    batch.ending ||= ends;
    this.update();
  }
}
