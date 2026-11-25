
import type { SqlExecutor } from './executor.ts';

/**
 * The post-commit observation of each publication with a committed event: one clock_timestamp() for the statement, never
 * below the publication's newest recorded_at, and never replacing a mark already written.
 */
export async function markBeliefCommits(exec: SqlExecutor, publicationIds: readonly string[]): Promise<void> {
  await exec.executeRaw(`WITH t AS MATERIALIZED (SELECT clock_timestamp() AS at)
    INSERT INTO belief_commit_marks (publication_id, observed_at)
    SELECT e.publication_id, t.at FROM t, belief_events e
    WHERE e.publication_id = ANY($1::uuid[])
    GROUP BY e.publication_id, t.at HAVING max(e.recorded_at) <= t.at
    ON CONFLICT (publication_id) DO NOTHING`, [[...publicationIds]]);
}
