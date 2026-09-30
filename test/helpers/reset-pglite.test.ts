import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from './reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('CREATE TABLE schema_version (version int)');
  await engine.executeRaw('INSERT INTO schema_version VALUES (1)');
  await engine.executeRaw('CREATE TABLE reset_fixture_parent (id serial PRIMARY KEY, value text)');
  await engine.executeRaw('CREATE TABLE reset_fixture_child (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, parent_id int REFERENCES reset_fixture_parent)');
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterEach(async () => {
  await engine.executeRaw('DROP EVENT TRIGGER IF EXISTS reset_fixture_event');
  await engine.executeRaw('DROP RULE IF EXISTS reset_fixture_rule ON reset_fixture_parent');
  await engine.executeRaw('DROP SCHEMA IF EXISTS reset_fixture_external CASCADE');
  await engine.executeRaw('DROP TABLE IF EXISTS reset_fixture_added, "reset_fixture_quoted""name", reset_fixture_truncate_events CASCADE');
  await engine.executeRaw('DROP SEQUENCE IF EXISTS reset_fixture_unowned');
  await engine.executeRaw('DROP FUNCTION IF EXISTS reset_fixture_guard(), reset_fixture_event_guard() CASCADE');
});

afterAll(async () => {
  await engine.disconnect();
});

