/**
 * Whether the Postgres search statements may compute the `stale` flag (search/timeline-stale.ts), which names
 * `timeline_entries`. Postgres checks the privilege on every relation a statement names, matched or not, so a role
 * without SELECT on it (the reader role of docs/ENGINES.md) would fail every keyword, chunk, title, vector and CJK keyword search
 * with 42501. The probe asks `has_table_privilege` before the statement text is built; that role gets `false`.
 */
import type { BrainEngine } from '../engine.ts';
import { timelineStaleSql } from '../search/timeline-stale.ts';

// engine-sql-ok: a Postgres-only privilege probe; PGLite has no roles and always computes the flag.
const TIMELINE_ACCESS_SQL = `SELECT has_table_privilege('timeline_entries', 'SELECT') AS readable`;

/** One per engine. A positive answer is kept per engine object: a transaction clone probes again, so its SET LOCAL ROLE counts. */
export class TimelineStaleProbe {
  private readonly readable = new WeakSet<object>();

  async reads(engine: Pick<BrainEngine, 'executeRaw'>): Promise<boolean> {
    if (this.readable.has(engine)) return true;
    const [access] = await engine.executeRaw<{ readable: boolean }>(TIMELINE_ACCESS_SQL);
    if (access?.readable === true) this.readable.add(engine);
    return access?.readable === true;
  }

  /** The stale expression for the page whose `updated_at` and id are the given expressions, or `false` for that role. */
  async sql(engine: Pick<BrainEngine, 'executeRaw'>, updatedAt: string, pageId: string): Promise<string> {
    return timelineStaleSql(updatedAt, pageId, await this.reads(engine));
  }
}
