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
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 * It exempts the write's own rows, so write-capture.ts adds a second guard there: the serving process's own write counter (pages and links only) also marks a sample moved, except for an in-transaction putPage whose page
 * was pinned just before the commit (the revision and every compared field), where the fence and the pin decide.
 * Open gap: another process editing the very rows the write changes is not seen here; it can show as a difference, never as a match.
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
  /** Write samples each session (`sessionKey`) has had settled, whatever the epoch: carried into a new epoch together with `lost_applied` and `applied` (a count and the cursor that stops its source being added again are one ledger). Written in the same rename as the outcomes it stands for. */
  settled?: Record<string, number>;
  /** The part of `settled` that was page and link writes (`QUALIFYING` lines, `sampleQualifyingWeight`), written in the same rename as `settled` and carried with it. Only a credit known to be one counts, so orphan recovery books more
   * lost page and link writes than it would otherwise, never fewer. */
  settled_qualifying?: Record<string, number>;
  /** The credit a session had settled BEFORE its `settled` entry restarted (and the page and link part of it): the owner banks it in the same rename that deletes the entry (`removeSettledOwed`, under the tally lock), so `settled` and this are never counted twice and a
   * session's total is always their sum: no reader infers whether one includes the other from their sizes. An older writer keeps a field it does not know when it saves and prunes only `settled`, so the credit outlives its prune; the blocker's `booked_through` is a copy of it
   * (the larger of the two counts, for a writer that starts an epoch and drops what it does not know). Carried into a new epoch with `settled`; pruned with it once the session and its blocker are gone. */
  settled_before?: Record<string, number>; settled_before_qualifying?: Record<string, number>;
  /** The highest line number (`n`) of each writer's (`w`, `<pid>.<nonce>`) credited lost lines this file has taken: a line retried after a partial append carries the same numbers, so it is added once however much of the first try reached the file. Travels with `settled` and `lost_applied`. */
  line_seq?: Record<string, number>;
  /** Lost lines of this epoch that name no session (an older writer's): their obligation is unknown, so status reads no evidence for the epoch. */
  legacy_lines?: number;
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
  if (!(f?.version === 1 && typeof f.epoch_id === 'string' && OUTCOMES.every((o) => count(f[o])) && counts(f.capability_missing_by_family) && counts(f.uncomparable_by_reason) && (f.applied === undefined || counts(f.applied)) && (f.lost_applied === undefined || counts(f.lost_applied)) && (f.settled === undefined || counts(f.settled)) && (f.settled_qualifying === undefined || counts(f.settled_qualifying)) && (f.settled_before === undefined || counts(f.settled_before)) && (f.settled_before_qualifying === undefined || counts(f.settled_before_qualifying)) && (f.line_seq === undefined || counts(f.line_seq)) && (f.legacy_lines === undefined || count(f.legacy_lines)) && Array.isArray(f.in_flight) && f.in_flight.every(Number.isInteger))) throw new Error('not a write tally');
  return f;
}

/** The counts under `epochId`, or null when there are none (no file, an unreadable one, or another epoch's). */
export function readWriteTally(dir: string, epochId: string | null): WriteTallyFile | null {
  try { const f = loadTally(dir); return f && epochId !== null && f.epoch_id === epochId ? f : null; } catch { return null; } // silent-read-ok: no readable tally is no count; the status shows zero and criterion 5 stays missing
}

