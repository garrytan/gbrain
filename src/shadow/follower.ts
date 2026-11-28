/**
 * The shadow follower, serving side (shadow follow, plan PR 1). The mirrored engine publishes one invalidation batch
 * per committed primary write (invalidations.ts). This sink re-reads what each batch names from the primary, in one
 * read-only snapshot, and sends the rows to the shadow child (`{t:'apply'}`), which applies them to the Rust store
 * with a generation (follow-child.ts). Nothing here ever fails or slows a write: publishing only queues, and any
 * failure marks the coverage watermark invalid so a reconcile pass repairs the gap.
 *
 * Generations are microsecond clock readings taken BEFORE the read transaction, so a read that started later always
 * carries a later generation and the store keeps the newer one.
 */
import type { BrainEngine } from '../core/engine.ts';
import { quoteIdent, type DigestPlan } from '../core/persistence/graduation-digest.ts';
import type { SeedFollowKey, SeedPlan, SeedRelationPlan } from '../core/rust-engine/store.ts';
import { hasFingerprintFunctions, type FingerprintPair } from './fingerprints.ts';
import { rowDigest, sortKey, sortKeyUnsupported } from './follow-digest.ts';
import type { Invalidation, InvalidationBatch, InvalidationSink } from './invalidations.ts';
import type { ReadSource } from './read-pool.ts';
import { relationRead } from './seed.ts';
import { bookkeepingMember } from './write-capture.ts';

export const FOLLOW_QUEUE_BOUND = 1024;
export const FOLLOW_CHUNK_KEYS = 500;
const FOLLOW_CHUNK_BYTES = 2 * 1024 * 1024;
/** The relations a write comparison reads back (write-compare.ts `readBack`): pages and the links among them. */
const COMPARED_RELATIONS: ReadonlySet<string> = new Set(['pages', 'links']);
const UNMAPPED = 'unmapped_write:';
/**
 * Whether an item can change a row a write comparison reads: a `pages` or `links` item, or an `invalid` one (a write nothing describes), except an unmapped write by
 * a journal member whose statements write only bookkeeping tables (write-capture.ts `bookkeepingMember`: the protocol declaration, the counter lock, the request completion,
 * the publication's effects insert, an effect's completion, transaction settings and locks). Those are the process's own persistence bookkeeping, as its journal rows are.
 */
const movesComparedRows = (item: Invalidation): boolean =>
  item.kind === 'invalid' ? !(item.reason.startsWith(UNMAPPED) && bookkeepingMember(item.reason.slice(UNMAPPED.length))) : COMPARED_RELATIONS.has(item.relation);
const TYPED = new Set(['smallint', 'integer', 'bigint', 'uuid', 'text', 'character varying']);

let lastGeneration = 0;
const origin = performance.timeOrigin;
/** A strictly increasing microsecond clock for this process (a safe integer until the year 2255). */
export function nextGeneration(): number {
  lastGeneration = Math.max(lastGeneration + 1, Math.floor((origin + performance.now()) * 1000));
  return lastGeneration;
}

export interface FollowerOptions {
  /** Where the follower re-reads changed rows from the primary. */
  reads: ReadSource;
  /** The supervisor's `send`: false when the line was not accepted. */
  send: (line: string) => boolean;
  /** The supervisor's `request`. */
  rpc: <T>(method: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  /** A relation is dirty (`relation` item): a reconcile pass should repair it. */
  onDirty?: (relation: string) => void;
  /** The first batch of this process: time to run the fingerprint probe. */
  onFirstBatch?: () => void;
}

type RowsItem = Extract<Invalidation, { kind: 'rows' }>;
interface ReadRow { key: string[]; values: Record<string, string | null>; fp?: FingerprintPair }

export class ShadowFollower implements InvalidationSink {
  /** When this process last invalidated (or failed to deliver) coverage; reconcile compares it to a pass's start. */
  lastInvalidatedAt = 0;
  /** Batches accepted by `publish` in this process: the stable rerun compares it before and after its primary read (checks.ts). */
  published = 0;
  /**
   * Batches accepted by `publish` that can change a row a write comparison reads: one naming `pages` or `links` (rows or a whole relation), or an `invalid` item (a write nothing can describe, so it may have),
   * other than an unmapped write by a bookkeeping journal member (`movesComparedRows`).
   * The write sampler's `generation` (attach.ts `writeGeneration`): this process's own bookkeeping (journal, effect and lease rows, a link's transition rows, the journal members' declarations and locks) does not move it.
   */
  pageLinkWrites = 0;
  private readonly queue: InvalidationBatch[] = [];
  private draining: Promise<void> | null = null;
  private lastSeq: number | null = null;
  private pendingInvalid: string | null = null;
  private sentQueued = 0;
  private probed = false;
  private planCache: Promise<Map<string, SeedRelationPlan>> | null = null;
  private readonly reads = new Map<string, Promise<DigestPlan>>();
  private hasFingerprints: boolean | null = null;

