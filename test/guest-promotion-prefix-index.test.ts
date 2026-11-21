import { afterEach, beforeEach, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { v331 } from '../src/core/schema-migrations/v331-guest-promotion-prefix-index.ts';

let db: PGlite;
beforeEach(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE guest_promotions (
    guest_page_id integer NOT NULL, target_source_id text NOT NULL, target_slug text NOT NULL
  );
  CREATE INDEX guest_promotions_guest_page_idx ON guest_promotions (guest_page_id);
  INSERT INTO guest_promotions VALUES (7, 'default', 'notes/kept');`);
});
afterEach(async () => { await db.close(); });

async function indexExists(name: string): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', ['public.' + name]);
  return rows[0]!.present;
}

test('retires an exact prefix and retains the promotion key and rows', async () => {
  await db.exec(`CREATE UNIQUE INDEX guest_promotions_link_key ON guest_promotions (guest_page_id,target_source_id,target_slug)`);
  await db.exec(v331.sql);
  await db.exec(v331.sql);
  expect(await indexExists('guest_promotions_guest_page_idx')).toBe(false);
  expect(await indexExists('guest_promotions_link_key')).toBe(true);
  expect((await db.query('SELECT * FROM guest_promotions WHERE guest_page_id = 7')).rows).toEqual([
    { guest_page_id: 7, target_source_id: 'default', target_slug: 'notes/kept' },
  ]);
  await expect(db.exec(`INSERT INTO guest_promotions VALUES (7, 'default', 'notes/kept')`)).rejects.toThrow('guest_promotions_link_key');
});

test('keeps the legacy lookup when v314 could not add the unique index', async () => {
  await db.exec(`INSERT INTO guest_promotions VALUES (7, 'default', 'notes/kept')`);
  await db.exec(v331.sql);
  expect(await indexExists('guest_promotions_guest_page_idx')).toBe(true);
  expect((await db.query('SELECT * FROM guest_promotions WHERE guest_page_id = 7')).rows).toHaveLength(2);
});

test('keeps the lookup when a same-named partial index cannot replace it', async () => {
  await db.exec(`CREATE UNIQUE INDEX guest_promotions_link_key ON guest_promotions (guest_page_id,target_source_id,target_slug) WHERE target_source_id = 'default'`);
  await db.exec(v331.sql);
  expect(await indexExists('guest_promotions_guest_page_idx')).toBe(true);
});

test('keeps a customized guest-page index even with the canonical unique key', async () => {
  await db.exec(`DROP INDEX guest_promotions_guest_page_idx;
    CREATE INDEX guest_promotions_guest_page_idx ON guest_promotions (guest_page_id DESC);
    CREATE UNIQUE INDEX guest_promotions_link_key ON guest_promotions (guest_page_id,target_source_id,target_slug)`);
  await db.exec(v331.sql);
  expect(await indexExists('guest_promotions_guest_page_idx')).toBe(true);
});

test('preserves a guest-page index designated for CLUSTER', async () => {
  await db.exec(`ALTER TABLE guest_promotions CLUSTER ON guest_promotions_guest_page_idx;
    CREATE UNIQUE INDEX guest_promotions_link_key ON guest_promotions (guest_page_id,target_source_id,target_slug)`);
  await db.exec(v331.sql);
  expect(await indexExists('guest_promotions_guest_page_idx')).toBe(true);
});