/** How many write samples a serving process sent the child of `session` (supervisor.ts `recordSent`); the child reads it at the end of its input and counts what it never received as lost (`pipe_unflushed`). */
export const sentPath = (dir: string, session: string): string => join(dir, `write-sent.${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
/** The most samples one receipt may stand for: a larger count is not one we can write down (it would be a long loop of durable appends at worker start), so it reads as unreadable. */
const MAX_SENT = 1_000_000;
/** A receipt whose file is older than this is one whose worker is gone even if its pid runs (a reused pid), or that names no pid: a live worker removes its receipt within its exit deadline. */
const STALE_RECEIPT_MS = 10 * 60_000;
const RECEIPT_NAME = /^write-sent\.[A-Za-z0-9_-]+\.json$/;
export interface SentReceipt { session: string; sent: number; pid?: number; epoch_id?: string }
/** The receipt in `path`: null when there is no such file, `'unreadable'` when there is one that cannot be used as a count (a read error such as EIO, truncated JSON, another session, a count that is not 0 to `MAX_SENT`). */
function parseReceipt(path: string, session?: string): SentReceipt | null | 'unreadable' {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable'; }
  try {
    const f = JSON.parse(text) as Partial<SentReceipt>;
    if (typeof f?.session !== 'string' || (session !== undefined && f.session !== session) || !Number.isSafeInteger(f.sent) || f.sent! < 0 || f.sent! > MAX_SENT) return 'unreadable';
    return { session: f.session, sent: f.sent!, ...(Number.isSafeInteger(f.pid) ? { pid: f.pid } : {}), ...(typeof f.epoch_id === 'string' ? { epoch_id: f.epoch_id } : {}) };
  } catch { return 'unreadable'; }
}
/** The receipt of `session`: a count, null (no receipt), or `'unreadable'` (one that is there and cannot be read: never the same as none). */
export const readReceipt = (dir: string, session: string): SentReceipt | null | 'unreadable' => parseReceipt(sentPath(dir, session), session);
/** The sent count for `session`: a number, null when there is no receipt, `'unreadable'` when there is one that cannot be read (the child raises a fault and leaves it). */
export function readSent(dir: string, session: string): number | null | 'unreadable' { const r = readReceipt(dir, session); return r === null || r === 'unreadable' ? r : r.sent; }
/**
 * The receipts still on disk, by name: every one is a deficit nobody has recorded, so status reads each as no evidence (an unreadable one, one that names another epoch than this one, and one that names none alike:
 * only a recorded deficit may let status read measured). With no epoch nothing is counted; a missing directory has none; a listing that fails otherwise counts one.
 */
export function outstandingReceipts(dir: string, epoch: string | null): string[] {
  if (epoch === null) return [];
  let names: string[];
  try { names = readdirSync(dir).filter((n) => RECEIPT_NAME.test(n)).sort(); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : ['write-sent.*']; }
  return names.filter((name) => parseReceipt(join(dir, name)) !== null);
}
/**
 * How many samples a line stands for: 0 when it is not a write sample. Read only from text the sampler wrote itself, never from page content: a sample starts with its own first key
 * (`{"t":"write"`), and the count of earlier losses that could not be recorded is its LAST top-level field (`,"dropped":<n>}` and a newline, the sampler appends it after the event), so a
 * key named `dropped` inside a page ends `}}` and cannot match. Capped at 10,000 (the child's own cap). The child counts the same weight for each sample line it reads (child.ts).
 */
export function sampleWeight(line: string): number {
  if (!line.startsWith('{"t":"write"')) return 0;
  const dropped = /,"dropped":(\d{1,5})\}\n$/.exec(line.length > 40 ? line.slice(-40) : line);
  return 1 + (dropped ? droppedWeight(Number(dropped[1])) : 0);
}
/**
 * Whether a write sample line carries a loss that is already known (it must not wait in a window): a `dropped` count (weight above 1) or an `uncomparable` outcome the sampler wrote itself (`readback_failed`,
 * `primary_write_failed`, `preimage_timeout`). Reads only the sampler's own first keys (`t`, `op`, `outcome`); a sample's page content comes after `args`.
 */
export const carriesKnownLoss = (line: string): boolean => sampleWeight(line) > 1 || /^\{"t":"write","op":"[^"\\]*","outcome":"uncomparable"/.test(line);
/** The most earlier losses one sample line carries (the sampler cuts to it and keeps the rest for later lines). */
export const MAX_DROPPED = 10_000;
/**
 * How many owed samples the `dropped` count of a line stands for: the ONE rule the sampler (which never writes more than `MAX_DROPPED`), the supervisor's `sampleWeight` (which reads at most five digits) and the child (which credits what it read)
 * all use, so a line settles exactly the weight it was owed and never more. A count that is not a whole number from 1 to 99,999 is no count at all (a line the sampler did not write): 0.
 */
export const droppedWeight = (n: unknown): number => (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 99_999 ? Math.min(n as number, MAX_DROPPED) : 0);
/**
 * How many of a line's samples (`sampleWeight`) are qualifying writes: the page and link writes criterion 5 compares (`PILOT_WRITES`; every other write is sent as capability_missing). The sample itself counts when the op the sampler
 * wrote as its second key (`{"t":"write","op":"<name>"`) is one, never a name inside a page; the earlier losses it carries always count (which write each was is not known, so never as fewer). The supervisor counts it for the owed record
 * and the child for what it read, from the same bytes, so the lost page and link writes are the difference.
 */
export function sampleQualifyingWeight(line: string): number {
  const weight = sampleWeight(line);
  if (weight === 0) return 0;
  const op = /^\{"t":"write","op":"([A-Za-z]{1,60})"/.exec(line)?.[1];
  return weight - 1 + (op !== undefined && PILOT_WRITES.has(op) ? 1 : 0);
}
/** Lost-line reasons that are not page and link writes: such a sample would have been sent as capability_missing, so the owner folds it there under its own name, counted and visible, never against the compared share. */
export const LOST_NONQUALIFYING: ReadonlySet<string> = new Set(['pipe_unflushed_nonqualifying', 'receipt_orphaned_nonqualifying']);

/** The name a session has in file names, in the tally's `settled` map and on lost lines. */
export const sessionKey = (session: string): string => session.replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * What a serving process owes the child of one session: the weight of every write sample it accepted for that child (`sampleWeight`), written down durably BEFORE any line it covers reaches the pipe
 * (supervisor.ts). The child settles samples in its own tally write (`settled`); status blocks a session only while `owed` is more than `settled`. `closed`: the serving process ended the input;
 * `child_exited`: it saw the child die. Only the serving process writes it (tmp file, flushed, renamed over the file, directory flushed); the child that finishes the session removes it.
 */
export const owedPath = (dir: string, session: string): string => join(dir, `write-owed.${sessionKey(session)}.json`);
const OWED_NAME = /^write-owed\.([A-Za-z0-9_-]+)\.json$/;
const MAX_OWED = 1_000_000_000_000;
/**
 * `v: 1` is every record the serving process writes outside a flush window. `v: 2` is the OPEN MARKER of a window (`open_until`: epoch ms): `owed` is one more than it has accepted for the pipe, so every reader sees an unsettled session, and a crash
 * leaves it for the child or an owner worker to book as one `write_window_lost`. An older reader parses only `v: 1`: it reads a marker as unreadable, which is no evidence, never a settled session (it books and removes nothing).
 * `booked_epoch` (v:2 only): the TOMBSTONE of a window booked into that epoch. A tombstone stays for as long as its epoch does, so an older reader (which cannot read it) keeps reading the epoch as unresolved, and a reader counts it as one lost
 * window. A tombstone that names another epoch is stale: the next pass removes it. Builds up to 424b0fa0cf kept the tombstone in the session's own file (`write-owed.<session>.json`), which the serving process also writes; they are still read in place.
 * This version keeps it in a file of its own, the WINDOW BLOCKER (`write-owed.window-lost-<session>.json`, below), which only the owner pass writes and removes, under the tally lock.
 * `window_target`, `booked_through`, `booked_qualifying` (a blocker only): see `WINDOW_BLOCKER_PREFIX`.
 * `owed_qualifying`: how many of `owed` were page and link writes (`sampleQualifyingWeight`); absent in a record of an older serving process, which counts every owed sample as one. An open marker's one extra sample counts as one.
 */
export interface OwedRecord { v: 1 | 2; session: string; serving_pid: number; child_pid?: number; owed: number; owed_qualifying?: number; closed: boolean; child_exited: boolean; open_until?: number; booked_epoch?: string; window_target?: number; booked_through?: number; booked_qualifying?: number }
function parseOwed(path: string): OwedRecord | null | 'unreadable' {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable'; }
  try {
    const f = JSON.parse(text) as Partial<OwedRecord>;
    if ((f?.v !== 1 && f?.v !== 2) || (f.v === 2) !== (f.open_until !== undefined) || (f.open_until !== undefined && (!Number.isSafeInteger(f.open_until) || f.open_until < 0)) || (f.booked_epoch !== undefined && (f.v !== 2 || typeof f.booked_epoch !== 'string' || f.booked_epoch === '')) || typeof f.session !== 'string' || !Number.isSafeInteger(f.owed) || f.owed! < 0 || f.owed! > MAX_OWED || !Number.isSafeInteger(f.serving_pid) || typeof f.closed !== 'boolean' || typeof f.child_exited !== 'boolean' || (f.child_pid !== undefined && !Number.isSafeInteger(f.child_pid))) return 'unreadable';
    if (f.owed_qualifying !== undefined && (!Number.isSafeInteger(f.owed_qualifying) || f.owed_qualifying < 0 || f.owed_qualifying > f.owed!)) return 'unreadable';
    for (const n of [f.window_target, f.booked_through, f.booked_qualifying]) if (n !== undefined && (f.booked_epoch === undefined || !Number.isSafeInteger(n) || n < 0 || n > MAX_OWED)) return 'unreadable';
    return { v: f.v, session: f.session, serving_pid: f.serving_pid!, ...(f.child_pid !== undefined ? { child_pid: f.child_pid } : {}), owed: f.owed!, ...(f.owed_qualifying !== undefined ? { owed_qualifying: f.owed_qualifying } : {}), closed: f.closed, child_exited: f.child_exited, ...(f.open_until !== undefined ? { open_until: f.open_until } : {}), ...(f.booked_epoch !== undefined ? { booked_epoch: f.booked_epoch } : {}), ...(f.window_target !== undefined ? { window_target: f.window_target } : {}), ...(f.booked_through !== undefined ? { booked_through: f.booked_through } : {}), ...(f.booked_qualifying !== undefined ? { booked_qualifying: f.booked_qualifying } : {}) };
  } catch { return 'unreadable'; }
}
/** The owed record of `session`: the record, null (none), or `'unreadable'` (there, and not usable: never the same as none). */
export const readOwed = (dir: string, session: string): OwedRecord | null | 'unreadable' => parseOwed(owedPath(dir, session));
/** Writes the record durably: the temp file and the renamed file are flushed, then the directory. Throws when any step fails (the record is then not known to be on disk). */
export function writeOwed(dir: string, rec: OwedRecord): void {
  const path = owedPath(dir, rec.session); const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec) + '\n', { mode: 0o600 });
  flushFile(tmp);
  renameSync(tmp, path);
  flushDirectory(dir);
}
/** Removes the record and flushes the directory; throws when that failed (the caller keeps it as unsettled). */
function removeOwed(dir: string, key: string): void { rmSync(join(dir, `write-owed.${key}.json`), { force: true }); flushDirectory(dir); }
/** The owed files in `dir`, by session key; `failed` when the directory could not be listed (a missing directory has none). */
function listOwed(dir: string): { keys: string[]; failed: boolean } {
  try { return { keys: readdirSync(dir).flatMap((n) => OWED_NAME.exec(n)?.[1] ?? []).sort(), failed: false }; } catch (e) { return { keys: [], failed: (e as NodeJS.ErrnoException).code !== 'ENOENT' }; }
}

/**
 * The pending marker of a session (`write-pending.<session>.json`): a second name (a hard link) for a file that already exists in the shadow directory, made by the serving process the moment it fails to make the session's owed record durable. Only its presence matters.
 * Status blocks while one exists, and no remover (the orphan pass, `finish()`, the settlement pruning) touches its session, so what the serving process still holds in memory is never discharged by a stale count; the serving process removes it, in the same lock
 * hold as the record write, once the full record is on disk. A listing error reads as blocked, never as no markers.
 */
export const pendingPath = (dir: string, session: string): string => join(dir, `write-pending.${sessionKey(session)}.json`);
const PENDING_NAME = /^write-pending\.([A-Za-z0-9_-]+)\.json$/;
export function listPending(dir: string): { keys: string[]; failed: boolean } {
  try { return { keys: readdirSync(dir).flatMap((n) => PENDING_NAME.exec(n)?.[1] ?? []).sort(), failed: false }; } catch (e) { return { keys: [], failed: (e as NodeJS.ErrnoException).code !== 'ENOENT' }; }
}
/** How long a remover waits for the tally lock: a timeout defers (the next pass tries again), it never deletes. */
const REMOVER_LOCK_WAIT_MS = 500;
/** Runs `fn` under the tally's cross-process lock (the one a tally save, a remover and the serving process's record publication all take), waiting at most `waitMs`; throws when the lock stays held. */
export const withTallyLock = <T>(dir: string, fn: () => T, waitMs: number): T => withLock(join(dir, 'write-comparisons.lock'), fn, { waitMs });
/**
 * THE WINDOW BLOCKER (`write-owed.window-lost-<session>.json`): what keeps an older reader blocked, and this version's own proof, once a window of that session is booked into an epoch. It has the shape of the tombstone the previous release writes
 * (`v: 2`, `booked_epoch`, nothing owed), in a file of its own: the serving process writes only `write-owed.<session>.json` and never this name, so none of its write paths (the lock-free one included) can drop it. Only the owner pass, the owner worker's
 * own end-of-input booking and the tally fold write it, and only the owner pass and `removeSettledOwed` remove it, always under the tally lock. It names its epoch from its first byte (there is no unstamped state), and it is written BEFORE the window is
 * booked. A real session id is 16 hex characters and the keeper's refusal session is `r` plus hex, so no session can carry the prefix.
 * `window_target` (T): the open marker's `owed` when the blocker was written (the samples accepted plus one that stands for the window). The window is booked LAST of the first T samples, so the session's settled count reaches T only once the window is
 * booked. `booked_through` and `booked_qualifying`: the settled count (and its page and link part) the owner saw when it removed the session's settled file, a copy of what it banked in the tally's `settled_before` in the same hold (the larger of the two
 * counts is the credit before the tally's own `settled` entry restarted: that entry and the credit are disjoint, so a session's total is their sum and nothing is inferred from their sizes). The window is booked iff that total >= T. `serving_pid`: the session's
 * serving process (the owner's pid when it was not known): an earlier epoch's blocker is removed only once that process is gone, since its delayed record may still come. A blocker whose window never got booked (the owner died between the two) is not a loss: the next
 * pass books it, or drops it when the marker turned into a record that closed normally.
 */
export const WINDOW_BLOCKER_PREFIX = 'window-lost-';
const blockerKey = (key: string): string => `${WINDOW_BLOCKER_PREFIX}${key}`;
const isBlockerKey = (key: string): boolean => key.startsWith(WINDOW_BLOCKER_PREFIX);
const blockerPath = (dir: string, key: string): string => owedPath(dir, blockerKey(key));
function putBlocker(dir: string, key: string, epoch: string, target: number, through: number, throughQualifying: number, servingPid: number = process.pid): void {
  writeOwed(dir, { v: 2, session: blockerKey(key), serving_pid: servingPid, owed: 0, closed: true, child_exited: true, open_until: 0, booked_epoch: epoch, window_target: target, booked_through: through, booked_qualifying: throughQualifying });
}
/** The blocker of `key` that names `epoch`: null when there is none for that epoch (none at all, or another epoch's, which is stale), `'unreadable'` when the file is there and cannot be used. */
function blockerFor(dir: string, key: string, epoch: string): OwedRecord | null | 'unreadable' {
  const b = parseOwed(blockerPath(dir, key));
  return b === null || b === 'unreadable' ? b : b.booked_epoch === epoch ? b : null;
}
/** The credit a session had settled before its tally entry restarted: the tally's `settled_before` or the blocker's copy of it, whichever is larger (they are the same number written together; one is older when a write between them was cut short). */
const anchorOf = (tally: WriteTallyFile | null | undefined, blocker: OwedRecord | null | 'unreadable' | undefined, key: string): number => Math.max(tally?.settled_before?.[key] ?? 0, blocker !== null && blocker !== undefined && blocker !== 'unreadable' ? blocker.booked_through ?? 0 : 0);
const anchorQualifyingOf = (tally: WriteTallyFile | null | undefined, blocker: OwedRecord | null | 'unreadable' | undefined, key: string): number => Math.max(tally?.settled_before_qualifying?.[key] ?? 0, blocker !== null && blocker !== undefined && blocker !== 'unreadable' ? blocker.booked_qualifying ?? 0 : 0);
/** A session's settled count: the credit banked before its tally entry restarted, the entry (credit since), and the lines nobody has folded. The three are disjoint: a sum, never a comparison of sizes. */
const settledOf = (entry: number, unfolded: number, anchor: number): number => anchor + entry + unfolded;
/**
 * Banks a session's settled entry into `settled_before` (the tally's file, in one rename, under the lock the caller holds) so the credit it holds survives an older writer's prune and the entry restarts at zero: `total` is the session's whole settled count
 * (`settledOf`), `totalQualifying` its page and link part. Nothing to do when there is no tally file or the credit is banked already.
 */
function bankSettled(dir: string, key: string, tally: WriteTallyFile | null, total: number, totalQualifying: number): void {
  if (tally === null) return;
  const entry = tally.settled?.[key] ?? 0; const entryQ = tally.settled_qualifying?.[key] ?? 0;
  if (entry === 0 && entryQ === 0 && (tally.settled_before?.[key] ?? 0) >= total && (tally.settled_before_qualifying?.[key] ?? 0) >= totalQualifying) return;
  (tally.settled_before ??= {})[key] = Math.max(tally.settled_before[key] ?? 0, total);
  if (totalQualifying > 0) (tally.settled_before_qualifying ??= {})[key] = Math.max(tally.settled_before_qualifying?.[key] ?? 0, totalQualifying);
  if (tally.settled) { delete tally.settled[key]; if (!Object.keys(tally.settled).length) delete tally.settled; }
  if (tally.settled_qualifying) { delete tally.settled_qualifying[key]; if (!Object.keys(tally.settled_qualifying).length) delete tally.settled_qualifying; }
  tally.updated_at = new Date().toISOString();
  const tmp = `${writeTallyPath(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(tally) + '\n', { mode: 0o600 });
  flushFile(tmp);
  renameSync(tmp, writeTallyPath(dir));
  flushDirectory(dir);
}
/**
 * The serving process of a session's owed record (the owner's own pid when there is no record): the blocker carries it. A record that cannot be read is not "no record": it throws, so the fold that asked fails and
 * is retried, rather than stamping this worker's pid on a blocker whose session is still being served by another process.
 */
function servingPidOf(dir: string, key: string): number {
  const o = parseOwed(owedPath(dir, key));
  if (o === 'unreadable') throw new Error('owed record unreadable');
  return o === null ? process.pid : o.serving_pid;
}
/**
 * Under the tally lock, makes sure `key` has a blocker for `epoch` BEFORE its window is booked: the one that exists; or, over another epoch's blocker whose window was never booked, that blocker taken over for `epoch` (same target and anchor); or a new one whose target
 * is the owed count of the session's open marker (re-read here). Null when nothing could be held: a window another epoch's blocker already booked (it is that epoch's window, never this one's), no marker any more (it was replaced by a record that closed normally, so
 * there is no window to book), a manifest that no longer names `epoch`, an unreadable file, a lock that stayed held.
 */
export function holdBlocker(dir: string, key: string, epoch: string): OwedRecord | null {
  try {
    return withTallyLock(dir, () => {
      const have = blockerFor(dir, key, epoch);
      if (have === 'unreadable') return null;
      if (have !== null) return have;
      if (readEpoch(dir)?.epoch_id !== epoch) return null;
      const prior = parseOwed(blockerPath(dir, key)); // another epoch's (blockerFor found none for this one)
      if (prior === 'unreadable') return null;
      if (prior !== null) {
        const tally = loadTally(dir);
        if (settledOf(tally?.settled?.[key] ?? 0, 0, anchorOf(tally, prior, key)) >= (prior.window_target ?? 0)) return null; // booked in its own epoch: not a window of this one, and its blocker is not overwritten
        putBlocker(dir, key, epoch, prior.window_target ?? 0, prior.booked_through ?? 0, prior.booked_qualifying ?? 0, prior.serving_pid);
        return blockerFor(dir, key, epoch) as OwedRecord;
      }
      const rec = parseOwed(join(dir, `write-owed.${key}.json`));
      if (rec === null || rec === 'unreadable' || rec.v !== 2 || rec.booked_epoch !== undefined) return null;
      putBlocker(dir, key, epoch, rec.owed, 0, 0, rec.serving_pid);
      return blockerFor(dir, key, epoch) as OwedRecord;
    }, REMOVER_LOCK_WAIT_MS);
  } catch { return null; } // silent-read-ok: no window is booked now; the pass tries again
}
/**
 * The one way a session's owed file is removed: under the tally lock, with no marker for the session, the record on disk read again (a republished, higher record is not the one that was judged settled) and the tally's settled count read again, the file is
 * removed only if everything it owes is settled (and, for the worker's own `finish()`, it was closed). The serving process publishes a record and clears its marker under the same lock. False when the file stays: unsettled, marked, unreadable or the lock stayed held.
 * In the same lock hold the session's blocker for `epoch` is brought up to date BEFORE the file goes: the settled count is banked in the tally's `settled_before` (one rename that also restarts the entry, so the credit outlives an older writer's prune and is never added to the entry) and copied into the blocker's anchor; a blocker whose window was never booked, and whose marker is
 * now a record that closed normally, is dropped (no window was lost); a settled open marker no blocker accounts for (an older build left it) is claimed for `epoch`, fail closed, as the older builds stamped it. A marker a blocker of ANOTHER epoch accounts for is the
 * window of that epoch: it is removed without a claim. A tombstone in the session file (an older build's) stays as it is.
 */
function removeSettledOwed(dir: string, key: string, requireClosed: boolean, epoch: string): boolean {
  try {
    return withTallyLock(dir, () => {
      const pending = listPending(dir);
      if (pending.failed || pending.keys.includes(key)) return false;
      const rec = parseOwed(join(dir, `write-owed.${key}.json`));
      if (rec === null) return true;
      if (rec === 'unreadable' || (requireClosed && !rec.closed)) return false;
      if (rec.booked_epoch !== undefined) return (loadTally(dir)?.settled?.[key] ?? 0) >= rec.owed; // an older build's tombstone in the session file: it stays for its epoch
      const blocker = parseOwed(blockerPath(dir, key));
      if (blocker === 'unreadable') return false;
      const tally = loadTally(dir); // the credit banked before the entry restarted counts whatever epoch the blocker names: settlement is the ledger of every epoch
      const settled = settledOf(tally?.settled?.[key] ?? 0, 0, anchorOf(tally, blocker, key)); const settledQ = settledOf(tally?.settled_qualifying?.[key] ?? 0, 0, anchorQualifyingOf(tally, blocker, key));
      if (settled < rec.owed) return false;
      if (blocker !== null && blocker.booked_epoch === epoch) {
        const target = blocker.window_target ?? 0;
        if (settled < target) removeOwed(dir, blockerKey(key)); // never booked, and the marker closed normally
        else { // booked: the credit is banked in the tally (one rename that also restarts the entry), then copied into the blocker, before the session's file goes
          bankSettled(dir, key, tally, settled, settledQ);
          if ((blocker.booked_through ?? 0) < settled || (blocker.booked_qualifying ?? 0) < settledQ) putBlocker(dir, key, epoch, target, Math.max(blocker.booked_through ?? 0, settled), Math.max(blocker.booked_qualifying ?? 0, settledQ), blocker.serving_pid);
        }
      } else if (blocker === null && rec.v === 2) {
        if (readEpoch(dir)?.epoch_id !== epoch) return false; // the epoch moved: the next owner decides
        bankSettled(dir, key, tally, settled, settledQ);
        putBlocker(dir, key, epoch, rec.owed, settled, settledQ, rec.serving_pid);
      }
      removeOwed(dir, key); return true;
    }, REMOVER_LOCK_WAIT_MS);
  } catch { return false; } // silent-read-ok: the file stays; the next pass tries again, and status reads its deficit
}

/**
 * Removes a tombstone of an EARLIER epoch (it goes with its epoch), under the tally lock and judged on the record read again there: the serving process may have republished a higher obligation for the session since the listing, and that
 * record is not a tombstone (or names this epoch, or has a marker) and stays. The manifest is read again there too: a pass that began in an epoch the manifest has since left removes nothing, since what it lists may be the new epoch's own
 * blocker. False when the file stays.
 */
function removeStaleTomb(dir: string, key: string, epoch: string): boolean {
  try {
    return withTallyLock(dir, () => {
      const pending = listPending(dir); const session = isBlockerKey(key) ? key.slice(WINDOW_BLOCKER_PREFIX.length) : key; // the serving process names its pending marker for the session, not for a blocker file
      if (pending.failed || pending.keys.includes(key) || pending.keys.includes(session)) return false;
      if (session !== key && existsSync(join(dir, `write-owed.${session}.json`))) return false; // the session's own file still stands: the blocker's credit anchor is still what settles it
      const rec = parseOwed(join(dir, `write-owed.${key}.json`));
      if (rec === null) return true;
      if (rec === 'unreadable' || rec.v !== 2 || rec.booked_epoch === undefined || rec.booked_epoch === epoch) return false;
      if (readEpoch(dir)?.epoch_id !== epoch) return false; // the epoch moved after this pass began: this may be the new epoch's blocker, and the new owner decides
      if (session !== key && rec.serving_pid > 1 && running(rec.serving_pid)) return false; // the session's serving process is alive: its delayed record (the cumulative count) may still be published, and this blocker is what keeps the samples it already settled from being booked again
      removeOwed(dir, key); return true;
    }, REMOVER_LOCK_WAIT_MS);
  } catch { return false; } // silent-read-ok: the file stays; the next pass tries again
}

/** The most samples one `recordLost` call stands for (the child's own cap on a `dropped` count). */
const MAX_LOST_PER_RECORD = 10_000;
/**
 * Samples the serving process lost (a refused send, a read-back abandoned at disconnect) are never written into the tally by that process (a locked write could stall it): each is one `{epoch_id, reason, session}` line appended,
 * with no lock, to its own file; the owner child folds them in. `session` names the session whose obligation the line settles; the serving process's own losses were never owed, so they carry `''` (they settle nothing). A line with no
 * `session` key is an older writer's: its obligation is unknown (the tally's `legacy_lines`). True only when the line and its directory entry are flushed to disk; false otherwise.
 */
export const lostPath = (dir: string, pid: number): string => join(dir, `write-lost.${pid}.jsonl`);
/** Appends `n` lost lines (no flush). Throws when the append failed. */
function appendLostLines(dir: string, epoch: string, reason: string, n: number, session: string, numbered?: { w: string; from: number }): void {
  // A numbered line (`w`, `n`) is added once by the owner however often it is written: a partial append that is retried whole leaves the same numbers twice, and the second copy of each is skipped.
  const text = numbered ? Array.from({ length: n }, (_, i) => JSON.stringify({ epoch_id: epoch, reason, session, w: numbered.w, n: numbered.from + i }) + '\n').join('') : (JSON.stringify({ epoch_id: epoch, reason, session }) + '\n').repeat(n);
  appendFileSync(lostPath(dir, process.pid), text, { flag: 'a', mode: 0o600 });
}
function flushLostFile(dir: string): void { flushFile(lostPath(dir, process.pid)); flushDirectory(dir); }
export function recordLost(dir: string, epoch: string, reason: string, n = 1, session = ''): boolean {
  if (!Number.isInteger(n) || n < 1 || n > MAX_LOST_PER_RECORD) return false; // one append stands for exactly n samples: a larger count is `recordLostCount`'s (it splits it), never cut here
  try { appendLostLines(dir, epoch, reason, n, session); flushLostFile(dir); return true; } catch { return false; } // silent-read-ok: false is the answer, never a pass: the sampler then carries the count on its next line
}
/** Records `n` lost samples in appends of at most `MAX_LOST_PER_RECORD`; returns how many were recorded (all of them, or the ones before the first append that failed), so a caller keeps exactly the remainder. */
export function recordLostCount(dir: string, epoch: string, reason: string, n: number, session = ''): number {
  let done = 0;
  while (done < n) { const k = Math.min(n - done, MAX_LOST_PER_RECORD); if (!recordLost(dir, epoch, reason, k, session)) break; done += k; }
  return done;
}
/** One line of a lost file: its reason, whether it names the epoch asked for, and its session (`null`: no `session` key at all, an older writer's). */
interface LostLine { reason: string; thisEpoch: boolean; epoch: string | null; session: string | null; w: string | null; n: number | null }
/** The lost lines past what `applied` took, per file: the complete lines' end offset and the lines (every epoch's: another epoch's settle their session but are no outcome here; a line that is not readable, or an unfinished one whose writer is dead, counts as `lost_unreadable`). */
function readLost(dir: string, epoch: string, applied: Record<string, number> = {}): Array<{ name: string; end: number; lines: LostLine[]; unreadable?: true }> {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => /^write-lost\.\d+\.jsonl$/.test(n)); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : [{ name: '', end: 0, lines: [], unreadable: true }]; } // a directory that is gone has nothing to fold; one that cannot be listed is unresolved, never empty
  return names.flatMap((name) => {
    try {
      const buf = readFileSync(join(dir, name)); const from = applied[name] ?? 0; const cut = buf.lastIndexOf(10) + 1;
      const open = buf.length > Math.max(cut, from); // bytes after the last newline: a line still being appended, or one a crash cut short
      const end = open && !running(Number(/\d+/.exec(name)![0])) ? buf.length : cut; // its writer is gone: it ends as one lost_unreadable (its offset moves past it); while the writer lives it is unresolved
      if (end <= from && !open) return [];
      const lines = buf.subarray(from, end).toString('utf8').split('\n').filter(Boolean).map((l): LostLine => {
        try { const e = JSON.parse(l); return { reason: String(e?.reason), thisEpoch: e?.epoch_id === epoch, epoch: typeof e?.epoch_id === 'string' ? e.epoch_id : null, session: typeof e?.session === 'string' ? e.session : null, w: typeof e?.w === 'string' ? e.w : null, n: Number.isSafeInteger(e?.n) ? e.n : null }; } catch { return { reason: 'lost_unreadable', thisEpoch: true, epoch: null, session: '', w: null, n: null }; }
      });
      return [{ name, end: Math.max(end, from), lines, ...(open && end < buf.length ? { unreadable: true as const } : {}) }];
    } catch { return [{ name, end: 0, lines: [], unreadable: true }]; } // a file that cannot be read stays unfolded and unresolved: status reads it as no evidence
  });
}
/** The lines of one file this tally has not taken, without the second copies: a numbered line at or below its writer's highest number taken is a copy of one already counted. `seen` moves forward as lines are kept. */
function firstCopies(lines: LostLine[], seen: Record<string, number>): LostLine[] {
  return lines.filter((x) => { if (x.w === null || x.n === null) return true; if (x.n <= (seen[x.w] ?? 0)) return false; seen[x.w] = x.n; return true; });
}
/**
 * Lost samples that no tally has taken yet: `outcomes` of `epoch` (status reads any as no evidence, like a standing in-flight mark) and, per session, the samples every epoch's lines would settle.
 * `unreadable` is true when a journal could not be read: `bySession` then lacks that journal's lines, so a pass that books from it would book samples a later fold counts again.
 */
