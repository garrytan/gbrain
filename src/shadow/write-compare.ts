/**
 * Write comparisons, the part both processes share (swap criterion 5; docs/designs/RUST_ENGINE.md, "What is compared", Writes).
 *
 * A pilot covers ONLY putPage, deletePage, addLink, addLinksBatch and removeLink. For a sampled one the serving process copies the
 * rows the write touches from the primary (the preimage) and sends them with the write; the shadow child seeds a SCRATCH Rust store
 * with them, applies the same write there (never to the live shadow store, never to the primary) and compares typed read-backs
 * of the changed rows. Every sampled write of another family is counted `capability_missing`, by family. Fail closed: a write
 * whose preimage could not be read or loaded, or that failed on one side, is `uncomparable` and never `comparable`.
 *
 * Counts live in `write-comparisons.json`, written by the child under the current evidence epoch; `status` reads them.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
export interface WriteEvent { t: 'write'; op: string; outcome?: WriteOutcome; reason?: string; family?: string; /** Earlier samples the pipe refused (counted uncomparable, `send_shed`). */ dropped?: number; args?: unknown[]; pre?: PreImage; post?: unknown; moved?: boolean }

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
}
export const writeTallyPath = (dir: string): string => join(dir, 'write-comparisons.json');

/** The counts under `epochId`, or null when there are none (no file, an unreadable one, or another epoch's). */
export function readWriteTally(dir: string, epochId: string | null): WriteTallyFile | null {
  try {
    const parsed = JSON.parse(readFileSync(writeTallyPath(dir), 'utf8')) as WriteTallyFile;
    return epochId !== null && parsed?.version === 1 && parsed.epoch_id === epochId ? parsed : null;
  } catch { return null; } // silent-read-ok: no readable tally is no count; the status shows zero and criterion 5 stays missing
}

const MAX_KEYS = 64;
const bump = (map: Record<string, number>, key: string, count: number): void => { const k = key in map || Object.keys(map).length < MAX_KEYS ? key : 'other'; map[k] = (map[k] ?? 0) + count; };

type Verdict = [outcome: WriteOutcome, key: string | undefined, count: number];
function applyVerdict(file: WriteTallyFile, [outcome, key, count]: Verdict): void {
  file[outcome] += count;
  const name = typeof key === 'string' && /^[A-Za-z][A-Za-z0-9_:]{0,59}$/.test(key) ? key : 'other'; // a name, never text that could hold content
  if (outcome === 'capability_missing') bump(file.capability_missing_by_family, name, count);
  if (outcome === 'uncomparable') bump(file.uncomparable_by_reason, name, count);
}

/**
 * Counts outcomes under the current epoch and writes the file after each one (sampled writes are rare). With no epoch, or no directory, nothing is counted.
 * A verdict that could not be written is kept and written with the next one, and the file it could not update is removed, so a count that no longer
 * includes a verdict never stands as evidence (it reads as no count, never as a pass).
 */
export class WriteTally {
  private unsaved: Verdict[] = [];
  constructor(private readonly dir: string, private readonly epoch: () => string | null, private readonly alive: () => boolean = () => existsSync(dir)) {}
  note(outcome: WriteOutcome, key?: string, count = 1): void {
    const epoch = this.epoch();
    if (epoch === null || !this.alive()) return;
    this.unsaved.push([outcome, key, count]);
    const file = readWriteTally(this.dir, epoch) ?? { version: 1 as const, epoch_id: epoch, updated_at: '', comparable: 0, unexplained_difference: 0, uncomparable: 0, capability_missing: 0, capability_missing_by_family: {}, uncomparable_by_reason: {} };
    for (const verdict of this.unsaved) applyVerdict(file, verdict);
    file.updated_at = new Date().toISOString();
    try {
      const tmp = `${writeTallyPath(this.dir)}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(file) + '\n', { mode: 0o600 });
      renameSync(tmp, writeTallyPath(this.dir));
      this.unsaved = [];
    } catch {
      try { unlinkSync(writeTallyPath(this.dir)); } catch { /* nothing to remove, or it cannot be: the follower's own status stops updating in the same directory */ }
    }
  }
}
