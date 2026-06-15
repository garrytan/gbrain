import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { SCHEMA_SQL } from '../src/core/schema-embedded.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

const PGLITE_SCHEMA_TEST_TIMEOUT_MS = 60_000;
const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    rmSync(tempPaths.pop()!, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.push(dir);
  return dir;
}

function createLegacySqliteMemoryCandidateEntries(db: any): void {
  db.exec(`
    CREATE TABLE memory_candidate_entries (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      candidate_type TEXT NOT NULL CHECK (candidate_type IN ('fact', 'relationship', 'note_update', 'procedure', 'profile_update', 'open_question', 'rationale')),
      proposed_content TEXT NOT NULL,
      source_refs TEXT NOT NULL DEFAULT '[]',
      generated_by TEXT NOT NULL CHECK (generated_by IN ('agent', 'map_analysis', 'dream_cycle', 'manual', 'import')),
      extraction_kind TEXT NOT NULL CHECK (extraction_kind IN ('extracted', 'inferred', 'ambiguous', 'manual')),
      confidence_score REAL NOT NULL,
      importance_score REAL NOT NULL,
      recurrence_score REAL NOT NULL,
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'work', 'personal', 'secret', 'unknown')),
      status TEXT NOT NULL CHECK (status IN ('captured', 'candidate', 'staged_for_review', 'rejected', 'promoted', 'superseded')),
      target_object_type TEXT CHECK (target_object_type IS NULL OR target_object_type IN ('curated_note', 'procedure', 'profile_memory', 'personal_episode', 'other')),
      target_object_id TEXT,
      reviewed_at TEXT,
      review_reason TEXT,
      patch_target_kind TEXT CHECK (patch_target_kind IS NULL OR patch_target_kind IN ('page', 'source_record', 'task_thread', 'working_set', 'task_event', 'task_episode', 'attempt', 'decision', 'procedure', 'memory_candidate', 'memory_patch_candidate', 'profile_memory', 'personal_episode', 'memory_realm', 'memory_session', 'memory_session_attachment', 'context_map', 'context_atlas', 'file_artifact', 'export_artifact', 'ledger_event')),
      patch_target_id TEXT,
      patch_base_target_snapshot_hash TEXT,
      patch_body TEXT CHECK (patch_body IS NULL OR (json_valid(patch_body) AND json_type(patch_body) IN ('object', 'array'))),
      patch_format TEXT CHECK (patch_format IS NULL OR patch_format IN ('merge_patch', 'json_patch', 'unified_diff', 'whole_record', 'operation')),
      patch_operation_state TEXT CHECK (patch_operation_state IS NULL OR patch_operation_state IN ('proposed', 'dry_run_validated', 'approved_for_apply', 'apply_in_progress', 'applied', 'conflicted', 'failed')),
      patch_risk_class TEXT CHECK (patch_risk_class IS NULL OR patch_risk_class IN ('low', 'medium', 'high', 'critical', 'unknown')),
      patch_expected_resulting_target_snapshot_hash TEXT,
      patch_provenance_summary TEXT,
      patch_actor TEXT,
      patch_originating_session_id TEXT,
      patch_ledger_event_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(patch_ledger_event_ids) AND json_type(patch_ledger_event_ids) = 'array'),
      verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'verified', 'refuted')),
      verification_method TEXT CHECK (verification_method IS NULL OR verification_method IN ('command_execution', 'db_query', 'file_inspection', 'source_recheck', 'user_confirmation', 'external_lookup')),
      verification_evidence TEXT,
      verification_source_refs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(verification_source_refs) AND json_type(verification_source_refs) = 'array'),
      verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

function createLegacySqliteMemoryMutationEvents(db: any): void {
  db.exec(`
    CREATE TABLE memory_mutation_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      realm_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (
        operation IN (
          'record_memory_mutation_event',
          'create_memory_candidate_entry',
          'advance_memory_candidate_status'
        )
      ),
      target_kind TEXT NOT NULL CHECK (
        target_kind IN ('page', 'memory_candidate', 'memory_patch_candidate', 'ledger_event')
      ),
      target_id TEXT NOT NULL,
      scope_id TEXT,
      source_refs TEXT NOT NULL CHECK (json_valid(source_refs) AND json_type(source_refs) = 'array'),
      expected_target_snapshot_hash TEXT,
      current_target_snapshot_hash TEXT,
      result TEXT NOT NULL CHECK (
        result IN ('dry_run', 'staged_for_review', 'approved', 'applied', 'conflict', 'denied', 'failed', 'redacted')
      ),
      conflict_info TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0 CHECK (
        dry_run IN (0, 1)
        AND (
          (result = 'dry_run' AND dry_run = 1)
          OR (result <> 'dry_run' AND dry_run = 0)
        )
      ),
      metadata TEXT NOT NULL DEFAULT '{}',
      redaction_visibility TEXT NOT NULL DEFAULT 'visible' CHECK (
        redaction_visibility IN ('visible', 'partially_redacted', 'tombstoned')
      ),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      decided_at TEXT,
      applied_at TEXT
    );
  `);
}

describe('canonical target proposal schema', () => {
  test('embedded Postgres baselines carry proposal foreign key contracts', () => {
    for (const schema of [SCHEMA_SQL, PGLITE_SCHEMA_SQL]) {
      expect(schema).toContain('CREATE TABLE IF NOT EXISTS memory_candidate_entries');
      expect(schema).toContain('CONSTRAINT fk_canonical_target_proposals_source_candidate');
      expect(schema).toContain('CONSTRAINT fk_canonical_target_proposals_stub_patch_candidate');
      expect(schema).toContain('CONSTRAINT fk_canonical_target_proposals_superseded_by');
      expect(schema).toContain('CONSTRAINT fk_canonical_target_proposal_status_events_proposal');
      expect(schema).toContain('REFERENCES canonical_target_proposal_entries(id) ON DELETE CASCADE');
    }
  });

  test('fresh PGLite schema contains proposal tables and indexes', async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ engine: 'pglite', database_path: join(tempDir('mbrain-proposal-pglite-'), 'db') });
      await engine.initSchema();

      const db = (engine as any).db;
      const tables = await db.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('canonical_target_proposal_entries', 'canonical_target_proposal_status_events')
         ORDER BY table_name`,
      );
      expect(tables.rows.map((row: { table_name: string }) => row.table_name)).toEqual([
        'canonical_target_proposal_entries',
        'canonical_target_proposal_status_events',
      ]);

      const indexes = await db.query(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'canonical_target_proposal_entries'
         ORDER BY indexname`,
      );
      expect(indexes.rows.map((row: { indexname: string }) => row.indexname)).toEqual(
        expect.arrayContaining([
          'idx_canonical_target_proposals_scope_status',
          'idx_canonical_target_proposals_scope_slug',
          'idx_canonical_target_proposals_source_candidate',
          'idx_canonical_target_proposals_linked_candidates',
        ]),
      );

      const constraints = await db.query(
        `SELECT conname, contype, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid IN (
           'canonical_target_proposal_entries'::regclass,
           'canonical_target_proposal_status_events'::regclass
         )
         ORDER BY conname`,
      );
      const definitions = constraints.rows.map((row: { definition: string }) => row.definition).join('\n');
      expect(definitions).toContain('FOREIGN KEY (source_candidate_id) REFERENCES memory_candidate_entries(id)');
      expect(definitions).toContain('FOREIGN KEY (stub_patch_candidate_id) REFERENCES memory_candidate_entries(id)');
      expect(definitions).toContain('FOREIGN KEY (superseded_by) REFERENCES canonical_target_proposal_entries(id)');
      expect(definitions).toContain('FOREIGN KEY (proposal_id) REFERENCES canonical_target_proposal_entries(id) ON DELETE CASCADE');
      expect(definitions).toContain('proposed');
      expect(definitions).toContain('patch_staged');
    } finally {
      await engine.disconnect().catch(() => undefined);
    }
  }, PGLITE_SCHEMA_TEST_TIMEOUT_MS);

  test('PGLite migration 55 creates proposal contracts on existing databases', async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ engine: 'pglite', database_path: join(tempDir('mbrain-proposal-migrate-pglite-'), 'db') });
      const db = (engine as any).db;
      await db.exec(`
        CREATE TABLE config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO config (key, value) VALUES ('version', '54');

        CREATE TABLE memory_candidate_entries (
          id TEXT PRIMARY KEY,
          patch_target_kind TEXT
        );

        CREATE TABLE memory_mutation_events (
          id TEXT PRIMARY KEY,
          operation TEXT NOT NULL CHECK (
            operation IN (
              'record_memory_mutation_event',
              'create_memory_candidate_entry',
              'advance_memory_candidate_status'
            )
          ),
          target_kind TEXT NOT NULL CHECK (
            target_kind IN ('page', 'memory_candidate', 'memory_patch_candidate', 'ledger_event')
          )
        );
      `);

      await runMigrations(engine as any, { log: () => undefined });

      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      const constraints = await db.query(
        `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid IN (
           'canonical_target_proposal_entries'::regclass,
           'canonical_target_proposal_status_events'::regclass,
           'memory_candidate_entries'::regclass
         )
         ORDER BY conname`,
      );
      const definitions = constraints.rows.map((row: { conname: string; definition: string }) => (
        `${row.conname}: ${row.definition}`
      )).join('\n');

      expect(definitions).toContain('fk_canonical_target_proposals_source_candidate');
      expect(definitions).toContain('fk_canonical_target_proposals_stub_patch_candidate');
      expect(definitions).toContain('fk_canonical_target_proposals_superseded_by');
      expect(definitions).toContain('fk_canonical_target_proposal_status_events_proposal');
      expect(definitions).toContain('chk_memory_candidate_entries_patch_target_kind');
      expect(definitions).toContain('canonical_target_proposal');

      await db.exec(`
        INSERT INTO memory_mutation_events (id, operation, target_kind)
        VALUES
          ('proposal-ledger-operation', 'create_canonical_target_proposal', 'canonical_target_proposal'),
          ('candidate-bind-ledger-operation', 'bind_memory_candidate_target', 'memory_candidate');
      `);
      const ledgerRows = await db.query(
        `SELECT operation, target_kind
         FROM memory_mutation_events
         ORDER BY id`,
      );
      expect(ledgerRows.rows).toEqual([
        {
          operation: 'bind_memory_candidate_target',
          target_kind: 'memory_candidate',
        },
        {
          operation: 'create_canonical_target_proposal',
          target_kind: 'canonical_target_proposal',
        },
      ]);
    } finally {
      await engine.disconnect().catch(() => undefined);
    }
  }, PGLITE_SCHEMA_TEST_TIMEOUT_MS);

  test('fresh SQLite schema contains proposal tables and indexes', async () => {
    const engine = new SQLiteEngine();
    try {
      await engine.connect({ engine: 'sqlite', database_path: join(tempDir('mbrain-proposal-sqlite-'), 'brain.db') });
      await engine.initSchema();
      const db = (engine as any).database;

      const tables = db.query(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('canonical_target_proposal_entries', 'canonical_target_proposal_status_events')
         ORDER BY name`,
      ).all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual([
        'canonical_target_proposal_entries',
        'canonical_target_proposal_status_events',
      ]);

      const indexes = db.query(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'index'
           AND tbl_name = 'canonical_target_proposal_entries'
         ORDER BY name`,
      ).all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining([
        'idx_canonical_target_proposals_scope_status',
        'idx_canonical_target_proposals_scope_slug',
        'idx_canonical_target_proposals_source_candidate',
      ]));

      const proposalTable = db.query(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'canonical_target_proposal_entries'`,
      ).get() as { sql: string };
      expect(proposalTable.sql).toContain(`rationale TEXT NOT NULL DEFAULT ''`);
      expect(proposalTable.sql).toContain(
        "status IN ('proposed', 'approved', 'patch_staged', 'bound', 'rejected', 'superseded', 'blocked')",
      );

      const proposalFks = db.query(
        `PRAGMA foreign_key_list(canonical_target_proposal_entries)`,
      ).all() as Array<{ from: string; table: string; on_delete: string }>;
      expect(proposalFks).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: 'source_candidate_id', table: 'memory_candidate_entries' }),
        expect.objectContaining({ from: 'stub_patch_candidate_id', table: 'memory_candidate_entries' }),
        expect.objectContaining({ from: 'superseded_by', table: 'canonical_target_proposal_entries' }),
      ]));

      const eventFks = db.query(
        `PRAGMA foreign_key_list(canonical_target_proposal_status_events)`,
      ).all() as Array<{ from: string; table: string; on_delete: string }>;
      const eventTable = db.query(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'canonical_target_proposal_status_events'`,
      ).get() as { sql: string };
      expect(eventTable.sql).toContain(
        "from_status IN ('proposed', 'approved', 'patch_staged', 'bound', 'rejected', 'superseded', 'blocked')",
      );
      expect(eventTable.sql).toContain(
        "to_status IN ('proposed', 'approved', 'patch_staged', 'bound', 'rejected', 'superseded', 'blocked')",
      );
      expect(eventTable.sql).toContain(
        "event_kind IN ('created', 'approved', 'patch_staged', 'bound', 'rejected', 'superseded', 'blocked')",
      );
      expect(eventFks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          from: 'proposal_id',
          table: 'canonical_target_proposal_entries',
          on_delete: 'CASCADE',
        }),
      ]));
    } finally {
      await engine.disconnect().catch(() => undefined);
    }
  });

  test('SQLite migration 55 creates proposal contracts and repairs patch targets', async () => {
    const engine = new SQLiteEngine();
    try {
      await engine.connect({ engine: 'sqlite', database_path: join(tempDir('mbrain-proposal-migrate-sqlite-'), 'brain.db') });
      const db = (engine as any).database;
      db.exec(`
        CREATE TABLE config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO config (key, value) VALUES ('version', '54');
      `);
      createLegacySqliteMemoryCandidateEntries(db);
      createLegacySqliteMemoryMutationEvents(db);

      await (engine as any).runSqliteMigrations(54);

      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      const candidateTable = db.query(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'memory_candidate_entries'`,
      ).get() as { sql: string };
      expect(candidateTable.sql).toContain('canonical_target_proposal');

      const proposalTable = db.query(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'canonical_target_proposal_entries'`,
      ).get() as { sql: string };
      expect(proposalTable.sql).toContain(`rationale TEXT NOT NULL DEFAULT ''`);
      expect(proposalTable.sql).toContain(
        "status IN ('proposed', 'approved', 'patch_staged', 'bound', 'rejected', 'superseded', 'blocked')",
      );

      const eventTable = db.query(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'canonical_target_proposal_status_events'`,
      ).get() as { sql: string };
      expect(eventTable.sql).toContain('ON DELETE CASCADE');
      expect(eventTable.sql).toContain(
        "event_kind IN ('created', 'approved', 'patch_staged', 'bound', 'rejected', 'superseded', 'blocked')",
      );

      db.run(`
        INSERT INTO memory_mutation_events (
          id, session_id, realm_id, actor, operation, target_kind, target_id,
          scope_id, source_refs, result, dry_run, metadata, redaction_visibility
        ) VALUES (
          'proposal-ledger-operation', 'session', 'realm', 'test',
          'create_canonical_target_proposal', 'canonical_target_proposal', 'proposal',
          'workspace:default', '["User, direct message, 2026-06-15 12:00 KST"]',
          'approved', 0, '{}', 'visible'
        )
      `);
      db.run(`
        INSERT INTO memory_mutation_events (
          id, session_id, realm_id, actor, operation, target_kind, target_id,
          scope_id, source_refs, result, dry_run, metadata, redaction_visibility
        ) VALUES (
          'candidate-bind-ledger-operation', 'session', 'realm', 'test',
          'bind_memory_candidate_target', 'memory_candidate', 'candidate',
          'workspace:default', '["User, direct message, 2026-06-15 12:01 KST"]',
          'approved', 0, '{}', 'visible'
        )
      `);
      const ledgerRows = db.query(
        `SELECT operation, target_kind
         FROM memory_mutation_events
         ORDER BY id`,
      ).all() as Array<{ operation: string; target_kind: string }>;
      expect(ledgerRows).toEqual([
        {
          operation: 'bind_memory_candidate_target',
          target_kind: 'memory_candidate',
        },
        {
          operation: 'create_canonical_target_proposal',
          target_kind: 'canonical_target_proposal',
        },
      ]);
    } finally {
      await engine.disconnect().catch(() => undefined);
    }
  });
});