export function unfoldedLines(dir: string, epoch: string | null, taken?: Record<string, number>, lineSeq?: Record<string, number>): { outcomes: number; bySession: Record<string, number>; qualifyingBySession: Record<string, number>; unreadable: boolean } {
  const out = { outcomes: 0, bySession: {} as Record<string, number>, qualifyingBySession: {} as Record<string, number>, unreadable: false };
  if (epoch === null) return out;
  const seen = { ...lineSeq };
  for (const l of readLost(dir, epoch, taken)) {
    const lines = firstCopies(l.lines, seen);
    if (l.unreadable) out.unreadable = true;
    out.outcomes += lines.filter((x) => x.thisEpoch).length + (l.unreadable ? 1 : 0);
    for (const x of lines) {
      if (!x.session) continue;
      out.bySession[x.session] = (out.bySession[x.session] ?? 0) + 1;
      if (QUALIFYING_LINE_REASONS.has(x.reason)) out.qualifyingBySession[x.session] = (out.qualifyingBySession[x.session] ?? 0) + 1;
    }
  }
  return out;
}
export function unfoldedLost(dir: string, epoch: string | null, taken?: Record<string, number>): number { return unfoldedLines(dir, epoch, taken).outcomes; }

/** Identifies the published tally file (inode, size, modification time): a rename publishes a new one. */
function tallyIdentity(dir: string): string {
  try { const s = statSync(writeTallyPath(dir), { bigint: true }); return `${s.ino}:${s.size}:${s.mtimeNs}`; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'error'; }
}
const SNAPSHOT_TRIES = 3;
/**
 * What status reads for write comparisons, in the one order that can only over-block: the tally, then the lost lines no tally has folded, then the owed files; then the tally's identity again. A session's samples are settled in a tally save
 * (or a lost line the owner folds into one), and an owed file is removed only after its settlement is in a tally read back from disk, so a scan that finds a file gone follows a newer tally than the one it read first: the identity
 * differs, and the read is repeated (at most `SNAPSHOT_TRIES`), then read as unresolved (`unstable`), never as measured. `outstanding`: sessions whose owed count is above what is settled (or whose file cannot be read), by name.
 * Reading the owed files first could let a later settled sample hide an earlier unsettled one.
 */
