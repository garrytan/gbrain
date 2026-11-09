/**
 * #8729: `gbrain sources writer failures` (readTerminalFailures) and the terminal summary on a source whose page has many
 * sync writes with large frozen intents.
 *
 * 1. Protects: the drill-down and the summary answer `ok` within their statement bound when a page holds a few hundred
 *    failed sync imports and thousands of later committed ones, each carrying a large frozen file in its intent.
 * 2. Fails when: the supersession probe's connector-retry branch reads every later committed submit_job's intent (one
 *    detoast per failed row and candidate) before it knows the failed row is a connector write, so each batch outruns
 *    TERMINAL_STATEMENT_MS and the read reports `unknown`.
 * 3. Postgres only: the bound is a server-side statement timeout.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { readTerminalFailures, readTerminalFailureSummary } from '../../src/core/persistence/terminal-failures.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';

let engine: PostgresEngine;
let close: (() => Promise<void>) | undefined;

async function seed(state: 'failed' | 'committed', rows: number): Promise<void> {
  await engine.executeRaw(`INSERT INTO persistence_requests (principal_kind, principal_id, request_id, operation, source_id, source_incarnation, slug, digest,
      authority, intent_bytes, terminal_reservation, state, intent, error_code, error_message, completed_at)
    SELECT 'local_cli', 'example', gen_random_uuid(), 'submit_job', 'source-a', gen_random_uuid(), 'conversations/chat-example', md5($1 || g::text),
      '{}'::jsonb, 1, 1, $1, jsonb_build_object('kind', 'managed_sync_import', 'path', 'conversations/chat-example.md', 'content', repeat(md5(g::text), 65536)),
      CASE WHEN $1 = 'failed' THEN 'body_staging_expired' END, CASE WHEN $1 = 'failed' THEN 'The staged body of this write is expired.' END,
      now() - (g || ' seconds')::interval
    FROM generate_series(1, $2::int) g`, [state, rows]);
}

(hasDatabase() ? describe : describe.skip)('terminal failure reads over large sync intents (#8729) [postgres]', () => {
  beforeAll(async () => {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine; close = pg.close;
    await engine.executeRaw("INSERT INTO sources(id, name, local_path, config) VALUES ('source-a', 'source-a', '/nonexistent/source-a', '{}')");
    await seed('failed', 200);
    for (let i = 0; i < 4; i++) await seed('committed', 500);
    await engine.executeRaw('ANALYZE persistence_requests');
  }, 300_000);
  afterAll(async () => { await close?.(); });

  test('the drill-down rows, its groups and the summary answer ok', async () => {
    const rows = await readTerminalFailures(engine, { sourceId: 'source-a' });
    expect(rows.status).toBe('ok');
    const groups = await readTerminalFailures(engine, { sourceId: 'source-a', groupBy: 'category' });
    expect(groups.status).toBe('ok');
    expect(groups.status === 'ok' && groups.groups?.reduce((sum, group) => sum + group.rows, 0)).toBe(200);
    expect((await readTerminalFailureSummary(engine, { sourceIds: ['source-a'] })).status).toBe('ok');
  }, 120_000);
});
