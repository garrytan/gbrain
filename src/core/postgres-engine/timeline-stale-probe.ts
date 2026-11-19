/**
 * Whether the Postgres search statements may compute the `stale` flag (search/timeline-stale.ts), which names
 * `timeline_entries`. Postgres checks the privilege on every relation a statement names, matched or not, so a role
 * without SELECT on it (the reader role of docs/ENGINES.md) would fail every keyword, chunk, title, vector and CJK keyword search
 * with 42501. The probe asks `has_table_privilege` before the statement text is built; that role gets `false`.
 * Keyword, title, chunk and CJK keyword search run it inside their bounded read transaction (`db` is that transaction),
 * after its settings, so the keyword statement timeout bounds it and it answers for the role that transaction runs as.
 */
import type { BrainEngine } from '../engine.ts';
import { timelineStaleSql } from '../search/timeline-stale.ts';

// engine-sql-ok: a Postgres-only privilege probe; PGLite has no roles and always computes the flag.
const TIMELINE_ACCESS_SQL = `SELECT has_table_privilege('timeline_entries', 'SELECT') AS readable`;

/** One per engine. A positive answer is kept per engine object: a transaction clone probes again, so its SET LOCAL ROLE counts. */
export class TimelineStaleProbe {
  private readonly readable = new WeakSet<object>();

  async reads(engine: object, db: Pick<BrainEngine, 'executeRaw'>): Promise<boolean> {
    if (this.readable.has(engine)) return true;
    const [access] = await db.executeRaw<{ readable: boolean }>(TIMELINE_ACCESS_SQL);
    if (access?.readable === true) this.readable.add(engine);
    return access?.readable === true;
  }

  /** The stale expression for the page whose `updated_at` and id are the given expressions, or `false` for that role. */
  async sql(engine: object, db: Pick<BrainEngine, 'executeRaw'>, updatedAt: string, pageId: string): Promise<string> {
    return timelineStaleSql(updatedAt, pageId, await this.reads(engine, db));
  }
}