export interface WriteSnapshot { writes: WriteTallyFile | null; unfolded: number; outstanding: string[]; unstable: boolean; windowFiles: number }
export function readWriteSnapshot(dir: string, epoch: string | null, between?: (stage: 'tally' | 'lines' | 'owed') => void): WriteSnapshot { // `between`: a seam for tests, called after each read
  for (let attempt = 0; attempt < SNAPSHOT_TRIES; attempt++) {
    const before = tallyIdentity(dir);
    const writes = readWriteTally(dir, epoch); between?.('tally');
    const lines = unfoldedLines(dir, epoch, writes?.lost_applied, writes?.line_seq); between?.('lines');
    const pending = epoch === null ? { keys: [], failed: false } : listPending(dir); // before the owed files: a record is published before its marker is cleared, so a scan that finds no marker reads the published record next
    const owed = epoch === null ? { keys: [], failed: false } : listOwed(dir); between?.('owed');
    const windows = new Set<string>(); const outstanding: string[] = [...(owed.failed ? ['write-owed.*'] : []), ...(pending.failed ? ['write-pending.*'] : []), ...pending.keys.map((k) => `write-pending.${k}.json`)];
    const blockers = new Map<string, OwedRecord | 'unreadable'>(); // the window blockers by session: a window is lost once the session's settled count (or the blocker's anchor) reaches its target
    for (const key of owed.keys) if (isBlockerKey(key)) { const b = readOwed(dir, key); if (b !== null) blockers.set(key.slice(WINDOW_BLOCKER_PREFIX.length), b); }
    for (const key of owed.keys) {
      if (pending.keys.includes(key)) continue; // counted once, by its marker
      const rec = readOwed(dir, key);
      if (rec === null) continue; // removed since the listing: settled before the tally's identity is read again
      if (rec === 'unreadable') { outstanding.push(`write-owed.${key}.json`); continue; }
      if (rec.booked_epoch !== undefined && rec.booked_epoch !== epoch) continue; // a tombstone or blocker of another epoch: nothing of this one
      if (isBlockerKey(key)) { // a blocker: a lost window once it is booked (an unbooked one is the session's open marker, which is outstanding on its own)
        const session = key.slice(WINDOW_BLOCKER_PREFIX.length);
        if (settledOf(writes?.settled?.[session] ?? 0, lines.bySession[session] ?? 0, anchorOf(writes, rec, session)) >= (rec.window_target ?? 0)) windows.add(session);
        continue;
      }
      const anchor = anchorOf(writes, blockers.get(key), key); // the credit banked before the entry restarted (the session's blocker, whatever epoch it names): it outlives a settled entry an older writer pruned
      if (rec.owed > settledOf(writes?.settled?.[key] ?? 0, lines.bySession[key] ?? 0, anchor)) outstanding.push(`write-owed.${key}.json`);
      else if (rec.v === 2) { const b = blockers.get(key); if (b === undefined || (b !== 'unreadable' && b.booked_epoch === epoch)) windows.add(key); } // a tombstone in the session file, or a settled marker nothing accounts for; a blocker of another epoch owns the marker: not this epoch's window
    }
    const again = listOwed(dir); const moved = !owed.failed && (again.failed || again.keys.some((k) => isBlockerKey(k) && !owed.keys.includes(k))); // a blocker published since the listing: a settled marker may have moved to it without a tally write, and a scan that listed the marker never saw the blocker
    if (!moved && tallyIdentity(dir) === before) return { writes, unfolded: lines.outcomes, outstanding, unstable: false, windowFiles: windows.size };
  }
  return { writes: readWriteTally(dir, epoch), unfolded: 0, outstanding: [], unstable: true, windowFiles: 0 };
}

