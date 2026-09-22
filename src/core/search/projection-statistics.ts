import type { BrainEngine } from '../engine.ts';

export const PROJECTION_STATISTICS_NAME = 'pages_text_projection_current_stats';

export const PROJECTION_STATISTICS_SQL = `
CREATE STATISTICS IF NOT EXISTS ${PROJECTION_STATISTICS_NAME}
  ON ((text_projection_revision = knowledge_revision)) FROM pages;
ANALYZE pages(text_projection_revision, knowledge_revision);
`;

export async function verifyProjectionStatistics(engine: Pick<BrainEngine, 'executeRaw'>): Promise<void> {
  const rows = await engine.executeRaw<{
    expression: string;
    correct_table: boolean;
    sampled_rows: number;
    can_inspect: boolean;
    collected: boolean;
  }>(`SELECT pg_get_expr(e.stxexprs, e.stxrelid) AS expression,
       e.stxrelid = 'pages'::regclass AS correct_table,
       p.reltuples AS sampled_rows,
       has_table_privilege(p.oid, 'SELECT') AND NOT row_security_active(p.oid) AS can_inspect,
       x.null_frac IS NOT NULL AS collected
     FROM pg_class p JOIN pg_statistic_ext e ON e.stxnamespace = p.relnamespace
     LEFT JOIN pg_stats_ext_exprs x
       ON x.statistics_schemaname = (SELECT nspname FROM pg_namespace WHERE oid = e.stxnamespace)
       AND x.statistics_name = e.stxname
       AND x.expr = pg_get_expr(e.stxexprs, e.stxrelid)
     WHERE p.oid = 'pages'::regclass AND e.stxname = $1`, [PROJECTION_STATISTICS_NAME]);
  const state = rows[0];
  if (!state || !state.correct_table || state.expression !== '(text_projection_revision = knowledge_revision)') {
    throw new Error('Projection planner statistics are missing or have the wrong definition; the schema migration was not verified.');
  }
  if (!state.can_inspect) {
    throw new Error('Projection planner statistics cannot be inspected by this database role or its row-security policy; run schema maintenance with an authorized maintenance role.');
  }
  if (Number(state.sampled_rows) < 0 || (Number(state.sampled_rows) > 0 && !state.collected)) {
    throw new Error('Projection planner statistics have not been collected; run ANALYZE pages(text_projection_revision, knowledge_revision) as the table owner.');
  }
}

export async function refreshProjectionStatistics(engine: BrainEngine): Promise<boolean> {
  try {
    const [role] = await engine.executeRaw<{ can_analyze: boolean }>(
      `SELECT pg_has_role(current_user, p.relowner, 'USAGE') OR r.rolsuper AS can_analyze
       FROM pg_class p CROSS JOIN pg_roles r
       WHERE p.oid = 'pages'::regclass AND r.rolname = current_user`,
    );
    if (!role?.can_analyze) {
      console.warn('[search] Projection planner statistics were not refreshed: database-owner maintenance is required. Run ANALYZE pages(text_projection_revision, knowledge_revision) as the table owner.');
      return false;
    }
    await engine.transaction(async tx => {
      if (engine.kind === 'postgres') {
        await tx.executeRaw("SET LOCAL statement_timeout = '30s'");
        await tx.executeRaw("SET LOCAL lock_timeout = '2s'");
      }
      await tx.executeRaw('ANALYZE pages(text_projection_revision, knowledge_revision)');
      await verifyProjectionStatistics(tx);
    });
    return true;
  } catch {
    console.warn('[search] Projection planner statistics could not be refreshed. Run ANALYZE pages(text_projection_revision, knowledge_revision) as the table owner; completed page writes were retained.');
    return false;
  }
}
