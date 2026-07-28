/**
 * Real-Postgres regression for synthesis receipt correlation.
 *
 * `minion_jobs.id` is INTEGER and decodes as a JavaScript number, while
 * `subagent_tool_executions.job_id` is BIGINT and the Postgres engine decodes it
 * as a JavaScript bigint. `collectChildPutPageSlugs` must normalize that driver
 * boundary before consulting number-keyed chunk and raw-source maps.
 *
 * Run: DATABASE_URL=... bun test test/e2e/synthesize-bigint-job-id-postgres.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { __testing } from '../../src/core/cycle/synthesize.ts';
import {
  getConn,
  getEngine,
  hasDatabase,
  setupDB,
  teardownDB,
} from './helpers.ts';

const { collectChildPutPageSlugs } = __testing;
const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping synthesis bigint job-id E2E (DATABASE_URL not set)');
}

describeE2E('synthesis receipt job-id correlation on Postgres', () => {
  beforeAll(async () => { await setupDB(); });
  afterAll(async () => { await teardownDB(); });

  test('matches bigint receipt ids to number-keyed child metadata', async () => {
    const engine = getEngine();
    const conn = getConn();
    const [job] = await conn`
      INSERT INTO minion_jobs (queue, name, data, status)
      VALUES ('default', 'subagent', ${conn.json({})}, 'completed')
      RETURNING id
    `;
    const jobId = job.id as number;

    try {
      await conn`
        INSERT INTO subagent_tool_executions (
          job_id, message_idx, tool_use_id, tool_name, status, input
        ) VALUES (
          ${jobId}, 0, 'bigint_job_id_tool', 'brain_put_page', 'complete',
          ${conn.json({ slug: 'wiki/agents/test/postgres-bigint-abc123' })}
        )
      `;

      const [receipt] = await engine.executeRaw<{ job_id: unknown }>(
        `SELECT job_id
           FROM subagent_tool_executions
          WHERE job_id = $1`,
        [jobId],
      );
      expect(typeof jobId).toBe('number');
      expect(typeof receipt.job_id).toBe('bigint');

      const refs = await collectChildPutPageSlugs(
        engine,
        [jobId],
        new Map([[jobId, { idx: 2, hash6: 'abc123' }]]),
        'default',
        new Map([[jobId, '/transcripts/postgres-bigint.md']]),
      );

      expect(refs).toEqual([{
        slug: 'wiki/agents/test/postgres-bigint-abc123-c2',
        source_id: 'default',
        raw_source: '/transcripts/postgres-bigint.md',
      }]);
    } finally {
      await conn`DELETE FROM minion_jobs WHERE id = ${jobId}`;
    }
  }, 30_000);
});
