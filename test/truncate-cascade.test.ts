import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { setupDB, teardownDB } from './e2e/helpers.ts';
import { testBackends } from './helpers/test-backends.ts';
import { truncateCascade } from './helpers/reset-pglite.ts';

for (const kind of testBackends()) {
  describe(`truncateCascade (${kind})`, () => {
    let engine: BrainEngine;
    beforeAll(async () => {
      if (kind === 'postgres') engine = await setupDB();
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
      await engine.executeRaw('CREATE TABLE truncate_fixture_parent (id serial PRIMARY KEY, value text)');
      await engine.executeRaw('CREATE TABLE truncate_fixture_child (id serial PRIMARY KEY, parent_id int REFERENCES truncate_fixture_parent)');
      await engine.executeRaw('CREATE TABLE truncate_fixture_unrelated (id serial PRIMARY KEY)');
    }, 60_000);
    beforeEach(async () => {
      await engine.executeRaw('TRUNCATE truncate_fixture_parent, truncate_fixture_unrelated RESTART IDENTITY CASCADE');
    });
    afterEach(async () => {
      await engine.executeRaw('DROP SCHEMA IF EXISTS truncate_fixture_external CASCADE');
      await engine.executeRaw('DROP TABLE IF EXISTS truncate_fixture_events');
      await engine.executeRaw('DROP FUNCTION IF EXISTS truncate_fixture_guard() CASCADE');
    });
    afterAll(async () => {
      await engine.executeRaw('DROP TABLE IF EXISTS truncate_fixture_child, truncate_fixture_parent, truncate_fixture_unrelated CASCADE');
      if (kind === 'postgres') await teardownDB();
      else await engine.disconnect();
    });

    test('empties the named table and its transitive referencers, continuing sequences', async () => {
      await engine.executeRaw('CREATE SCHEMA truncate_fixture_external');
      await engine.executeRaw('CREATE TABLE truncate_fixture_external.grandchild (id serial PRIMARY KEY, child_id int REFERENCES truncate_fixture_child)');
      await engine.executeRaw("INSERT INTO truncate_fixture_parent (value) VALUES ('parent')");
      await engine.executeRaw('INSERT INTO truncate_fixture_child (parent_id) VALUES (1)');
      await engine.executeRaw('INSERT INTO truncate_fixture_external.grandchild (child_id) VALUES (1)');
      await engine.executeRaw('INSERT INTO truncate_fixture_unrelated DEFAULT VALUES');
      await truncateCascade(engine, ['truncate_fixture_parent']);
      for (const table of ['truncate_fixture_parent', 'truncate_fixture_child', 'truncate_fixture_external.grandchild']) {
        expect(await engine.executeRaw(`SELECT * FROM ${table}`)).toEqual([]);
      }
      expect(await engine.executeRaw('SELECT id FROM truncate_fixture_unrelated')).toEqual([{ id: 1 }]);
      expect(await engine.executeRaw("INSERT INTO truncate_fixture_parent (value) VALUES ('next') RETURNING id")).toEqual([{ id: 2 }]);
      expect(await engine.executeRaw("SELECT current_setting('session_replication_role') AS role")).toEqual([{ role: 'origin' }]);
      await expect(engine.executeRaw('INSERT INTO truncate_fixture_child (parent_id) VALUES (999)')).rejects.toThrow('foreign key');
    });

    test(`${kind === 'postgres' ? 'reuses' : 'replaces'} table and index storage`, async () => {
      await engine.executeRaw("INSERT INTO truncate_fixture_parent (value) VALUES ('parent')");
      const sql = "SELECT relfilenode FROM pg_class WHERE oid IN ('truncate_fixture_parent'::regclass, 'truncate_fixture_child_pkey'::regclass) ORDER BY oid";
      const storage = await engine.executeRaw(sql);
      await truncateCascade(engine, ['truncate_fixture_parent']);
      if (kind === 'postgres') expect(await engine.executeRaw(sql)).toEqual(storage);
      else expect(await engine.executeRaw(sql)).not.toEqual(storage);
    });

    test('bypasses ordinary DELETE triggers like TRUNCATE and leaves them active afterwards', async () => {
      await engine.executeRaw("CREATE FUNCTION truncate_fixture_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'delete trigger is active'; END $$");
      await engine.executeRaw('CREATE TRIGGER truncate_fixture_delete BEFORE DELETE ON truncate_fixture_child FOR EACH ROW EXECUTE FUNCTION truncate_fixture_guard()');
      await engine.executeRaw("INSERT INTO truncate_fixture_parent (value) VALUES ('parent')");
      await engine.executeRaw('INSERT INTO truncate_fixture_child (parent_id) VALUES (1)');
      await truncateCascade(engine, ['truncate_fixture_parent']);
      expect(await engine.executeRaw('SELECT * FROM truncate_fixture_child')).toEqual([]);
      await engine.executeRaw('INSERT INTO truncate_fixture_child (parent_id) VALUES (NULL)');
      await expect(engine.executeRaw('DELETE FROM truncate_fixture_child')).rejects.toThrow('delete trigger is active');
    });

    test.each(['ALWAYS', 'REPLICA'])('falls back to TRUNCATE with an ENABLE %s row trigger in the closure', async mode => {
      await engine.executeRaw("CREATE FUNCTION truncate_fixture_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'replica delete trigger'; END $$");
      await engine.executeRaw('CREATE TRIGGER truncate_fixture_delete BEFORE DELETE ON truncate_fixture_child FOR EACH ROW EXECUTE FUNCTION truncate_fixture_guard()');
      await engine.executeRaw(`ALTER TABLE truncate_fixture_child ENABLE ${mode} TRIGGER truncate_fixture_delete`);
      await engine.executeRaw("INSERT INTO truncate_fixture_parent (value) VALUES ('parent')");
      await engine.executeRaw('INSERT INTO truncate_fixture_child (parent_id) VALUES (1)');
      await truncateCascade(engine, ['truncate_fixture_parent']);
      expect(await engine.executeRaw('SELECT * FROM truncate_fixture_child')).toEqual([]);
    });

    test('fires TRUNCATE triggers anywhere in the closure', async () => {
      await engine.executeRaw('CREATE TABLE truncate_fixture_events (value text)');
      await engine.executeRaw("CREATE FUNCTION truncate_fixture_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO truncate_fixture_events VALUES (TG_TABLE_NAME); RETURN NULL; END $$");
      await engine.executeRaw('CREATE TRIGGER truncate_fixture_truncate AFTER TRUNCATE ON truncate_fixture_child EXECUTE FUNCTION truncate_fixture_guard()');
      await truncateCascade(engine, ['truncate_fixture_parent']);
      expect(await engine.executeRaw('SELECT * FROM truncate_fixture_events')).toEqual([{ value: 'truncate_fixture_child' }]);
    });

    test('refuses empty or unsafe table lists', async () => {
      await expect(truncateCascade(engine, [])).rejects.toThrow('non-empty');
      await expect(truncateCascade(engine, ['pages; DROP TABLE pages'])).rejects.toThrow('invalid table name');
    });
  });
}
