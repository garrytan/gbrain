import { expect, test } from 'bun:test';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

const databaseUrl = process.env.DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

postgresTest('postgres initSchema creates restricted runner tables and append-only audit records', async () => {
  await withPostgresRunnerHarness(async (engine) => {
    await engine.initSchema();
	    await expectRunnerTables(engine);
	    await expectRunnerAuditTriggers(engine);
	    await expectAppendOnlyAuditFkDeleteRules(engine, { includeLifecycle: true });
	    await insertRunnerJob(engine, 'runner-job:fresh');
	    await expectRunnerJobIdentityGuards(engine, 'runner-job:fresh');

	    await engine.sql`
      INSERT INTO runner_tool_calls (
        id, runner_job_id, tool_name, status, policy_reason, request_hash, token_usage_json
      ) VALUES (
        ${'runner-tool-call:fresh'},
        ${'runner-job:fresh'},
        ${'read_assertion_context'},
        ${'allowed'},
        ${'runner_tool_allowed'},
        ${'sha256:request'},
        ${engine.sql.json({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })}
      )
    `;
  });
}, 60_000);

postgresTest('postgres v40 upgrades install restricted runner tables through migration v41', async () => {
  await withPostgresRunnerHarness(async (engine) => {
    await seedV40Prerequisites(engine);

    await runMigrations(engine);

	    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
	    await expectRunnerTables(engine);
	    await expectRunnerAuditTriggers(engine);
	    await expectAppendOnlyAuditFkDeleteRules(engine, { includeLifecycle: false });
	    await insertRunnerJob(engine, 'runner-job:upgrade');
	    await expectRunnerJobIdentityGuards(engine, 'runner-job:upgrade');
	    const rows = await engine.sql`
      SELECT runner_kind, task_type, can_execute_shell, can_access_connector_credentials
      FROM runner_jobs
      WHERE id = ${'runner-job:upgrade'}
    `;
    expect(rows[0]).toMatchObject({
      runner_kind: 'codex',
      task_type: 'assertion_extraction',
      can_execute_shell: false,
      can_access_connector_credentials: false,
    });
  });
}, 60_000);

async function withPostgresRunnerHarness(
  fn: (engine: PostgresEngine) => Promise<void>,
): Promise<void> {
  if (!databaseUrl) return;

  const engine = new PostgresEngine();
  const schemaName = `restricted_runner_${crypto.randomUUID().replaceAll('-', '_')}`;

  await engine.connect({ engine: 'postgres', database_url: databaseUrl, poolSize: 1 });
  await engine.sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
  await engine.sql.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public');
  await engine.sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
  await engine.sql.unsafe(`SET search_path TO "${schemaName}", public`);

  try {
    await fn(engine);
  } finally {
    await engine.sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await engine.disconnect();
  }
}

