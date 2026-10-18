function chunkVisibleFilter(p: string, c: string): string {
  return `(${c}.body_generation IS NULL OR ${c}.body_generation <= ${p}.body_generation)`;
}

export const visibleSql = `SELECT c.chunk_text FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE ${chunkVisibleFilter('p', 'c')}`;

export const maintenanceSql = `SELECT count(*) FROM content_chunks c -- chunk-visibility-ok: counts every row for a maintenance report
  WHERE c.page_id = $1`;

export const legacySql = `SELECT c.id FROM content_chunks c WHERE c.page_id = $1`;

export const unlistedSql = `SELECT c.chunk_text FROM content_chunks c WHERE c.page_id = $1`;
