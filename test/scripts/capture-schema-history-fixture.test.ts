/**
 * scripts/capture-schema-history-fixture.ts: the dump a schema-history fixture
 * is made of must restore to the same catalog, function bodies and rows. A
 * small schema with every object kind the dumper writes (identity and serial
 * columns, a generated column, a partial index, a foreign key to a unique
 * index, a check, a constraint trigger with a WHEN clause, a view, row level
 * security with a policy) is dumped from one engine and restored into another.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { dumpBrainSchema } from '../../scripts/capture-schema-history-fixture.ts';
import { FUNCTION_BODIES_SQL, pgliteCatalogQuery } from '../helpers/schema-catalog.ts';
import { diffCatalogSnapshots, snapshotCatalog } from '../helpers/schema-diff.ts';
import { sameUpToFlattenedBooleanChains } from '../helpers/schema-history.ts';
import { withColdPglite } from '../helpers/with-snapshot.ts';

let original: PGLiteEngine;
let restored: PGLiteEngine;
let dump: string;

beforeAll(async () => {
  original = new PGLiteEngine();
  restored = new PGLiteEngine();
  await withColdPglite(async () => {
    await original.connect({});
    await restored.connect({});
  });
  await original.db.exec(`
    CREATE TABLE owners (id SERIAL PRIMARY KEY, handle TEXT NOT NULL);
    CREATE UNIQUE INDEX owners_handle ON owners (handle);
    CREATE TABLE items (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      owner_handle TEXT NOT NULL REFERENCES owners (handle),
      title TEXT NOT NULL CHECK (title <> ''),
      pending BOOLEAN NOT NULL DEFAULT false,
      title_length INTEGER GENERATED ALWAYS AS (length(title)) STORED,
      meta JSONB NOT NULL DEFAULT '{}'
    );
    CREATE INDEX items_pending ON items (owner_handle) WHERE pending;
    CREATE FUNCTION items_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE CONSTRAINT TRIGGER items_touch AFTER UPDATE ON items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN ((old.title IS DISTINCT FROM new.title) OR (old.pending IS DISTINCT FROM new.pending)) EXECUTE FUNCTION items_touch();
    CREATE VIEW pending_items AS SELECT id, title FROM items WHERE pending;
    ALTER TABLE items ENABLE ROW LEVEL SECURITY;
    CREATE POLICY items_all ON items FOR ALL TO PUBLIC USING (true);
    INSERT INTO owners (handle) VALUES ('alice-example'), ('bob-example');
    INSERT INTO items (owner_handle, title, pending, meta) VALUES ('alice-example', 'first', true, '{"k": "it''s"}'), ('bob-example', 'second', false, '{}');
  `);
  dump = await dumpBrainSchema(async (sql) => (await original.db.query(sql)).rows as Array<Record<string, any>>, 1);
  await restored.db.exec(dump);
}, 60_000);

afterAll(async () => {
  await original.disconnect();
  await restored.disconnect();
});

test('a dumped brain restores to the same catalog, function bodies and rows', async () => {
  const diff = diffCatalogSnapshots(await snapshotCatalog(pgliteCatalogQuery(original)), await snapshotCatalog(pgliteCatalogQuery(restored)), { compareOrdinals: true })
    .filter((d) => !(d.section === 'triggers' && d.kind === 'changed' && sameUpToFlattenedBooleanChains(d.expected, d.actual)));
  expect(diff).toEqual([]);
  expect((await restored.db.query(FUNCTION_BODIES_SQL)).rows).toEqual((await original.db.query(FUNCTION_BODIES_SQL)).rows);
  for (const table of ['owners', 'items']) {
    const rows = async (engine: PGLiteEngine) => (await engine.db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    expect(await rows(restored)).toEqual(await rows(original));
  }
});

test('identity and serial counters continue where the original left off', async () => {
  await restored.db.exec(`INSERT INTO owners (handle) VALUES ('carol-example'); INSERT INTO items (owner_handle, title) VALUES ('carol-example', 'third')`);
  expect((await restored.db.query(`SELECT max(id)::int AS id FROM owners`)).rows).toEqual([{ id: 3 }]);
  expect((await restored.db.query(`SELECT max(id)::int AS id FROM items`)).rows).toEqual([{ id: 3 }]);
});
