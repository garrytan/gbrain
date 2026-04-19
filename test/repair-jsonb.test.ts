/**
 * Unit tests for `gbrain repair-jsonb`.
 *
 * The actual repair logic runs against real Postgres in
 * test/e2e/postgres-jsonb.test.ts (covers the round-trip + the migration
 * orchestrator end to end). Here we cover only the engine-detection
 * short-circuit: PGLite was never affected by the JSONB double-encode bug,
 * so the command must report 0 repaired rows and never connect.
 */

import { describe, test, expect } from 'bun:test';
import { repairJsonb } from '../src/commands/repair-jsonb.ts';

describe('repairJsonb — PGLite short-circuit', () => {
  test('PGLite engines short-circuit: no DB connection, all targets report 0 repaired', async () => {
    const result = await repairJsonb({
      dryRun: false,
      engineConfig: { engine: 'pglite' },
    });
    expect(result.engine).toBe('pglite');
    expect(result.total_repaired).toBe(0);
    // All 5 columns reported: pages.frontmatter, raw_data.data,
    // ingest_log.pages_updated, files.metadata, page_versions.frontmatter.
    expect(result.per_target.length).toBe(5);
    for (const t of result.per_target) {
      expect(t.rows_repaired).toBe(0);
    }
    const tables = result.per_target.map(t => `${t.table}.${t.column}`).sort();
    expect(tables).toEqual([
      'files.metadata',
      'ingest_log.pages_updated',
      'page_versions.frontmatter',
      'pages.frontmatter',
      'raw_data.data',
    ]);
  });
});
