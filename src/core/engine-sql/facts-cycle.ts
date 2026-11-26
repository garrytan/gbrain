
import type { EngineRawRead } from './cli-reads-ops.ts';

const LIVE_STORED_BODY_SQL = 'SELECT compiled_truth, timeline FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL';
const LIVE_STORED_BODY_LOCKED_SQL = 'SELECT compiled_truth, timeline FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL FOR UPDATE';

/** A page's stored body and timeline. */
export interface StoredBodyRow { compiled_truth: string | null; timeline: string | null }

/** The live page's stored body, or null for no live page. `lock` takes the row lock (inside a transaction). */
export async function readLiveStoredBody(raw: EngineRawRead, sourceId: string, slug: string, lock = false): Promise<StoredBodyRow | null> {
  const [row] = await raw<StoredBodyRow>(lock ? LIVE_STORED_BODY_LOCKED_SQL : LIVE_STORED_BODY_SQL, [sourceId, slug]);
  return row ?? null;
}
