/**
 * F4b (O-ENG-12, O-CEO-9): transactional planner-statistics accounting, PGLite
 * only. PGLite has no autovacuum and never populates
 * `pg_stat_user_tables.n_mod_since_analyze`, so every statement that changes
 * a hot table records how many rows it touched. The rows commit or roll back
 * with the data, survive crashes and restarts, and cover raw SQL, bulk writes
 * and delete/reinsert. Insert-only: no shared counter row.
 * `src/core/planner-stats.ts` turns them into row-delta ANALYZE.
 *
 * Applied only through `sqlFor.pglite` in the f4_planner_stats migration:
 * Postgres keeps autovacuum and its write paths gain no trigger.
 */
export const PLANNER_STATS_TABLES = ['pages', 'links', 'facts', 'takes', 'content_chunks', 'timeline_entries'] as const;
export type PlannerStatsTable = typeof PLANNER_STATS_TABLES[number];

const triggers = (table: PlannerStatsTable) => `
CREATE OR REPLACE TRIGGER planner_stats_ins AFTER INSERT ON ${table} REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION gbrain_count_modifications();
CREATE OR REPLACE TRIGGER planner_stats_upd AFTER UPDATE ON ${table} REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION gbrain_count_modifications();
CREATE OR REPLACE TRIGGER planner_stats_del AFTER DELETE ON ${table} REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION gbrain_count_modifications();`;

export const PLANNER_STATS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS planner_stats_deltas (
  id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  n BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS planner_stats_state (
  table_name TEXT PRIMARY KEY,
  analyzed_through BIGINT NOT NULL DEFAULT 0,
  analyzed_at TIMESTAMPTZ,
  last_analyze_ms INTEGER
);
CREATE OR REPLACE FUNCTION gbrain_count_modifications() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  modified BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT count(*) INTO modified FROM old_rows;
  ELSE
    SELECT count(*) INTO modified FROM new_rows;
  END IF;
  IF modified > 0 THEN
    INSERT INTO planner_stats_deltas (table_name, n) VALUES (TG_TABLE_NAME, modified);
  END IF;
  RETURN NULL;
END $$;
${PLANNER_STATS_TABLES.map(triggers).join('\n')}
`;