  constructor(private readonly o: FollowerOptions) {}

  publish(batch: InvalidationBatch): void {
    try {
      this.published++;
      if (batch.items.some(movesComparedRows)) this.pageLinkWrites++;
      if (this.queue.length >= FOLLOW_QUEUE_BOUND) { this.invalidate('queue_overflow'); return; }
      this.queue.push(batch);
      this.draining ??= new Promise<void>((resolve) => setImmediate(() => { void this.drain().finally(resolve); }));
    } catch { /* the follower never fails a write */ }
  }

  /** Nothing published is still queued or being read and sent, and no lost send waits to be reported as an invalidation. */
  idle(): boolean { return this.queue.length === 0 && this.draining === null && this.pendingInvalid === null; }

  /** Why `idle()` cannot become true by waiting: a lost send is waiting to be reported with the next batch, and none is queued. */
  blocked(): string | null { return this.queue.length === 0 && this.draining === null ? this.pendingInvalid : null; }

  /** Resolves when everything published so far has been read and sent (or shed). */
  async settle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /**
   * The coverage watermark must go invalid: something was lost or cannot be described. With a `relation` only that
   * relation is dirty, and the child holds the obligation until a pass for it repairs it; if that line is lost the
   * whole watermark goes invalid instead.
   */
  invalidate(reason: string, relation?: string): void {
    const sent = this.send({ t: 'watermark', valid: false, reason, ...(relation ? { relation } : {}) });
    if (sent && relation) return;
    this.lastInvalidatedAt = Date.now();
    if (!sent) this.pendingInvalid ??= relation ? 'relation_dirty_shed' : reason;
  }

