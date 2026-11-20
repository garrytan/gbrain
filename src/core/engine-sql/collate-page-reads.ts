/**
 * Reads of pages, files and facts that sort by byte on every engine (the collate-equal lane), each a typed BrainEngine
 * member. Each function runs the statement its caller ran through `executeRaw`, with the same text and parameters, on the
 * engine's own `executeRaw`; only its home moved (pinned by test/engine-sql-caller-raw-sql-pins.test.ts, compared across
 * engines and the Rust store by test/engine-parity/collate-core-page-lists.test.ts).
 *
 * Placeholders that a caller numbered by hand (`$1` the limit, `$2` the slug) stay hand-numbered inside `trustedSql`
 * string literals of a fragment with no bound values, so the text is the caller's byte for byte.
 */
import { privatePagesFilterForCaller } from '../search/private-visibility.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/**
 * The most files `file_list` returns. Both branches need a LIMIT: without one, the slug-filtered branch materializes every
 * file for that slug, and an MCP caller could force unbounded memory consumption by targeting a page with many attachments.
 */
export const FILE_LIST_LIMIT = 100;

/** The predicate over the files alias `f`: always true, or no page the file names is one the caller cannot read. No values. */
function fileReadableFragment(excludePrivate: boolean) {
  return excludePrivate
    ? sqlFragment`NOT EXISTS (SELECT 1 FROM pages fp WHERE (fp.id = f.page_id OR fp.slug = f.page_slug) AND NOT ${trustedSql(privatePagesFilterForCaller('fp'))})`
    : sqlFragment`TRUE`;
}

/**
 * file_list: the files of one page (by name) or of every page (by page, then name) that the caller can read, at most 100.
 * Text sorts by byte and equal names fall to the file id, so the limit cuts the same rows on every engine.
 */
export async function listReadableFileRows(raw: EngineRawRead, slug: string | undefined, excludePrivate: boolean): Promise<Array<Record<string, unknown>>> {
  const { text, params } = renderFragment(slug === undefined
    ? sqlFragment`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at
      FROM files f WHERE (${trustedSql('TRUE')}) AND ${fileReadableFragment(excludePrivate)}
      ORDER BY ${trustedSql('page_slug COLLATE "C", filename COLLATE "C", id')} ${trustedSql('LIMIT $1')}`
    : sqlFragment`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at
      FROM files f WHERE (${trustedSql('f.page_slug = $2')}) AND ${fileReadableFragment(excludePrivate)}
      ORDER BY ${trustedSql('filename COLLATE "C", id')} ${trustedSql('LIMIT $1')}`);
  if (params.length !== 0) throw new Error('listReadableFileRows: the statement binds no value of its own');
  return raw<Record<string, unknown>>(text, slug === undefined ? [FILE_LIST_LIMIT] : [FILE_LIST_LIMIT, slug]);
}
