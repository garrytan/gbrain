/**
 * Vector recall evidence (plan decision 8, review F4): how much of the true top 10 each engine returned.
 *
 * The reference is the PRIMARY's own `searchVector` with the same arguments, run in a read-only transaction with index
 * scans turned off (`enable_indexscan`, `enable_bitmapscan`): the same statements, the primary's own filters, but an
 * exact scan over the primary's whole corpus. Both engines' answers are scored against it: the hits among an engine's own
 * first ten rows, over the size of the reference's top ten; a reference row tied with its tenth score counts for the places the
 * strictly better rows leave. The reference is asked for `RECALL_REFERENCE_LIMIT` rows so a tie at the cutoff is visible; a
 * reference whose last row still ties the cutoff is not scored, and neither is a sample whose corpus moved (checks.ts). A sample with an offset, a
 * limit under ten or an empty reference is skipped. Reference runs are at most one a minute and never on the request path:
 * the child asks the serving process after it has recorded the comparison. Scores go to `recall/YYYY-MM-DD.jsonl`
 * (ids never; epoch, three numbers and a size), and the status averages the epoch's lines once there are
 * `RECALL_MIN_SAMPLES` of them. The overlap with the primary is kept apart: it measures agreement, not recall.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readEpoch } from './evidence-epoch.ts';
import { readJsonlStrict } from './ledger.ts';

export const RECALL_TOP = 10;
export const RECALL_MIN_SAMPLES = 30;
export const RECALL_REFERENCE_LIMIT = 50;
export const RECALL_INTERVAL_MS = 60_000;

export interface RankedKey { k: string; s: number }
export interface RecallScore { vector: number; primary: number; overlap: number; ref_size: number }
export interface RecallLine extends RecallScore { ts: string; epoch_id: string }

const keyOf = (row: unknown): RankedKey | null => {
  const r = row as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const k = r.chunk_id ?? `${String(r.page_id ?? r.slug)}#${String(r.chunk_index ?? '')}`;
  return { k: String(k), s: Number(r.score) };
};

/** The ranked key of a search result row: its chunk, else its page and chunk index. Elements that are not rows are left out (the reference's own rows). */
export function rankedKeys(encoded: unknown): RankedKey[] {
  if (!Array.isArray(encoded)) return [];
  return encoded.flatMap((row): RankedKey[] => { const k = keyOf(row); return k ? [k] : []; });
}

/** An engine's own first ten POSITIONS: an element that is not a row takes its place and counts for nothing, so it can never move a later row into the top ten. A non-list answer has none. */
function firstTen(encoded: unknown): Array<RankedKey | null> {
  return Array.isArray(encoded) ? encoded.slice(0, RECALL_TOP).map(keyOf) : [];
}

/** The first ten positions as content-free keys, holes kept (null): the rerun representation of an answer, so a malformed position still takes its place when it is scored. */
export const firstTenKeys = firstTen;

/** Only an unpaged read of at least ten rows has a top ten to score. Unset limit is the engine default (20). */
export function recallEligible(args: unknown[]): boolean {
  const opts = (args[1] ?? {}) as { limit?: unknown; offset?: unknown };
  const limit = opts.limit === undefined ? 20 : Number(opts.limit);
  return Number(opts.offset ?? 0) === 0 && limit >= RECALL_TOP;
}

const TIE = 1e-9;

/**
 * Scores the primary's and Rust's answers (encoded result arrays) against the reference rows. Reference rows tied with the
 * tenth score are true neighbours, however the engines ordered them, but only for the top-ten slots the strictly better
 * rows leave: an engine that returns ten tied rows and none of nine better ones scores one, not ten. Null when the reference
 * is empty, and when it cannot be trusted to hold the whole tie: asked for `RECALL_REFERENCE_LIMIT` rows and the last one
 * still ties the tenth score, more tied rows may lie beyond it, so the sample is unscorable.
 */