async function expectRunnerTables(engine: PostgresEngine): Promise<void> {
  const tables = await engine.sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN (
        'runner_jobs',
        'runner_tool_calls',
        'runner_messages',
        'runner_artifacts'
      )
    ORDER BY table_name
  `;
  expect(tables.map((row) => row.table_name)).toEqual([
    'runner_artifacts',
    'runner_jobs',
    'runner_messages',
    'runner_tool_calls',
  ]);
}

async function expectRunnerAuditTriggers(engine: PostgresEngine): Promise<void> {
  const triggers = await engine.sql`
    SELECT t.tgname
    FROM pg_trigger
      t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND n.nspname = current_schema()
	      AND c.relname IN ('runner_jobs', 'runner_tool_calls', 'runner_messages', 'runner_artifacts')
	      AND t.tgname IN (
	        'prevent_runner_jobs_identity_update',
	        'prevent_runner_jobs_delete',
	        'prevent_runner_tool_calls_update',
	        'prevent_runner_tool_calls_delete',
        'prevent_runner_messages_update',
        'prevent_runner_messages_delete',
        'prevent_runner_artifacts_update',
        'prevent_runner_artifacts_delete'
      )
    ORDER BY tgname
  `;
	  expect(triggers.map((row) => row.tgname)).toEqual([
	    'prevent_runner_artifacts_delete',
	    'prevent_runner_artifacts_update',
	    'prevent_runner_jobs_delete',
	    'prevent_runner_jobs_identity_update',
	    'prevent_runner_messages_delete',
	    'prevent_runner_messages_update',
    'prevent_runner_tool_calls_delete',
    'prevent_runner_tool_calls_update',
	  ]);
	}

async function expectAppendOnlyAuditFkDeleteRules(
  engine: PostgresEngine,
  options: { includeLifecycle: boolean },
): Promise<void> {
  const rows = await engine.sql`
    SELECT tc.table_name, kcu.column_name, rc.delete_rule
    FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_schema = tc.constraint_schema
       AND kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema = tc.table_schema
       AND kcu.table_name = tc.table_name
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_schema = tc.constraint_schema
       AND rc.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = current_schema()
      AND (
        (tc.table_name = 'runner_jobs' AND kcu.column_name = 'memory_job_id')
        OR (tc.table_name = 'forgetting_events' AND kcu.column_name = 'policy_id')
        OR (tc.table_name = 'restore_events' AND kcu.column_name = 'policy_id')
        OR (tc.table_name = 'memory_tombstones' AND kcu.column_name IN ('purge_event_id', 'purge_plan_id'))
      )
  `;
  const deleteRules = new Map(rows.map((row) => [
    `${String(row.table_name)}.${String(row.column_name)}`,
    String(row.delete_rule),
  ]));
  const expected = [
    'runner_jobs.memory_job_id',
    ...(options.includeLifecycle
      ? [
          'forgetting_events.policy_id',
          'restore_events.policy_id',
          'memory_tombstones.purge_event_id',
          'memory_tombstones.purge_plan_id',
        ]
      : []),
  ];

  for (const key of expected) {
    expect(deleteRules.get(key)).toBe('RESTRICT');
  }
}

async function expectRunnerJobIdentityGuards(engine: PostgresEngine, id: string): Promise<void> {
  await engine.sql`
    UPDATE runner_jobs
    SET status = ${'running'}, updated_at = ${'2026-05-21T09:10:00.000Z'}
    WHERE id = ${id}
  `;
  const statusRows = await engine.sql`
    SELECT status
    FROM runner_jobs
    WHERE id = ${id}
  `;
  expect(statusRows[0]?.status).toBe('running');

  await expectSqlRejects(engine.sql`
    UPDATE runner_jobs
    SET prompt_hash = ${'sha256:tampered'}
    WHERE id = ${id}
  `, 'runner job identity fields are append-only');

  await expectSqlRejects(engine.sql`
    DELETE FROM runner_jobs
    WHERE id = ${id}
  `, 'runner jobs are append-only');
}

async function expectSqlRejects(query: PromiseLike<unknown>, message: string): Promise<void> {
  let thrown: unknown = null;
  try {
    await query;
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeTruthy();
  expect(String((thrown as { message?: unknown }).message ?? thrown)).toContain(message);
}

async function seedV40Prerequisites(engine: PostgresEngine): Promise<void> {
  await engine.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO config (key, value) VALUES ('version', '40')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

    CREATE TABLE IF NOT EXISTS memory_jobs (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      queue             TEXT NOT NULL DEFAULT 'maintenance',
      status            TEXT NOT NULL,
      priority          INTEGER NOT NULL DEFAULT 0,
      payload_json      JSONB NOT NULL DEFAULT '{}',
      result_json       JSONB,
      progress_json     JSONB NOT NULL DEFAULT '{}',
      max_attempts      INTEGER NOT NULL DEFAULT 1,
      attempts_started  INTEGER NOT NULL DEFAULT 0,
      attempts_finished INTEGER NOT NULL DEFAULT 0,
      backoff_type      TEXT NOT NULL DEFAULT 'none',
      backoff_delay_ms  INTEGER NOT NULL DEFAULT 0,
      lock_token        TEXT,
      lock_owner        TEXT,
      lock_expires_at   TIMESTAMPTZ,
      timeout_ms        INTEGER,
      timeout_at        TIMESTAMPTZ,
      idempotency_key   TEXT,
      parent_job_id     TEXT REFERENCES memory_jobs(id) ON DELETE SET NULL,
      failure_class     TEXT,
      last_error        TEXT,
      next_run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at        TIMESTAMPTZ,
      finished_at       TIMESTAMPTZ,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION prevent_maintenance_audit_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'maintenance audit tables are append-only';
    END;
    $$ LANGUAGE plpgsql;
  `);
}

async function insertRunnerJob(engine: PostgresEngine, id: string): Promise<void> {
  await engine.sql`
    INSERT INTO runner_jobs (
      id, runner_kind, task_type, source_scope_json, prompt_hash, input_hash,
      status, token_usage_json
    ) VALUES (
      ${id},
      ${'codex'},
      ${'assertion_extraction'},
      ${engine.sql.json({
        source_id: 'source:codex',
        source_item_ids: ['source-item:1'],
        chunk_ids: ['source-chunk:1'],
      })},
      ${'sha256:prompt'},
      ${'sha256:input'},
      ${'queued'},
      ${engine.sql.json({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })}
    )
  `;
}
