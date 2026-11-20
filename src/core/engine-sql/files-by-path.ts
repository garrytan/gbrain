/**
 * The file rows `gbrain files verify` walks, as a typed BrainEngine member (the collate-equal lane). The statement is the
 * one the command ran through its tagged `sql` template, run on the engine's own `executeRaw`; only its home moved (pinned by
 * test/engine-sql-caller-raw-sql-pins.test.ts, compared across engines and the Rust store by
 * test/engine-parity/collate-command-listings.test.ts). `storage_path` is unique, so the byte sort is a total order.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

/** The most rows `files verify` checks in one run. */
export const FILES_VERIFY_LIMIT = 1000;

/** Every file row by `storage_path` bytes, at most `limit`: the columns of `FileRow`. */
export async function listFilesByStoragePath(raw: EngineRawRead, limit: number): Promise<Array<Record<string, unknown>>> {
  return raw<Record<string, unknown>>(
    `SELECT id, source_id, page_slug, page_id, filename, storage_path, mime_type, size_bytes, content_hash, metadata, created_at
       FROM files ORDER BY storage_path COLLATE "C" LIMIT $1`,
    [limit],
  );
}
