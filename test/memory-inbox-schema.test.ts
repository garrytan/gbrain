import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import postgres from 'postgres';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

describe('memory-inbox schema', () => {
  const tempPaths: string[] = [];
  const SUPERSEDED_LINK_REQUIRED_PATTERN = /superseded candidate requires a supersession link record/;
  const legacyMemoryCandidateV15Sql = `
    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO config (key, value) VALUES ('version', '15');

    CREATE TABLE memory_candidate_entries (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      candidate_type TEXT NOT NULL CHECK (candidate_type IN ('fact', 'relationship', 'note_update', 'procedure', 'profile_update', 'open_question', 'rationale')),
      proposed_content TEXT NOT NULL,
      source_refs JSONB NOT NULL DEFAULT '[]',
      generated_by TEXT NOT NULL CHECK (generated_by IN ('agent', 'map_analysis', 'dream_cycle', 'manual', 'import')),
      extraction_kind TEXT NOT NULL CHECK (extraction_kind IN ('extracted', 'inferred', 'ambiguous', 'manual')),
      confidence_score DOUBLE PRECISION NOT NULL,
      importance_score DOUBLE PRECISION NOT NULL,
      recurrence_score DOUBLE PRECISION NOT NULL,
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'work', 'personal', 'secret', 'unknown')),
      status TEXT NOT NULL CHECK (status IN ('captured', 'candidate', 'staged_for_review')),
      target_object_type TEXT CHECK (target_object_type IS NULL OR target_object_type IN ('curated_note', 'procedure', 'profile_memory', 'personal_episode', 'other')),
      target_object_id TEXT,
      reviewed_at TIMESTAMPTZ,
      review_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_memory_candidates_scope_status
      ON memory_candidate_entries(scope_id, status, updated_at DESC);
    CREATE INDEX idx_memory_candidates_scope_type
      ON memory_candidate_entries(scope_id, candidate_type, updated_at DESC);
    CREATE INDEX idx_memory_candidates_target
      ON memory_candidate_entries(target_object_type, target_object_id);
  `;
  const legacyMemoryCandidateSqliteV15Sql = `
    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO config (key, value) VALUES ('version', '15');

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
      status TEXT NOT NULL CHECK (status IN ('captured', 'candidate', 'staged_for_review')),
      target_object_type TEXT CHECK (target_object_type IS NULL OR target_object_type IN ('curated_note', 'procedure', 'profile_memory', 'personal_episode', 'other')),
      target_object_id TEXT,
      reviewed_at TEXT,
      review_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX idx_memory_candidates_scope_status
      ON memory_candidate_entries(scope_id, status, updated_at DESC);
    CREATE INDEX idx_memory_candidates_scope_type
      ON memory_candidate_entries(scope_id, candidate_type, updated_at DESC);
    CREATE INDEX idx_memory_candidates_target
      ON memory_candidate_entries(target_object_type, target_object_id);
  `;

  const seedMigrationCandidates = async (
    engine: PGLiteEngine | PostgresEngine,
    prefix: string,
    sourceRef: string,
  ) => {
    for (const suffix of ['rejectable', 'promotable', 'supersedable', 'replacement']) {
      const id = `${prefix}-${suffix}`;
      await engine.createMemoryCandidateEntry({
        id,
        scope_id: 'workspace:default',
        candidate_type: 'fact',
        proposed_content: `Candidate ${id} must survive migration.`,
        source_refs: [sourceRef],
        generated_by: 'manual',
        extraction_kind: 'manual',
        confidence_score: 0.7,
        importance_score: 0.6,
        recurrence_score: 0.1,
        sensitivity: 'work',
        status: 'captured',
      });
    }
  };

  const assertPgliteFinalStatusContract = async (engine: PGLiteEngine, prefix: string) => {
    const db = (engine as any).db;
    await expect(db.query(
      `UPDATE memory_candidate_entries
       SET status = 'rejected'
       WHERE id = $1`,
      [`${prefix}-rejectable`],
    )).resolves.toBeDefined();
    await expect(db.query(
      `UPDATE memory_candidate_entries
       SET status = 'promoted'
       WHERE id = $1`,
      [`${prefix}-promotable`],
    )).resolves.toBeDefined();
    await expect(db.query(
      `UPDATE memory_candidate_entries
       SET status = 'promoted'
       WHERE id = $1`,
      [`${prefix}-replacement`],
    )).resolves.toBeDefined();
    await expect(db.query(
      `UPDATE memory_candidate_entries
       SET status = 'superseded'
       WHERE id = $1`,
      [`${prefix}-supersedable`],
    )).rejects.toThrow(SUPERSEDED_LINK_REQUIRED_PATTERN);
    await db.query(
      `INSERT INTO memory_candidate_supersession_entries (
        id,
        scope_id,
        superseded_candidate_id,
        replacement_candidate_id,
        review_reason
      ) VALUES (
        $1,
        'workspace:default',
        $2,
        $3,
        'verified after migration'
      )`,
      [`${prefix}-supersession`, `${prefix}-supersedable`, `${prefix}-replacement`],
    );
    await expect(db.query(
      `UPDATE memory_candidate_entries
       SET status = 'superseded'
       WHERE id = $1`,
      [`${prefix}-supersedable`],
    )).resolves.toBeDefined();

    const statusRows = await db.query(
      `SELECT id, status
       FROM memory_candidate_entries
       WHERE id LIKE $1
       ORDER BY id ASC`,
      [`${prefix}-%`],
    );

    expect(statusRows.rows).toEqual([
      { id: `${prefix}-promotable`, status: 'promoted' },
      { id: `${prefix}-rejectable`, status: 'rejected' },
      { id: `${prefix}-replacement`, status: 'promoted' },
      { id: `${prefix}-supersedable`, status: 'superseded' },
    ]);
  };

  const assertSqliteFinalStatusContract = async (engine: SQLiteEngine, prefix: string) => {
    await engine.updateMemoryCandidateEntryStatus(`${prefix}-rejectable`, {
      status: 'rejected',
      review_reason: 'verified after sqlite migration',
    });
    await engine.promoteMemoryCandidateEntry(`${prefix}-promotable`);
    await engine.promoteMemoryCandidateEntry(`${prefix}-replacement`);
    await engine.promoteMemoryCandidateEntry(`${prefix}-supersedable`);
    const db = (engine as any).database;
    expect(() => {
      db.query(`
        UPDATE memory_candidate_entries
        SET status = 'superseded'
        WHERE id = ?
      `).run(`${prefix}-supersedable`);
    }).toThrow(SUPERSEDED_LINK_REQUIRED_PATTERN);
    await engine.supersedeMemoryCandidateEntry({
      id: `${prefix}-supersession`,
      scope_id: 'workspace:default',
      superseded_candidate_id: `${prefix}-supersedable`,
      replacement_candidate_id: `${prefix}-replacement`,
      expected_current_status: 'promoted',
      review_reason: 'verified after sqlite migration',
    });

    const statusRows = await engine.listMemoryCandidateEntries({
      scope_id: 'workspace:default',
      limit: 10,
    });

    expect(statusRows.map((entry) => ({ id: entry.id, status: entry.status })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: `${prefix}-promotable`, status: 'promoted' },
      { id: `${prefix}-rejectable`, status: 'rejected' },
      { id: `${prefix}-replacement`, status: 'promoted' },
      { id: `${prefix}-supersedable`, status: 'superseded' },
    ]);
  };

  const assertPostgresFinalStatusContract = async (engine: PostgresEngine, prefix: string) => {
    const sql = engine.sql;
    await sql`UPDATE memory_candidate_entries SET status = 'rejected' WHERE id = ${`${prefix}-rejectable`}`;
    await sql`UPDATE memory_candidate_entries SET status = 'promoted' WHERE id = ${`${prefix}-promotable`}`;
    await sql`UPDATE memory_candidate_entries SET status = 'promoted' WHERE id = ${`${prefix}-replacement`}`;
    await sql`UPDATE memory_candidate_entries SET status = 'promoted' WHERE id = ${`${prefix}-supersedable`}`;
    await expect(
      sql`UPDATE memory_candidate_entries SET status = 'superseded' WHERE id = ${`${prefix}-supersedable`}`,
    ).rejects.toThrow(SUPERSEDED_LINK_REQUIRED_PATTERN);
    await sql`
      INSERT INTO memory_candidate_supersession_entries (
        id,
        scope_id,
        superseded_candidate_id,
        replacement_candidate_id,
        review_reason
      ) VALUES (
        ${`${prefix}-supersession`},
        ${'workspace:default'},
        ${`${prefix}-supersedable`},
        ${`${prefix}-replacement`},
        ${'verified after postgres migration'}
      )
    `;
    await sql`UPDATE memory_candidate_entries SET status = 'superseded' WHERE id = ${`${prefix}-supersedable`}`;

    const statusRows = await sql`
      SELECT id, status
      FROM memory_candidate_entries
      WHERE id LIKE ${`${prefix}-%`}
      ORDER BY id ASC
    `;

    expect(statusRows.map((row) => ({ id: row.id, status: row.status }))).toEqual([
      { id: `${prefix}-promotable`, status: 'promoted' },
      { id: `${prefix}-rejectable`, status: 'rejected' },
      { id: `${prefix}-replacement`, status: 'promoted' },
      { id: `${prefix}-supersedable`, status: 'superseded' },
    ]);
  };

  afterEach(async () => {
    while (tempPaths.length > 0) {
      rmSync(tempPaths.pop()!, { recursive: true, force: true });
    }
  });

  test('sqlite initSchema creates memory candidate supersession schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-sqlite-'));
    const databasePath = join(dir, 'brain.db');
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const db = (engine as any).database;
    const rows = db
      .query(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('memory_candidate_entries', 'memory_candidate_supersession_entries', 'memory_candidate_contradiction_entries')
         ORDER BY name ASC`,
      )
      .all() as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toEqual([
      'memory_candidate_contradiction_entries',
      'memory_candidate_entries',
      'memory_candidate_supersession_entries',
    ]);

    const schema = db
      .query(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'memory_candidate_entries'`,
      )
      .get() as { sql: string };

    expect(schema.sql).toContain("candidate_type TEXT NOT NULL CHECK");
    expect(schema.sql).toContain("generated_by TEXT NOT NULL CHECK");
    expect(schema.sql).toContain("extraction_kind TEXT NOT NULL CHECK");
    expect(schema.sql).toContain("sensitivity TEXT NOT NULL CHECK");
    expect(schema.sql).toContain("status TEXT NOT NULL CHECK");
    expect(schema.sql).toContain("target_object_type TEXT CHECK");

    expect(() => {
      db.query(`
        INSERT INTO memory_candidate_entries (
          id,
          scope_id,
          candidate_type,
          proposed_content,
          source_refs,
          generated_by,
          extraction_kind,
          confidence_score,
          importance_score,
          recurrence_score,
          sensitivity,
          status
        ) VALUES (
          'promoted-status',
          'workspace:default',
          'fact',
          'Promoted should be valid in the promotion slice.',
          '[]',
          'manual',
          'manual',
          0.5,
          0.5,
          0,
          'work',
          'promoted'
        )
      `).run();
    }).not.toThrow();

    expect(() => {
      db.query(`
        INSERT INTO memory_candidate_entries (
          id,
          scope_id,
          candidate_type,
          proposed_content,
          source_refs,
          generated_by,
          extraction_kind,
          confidence_score,
          importance_score,
          recurrence_score,
          sensitivity,
          status
        ) VALUES (
          'bad-status',
          'workspace:default',
          'fact',
          'Invalid status should fail at the DB layer.',
          '[]',
          'manual',
          'manual',
          0.5,
          0.5,
          0,
          'work',
          'superseded'
        )
      `).run();
    }).toThrow(SUPERSEDED_LINK_REQUIRED_PATTERN);

    const supersessionSchema = db
      .query(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'memory_candidate_supersession_entries'`,
      )
      .get() as { sql: string };

    expect(supersessionSchema.sql).toContain("superseded_candidate_id TEXT NOT NULL");
    expect(supersessionSchema.sql).toContain("replacement_candidate_id TEXT NOT NULL");

    const contradictionSchema = db
      .query(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'memory_candidate_contradiction_entries'`,
      )
      .get() as { sql: string };

    expect(contradictionSchema.sql).toContain("candidate_id TEXT NOT NULL");
    expect(contradictionSchema.sql).toContain("challenged_candidate_id TEXT NOT NULL");
    expect(contradictionSchema.sql).toContain("outcome TEXT NOT NULL CHECK");

    await engine.disconnect();
  });

  test('sqlite upgrades an actual v15 memory candidate catalog', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-sqlite-v15-'));
    const databasePath = join(dir, 'brain.db');
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: databasePath });

    try {
      const db = (engine as any).database;
      db.exec(legacyMemoryCandidateSqliteV15Sql);

      for (const suffix of ['rejectable', 'promotable', 'supersedable', 'replacement']) {
        const id = `sqlitelegacy-${suffix}`;
        await engine.createMemoryCandidateEntry({
          id,
          scope_id: 'workspace:default',
          candidate_type: 'fact',
          proposed_content: `Candidate ${id} must survive SQLite v15 migration.`,
          source_refs: ['sqlite-legacy-v15-catalog'],
          generated_by: 'manual',
          extraction_kind: 'manual',
          confidence_score: 0.7,
          importance_score: 0.6,
          recurrence_score: 0.1,
          sensitivity: 'work',
          status: 'staged_for_review',
        });
      }

      await engine.initSchema();

      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      const preserved = await engine.listMemoryCandidateEntries({
        scope_id: 'workspace:default',
        limit: 10,
      });

      expect(preserved.map((entry) => entry.id).sort()).toEqual([
        'sqlitelegacy-promotable',
        'sqlitelegacy-rejectable',
        'sqlitelegacy-replacement',
        'sqlitelegacy-supersedable',
      ]);
      expect(preserved.every((entry) => entry.source_refs.includes('sqlite-legacy-v15-catalog'))).toBe(true);

      await assertSqliteFinalStatusContract(engine, 'sqlitelegacy');
    } finally {
      await engine.disconnect();
    }
  });

  test('sqlite rerun from stale v15 preserves final-status candidates and keeps final status contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-sqlite-rerun-'));
    const databasePath = join(dir, 'brain.db');
    tempPaths.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: databasePath });

    try {
      await engine.initSchema();

      const seedCandidate = async (id: string) => {
        await engine.createMemoryCandidateEntry({
          id,
          scope_id: 'workspace:default',
          candidate_type: 'fact',
          proposed_content: `Candidate ${id} must survive SQLite migration reruns.`,
          source_refs: ['sqlite-migration-rerun-test'],
          generated_by: 'manual',
          extraction_kind: 'manual',
          confidence_score: 0.7,
          importance_score: 0.6,
          recurrence_score: 0.1,
          sensitivity: 'work',
          status: 'staged_for_review',
        });
      };

      await seedCandidate('sqlite-rerun-rejectable');
      await seedCandidate('sqlite-rerun-promotable');
      await seedCandidate('sqlite-rerun-supersedable');
      await seedCandidate('sqlite-rerun-replacement');
      await engine.updateMemoryCandidateEntryStatus('sqlite-rerun-rejectable', {
        status: 'rejected',
        review_reason: 'seed final rejected status before replay',
      });
      await engine.promoteMemoryCandidateEntry('sqlite-rerun-promotable');
      await engine.promoteMemoryCandidateEntry('sqlite-rerun-supersedable');
      await engine.promoteMemoryCandidateEntry('sqlite-rerun-replacement');
      await engine.supersedeMemoryCandidateEntry({
        id: 'sqlite-rerun-supersession',
        scope_id: 'workspace:default',
        superseded_candidate_id: 'sqlite-rerun-supersedable',
        replacement_candidate_id: 'sqlite-rerun-replacement',
        expected_current_status: 'promoted',
        review_reason: 'seed final superseded status before replay',
      });

      await engine.setConfig('version', '15');
      await expect(engine.initSchema()).resolves.toBeUndefined();

      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      const preserved = await engine.listMemoryCandidateEntries({
        scope_id: 'workspace:default',
        limit: 10,
      });

      expect(preserved.map((entry) => [entry.id, entry.status]).sort()).toEqual([
        ['sqlite-rerun-promotable', 'promoted'],
        ['sqlite-rerun-rejectable', 'rejected'],
        ['sqlite-rerun-replacement', 'promoted'],
        ['sqlite-rerun-supersedable', 'superseded'],
      ]);
      expect(preserved.every((entry) => entry.source_refs.includes('sqlite-migration-rerun-test'))).toBe(true);
    } finally {
      await engine.disconnect();
    }
  });

  test('pglite initSchema creates memory candidate supersession schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-pglite-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();

    const result = await (engine as any).db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('memory_candidate_entries', 'memory_candidate_supersession_entries', 'memory_candidate_contradiction_entries')
       ORDER BY table_name ASC`,
    );

    expect(result.rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'memory_candidate_contradiction_entries',
      'memory_candidate_entries',
      'memory_candidate_supersession_entries',
    ]);

    await expect((engine as any).db.query(`
      INSERT INTO memory_candidate_entries (
        id,
        scope_id,
        candidate_type,
        proposed_content,
        source_refs,
        generated_by,
        extraction_kind,
        confidence_score,
        importance_score,
        recurrence_score,
        sensitivity,
        status
      ) VALUES (
        'promoted-status',
        'workspace:default',
        'fact',
        'Promoted should be valid in the promotion slice.',
        '[]',
        'manual',
        'manual',
        0.5,
        0.5,
        0,
        'work',
        'promoted'
      )
    `)).resolves.toBeDefined();

    await expect((engine as any).db.query(`
      INSERT INTO memory_candidate_entries (
        id,
        scope_id,
        candidate_type,
        proposed_content,
        source_refs,
        generated_by,
        extraction_kind,
        confidence_score,
        importance_score,
        recurrence_score,
        sensitivity,
        status
      ) VALUES (
        'bad-status',
        'workspace:default',
        'fact',
        'Invalid status should fail at the DB layer.',
        '[]',
        'manual',
        'manual',
        0.5,
        0.5,
        0,
        'work',
        'superseded'
      )
    `)).rejects.toThrow(SUPERSEDED_LINK_REQUIRED_PATTERN);

    const supersessionTables = await (engine as any).db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'memory_candidate_supersession_entries'`,
    );

    expect(supersessionTables.rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'memory_candidate_supersession_entries',
    ]);

    const contradictionTables = await (engine as any).db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'memory_candidate_contradiction_entries'`,
    );

    expect(contradictionTables.rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'memory_candidate_contradiction_entries',
    ]);

    await engine.disconnect();
  });

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    test('postgres upgrades an actual v15 memory candidate catalog', async () => {
      const schema = `mbrain_memory_inbox_v15_${Date.now()}`;
      const quotedSchema = `"${schema.replace(/"/g, '""')}"`;
      const admin = postgres(databaseUrl, { max: 1, idle_timeout: 1, connect_timeout: 10 });
      const schemaUrl = new URL(databaseUrl);
      schemaUrl.searchParams.set('options', `-c search_path=${schema}`);

      const engine = new PostgresEngine();
      try {
        await admin.unsafe(`CREATE SCHEMA ${quotedSchema}`);
        await engine.connect({ engine: 'postgres', database_url: schemaUrl.toString(), poolSize: 1 });
        await engine.sql.unsafe(legacyMemoryCandidateV15Sql);
        await seedMigrationCandidates(engine, 'pglegacy', 'postgres-legacy-v15-catalog');

        await runMigrations(engine);

        expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
        const preserved = await engine.listMemoryCandidateEntries({
          scope_id: 'workspace:default',
          limit: 10,
        });

        expect(preserved.map((entry) => entry.id).sort()).toEqual([
          'pglegacy-promotable',
          'pglegacy-rejectable',
          'pglegacy-replacement',
          'pglegacy-supersedable',
        ]);
        expect(preserved.every((entry) => entry.source_refs.includes('postgres-legacy-v15-catalog'))).toBe(true);

        await assertPostgresFinalStatusContract(engine, 'pglegacy');
      } finally {
        await engine.disconnect().catch(() => undefined);
        await admin.unsafe(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => undefined);
        await admin.end({ timeout: 0 }).catch(() => undefined);
      }
    }, 20000);
  } else {
    test.skip('postgres v15 memory candidate migration skipped: DATABASE_URL is not configured', () => {});
  }

  test('pglite upgrades an actual v15 memory candidate catalog', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-pglite-v15-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });

    try {
      const db = (engine as any).db;
      await db.exec(legacyMemoryCandidateV15Sql);
      await seedMigrationCandidates(engine, 'legacy', 'legacy-v15-catalog');

      await runMigrations(engine);

      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      const preserved = await engine.listMemoryCandidateEntries({
        scope_id: 'workspace:default',
        limit: 10,
      });

      expect(preserved.map((entry) => entry.id).sort()).toEqual([
        'legacy-promotable',
        'legacy-rejectable',
        'legacy-replacement',
        'legacy-supersedable',
      ]);
      expect(preserved.every((entry) => entry.source_refs.includes('legacy-v15-catalog'))).toBe(true);

      await assertPgliteFinalStatusContract(engine, 'legacy');
    } finally {
      await engine.disconnect();
    }
  });

  test('pglite rerun from v15 preserves candidates and keeps final status contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-pglite-rerun-'));
    tempPaths.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });

    try {
      await engine.initSchema();

      const seedCandidate = async (id: string) => {
        await engine.createMemoryCandidateEntry({
          id,
          scope_id: 'workspace:default',
          candidate_type: 'fact',
          proposed_content: `Candidate ${id} must survive migration reruns.`,
          source_refs: ['migration-rerun-test'],
          generated_by: 'manual',
          extraction_kind: 'manual',
          confidence_score: 0.7,
          importance_score: 0.6,
          recurrence_score: 0.1,
          sensitivity: 'work',
          status: 'captured',
        });
      };

      await seedCandidate('rerun-rejectable');
      await seedCandidate('rerun-promotable');
      await seedCandidate('rerun-supersedable');
      await seedCandidate('rerun-replacement');

      await engine.setConfig('version', '15');
      await runMigrations(engine);

      const preserved = await engine.listMemoryCandidateEntries({
        scope_id: 'workspace:default',
        limit: 10,
      });

      expect(preserved.map((entry) => entry.id).sort()).toEqual([
        'rerun-promotable',
        'rerun-rejectable',
        'rerun-replacement',
        'rerun-supersedable',
      ]);
      expect(preserved.every((entry) => entry.source_refs.includes('migration-rerun-test'))).toBe(true);

      await assertPgliteFinalStatusContract(engine, 'rerun');
    } finally {
      await engine.disconnect();
    }
  });
});
