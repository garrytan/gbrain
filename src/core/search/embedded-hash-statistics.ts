import type { BrainEngine } from '../engine.ts';

export const EMBEDDED_HASH_STATISTICS_NAME = 'content_chunks_embedded_hash_current_stats';

export const EMBEDDED_HASH_STATISTICS_SQL = `
CREATE STATISTICS IF NOT EXISTS ${EMBEDDED_HASH_STATISTICS_NAME}
  ON ((embedded_text_hash = md5(chunk_text))) FROM content_chunks;
ANALYZE content_chunks(embedded_text_hash, chunk_text);
`;

export async function verifyEmbeddedHashStatistics(engine: Pick<BrainEngine, 'executeRaw'>): Promise<void> {
  const rows = await engine.executeRaw<{
    expression: string;
    correct_table: boolean;
    sampled_rows: number;
    can_inspect: boolean;
    collected: boolean;
  }>(`SELECT pg_get_expr(e.stxexprs, e.stxrelid) AS expression,
       e.stxrelid = 'content_chunks'::regclass AS correct_table,
       p.reltuples AS sampled_rows,
       has_table_privilege(p.oid, 'SELECT') AND NOT row_security_active(p.oid) AS can_inspect,
       x.null_frac IS NOT NULL AS collected
     FROM pg_class p JOIN pg_statistic_ext e ON e.stxnamespace = p.relnamespace
     LEFT JOIN pg_stats_ext_exprs x
       ON x.statistics_schemaname = (SELECT nspname FROM pg_namespace WHERE oid = e.stxnamespace)
       AND x.statistics_name = e.stxname
       AND x.expr = pg_get_expr(e.stxexprs, e.stxrelid)
     WHERE p.oid = 'content_chunks'::regclass AND e.stxname = $1`, [EMBEDDED_HASH_STATISTICS_NAME]);
  const state = rows[0];
  if (!state || !state.correct_table || state.expression !== '(embedded_text_hash = md5(chunk_text))') {
    throw new Error('Embedded-hash planner statistics are missing or have the wrong definition; the schema migration was not verified.');
  }
  if (!state.can_inspect) {
    throw new Error('Embedded-hash planner statistics cannot be inspected by this database role or its row-security policy; run schema maintenance with an authorized maintenance role.');
  }
  if (Number(state.sampled_rows) < 0 || (Number(state.sampled_rows) > 0 && !state.collected)) {
    throw new Error('Embedded-hash planner statistics have not been collected; run ANALYZE content_chunks(embedded_text_hash, chunk_text) as the table owner.');
  }
}