  private send(message: Record<string, unknown>): boolean {
    try { return this.o.send(JSON.stringify(message) + '\n'); } catch { return false; }
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length) {
        const batch = this.queue.shift()!;
        try { await this.process(batch); } catch (error) { this.invalidate(`read_failed:${error instanceof Error ? error.name : 'unknown'}`); }
      }
      if (this.sentQueued > 0 && this.send({ t: 'depth', queued: 0 })) this.sentQueued = 0;
    } finally { this.draining = null; }
  }

  private plan(): Promise<Map<string, SeedRelationPlan>> {
    this.planCache ??= this.o.rpc<SeedPlan>('seedPlan', {}, 30_000).then((p) => new Map(p.relations.map((r) => [r.relation, r])), (error) => { this.planCache = null; throw error; });
    return this.planCache;
  }

  private async process(batch: InvalidationBatch): Promise<void> {
    if (this.lastSeq !== null && batch.seq !== this.lastSeq + 1) this.invalidate('seq_gap');
    this.lastSeq = batch.seq;
    if (!this.probed) { this.probed = true; try { this.o.onFirstBatch?.(); } catch { /* best effort */ } }
    if (this.pendingInvalid && this.send({ t: 'watermark', valid: false, reason: this.pendingInvalid })) this.pendingInvalid = null;
    const plan = await this.plan();
    const byRelation = new Map<string, RowsItem[]>();
    for (const item of batch.items) {
      if (item.kind === 'invalid') { this.reads.clear(); this.invalidate(`invalid:${item.reason}`); }
      else if (item.kind === 'relation') {
        if (!plan.has(item.relation)) continue;
        this.invalidate('relation_dirty', item.relation);
        try { this.o.onDirty?.(item.relation); } catch { /* best effort */ }
      } else if (plan.has(item.relation)) byRelation.set(item.relation, [...(byRelation.get(item.relation) ?? []), item]);
    }
    for (const [relation, items] of byRelation) await this.applyRows(batch, plan.get(relation)!, items);
  }

  private readPlan(rp: SeedRelationPlan, tx: BrainEngine): Promise<DigestPlan> {
    let read = this.reads.get(rp.relation);
    if (!read) {
      const extra = rp.relation === 'facts' && this.hasFingerprints
        ? [`gbrain_fact_fingerprint(t."fact") AS fp0`, `gbrain_fact_fingerprint_v1(t."fact") AS fp1`] : [];
      read = relationRead(tx, rp.relation, rp.key, extra);
      this.reads.set(rp.relation, read);
      read.catch(() => this.reads.delete(rp.relation));
    }
    return read;
  }

  private async applyRows(batch: InvalidationBatch, rp: SeedRelationPlan, items: RowsItem[]): Promise<void> {
    const generation = nextGeneration();
    const found = new Map<string, ReadRow>();
    const wanted = new Map<string, string[]>();
    let read!: DigestPlan;
    // Outside the snapshot: a single-connection engine cannot run a second query while its transaction is open.
    if (rp.relation === 'facts') this.hasFingerprints ??= await this.o.reads.read((tx) => hasFingerprintFunctions(tx));
    await this.o.reads.read(async (tx) => {
      read = await this.readPlan(rp, tx);
      if (sortKeyUnsupported(read.key)) return;
      const groups = new Map<string, { columns: string[]; tuples: string[][] }>();
      for (const item of items) {
        const columns = Object.keys(item.selector).sort();
        const group = groups.get(columns.join('\0')) ?? { columns, tuples: [] };
        group.tuples.push(columns.map((c) => item.selector[c]!));
        groups.set(columns.join('\0'), group);
        for (const key of item.before_keys ?? []) wanted.set(JSON.stringify(key), key);
      }
      for (const { columns, tuples } of groups.values()) await this.readWhere(tx, read, columns, tuples, found);
      const before = [...wanted.values()].filter((k) => k.length === read.key.length);
      if (before.length) await this.readWhere(tx, read, read.key.map((k) => k.name), before, found);
    });
    if (sortKeyUnsupported(read.key)) { this.invalidate(`sort_key_unsupported:${rp.relation}`); return; }

    const tuples = new Map<string, string[]>([...wanted].filter(([, k]) => k.length === read.key.length));
    for (const row of found.values()) tuples.set(JSON.stringify(row.key), row.key);
    const entries = [...tuples.values()].map((tuple) => ({ tuple, sort: sortKey(read.key, tuple).toString('hex'), row: found.get(JSON.stringify(tuple)) }))
      .sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
    let chunk: typeof entries = [];
    let bytes = 0;
    const flush = (): boolean => {
      if (!chunk.length) return true;
      const withRows = chunk.filter((e) => e.row);
      const keys: SeedFollowKey[] = chunk.map((e) => ({ sort: e.sort, key: Object.fromEntries(read.key.map((k, i) => [k.name, e.tuple[i]!])) }));
      const message = {
        t: 'apply', seq: batch.seq, committed_at: batch.committed_at, relation: rp.relation, generation, keys,
        rows: withRows.map((e) => e.row!.values),
        digests: withRows.map((e) => ({ sort: e.sort, digest: rowDigest(e.row!.values).toString('hex') })),
        ...(withRows.some((e) => e.row!.fp) ? { fp: withRows.map((e) => e.row!.fp ?? null) } : {}),
        queued: this.queue.length,
      };
      chunk = []; bytes = 0;
      if (this.send(message)) { this.sentQueued = this.queue.length; return true; }
      this.lastInvalidatedAt = Date.now();
      this.pendingInvalid ??= 'apply_shed';
      return false;
    };
    for (const entry of entries) {
      chunk.push(entry);
      bytes += entry.row ? JSON.stringify(entry.row.values).length : 64;
      if ((chunk.length >= FOLLOW_CHUNK_KEYS || bytes >= FOLLOW_CHUNK_BYTES) && !flush()) return;
    }
    flush();
  }

  /** The rows of `read` whose `columns` equal one of `tuples` (text), added to `into` by primary key. */
  private async readWhere(tx: BrainEngine, read: DigestPlan, columns: string[], tuples: string[][], into: Map<string, ReadRow>): Promise<void> {
    const types = columns.map((c) => read.columns.find((m) => m.name === c)?.type ?? read.key.find((m) => m.name === c)?.type);
    const typed = types.map((type) => type !== undefined && TYPED.has(type) ? type : null);
    const left = columns.map((c, i) => typed[i] ? `t.${quoteIdent(c)}` : `t.${quoteIdent(c)}::text`).join(', ');
    const right = columns.map((_, i) => typed[i] ? `u.c${i}::${typed[i]}` : `u.c${i}`).join(', ');
    const sql = `/* shadow-follow read */ ${read.select} WHERE (${left}) IN (SELECT ${right} FROM unnest(${columns.map((_, i) => `$${i + 1}::text[]`).join(', ')}) AS u(${columns.map((_, i) => `c${i}`).join(', ')}))`;
    for (let from = 0; from < tuples.length; from += FOLLOW_CHUNK_KEYS) {
      const part = tuples.slice(from, from + FOLLOW_CHUNK_KEYS);
      const rows = await tx.executeRaw<Record<string, string | null>>(sql, columns.map((_, i) => part.map((t) => t[i]!)));
      for (const r of rows) {
        const values: Record<string, string | null> = {};
        read.columns.forEach((c, i) => { values[c.name] = r[`c${i}`] ?? null; });
        const key = read.key.map((_, i) => r[`k${i}`] as string);
        into.set(JSON.stringify(key), { key, values, ...(r.fp0 != null ? { fp: [r.fp0, r.fp1 as string] as FingerprintPair } : {}) });
      }
    }
  }
}