describe('resetPgliteState', () => {
  test('reuses table and index storage during ordinary fixture cleanup', async () => {
    await engine.executeRaw("INSERT INTO reset_fixture_parent (value) VALUES ('before')");
    const sql = "SELECT oid, relfilenode FROM pg_class WHERE oid IN ('reset_fixture_parent'::regclass, 'reset_fixture_parent_pkey'::regclass) ORDER BY oid";
    const storage = await engine.executeRaw(sql);
    await resetPgliteState(engine);
    expect(await engine.executeRaw(sql)).toEqual(storage);
    expect(await engine.executeRaw('SELECT * FROM reset_fixture_parent')).toEqual([]);
  });

  test('reclaims aggregate TOAST-heavy storage across repeated full resets', async () => {
    await engine.executeRaw('CREATE TABLE reset_fixture_added (id serial PRIMARY KEY, value text)');
    const [{ payload }] = await engine.executeRaw<{ payload: string }>(
      "SELECT string_agg(md5(i::text), '') AS payload FROM generate_series(1, 4096) i",
    );
    expect(payload.length).toBe(128 * 1024);
    let previous = 0;
    let reclaimed = 0;
    let peak = 0;
    for (let i = 0; i < 100; i++) {
      expect(await engine.executeRaw('INSERT INTO reset_fixture_parent (value) VALUES ($1) RETURNING id', [payload]))
        .toEqual([{ id: 1 }]);
      expect(await engine.executeRaw('INSERT INTO reset_fixture_added (value) VALUES ($1) RETURNING id', [payload]))
        .toEqual([{ id: 1 }]);
      await resetPgliteState(engine);
      const [{ bytes }] = await engine.executeRaw<{ bytes: number }>(
        "SELECT (pg_total_relation_size('reset_fixture_parent') + pg_total_relation_size('reset_fixture_added'))::bigint AS bytes",
      );
      const size = Number(bytes);
      if (size < previous) reclaimed++;
      peak = Math.max(peak, size);
      previous = size;
      expect(size).toBeLessThan(8 * 1024 * 1024);
      expect(await engine.executeRaw('SELECT count(*)::int AS n FROM reset_fixture_parent UNION ALL SELECT count(*)::int AS n FROM reset_fixture_added'))
        .toEqual([{ n: 0 }, { n: 0 }]);
    }
    expect(peak).toBeGreaterThan(1024 * 1024);
    expect(reclaimed).toBeGreaterThanOrEqual(3);
    expect(await engine.executeRaw("SELECT current_setting('session_replication_role') AS role")).toEqual([{ role: 'origin' }]);
    await expect(engine.executeRaw('INSERT INTO reset_fixture_child (parent_id) VALUES (999)')).rejects.toThrow('foreign key');
  }, 60_000);

  test('clears every public table, including foreign-key cycles, and restores the default source', async () => {
    await engine.executeRaw('ALTER TABLE reset_fixture_parent ADD COLUMN child_id int REFERENCES reset_fixture_child');
    try {
      await engine.executeRaw("INSERT INTO reset_fixture_parent (value) VALUES ('parent')");
      await engine.executeRaw('INSERT INTO reset_fixture_child (parent_id) VALUES (1)');
      await engine.executeRaw('UPDATE reset_fixture_parent SET child_id = 1');
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('extra', 'Extra')");
      await engine.putPage('reset-fixture/page', { type: 'note', title: 'Fixture', compiled_truth: 'body', timeline: '' });
      await engine.setConfig('reset-fixture', 'present');
      await resetPgliteState(engine);
      const tables = await engine.executeRaw<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'");
      for (const { tablename } of tables) {
        if (['schema_version', 'page_generation_clock', 'persistence_brain', 'sources'].includes(tablename)) continue;
        const rows = await engine.executeRaw(`SELECT count(*)::int AS n FROM public."${tablename.replaceAll('"', '""')}"`);
        expect(rows).toEqual([{ n: 0 }]);
      }
      expect(await engine.executeRaw('SELECT id, name, config, local_path FROM sources')).toEqual([
        { id: 'default', name: 'default', config: { federated: true }, local_path: null },
      ]);
    } finally {
      await engine.executeRaw('ALTER TABLE reset_fixture_parent DROP COLUMN child_id');
    }
  });

  test('preserves schema and generation infrastructure but rotates the logical brain identity', async () => {
    await engine.putPage('reset-fixture/generation', { type: 'note', title: 'Fixture', compiled_truth: 'body', timeline: '' });
    const version = await engine.executeRaw('SELECT * FROM schema_version');
    const clock = await engine.executeRaw('SELECT * FROM page_generation_clock');
    const generation = await engine.executeRaw('SELECT last_value, is_called FROM page_generation_clock_seq');
    const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain');
    await engine.executeRaw('UPDATE persistence_brain SET enabled = true, activated_at = now() WHERE singleton = 1');
    await resetPgliteState(engine);
    expect(await engine.executeRaw('SELECT * FROM schema_version')).toEqual(version);
    expect(await engine.executeRaw('SELECT * FROM page_generation_clock')).toEqual(clock);
    expect(await engine.executeRaw('SELECT last_value, is_called FROM page_generation_clock_seq')).toEqual(generation);
    const [fresh] = await engine.executeRaw<{ brain_id: string; enabled: boolean; activated_at: string | null }>('SELECT brain_id, enabled, activated_at FROM persistence_brain');
    expect(fresh.brain_id).not.toBe(brain.brain_id);
    expect(fresh.enabled).toBe(false);
    expect(fresh.activated_at).toBeNull();
  });

  test('restarts serial and identity sequences even when their tables are already empty', async () => {
    await engine.executeRaw("SELECT nextval('reset_fixture_parent_id_seq') FROM generate_series(1, 3)");
    await engine.executeRaw('INSERT INTO reset_fixture_child (parent_id) VALUES (NULL)');
    await engine.executeRaw('DELETE FROM reset_fixture_child');
    await engine.executeRaw('CREATE SEQUENCE reset_fixture_unowned START 7');
    await engine.executeRaw("SELECT nextval('reset_fixture_unowned')");
    await resetPgliteState(engine);
    expect(await engine.executeRaw("INSERT INTO reset_fixture_parent (value) VALUES ('fresh') RETURNING id")).toEqual([{ id: 1 }]);
    expect(await engine.executeRaw('INSERT INTO reset_fixture_child (parent_id) VALUES (1) RETURNING id')).toEqual([{ id: 1 }]);
    expect(await engine.executeRaw("SELECT nextval('reset_fixture_unowned') AS id")).toEqual([{ id: 8 }]);
  });

  test('discovers new tables and quoted identifiers on every reset and respects sequence starts', async () => {
    await resetPgliteState(engine);
    await engine.executeRaw('CREATE TABLE "reset_fixture_quoted""name" (id int GENERATED ALWAYS AS IDENTITY (START WITH 23), value text)');
    await engine.executeRaw('CREATE TABLE reset_fixture_added (id serial PRIMARY KEY)');
    await engine.executeRaw('INSERT INTO "reset_fixture_quoted""name" (value) VALUES (\'quoted\')');
    await engine.executeRaw('INSERT INTO reset_fixture_added DEFAULT VALUES');
    await resetPgliteState(engine);
    expect(await engine.executeRaw('SELECT * FROM "reset_fixture_quoted""name"')).toEqual([]);
    expect(await engine.executeRaw('SELECT * FROM reset_fixture_added')).toEqual([]);
    expect(await engine.executeRaw('INSERT INTO "reset_fixture_quoted""name" (value) VALUES (\'fresh\') RETURNING id')).toEqual([{ id: 23 }]);
    expect(await engine.executeRaw('INSERT INTO reset_fixture_added DEFAULT VALUES RETURNING id')).toEqual([{ id: 1 }]);
  });

  test('bypasses ordinary DELETE triggers only during cleanup and restores FK enforcement', async () => {
    await engine.executeRaw("CREATE FUNCTION reset_fixture_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'delete trigger is active'; END $$");
    await engine.executeRaw('CREATE TRIGGER reset_fixture_delete BEFORE DELETE ON reset_fixture_parent FOR EACH ROW EXECUTE FUNCTION reset_fixture_guard()');
    await engine.executeRaw("INSERT INTO reset_fixture_parent (value) VALUES ('before')");
    await resetPgliteState(engine);
    expect(await engine.executeRaw("SELECT current_setting('session_replication_role') AS role")).toEqual([{ role: 'origin' }]);
    await engine.executeRaw("INSERT INTO reset_fixture_parent (value) VALUES ('after')");
    await expect(engine.executeRaw('DELETE FROM reset_fixture_parent')).rejects.toThrow('delete trigger is active');
    await expect(engine.executeRaw('INSERT INTO reset_fixture_child (parent_id) VALUES (999)')).rejects.toThrow('foreign key');
  });

  test.each(['ALWAYS', 'REPLICA'])('retains TRUNCATE semantics with an ENABLE %s row trigger', async mode => {
    await engine.executeRaw("CREATE FUNCTION reset_fixture_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'replica delete trigger'; END $$");
    await engine.executeRaw('CREATE TRIGGER reset_fixture_delete BEFORE DELETE ON reset_fixture_parent FOR EACH ROW EXECUTE FUNCTION reset_fixture_guard()');
    await engine.executeRaw(`ALTER TABLE reset_fixture_parent ENABLE ${mode} TRIGGER reset_fixture_delete`);
    await engine.executeRaw("INSERT INTO reset_fixture_parent (value) VALUES ('before')");
    await resetPgliteState(engine);
    expect(await engine.executeRaw('SELECT * FROM reset_fixture_parent')).toEqual([]);
  });

  test('fires custom TRUNCATE triggers instead of silently bypassing their contract', async () => {
    await engine.executeRaw('CREATE TEMP TABLE reset_fixture_truncate_events (value text)');
    await engine.executeRaw("CREATE FUNCTION reset_fixture_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO reset_fixture_truncate_events VALUES ('truncated'); RETURN NULL; END $$");
    await engine.executeRaw('CREATE TRIGGER reset_fixture_truncate AFTER TRUNCATE ON reset_fixture_parent EXECUTE FUNCTION reset_fixture_guard()');
    await resetPgliteState(engine);
    expect(await engine.executeRaw('SELECT * FROM reset_fixture_truncate_events')).toEqual([{ value: 'truncated' }]);
  });

  test('cannot be bypassed by an ALWAYS-enabled DELETE rewrite rule', async () => {
    await engine.executeRaw('CREATE RULE reset_fixture_rule AS ON DELETE TO reset_fixture_parent DO INSTEAD NOTHING');
    await engine.executeRaw('ALTER TABLE reset_fixture_parent ENABLE ALWAYS RULE reset_fixture_rule');
    await engine.executeRaw("INSERT INTO reset_fixture_parent (value) VALUES ('before')");
    await resetPgliteState(engine);
    expect(await engine.executeRaw('SELECT * FROM reset_fixture_parent')).toEqual([]);
  });

  test('still cascades into a referencing table outside the public schema', async () => {
    await engine.executeRaw('CREATE SCHEMA reset_fixture_external');
    await engine.executeRaw('CREATE TABLE reset_fixture_external.child (id serial PRIMARY KEY, parent_id int REFERENCES reset_fixture_parent)');
    await engine.executeRaw("INSERT INTO reset_fixture_parent (value) VALUES ('parent')");
    await engine.executeRaw('INSERT INTO reset_fixture_external.child (parent_id) VALUES (1)');
    await resetPgliteState(engine);
    expect(await engine.executeRaw('SELECT * FROM reset_fixture_external.child')).toEqual([]);
    await engine.executeRaw("INSERT INTO reset_fixture_parent (value) VALUES ('fresh')");
    expect(await engine.executeRaw('INSERT INTO reset_fixture_external.child (parent_id) VALUES (1) RETURNING id')).toEqual([{ id: 1 }]);
  });

  test('retains inherited-table truncation across schemas', async () => {
    await engine.executeRaw('CREATE SCHEMA reset_fixture_external');
    await engine.executeRaw('CREATE TABLE reset_fixture_external.child () INHERITS (reset_fixture_parent)');
    await engine.executeRaw("INSERT INTO reset_fixture_external.child (value) VALUES ('inherited')");
    await resetPgliteState(engine);
    expect(await engine.executeRaw('SELECT * FROM reset_fixture_external.child')).toEqual([]);
  });

  test('does not introduce ALTER SEQUENCE event-trigger effects', async () => {
    await engine.executeRaw("CREATE FUNCTION reset_fixture_event_guard() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sequence DDL observed'; END $$");
    await engine.executeRaw("CREATE EVENT TRIGGER reset_fixture_event ON ddl_command_start WHEN TAG IN ('ALTER SEQUENCE') EXECUTE FUNCTION reset_fixture_event_guard()");
    await resetPgliteState(engine);
    expect(await engine.executeRaw("INSERT INTO reset_fixture_parent (value) VALUES ('fresh') RETURNING id")).toEqual([{ id: 1 }]);
  });

  test('rolls back failed reseeding and never leaves triggers disabled', async () => {
    await engine.executeRaw("CREATE FUNCTION reset_fixture_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'reseed failed'; END $$");
    await engine.executeRaw('CREATE TRIGGER reset_fixture_insert BEFORE INSERT ON sources FOR EACH ROW EXECUTE FUNCTION reset_fixture_guard()');
    await engine.executeRaw("INSERT INTO reset_fixture_parent (value) VALUES ('survives')");
    const brain = await engine.executeRaw('SELECT * FROM persistence_brain');
    await expect(resetPgliteState(engine)).rejects.toThrow('reseed failed');
    expect(await engine.executeRaw('SELECT value FROM reset_fixture_parent')).toEqual([{ value: 'survives' }]);
    expect(await engine.executeRaw('SELECT * FROM persistence_brain')).toEqual(brain);
    expect(await engine.executeRaw("SELECT current_setting('session_replication_role') AS role")).toEqual([{ role: 'origin' }]);
    await expect(engine.executeRaw('INSERT INTO reset_fixture_child (parent_id) VALUES (999)')).rejects.toThrow('foreign key');
  });
});
