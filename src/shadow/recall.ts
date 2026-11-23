/**
 * Vector recall evidence (plan decision 8, review F4): how much of the true top 10 each engine returned.
 *
 * The reference is the PRIMARY's own `searchVector` with the same arguments, run in a read-only transaction with index
 * scans turned off (`enable_indexscan`, `enable_bitmapscan`): the same statements, the primary's own filters, but an
 * exact scan over the primary's whole corpus. Both engines' answers are scored against it: the hits among an engine's own
 * first ten rows, over the size of the reference's top ten, counting every reference row tied with its tenth score. The
 * reference is asked for `RECALL_REFERENCE_LIMIT` rows so a tie at the cutoff is visible. A sample with an offset, a
 * limit under ten or an empty reference is skipped. Reference runs are at most one a minute and never on the request path:
 * the child asks the serving process after it has recorded the comparison. Scores go to `recall/YYYY-MM-DD.jsonl`
 * (ids never; epoch, three numbers and a size), and the status averages the epoch's lines once there are
 * `RECALL_MIN_SAMPLES` of them. The overlap with the primary is kept apart: it measures agreement, not recall.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonlStrict } from './ledger.ts';

export const RECALL_TOP = 10;
export const RECALL_MIN_SAMPLES = 30;
export const RECALL_REFERENCE_LIMIT = 50;
export const RECALL_INTERVAL_MS = 60_000;

export interface RankedKey { k: string; s: number }
export interface RecallScore { vector: number; primary: number; overlap: number; ref_size: number }
export interface RecallLine extends RecallScore { ts: string; epoch_id: string }

/** The ranked key of a search result row: its chunk, else its page and chunk index. */
export function rankedKeys(encoded: unknown): RankedKey[] {
  if (!Array.isArray(encoded)) return [];
  return encoded.flatMap((row): RankedKey[] => {
    const r = row as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') return [];
    const k = r.chunk_id ?? `${String(r.page_id ?? r.slug)}#${String(r.chunk_index ?? '')}`;
    return [{ k: String(k), s: Number(r.score) }];
  });
}

/** Only an unpaged read of at least ten rows has a top ten to score. Unset limit is the engine default (20). */
export function recallEligible(args: unknown[]): boolean {
  const opts = (args[1] ?? {}) as { limit?: unknown; offset?: unknown };
  const limit = opts.limit === undefined ? 20 : Number(opts.limit);
  return Number(opts.offset ?? 0) === 0 && limit >= RECALL_TOP;
}

/** The reference's arguments: the caller's own, with room for ties past the cutoff. */
export function referenceArgs(args: unknown[]): unknown[] {
  return [args[0], { ...((args[1] ?? {}) as object), limit: RECALL_REFERENCE_LIMIT, offset: 0 }];
}

const hitsIn = (engine: RankedKey[], truth: Set<string>): number => engine.slice(0, RECALL_TOP).filter((r) => truth.has(r.k)).length;

/**
 * Scores the primary's and Rust's answers (encoded result arrays) against the reference rows. Null when the reference
 * is empty. Reference rows tied with the tenth score count as true neighbours, however the engines ordered them.
 */
export function scoreRecall(reference: RankedKey[], primary: unknown, rust: unknown): RecallScore | null {
  if (reference.length === 0) return null;
  const top = reference.slice(0, RECALL_TOP);
  const cutoff = top[top.length - 1]!.s;
  const truth = new Set(reference.filter((r, i) => i < RECALL_TOP || Math.abs(r.s - cutoff) <= 1e-9).map((r) => r.k));
  const p = rankedKeys(primary);
  const r = rankedKeys(rust);
  const share = (hits: number): number => Math.min(hits, top.length) / top.length;
  const both = new Set(p.slice(0, RECALL_TOP).map((x) => x.k));
  return {
    vector: share(hitsIn(r, truth)), primary: share(hitsIn(p, truth)), ref_size: top.length,
    overlap: Math.min(RECALL_TOP, r.slice(0, RECALL_TOP).filter((x) => both.has(x.k)).length) / Math.max(1, Math.min(RECALL_TOP, p.length)),
  };
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

export function appendRecall(dir: string, line: RecallLine): void {
  mkdirSync(recallDir(dir), { recursive: true, mode: 0o700 });
  appendFileSync(join(recallDir(dir), `${line.ts.slice(0, 10)}.jsonl`), JSON.stringify(line) + '\n', { mode: 0o600 });
}

/** Every score line of `epochId`; [] when none were written, null when a file cannot be read whole. */
export function readEpochRecall(dir: string, epochId: string): RecallLine[] | null {
  if (!existsSync(recallDir(dir))) return [];
  const out: RecallLine[] = [];
  for (const name of readdirSync(recallDir(dir)).sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const lines = readJsonlStrict<RecallLine>(join(recallDir(dir), name));
    if (lines === null) return null;
    for (const l of lines) if (l?.epoch_id === epochId && [l.vector, l.primary, l.overlap].every(Number.isFinite)) out.push(l);
  }
  return out;
}