export function scoreRecall(reference: RankedKey[], primary: unknown, rust: unknown): RecallScore | null {
  if (reference.length === 0) return null;
  const top = reference.filter((r, i) => reference.findIndex((x) => x.k === r.k) === i).slice(0, RECALL_TOP); // distinct identities only
  const cutoff = top[top.length - 1]!.s;
  if (reference.length >= RECALL_REFERENCE_LIMIT && Math.abs(reference[reference.length - 1]!.s - cutoff) <= TIE) return null;
  const tied = (r: RankedKey): boolean => Math.abs(r.s - cutoff) <= TIE;
  const better = new Set(top.filter((r) => !tied(r)).map((r) => r.k));
  const ties = new Set(reference.filter(tied).map((r) => r.k));
  const slots = top.length - better.size; // top-ten places the tied rows fill
  const hits = (answer: Array<RankedKey | null>): number => {
    const first = new Set(answer.flatMap((r) => (r ? [r.k] : []))); // a repeated row is one neighbour, never ten
    return [...first].filter((k) => better.has(k)).length + Math.min(slots, [...first].filter((k) => ties.has(k) && !better.has(k)).length);
  };
  const p = firstTen(primary);
  const r = firstTen(rust);
  const share = (n: number): number => Math.min(n, top.length) / top.length;
  const both = new Set(p.flatMap((x) => (x ? [x.k] : [])));
  const shared = new Set(r.flatMap((x) => (x && both.has(x.k) ? [x.k] : []))).size;
  return { vector: share(hits(r)), primary: share(hits(p)), ref_size: top.length, overlap: shared / Math.max(1, both.size) };
}

/** At most one `take` per interval. */
export class IntervalGate {
  private last = -Infinity;
  constructor(private readonly ms: number, private readonly now: () => number = Date.now) {}
  take(): boolean {
    const at = this.now();
    if (at - this.last < this.ms) return false;
    this.last = at;
    return true;
  }
}

const recallDir = (dir: string): string => join(dir, 'recall');

/**
 * Appends one score line. Never creates the shadow directory itself: after `engine shadow stop --delete`, a reference that finishes late
 * must not bring the evidence back (the usage and ledger writers follow the same rule). With `currentEpochOnly` (the child's writer) it also
 * writes nothing when the directory's current epoch is not the line's: a score of a replaced epoch is dropped, never restamped.
 */
export function appendRecall(dir: string, line: RecallLine, opts: { currentEpochOnly?: boolean } = {}): void {
  if (!existsSync(dir)) return;
  if (opts.currentEpochOnly && readEpoch(dir)?.epoch_id !== line.epoch_id) return;
  mkdirSync(recallDir(dir), { recursive: true, mode: 0o700 });
  appendFileSync(join(recallDir(dir), `${line.ts.slice(0, 10)}.jsonl`), JSON.stringify(line) + '\n', { mode: 0o600 });
}

const unit = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
/** The whole schema of one complete record: any other shape, or a score outside 0..1, is not a recall record. */
export function validRecallLine(l: unknown): l is RecallLine {
  const r = l as Record<string, unknown> | null;
  return !!r && typeof r === 'object' && typeof r.ts === 'string' && Number.isFinite(Date.parse(r.ts)) && typeof r.epoch_id === 'string' && r.epoch_id !== ''
    && unit(r.vector) && unit(r.primary) && unit(r.overlap) && Number.isInteger(r.ref_size) && (r.ref_size as number) >= 1 && (r.ref_size as number) <= RECALL_TOP;
}

/**
 * Every score line of `epochId`; [] when none were written. Null (recall unavailable, the fields stay absent) when a file
 * cannot be read whole, or when any complete record, of any epoch, does not match the schema: a bad record may be one of this
 * epoch's, so it is never skipped and never trusted. A torn last line is the one thing skipped (readJsonlStrict).
 */
export function readEpochRecall(dir: string, epochId: string): RecallLine[] | null {
  if (!existsSync(recallDir(dir))) return [];
  const out: RecallLine[] = [];
  let names: string[];
  try { names = readdirSync(recallDir(dir)).sort(); } catch { return null; } // silent-read-ok: null is the unreadable marker (a file where the directory belongs, no permission, a deletion while listing); recall stays unavailable, never zero
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const lines = readJsonlStrict<unknown>(join(recallDir(dir), name));
    if (lines === null) return null;
    for (const l of lines) {
      if (!validRecallLine(l)) return null;
      if (l.epoch_id === epochId) out.push(l);
    }
  }
  return out;
}