const MAX_KEYS = 64;
/** The one reason a full map never folds into `other`: status reads it as a lost window of unknown size (never measured), so it must stay countable (the map may hold one key more than `MAX_KEYS` for it). */
export const WINDOW_LOST_REASON = 'write_window_lost';
/** Lost-line reasons that settle page and link writes (`settled_qualifying`); a line of any other reason settles only `settled`, so the qualifying part of a session is never overstated. A lost window's one counts: the open marker's extra sample is counted as a page and link write. */
const QUALIFYING_LINE_REASONS: ReadonlySet<string> = new Set(['pipe_unflushed', 'receipt_orphaned', WINDOW_LOST_REASON]);
const bump = (map: Record<string, number>, key: string, n: number): void => { const k = key in map || Object.keys(map).length < MAX_KEYS || key === WINDOW_LOST_REASON ? key : 'other'; map[k] = (map[k] ?? 0) + n; };
function applyVerdict(file: WriteTallyFile, outcome: WriteOutcome, key: string | undefined, n: number): void {
  file[outcome] += n;
  const name = typeof key === 'string' && /^[A-Za-z][A-Za-z0-9_:]{0,59}$/.test(key) ? key : 'other'; // a name, never text that could hold content
  if (outcome === 'capability_missing') bump(file.capability_missing_by_family, name, n);
  if (outcome === 'uncomparable') bump(file.uncomparable_by_reason, name, n);
}
export const running = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** A save that keeps failing for this long, with outcomes it still holds, ends the child (the supervisor restarts it, and the next owner books what it never settled). */
export const SAVE_FAILURE_EXIT_MS = 60_000;
const NO_EPOCH_REASON = 'no_epoch';
const RETIRED_REASON = 'epoch_retired';
interface Batch { seq: number; delta: WriteTallyFile; credit: number; creditQualifying: number; windowCredit: number; ending: boolean }

/**
 * The write tally (swap criterion 5). The file changes only inside one cross-process lock, as a read-modify-write of THIS child's unsaved verdicts
 * (`pending` batches) onto what the file holds now: a held snapshot is never written back, so nothing another child saved can be overwritten. Only the child that owns the Rust store has an epoch (one fixed id for its life: `epoch()` is the owner's `curEpoch`, null for a client), so a client child records nothing in the tally and a retired epoch's results can never be added to another epoch's file (a save also refuses a file whose manifest epoch is not this child's). A save
 * is the temp file flushed, renamed over the file and the directory flushed; only then do its batches count as saved. A save that fails, at any point
 * (even after the rename, where it may have landed), keeps its batches, and `applied` (the last batch number of this child the file has taken) makes the
 * retry add each batch once. A replay publishes its pid in `in_flight` (`begin`, true only when that is durable on disk; the caller refuses the replay on
 * false) and only its own verdict, or the recovery of a dead pid, removes it. A mark whose replay never wrote a verdict is one that could have been
 * a mismatch, so a dead pid's counts `unexplained_difference`: a hard kill during a replay fails criterion 5 for the epoch.
 *
 * Settling. Each verdict is noted with the credit it settles: how many of the session's owed samples (`write-owed.<session>.json`) it stands for. The credit is part of the verdict's batch, so one rename takes both or neither (`settled[session]`).
 * A client child and a child whose epoch was retired cannot write the tally: their verdicts become lost lines tagged with the session (`no_epoch`, `epoch_retired`), which the owner folds into `settled` (any epoch's) and into the outcomes (this epoch's only).
 * Each such line is numbered (`w`, `n`) when its batch is first tried, and a retry writes the same numbers: after an append that failed part-way, or that succeeded and whose flush failed, the owner adds each number once, so no partial write can credit a line twice.
 */
export class WriteTally {
  private pending: Batch[] = [];
  private sealed = 0; // the first `sealed` pending batches were in a save that may have landed: never added to, until a durable save takes them
  private seq = 0;
  private retired = false; // the manifest names another epoch than this child's: its verdicts can only be lost lines
  private readonly journal = new Map<string, number>(); // lost lines not yet appended: `reason\0credited` -> count
  private nextLine = 0; // the last line number given to a lost line
  private attempt: { k: string; from: number; n: number } | null = null; // the batch being written: its numbers stay the same on every retry
  private failingSince: number | null = null;
  private readonly id: string;
  private readonly key: string;
  constructor(private readonly dir: string, private readonly epoch: () => string | null, private readonly alive: () => boolean = () => existsSync(dir), private readonly pid: number = process.pid, session = '', private readonly now: () => number = Date.now) {
    this.id = `${pid}.${randomBytes(4).toString('hex')}`;
    this.key = session ? sessionKey(session) : '';
  }
  private journalSize(): number { let n = 0; for (const v of this.journal.values()) n += v; return n; }
  private holding(): boolean { return this.pending.length > 0 || this.journal.size > 0; }
  /** The result of a save, remembered: a save that fails while outcomes are still held starts the clock `stuckMs` reads. */
  private track(ok: boolean): boolean {
    if (ok) { if (!this.holding()) this.failingSince = null; } else if (this.holding()) this.failingSince ??= this.now();
    return ok;
  }
  /** How long saves have been failing in a row while this child holds outcomes it could not save (0 when they are not). */
  stuckMs(): number { return this.failingSince === null ? 0 : this.now() - this.failingSince; }
  private credit(file: WriteTallyFile, key: string, n: number, qualifying = 0): void {
    (file.settled ??= {})[key] = (file.settled[key] ?? 0) + n;
    if (qualifying > 0) (file.settled_qualifying ??= {})[key] = (file.settled_qualifying[key] ?? 0) + Math.min(n, qualifying);
  }
  /** One locked read-modify-write: dead pids recovered, then this child's unsaved batches, then `change`. False when nothing was saved (the batches are kept). `fresh`: a mark under this pid is from an earlier process that had it. */
  private update(change?: (file: WriteTallyFile) => void, fresh = false): boolean {
    const epoch = this.epoch();
    if (epoch === null || !this.alive()) return false;
    if (this.retired) return false;
    const batches = this.pending; let renamed = false; let retiredNow = false;
    try {
      withLock(join(this.dir, 'write-comparisons.lock'), () => {
        // Only a manifest that names ANOTHER epoch retires this child: one that cannot be read (a torn read, an I/O error) is a failed save, tried again, never a verdict that this child's epoch is gone.
        const current = readEpoch(this.dir);
        if (current === null) throw new Error('epoch manifest unreadable');
        if (current.epoch_id !== epoch) { retiredNow = true; return; } // a child of a retired epoch must not replace the current epoch's file
        const saved = loadTally(this.dir);
        // A new epoch starts its outcomes at zero and keeps the settlement ledger whole: `settled`, the cursors that stop its sources being added again (`lost_applied`, `applied`) travel together.
        const file = saved?.epoch_id === epoch ? saved : { ...blank(epoch), ...(saved?.settled ? { settled: { ...saved.settled } } : {}), ...(saved?.settled_qualifying ? { settled_qualifying: { ...saved.settled_qualifying } } : {}), ...(saved?.settled_before ? { settled_before: { ...saved.settled_before } } : {}), ...(saved?.settled_before_qualifying ? { settled_before_qualifying: { ...saved.settled_before_qualifying } } : {}), ...(saved?.lost_applied ? { lost_applied: { ...saved.lost_applied } } : {}), ...(saved?.line_seq ? { line_seq: { ...saved.line_seq } } : {}), ...(saved?.applied ? { applied: { ...saved.applied } } : {}) };
        file.applied ??= {};
        const dead = file.in_flight.filter((p) => (p === this.pid ? fresh : !running(p)));
        for (const p of dead) applyVerdict(file, 'unexplained_difference', undefined, 1);
        file.in_flight = file.in_flight.filter((p) => !dead.includes(p));
        for (const id of Object.keys(file.applied)) if (id !== this.id && !running(Number.parseInt(id, 10))) delete file.applied[id];
        const todo = batches.filter((b) => b.seq > (file.applied![this.id] ?? 0));
        const lost = readLost(this.dir, epoch, file.lost_applied).filter((l) => l.end > (file.lost_applied?.[l.name] ?? 0) && (l.lines.some((x) => x.thisEpoch || x.session) || l.unreadable)); // the serving processes' lost samples, taken once under the same lock; a file holding only another epoch's lines that settle no session has nothing to fold: it is left as it is (no tally is written for it)
        if (!change && !dead.length && !todo.length && !lost.length) { if (this.sealed > 0) { flushFile(writeTallyPath(this.dir)); flushDirectory(this.dir); } return; } // a save that may have landed (renamed, directory flush failed) is durable only once this flush has succeeded
        file.lost_applied ??= {};
        const credited = new Set<string>(); const windowLines = new Map<string, string>(); // sessions a client child's lost line says lost a window, with the epoch the line names
        file.line_seq ??= {};
        for (const l of lost) {
          for (const x of firstCopies(l.lines, file.line_seq)) {
            if (x.thisEpoch) { applyVerdict(file, LOST_NONQUALIFYING.has(x.reason) ? 'capability_missing' : 'uncomparable', x.reason, 1); if (x.session === null) file.legacy_lines = (file.legacy_lines ?? 0) + 1; }
            if (x.session) { this.credit(file, x.session, 1, QUALIFYING_LINE_REASONS.has(x.reason) ? 1 : 0); credited.add(x.session); if (x.reason === WINDOW_LOST_REASON && x.epoch !== null) windowLines.set(x.session, x.epoch); }
          }
          file.lost_applied[l.name] = l.end;
        }
        for (const b of todo) {
          for (const o of OUTCOMES) file[o] += b.delta[o];
          for (const [k, n] of Object.entries(b.delta.capability_missing_by_family)) bump(file.capability_missing_by_family, k, n);
          for (const [k, n] of Object.entries(b.delta.uncomparable_by_reason)) bump(file.uncomparable_by_reason, k, n);
          if (b.ending) file.in_flight = file.in_flight.filter((p) => p !== this.pid);
          if (b.credit > 0 && this.key) { this.credit(file, this.key, b.credit, b.creditQualifying); credited.add(this.key); }
          file.applied[this.id] = b.seq;
        }
        for (const [session, lineEpoch] of windowLines) { // a client child has no epoch and cannot hold a blocker: the owner holds it here, for the epoch the line names, before the credit is saved, so a later epoch can never read the settled marker as its own
          const have = parseOwed(blockerPath(this.dir, session));
          if (have === 'unreadable') throw new Error('window blocker unreadable'); // not knowing whether the blocker is there, the fold commits nothing (no credit, no journal cursor): the lines are read again on the next pass, and the lookup with them
          if (have !== null && (have.booked_epoch === lineEpoch || lineEpoch !== epoch)) continue; // one for that epoch is there; or an older epoch's line never replaces another epoch's blocker
          putBlocker(this.dir, session, lineEpoch, 1, have?.booked_through ?? 0, have?.booked_qualifying ?? 0, servingPidOf(this.dir, session)); // intent only: no credit is published before the tally that holds it is renamed (the owner's cleanup banks the credit from the committed ledger)
        }
        for (const w of Object.keys(file.line_seq)) if (w !== this.id && !running(Number.parseInt(w, 10))) delete file.line_seq[w]; // a gone writer's numbers: its file was taken to the end above
        if (!Object.keys(file.line_seq).length) delete file.line_seq;
        if (file.settled || file.settled_before) { // a session whose owed file is gone is settled for good (it was credited on an earlier save): its entry goes; the credit banked before it restarted stays while the session's blocker does
          const owed = listOwed(this.dir); const pending = listPending(this.dir); // a session with a marker is not gone: the serving process still holds an obligation its record does not state
          const gone = (k: string): boolean => !owed.keys.includes(k) && !owed.keys.includes(blockerKey(k)) && !pending.keys.includes(k) && !credited.has(k);
          if (!owed.failed && !pending.failed) {
            for (const k of Object.keys(file.settled ?? {})) if (gone(k)) { delete file.settled![k]; if (file.settled_qualifying) delete file.settled_qualifying[k]; }
            for (const k of Object.keys(file.settled_before ?? {})) if (gone(k)) { delete file.settled_before![k]; if (file.settled_before_qualifying) delete file.settled_before_qualifying[k]; }
          }
          if (file.settled_qualifying && !Object.keys(file.settled_qualifying).length) delete file.settled_qualifying;
          if (file.settled_before && !Object.keys(file.settled_before).length) delete file.settled_before;
          if (file.settled_before_qualifying && !Object.keys(file.settled_before_qualifying).length) delete file.settled_before_qualifying;
        }
        change?.(file);
        file.updated_at = new Date().toISOString();
        const tmp = `${writeTallyPath(this.dir)}.${this.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(file) + '\n', { mode: 0o600 });
        flushFile(tmp);
        renameSync(tmp, writeTallyPath(this.dir)); renamed = true;
        flushDirectory(this.dir);
      });
      if (retiredNow) { this.retire(); return false; }
      this.pending = []; this.sealed = 0;
      return this.track(true);
    } catch { if (renamed) this.sealed = batches.length; return this.track(false); } // silent-read-ok: false is the answer, never a pass: begin() refuses the replay, and note() keeps the unsaved batches for the next save
  }
  /**
   * This child's epoch is not the manifest's any more. Its verdicts can never be added to the tally, so each unsaved credit becomes lost lines of its own epoch (`epoch_retired`) that the owner of the current epoch folds into `settled`.
   * A batch the current file already took (a save that landed, then failed to flush) is left out: its credit exists once. Until the current file can be read to tell, the batches stay.
   */
  private retire(): void { this.retired = true; this.reconcileRetired(); }
  private reconcileRetired(): boolean {
    if (this.pending.length === 0) return true;
    let taken = 0;
    try { taken = loadTally(this.dir)?.applied?.[this.id] ?? 0; } catch { return false; } // silent-read-ok: an unreadable file cannot say which batches it took; they stay until it can
    for (const b of this.pending) if (b.seq > taken && b.credit - b.windowCredit > 0 && this.key) this.addJournal(RETIRED_REASON, true, b.credit - b.windowCredit); // the window's credit is not retired credit: its verdict was never saved, so the next epoch's owner books it
    this.pending = []; this.sealed = 0;
    return true;
  }
  private addJournal(reason: string, credited: boolean, n: number): void { if (n > 0) this.journal.set(`${reason}\0${credited ? 1 : 0}`, (this.journal.get(`${reason}\0${credited ? 1 : 0}`) ?? 0) + n); }
  /**
   * The lost lines of a client child (no epoch of its own) or a retired child, written once the flusher or a save asks: one append per reason, never one durable write per verdict. The tally file itself is not touched.
   * With no epoch on disk yet a client's count waits for the next flush. True when nothing is left to write (or the shadow directory is gone).
   */
  private flushJournal(): boolean {
    if (this.retired && !this.reconcileRetired()) return this.track(false);
    if (!this.alive()) { this.journal.clear(); this.attempt = null; return true; }
    const keys = [...this.journal.keys()]; if (this.attempt && keys.includes(this.attempt.k)) keys.splice(keys.indexOf(this.attempt.k), 1), keys.unshift(this.attempt.k); // the batch that was being written goes first, with its own numbers
    for (const k of keys) {
      const [reason, credited] = k.split('\0') as [string, string];
      for (let left = this.journal.get(k) ?? 0; left > 0; left = this.journal.get(k) ?? 0) {
        const epoch = this.retired ? this.epoch() : readEpoch(this.dir)?.epoch_id;
        if (epoch === null || epoch === undefined) return this.track(false);
        if (!this.attempt || this.attempt.k !== k) { const n = Math.min(left, MAX_LOST_PER_RECORD); this.attempt = { k, from: this.nextLine + 1, n }; this.nextLine += n; }
        const { from, n } = this.attempt;
        try { appendLostLines(this.dir, epoch, reason, n, credited === '1' ? this.key : '', { w: this.id, from }); flushLostFile(this.dir); } catch { return this.track(false); } // a failure keeps the batch and its numbers: the retry writes them all again, and the owner takes each number once
        this.attempt = null;
        if (left - n > 0) this.journal.set(k, left - n); else this.journal.delete(k);
      }
    }
    return this.track(true);
  }
  /** Writes the lost lines a client or retired child holds (the 2 s flusher calls it); true when none is left. */
  flush(): boolean { return this.flushJournal(); }
  /**
   * Books `missing` unsettled samples of a gone session as lost lines tagged with it. Only the lost page and link writes count against the share: the owed qualifying count less the qualifying part already settled (`settledQualifying`; a record with no qualifying
   * count: all of them) is `receipt_orphaned`, the rest is `receipt_orphaned_nonqualifying`. `window` (1 for an open marker whose window is not booked yet, else 0) is one of the page and link writes: `write_window_lost`. It is booked after the first `head` samples
   * (`head` counts it: the samples up to the blocker's target), so the settled count reaches the target exactly when the window is booked; the rest of the samples follow. Each part is lines tagged with the session, so a retry after one part landed recomputes
   * the rest from what is on disk and books nothing twice. False when a part could not be written (the file stays).
   */
  private bookOrphan(rec: OwedRecord, key: string, missing: number, epoch: string, settledQualifying: number, window: number, head = missing): boolean {
    const win = Math.min(window, missing);
    const qualifying = Math.max(win, rec.owed_qualifying === undefined ? missing : Math.min(missing, Math.max(0, rec.owed_qualifying - settledQualifying)));
    const plain = qualifying - win; const other = missing - qualifying;
    const first = win > 0 ? Math.min(Math.max(head, 1), missing) : 0; // the samples up to and including the window
    const headPlain = Math.min(plain, Math.max(0, first - 1)); const headOther = Math.max(0, first - 1 - headPlain);
    const steps: Array<[string, number]> = win > 0 ? [['receipt_orphaned', headPlain], ['receipt_orphaned_nonqualifying', headOther], [WINDOW_LOST_REASON, win], ['receipt_orphaned', plain - headPlain], ['receipt_orphaned_nonqualifying', other - headOther]] : [['receipt_orphaned', plain], ['receipt_orphaned_nonqualifying', other]];
    for (const [reason, n] of steps) if (n > 0 && recordLostCount(this.dir, epoch, reason, n, key) < n) return false;
    return true;
  }
  /**
   * The obligations and receipts of sessions that are gone, settled by an owner worker (one with an epoch). A session's owed file is orphaned when its child was seen to exit, its child pid is not running, it was closed more than 10 minutes ago, or its serving pid is gone and it is older than
   * that. What it never settled (`owed` less `settled` and the lines no tally has folded yet) becomes `uncomparable` `receipt_orphaned` lines tagged with the session, and the file is removed only once a tally read back from disk shows the session settled: a closed file
   * whose samples are all settled is removed whoever settled them. A worker whose own epoch is no longer the manifest's settles nothing (what it booked would be another epoch's lines, and what it removed would be gone). Write receipts of older versions are settled the same way, by
   * their whole sent count. Cost: one listing of the shadow directory per call (at start, at each save and every 10 s), one read per file found.
   */
  private obligations(): void {
    const epoch = this.epoch();
    if (epoch === null || !this.alive() || this.retired || readEpoch(this.dir)?.epoch_id !== epoch) return;
    try {
      const names = readdirSync(this.dir);
      const pending = listPending(this.dir); if (pending.failed) return; // a marker that cannot be listed settles nothing
      let booked = false; const removable: string[] = []; const stale: string[] = [];
      let tally: WriteTallyFile | null = null; try { tally = loadTally(this.dir); } catch { return; } // silent-read-ok: a tally that cannot be read settles nothing now
      const lines = unfoldedLines(this.dir, epoch, tally?.lost_applied, tally?.line_seq);
      if (lines.unreadable) return; // a journal that cannot be read settles nothing now (booking from the rest would count its samples twice); the pass is retried
      for (const name of names) {
        const key = OWED_NAME.exec(name)?.[1];
        if (key === undefined || key === this.key || pending.keys.includes(key)) continue; // this child's own session is settled at the end of its input; a marked session is the serving process's to publish and clear
        const path = join(this.dir, name); const rec = parseOwed(path);
        if (rec === null || rec === 'unreadable') continue;
        if (rec.booked_epoch !== undefined) { // a tombstone or a window blocker: it stays for as long as its epoch does, and goes with it
          if (rec.booked_epoch !== epoch) { stale.push(key); continue; }
          if (isBlockerKey(key)) continue; // a blocker owes nothing: its session's own file is judged below
          const more = rec.owed - ((tally?.settled?.[key] ?? 0) + (lines.bySession[key] ?? 0)); // a tombstone of an older build: the serving process raised `owed` after the window was booked, the rest is a plain orphan (the window is booked already)
          if (more > 0 && this.bookOrphan(rec, key, more, epoch, (tally?.settled_qualifying?.[key] ?? 0) + (lines.qualifyingBySession[key] ?? 0), 0)) booked = true;
          continue;
        }
        const age = Date.now() - statSync(path).mtimeMs;
        const orphaned = rec.child_exited || (rec.child_pid !== undefined && rec.child_pid > 1 && !running(rec.child_pid)) || (rec.closed && age > STALE_RECEIPT_MS) || (rec.serving_pid > 1 && !running(rec.serving_pid) && age > STALE_RECEIPT_MS);
        if (!orphaned && !rec.closed) continue;
        const prior = parseOwed(blockerPath(this.dir, key)); if (prior === 'unreadable') continue; // the window blocker of this session, of whatever epoch: its credit anchor settles the session either way, and a window it booked is that epoch's, never this one's
        const settled = settledOf(tally?.settled?.[key] ?? 0, lines.bySession[key] ?? 0, anchorOf(tally, prior, key)); // the credit banked before the entry restarted outlives the tally's own entry
        const settledQualifying = settledOf(tally?.settled_qualifying?.[key] ?? 0, lines.qualifyingBySession[key] ?? 0, anchorQualifyingOf(tally, prior, key));
        const missing = rec.owed - settled;
        const due = prior !== null ? settled < (prior.window_target ?? 0) && rec.owed >= (prior.window_target ?? 0) : rec.v === 2; // the window is not booked yet: an open marker (v:2) nobody has started on, or a blocker (of this epoch or an earlier one) its credit has not reached whose record still owes the samples of that window (a record that owes fewer closed normally: no window was lost)
        if (orphaned && missing > 0) { // an open marker (v:2) left by a crash: one of the missing samples stands for the whole lost window, booked after the first `target - settled` samples and only once its blocker is on disk (a retry after a partial booking finds what is left, so it books the window exactly once)
          let target = prior?.window_target ?? rec.owed;
          if (due && prior?.booked_epoch !== epoch) { const held = holdBlocker(this.dir, key, epoch); if (held === null || (prior === null && held.window_target !== rec.owed)) continue; target = held.window_target ?? target; }
          if (!this.bookOrphan(rec, key, missing, epoch, settledQualifying, due ? 1 : 0, target - settled)) continue;
          booked = true;
        }
        removable.push(key);
      }
      if (booked && !this.update()) return;
      for (const key of removable) removeSettledOwed(this.dir, key, false, epoch); // judged above on a record read before the booking: it is read again under the lock, which also brings the session's blocker up to date
      for (const key of stale) removeStaleTomb(this.dir, key, epoch);
      for (const name of names.filter((n) => RECEIPT_NAME.test(n))) {
        const path = join(this.dir, name); const r = parseReceipt(path);
        if (r === null || r === 'unreadable') continue;
        const age = Date.now() - statSync(path).mtimeMs;
        if (!(age > STALE_RECEIPT_MS || (r.pid !== undefined && r.pid > 1 && r.pid !== this.pid && !running(r.pid)))) continue;
        if (recordLostCount(this.dir, epoch, 'receipt_orphaned', r.sent, sessionKey(r.session)) < r.sent) continue; // a receipt that names another epoch is settled like any other (it can only be hand-written: this version writes none)
        if (readEpoch(this.dir)?.epoch_id !== epoch) return; // the epoch moved while this was booked: the receipt stays for the new owner
        rmSync(path, { force: true });
      }
    } catch { /* silent-read-ok: an obligation that could not be settled stays on disk, and status reads it as no evidence */ }
  }
  /** Publishes this pid as having a replay in flight. True only when that is durable on disk: on false the replay must not run. */
  begin(): boolean { return !this.retired && this.update((file) => { if (!file.in_flight.includes(this.pid)) file.in_flight.push(this.pid); }); }
  /** At child start: settles what a gone session left, counts the marks of dead processes (and of an earlier process with this pid), and saves any verdict still unsaved. */
  recover(): void { this.obligations(); this.update(undefined, true); }
  /** One more try to save batches an earlier save could not take, to write the lost lines held, and to settle gone sessions (true when nothing is left unsaved). Also the 10 s pass. */
  save(): boolean {
    const written = this.flushJournal();
    this.obligations();
    if (this.epoch() === null || this.retired) return written;
    const saved = this.update();
    return this.retired ? this.flushJournal() : saved && written;
  }
  /** Counts one outcome; `ends` is a replay's own verdict, which removes its mark. `credit`: how many of the session's owed samples this outcome settles (saved in the same batch as the outcome, or written as lines tagged with the session). */
  note(outcome: WriteOutcome, key?: string, n = 1, ends = false, credit = 0, creditQualifying = 0): void {
    const epoch = this.epoch();
    if (!this.alive()) return;
    if (epoch === null || this.retired) { // a client child (another process owns the store), or a child whose epoch was retired: it records nothing in the tally; its verdict is written as lost lines for the owner to add up
      const settles = this.key ? Math.min(n, credit) : 0;
      if (this.retired) this.addJournal(RETIRED_REASON, true, key === WINDOW_LOST_REASON ? 0 : settles); // a retired epoch's outcome counts nowhere: only what it settles matters, and never the window (the next epoch's owner books it)
      else { this.addJournal(NO_EPOCH_REASON, true, settles); this.addJournal(NO_EPOCH_REASON, false, n - settles); }
      return;
    }
    let batch = this.pending.at(-1);
    if (!batch || this.pending.length === this.sealed) this.pending.push(batch = { seq: ++this.seq, delta: blank(epoch), credit: 0, creditQualifying: 0, windowCredit: 0, ending: false });
    applyVerdict(batch.delta, outcome, key, n);
    batch.credit += credit; batch.creditQualifying += Math.min(credit, creditQualifying);
    if (key === WINDOW_LOST_REASON) batch.windowCredit += credit; // the window's own credit is kept apart: a batch that never saved before its epoch was retired must not stand for a booked window
    batch.ending ||= ends;
    this.update();
  }
  /**
   * `n` samples the pipe never delivered (the serving process owed them, the child never read them), settling that many: `nonqualifying` of them were writes the shadow never compares (`capability_missing` `pipe_unflushed_nonqualifying`),
   * the rest page and link writes (`uncomparable` `pipe_unflushed`). `windowLost`: the session's owed record was the open marker of a window the serving process never closed (a crash): the first of the page and link writes stands for a whole
   * window of unknown size, booked as one `write_window_lost` (status reads no evidence for the rest of the epoch), the rest are booked first: the window's one goes last.
   */
  missing(n: number, nonqualifying = 0, windowLost = 0): void {
    if (n <= 0 || !this.alive()) return;
    const win = Math.min(Math.max(0, windowLost), n); const other = Math.min(Math.max(0, nonqualifying), n - win); const plain = n - win - other;
    if (this.epoch() === null) {
      const settles = this.key ? 1 : 0;
      for (const [reason, k] of [['pipe_unflushed', plain], ['pipe_unflushed_nonqualifying', other], [WINDOW_LOST_REASON, win]] as const) { if (k > 0) { this.addJournal(reason, true, k * settles); this.addJournal(reason, false, k * (1 - settles)); } }
      return;
    }
    if (plain > 0) this.note('uncomparable', 'pipe_unflushed', plain, false, plain, plain);
    if (other > 0) this.note('capability_missing', 'pipe_unflushed_nonqualifying', other, false, other, 0);
    if (win > 0) { // the window's one is booked LAST (as `obligations` does), and only once its blocker is on disk: a save that only partly lands leaves a deficit the next owner books as the window, exactly once
      if (!this.retired && (!this.key || holdBlocker(this.dir, this.key, this.epoch()!) === null)) return; // no blocker held (no marker any more, a lock that stayed held): the pass books the rest
      this.note('uncomparable', WINDOW_LOST_REASON, win, false, win, win);
    }
  }
  /**
   * At the end of this child's input, after its final save: removes this session's owed file when the serving process closed it and the settled count read back from disk covers what was owed. True when the file is gone or there was none.
   * A client child cannot read the settlement (the owner folds its lines), so it leaves the file for the owner's pass. A file that cannot be read, or an unsettled one, stays and status reads it as no evidence.
   */
  finish(): boolean {
    if (!this.key) return true;
    const rec = parseOwed(owedPath(this.dir, this.key));
    if (rec === null) return true;
    const epoch = this.epoch(); const open = rec !== 'unreadable' && rec.v === 2 && !rec.closed; // an open marker (v:2) the child settled at the end of its input: it goes like a closed record, and the blocker this child's booking held names the epoch it was booked in
    if (rec === 'unreadable' || (!rec.closed && !open) || epoch === null || (open && this.retired)) return false;
    try { const t = loadTally(this.dir); if (settledOf(t?.settled?.[this.key] ?? 0, 0, anchorOf(t, parseOwed(blockerPath(this.dir, this.key)), this.key)) < rec.owed) return false; } catch { return false; } // silent-read-ok: the file stays; status reads its deficit
    return removeSettledOwed(this.dir, this.key, !open, epoch); // the same checks again under the lock: a higher record the serving process published meanwhile stays; the window's blocker (held when the window was booked) stays, the settled marker goes
  }
}
