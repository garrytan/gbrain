/**
 * GST-3032 (#9689 second fix round): owner_only_marks for a non-owner Postgres login, upgraded from a v321 schema.
 *
 * 1. Protects: a brain that never held owner-only data reads and hard-deletes as on v321 for a non-owner login with no new
 *    grant; once the brain holds owner-only data, a login that cannot read every mark reads owner-only lineage closed
 *    (never open, never an error) and its hard deletes are refused naming the grant; after the statements doctor prints, a
 *    scoped writer's open deletes, take and timeline rewrites and coordinated purge go through and leave lineage closed
 *    (the row-security mark, which returns after it is cleared), its delete of an owner-only origin is refused, and the
 *    owner's delete of it marks everything derived; FORCE ROW LEVEL SECURITY on a lineage table does the same for the
 *    owner; a role with table privileges and no policy (Supabase's anon shape) neither reads nor adds a mark.
 * 2. Fails when: v322 makes a never-owner-only brain read owner_only_marks, a missing grant reads a derived row as open
 *    or raises from a read, a scoped writer's open delete is refused once granted, or PUBLIC policies return.
 * 3. Real seams: the migration runner from config version 321, the engine's own deletes and coordinated purge on a
 *    connection logged in as the writer, the guarded predicate every page read embeds (ownerOnlyPageSql), the doctor
 *    check and its rendered fix, and the ENGINES.md recipes applied verbatim.
 * Run: DATABASE_URL=... bun test test/e2e/owner-only-marks-scoped-login.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runMigrations } from '../../src/core/migrate.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { ownerOnlyFactSql, ownerOnlyForm, ownerOnlyPageSql } from '../../src/core/access/owner-only.ts';
import { v320 } from '../../src/core/schema-migrations/v320-owner-only-lineage.ts';
import { ownerOnlyMarksTriggersEntry } from '../../src/commands/doctor/checks/owner-only-marks-triggers.ts';
import { finalizeCheckFixes } from '../../src/commands/doctor/check-fix.ts';
import type { Check } from '../../src/commands/doctor.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const WRITER = `gbrain_oom_writer_${suffix}`;
const READER = `gbrain_oom_reader_${suffix}`;
const ANON = `gbrain_oom_anon_${suffix}`;
const OWNER2 = `gbrain_oom_owner_${suffix}`;
const HIDER = `gbrain_oom_hider_${suffix}`;
const OPEN = 'open-src';
const CHATS = 'messages-x';
const LINEAGE_TABLES = ['sources', 'facts', 'derivation_inputs', 'links', 'pages', 'takes', 'timeline_entries'];
const text = (title: string) => ['---', 'type: note', `title: ${title}`, '---', `# ${title}`, '', `Harbor ledger notes for ${title}.`].join('\n');

/** The SQL between `marker`'s begin and end comments in docs/ENGINES.md, with each placeholder replaced. */
function docsRecipe(marker: string, roles: Record<string, string>): string {
  // The operator recipes are applied verbatim, so the documented statements are the tested ones.
  const doc = readFileSync(new URL('../../docs/ENGINES.md', import.meta.url), 'utf8');
  const begin = doc.indexOf(`<!-- gbrain:${marker}:begin`);
  const open = doc.indexOf('```sql\n', begin);
  const close = doc.indexOf('```', open + 7);
  if (begin < 0 || open < 0 || close < 0) throw new Error(`docs/ENGINES.md has no ${marker} block`);
  const block = doc.slice(open + 7, close);
  return Object.entries(roles).reduce((sql, [placeholder, role]) => sql.replaceAll(placeholder, role), block);
}

describeE2E('owner_only_marks for a non-owner login, upgraded from v321 (Postgres)', () => {
  let admin: BrainEngine;
  let close: () => Promise<void>;
  let databaseUrl = '';
  const logins: PostgresEngine[] = [];

  async function connectAs(role: string): Promise<PostgresEngine> {
    const url = new URL(databaseUrl); url.username = role; url.password = 'oom-example';
    const engine = new PostgresEngine();
    await engine.connect({ database_url: url.toString(), poolSize: 2 });
    logins.push(engine);
    return engine;
  }
  const pageId = async (slug: string, source = OPEN) =>
    Number((await admin.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', [slug, source]))[0]!.id);
  async function page(slug: string, source = OPEN): Promise<number> {
    await importFromContent(admin, slug, text(slug), { sourceId: source, noEmbed: true });
    return pageId(slug, source);
  }
  const derive = (derived: number, input: number) => admin.executeRaw(
    `INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES ('pages', $1, 'pages', $2, $3)`,
    [String(derived), String(input), OPEN]);
  /** The page ids among `ids` that a non-owner caller served by `engine` reads: the guarded predicate every page read embeds. */
  async function openTo(engine: BrainEngine, ids: number[]): Promise<number[]> {
    const version = Number((await admin.executeRaw<{ v: string }>(`SELECT value AS v FROM config WHERE key = 'version'`))[0]!.v);
    const rows = await engine.executeRaw<{ id: number }>(
      `SELECT p.id FROM pages p WHERE p.id = ANY($1::bigint[]) AND NOT ${ownerOnlyPageSql('p', ownerOnlyForm(version))} ORDER BY p.id`, [ids]);
    return rows.map(r => Number(r.id));
  }
  const marks = async () => (await admin.executeRaw<{ m: string }>(`SELECT row_table || ':' || row_id AS m FROM owner_only_marks`))
    .map(r => r.m).sort();
  const held = async () => (await admin.executeRaw<{ held: boolean }>('SELECT gbrain_owner_only_held() AS held'))[0]!.held;
  const readMode = async (engine: BrainEngine) => (await engine.executeRaw<{ mode: string }>('SELECT gbrain_owner_only_read_mode() AS mode'))[0]!.mode;
  async function doctor(): Promise<Check> {
    const [check] = await ownerOnlyMarksTriggersEntry.run({ engine: admin, progress: { heartbeat() {} } } as never) as Check[];
    return check!;
  }
  const fact = async (source: string, claim: string) => Number((await admin.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source) VALUES ($1, 'notes/open', $2, 'fact', 'world', 'fixture') RETURNING id`, [source, claim]))[0]!.id);

  beforeAll(async () => {
    ({ engine: admin, databaseUrl, close } = await isolatedPersistencePostgres(DATABASE_URL!));
    await admin.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)`, [OPEN]);
    // Rewind to the v321 schema: no owner_only_marks, no triggers, v320's lineage functions.
    for (const table of ['pages', 'facts', 'takes', 'timeline_entries']) await admin.executeRaw(`DROP TRIGGER IF EXISTS gbrain_owner_only_row_deleted_trg ON ${table}`);
    await admin.executeRaw('DROP TRIGGER IF EXISTS gbrain_owner_only_source_changed_trg ON sources');
    await admin.executeRaw(`DROP FUNCTION IF EXISTS gbrain_owner_only_row_deleted(), gbrain_owner_only_source_changed(), gbrain_owner_only_mark_derived(text, bigint[]),
      gbrain_owner_only_lineage_strict(text, bigint), gbrain_owner_only_hold(), gbrain_owner_only_held(), gbrain_owner_only_marks_denied(text),
      gbrain_owner_only_lineage(text, bigint, text), gbrain_owner_only_read_mode(), gbrain_owner_only_reads_complete(regclass, text)`);
    await admin.executeRaw('DROP TABLE owner_only_marks');
    await admin.executeRaw(v320.sql);
    await admin.executeRaw(`UPDATE config SET value = '321' WHERE key = 'version'`);
    expect((await admin.executeRaw<{ t: string | null }>(`SELECT to_regclass('owner_only_marks')::text AS t`))[0]!.t).toBeNull();

    // The operator's grants and policies at v321: the writer gets every table and the maintainer recipe verbatim (its
    // pages and sources policies scoped by app.scopes, '*' for this login), USING (true) on the tables the recipe leaves to
    // the operator, and DELETE on the timeline rows of pages it sees; the reader gets ENGINES.md's reader GRANT line and config.
    await admin.executeRaw(`CREATE ROLE ${WRITER} LOGIN PASSWORD 'oom-example' NOSUPERUSER NOBYPASSRLS`);
    await admin.executeRaw(`CREATE ROLE ${READER} LOGIN PASSWORD 'oom-example' NOSUPERUSER NOBYPASSRLS`);
    for (const grant of ['USAGE ON SCHEMA public', 'ALL ON ALL TABLES IN SCHEMA public', 'ALL ON ALL SEQUENCES IN SCHEMA public', 'EXECUTE ON ALL FUNCTIONS IN SCHEMA public']) {
      await admin.executeRaw(`GRANT ${grant} TO ${WRITER}`);
    }
    await admin.executeRaw(`ALTER ROLE ${WRITER} SET app.scopes = '*'`);
    const recipe = docsRecipe('maintainer-rls-recipe', { '<writer-role>': WRITER });
    const recipeTables = new Set([...recipe.matchAll(/CREATE POLICY \w+ ON (\w+)/g)].map(m => m[1]!));
    await admin.executeRaw(recipe);
    const tables = (await admin.executeRaw<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map(r => r.t);
    for (const table of tables.filter(t => !recipeTables.has(t))) {
      await admin.executeRaw(`CREATE POLICY ${WRITER}_open ON ${table} FOR ALL TO ${WRITER} USING (true) WITH CHECK (true)`);
    }
    await admin.executeRaw(`CREATE POLICY ${WRITER}_timeline_rewrite ON timeline_entries FOR DELETE TO ${WRITER} USING (EXISTS (SELECT 1 FROM pages p WHERE p.id = page_id))`);
    await admin.executeRaw(`GRANT USAGE ON SCHEMA public TO ${READER}`);
    await admin.executeRaw(`GRANT SELECT ON pages, content_chunks, page_body_manifest, page_segment_texts, page_view_digests, sources TO ${READER}`);
    // ENGINES.md: "The other tables it reads (config, ...) need policies of their own"; connecting reads config.
    await admin.executeRaw(`GRANT SELECT ON config TO ${READER}`);
    for (const table of ['pages', 'sources', 'config']) await admin.executeRaw(`CREATE POLICY ${READER}_read ON ${table} FOR SELECT TO ${READER} USING (true)`);
    for (const table of LINEAGE_TABLES) {
      expect((await admin.executeRaw<{ on: boolean }>('SELECT relrowsecurity AS on FROM pg_class WHERE oid = $1::regclass', [table]))[0]!.on).toBe(true);
    }
  }, 240_000);

  afterAll(async () => {
    for (const engine of logins) await engine.disconnect().catch(() => undefined);
    if (!admin) return;
    const me = (await admin.executeRaw<{ u: string }>('SELECT current_user AS u'))[0]!.u;
    for (const role of [WRITER, READER, ANON, OWNER2, HIDER]) {
      await admin.executeRaw(`REASSIGN OWNED BY ${role} TO ${me}`).catch(() => undefined);
      await admin.executeRaw(`DROP OWNED BY ${role}`).catch(() => undefined);
    }
    await close();
    const { default: postgres } = await import('#postgres');
    const sql = postgres(DATABASE_URL!, { max: 1, prepare: false });
    for (const role of [WRITER, READER, ANON, OWNER2, HIDER]) await sql.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await sql.end();
  }, 120_000);

  test('(a) a brain that never held owner-only data reads and hard-deletes as on v321 for non-owner logins, with no new grant', async () => {
    const [a, b, c] = [await page('notes/a'), await page('notes/b'), await page('notes/c')];
    await derive(b, a);
    const f = await fact(OPEN, 'an open fact');
    const writer = await connectAs(WRITER);
    const reader = await connectAs(READER);
    const before = { writer: await openTo(writer, [a, b, c]), reader: await openTo(reader, [a, b, c]) };
    expect(before).toEqual({ writer: [a, b, c], reader: [a, b, c] });

    await runMigrations(admin);
    expect((await admin.executeRaw<{ v: string }>(`SELECT value AS v FROM config WHERE key = 'version'`))[0]!.v).not.toBe('321');
    expect({ writer: await openTo(writer, [a, b, c]), reader: await openTo(reader, [a, b, c]) }).toEqual(before);
    await writer.deletePage('notes/c', { sourceId: OPEN });
    await writer.executeRaw('DELETE FROM facts WHERE id = $1', [f]);
    expect((await admin.executeRaw('SELECT 1 FROM pages WHERE id = $1 UNION ALL SELECT 1 FROM facts WHERE id = $2', [c, f])).length).toBe(0);
    expect(await marks()).toEqual([]);
    expect(await held()).toBe(false);
    expect((await doctor()).status).toBe('ok');
  }, 240_000);

  test('(d) a role with table privileges and no policy (the Supabase anon shape) neither reads nor adds a mark', async () => {
    await admin.executeRaw(`CREATE ROLE ${ANON} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.executeRaw(`GRANT USAGE ON SCHEMA public TO ${ANON}`);
    await admin.executeRaw(`GRANT ALL ON owner_only_marks TO ${ANON}`);
    await admin.executeRaw(`INSERT INTO owner_only_marks (row_table, row_id) VALUES ('pages', '-1')`);
    const asAnon = <T,>(fn: (tx: BrainEngine) => Promise<T>) => admin.transaction(async tx => { await tx.executeRaw(`SET LOCAL ROLE ${ANON}`); return fn(tx); });
    expect(await asAnon(tx => tx.executeRaw('SELECT row_id FROM owner_only_marks'))).toEqual([]);
    await expect(asAnon(tx => tx.executeRaw(`INSERT INTO owner_only_marks (row_table, row_id) VALUES ('*', 'unguarded')`))).rejects.toThrow(/row-level security/);
    expect((await admin.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = 'owner_only_marks'::regclass`))[0]!.n).toBe(0);
    await admin.executeRaw(`DELETE FROM owner_only_marks WHERE row_id = '-1'`);
  }, 120_000);

  test('(b) once the brain holds owner-only data, a login with no new grant reads closed, never open and never an error, and its deletes name the grant', async () => {
    await admin.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"kind":"imessage"}'::jsonb)`, [CHATS]);
    expect(await held()).toBe(true);
    const chat = await page('imessage/chat/2026-06-14', CHATS);
    const [fromChat, plain, fromPlain] = [await page('notes/from-chat'), await page('notes/plain'), await page('notes/from-plain')];
    await derive(fromChat, chat);
    await derive(fromPlain, plain);
    const writer = await connectAs(WRITER);
    expect(await openTo(admin, [chat, fromChat, plain, fromPlain])).toEqual([plain, fromPlain]);
    expect(await openTo(writer, [chat, fromChat, plain, fromPlain])).toEqual([plain]);
    expect(await openTo(await connectAs(READER), [chat, fromChat, plain, fromPlain])).toEqual([]);
    await expect(writer.deletePage('notes/plain', { sourceId: OPEN })).rejects.toThrow(/owner_only_marks_unwritable/);
    expect(await pageId('notes/plain')).toBe(plain);

    const check = await doctor();
    expect({ status: check.status, logins: (check.details as { denied_logins: string[] }).denied_logins }).toEqual({ status: 'fail', logins: [READER, WRITER].sort() });
    const [rendered] = finalizeCheckFixes([check]);
    expect((rendered as unknown as { fix: { next: string } }).fix.next).toBe('tell_user_to_run');
  }, 240_000);

  test('(c) after the statements doctor prints, a scoped writer keeps deleting and lineage reads closed; an owner-only origin is the owner\'s to delete', async () => {
    const statements = ((await doctor()).details as { sql: string[] }).sql;
    await admin.executeRaw(statements.join('\n'));
    expect(((await doctor()).details as { denied_logins?: string[] }).denied_logins ?? []).toEqual([]);
    const writer = await connectAs(WRITER);
    const chat = await pageId('imessage/chat/2026-06-14', CHATS);
    const [fromChat, plain, fromPlain] = [await pageId('notes/from-chat'), await pageId('notes/plain'), await pageId('notes/from-plain')];
    // The writer's pages and sources policies read by app.scopes (the maintainer recipe), so its reads of the lineage are
    // not complete: every derived row reads closed for it (v328), while the owner reads the exact lineage.
    expect(await readMode(writer)).toBe('closed');
    expect(await openTo(writer, [chat, fromChat, plain, fromPlain])).toEqual([plain]);
    expect(await openTo(admin, [chat, fromChat, plain, fromPlain])).toEqual([plain, fromPlain]);
    expect(await openTo(await connectAs(READER), [chat, fromChat, plain, fromPlain])).toEqual([]);

    // The writer's open deletes, a take and a timeline rewrite and a coordinated purge all go through.
    const victim = await page('notes/victim');
    const holder = await page('notes/holder');
    await admin.executeRaw(`INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 1, 'a take', 'take', 'world')`, [holder]);
    await admin.executeRaw(`INSERT INTO timeline_entries (page_id, date, summary) VALUES ($1, '2026-06-14', 'an entry')`, [holder]);
    const f = await fact(OPEN, 'another open fact');
    await writer.deletePage('notes/victim', { sourceId: OPEN });
    await writer.executeRaw('DELETE FROM facts WHERE id = $1', [f]);
    await writer.executeRaw('DELETE FROM takes WHERE page_id = $1', [holder]);
    await writer.executeRaw('DELETE FROM timeline_entries WHERE page_id = $1', [holder]);
    await admin.executeRaw(`UPDATE pages SET deleted_at = now() - interval '4 days' WHERE id = $1`, [holder]);
    const { purgeDeletedPagesCoordinated } = await import('../../src/core/persistence/purge-deleted.ts');
    await purgeDeletedPagesCoordinated(writer, 72, { automatic: true });
    expect((await admin.executeRaw(`SELECT 1 FROM pages WHERE id = ANY($1::bigint[])
      UNION ALL SELECT 1 FROM facts WHERE id = $2 UNION ALL SELECT 1 FROM takes WHERE page_id = $3 UNION ALL SELECT 1 FROM timeline_entries WHERE page_id = $3`,
      [[victim, holder], f, holder])).length).toBe(0);
    expect(await marks()).toEqual(['*:row_security']);
    expect(await openTo(writer, [plain, fromPlain])).toEqual([plain]);
    expect((await doctor()).message).toContain('clearing the mark does not end it');

    // Cleared, it comes back with the writer's next permanent delete.
    await admin.executeRaw(`DELETE FROM owner_only_marks WHERE row_table = '*'`);
    expect(await marks()).toEqual([]);
    await page('notes/victim-2');
    await writer.deletePage('notes/victim-2', { sourceId: OPEN });
    expect(await marks()).toEqual(['*:row_security']);

    // The writer cannot delete the owner-only origin; the owner can, and every row derived from it is marked.
    await expect(writer.deletePage('imessage/chat/2026-06-14', { sourceId: CHATS })).rejects.toThrow(/owner_only_lineage_unreadable: this row is owner-only/);
    expect(await pageId('imessage/chat/2026-06-14', CHATS)).toBe(chat);
    await admin.deletePage('imessage/chat/2026-06-14', { sourceId: CHATS });
    expect(await marks()).toEqual(['*:row_security', `pages:${chat}`, `pages:${fromChat}`].sort());
    await admin.executeRaw(`DELETE FROM owner_only_marks WHERE row_table = '*'`);
    expect(await openTo(admin, [fromChat, plain, fromPlain])).toEqual([plain, fromPlain]);
    expect(await openTo(writer, [fromChat, plain, fromPlain])).toEqual([plain]);
  }, 240_000);

  test('(e) a policy on owner_only_marks counts only in the shape doctor prints: any other USING, or a restrictive policy beside it, reads closed and refuses deletes', async () => {
    const writer = await connectAs(WRITER);
    const read = `owner_only_marks_read_${WRITER}`;
    expect(await readMode(writer)).toBe('closed');
    await admin.executeRaw(`DROP POLICY ${read} ON owner_only_marks`);
    await admin.executeRaw(`CREATE POLICY ${read} ON owner_only_marks FOR SELECT TO ${WRITER} USING (row_table <> '*')`);
    try {
      expect(await readMode(writer)).toBe('source');
      await page('notes/shape-victim');
      await expect(writer.deletePage('notes/shape-victim', { sourceId: OPEN })).rejects.toThrow(/owner_only_marks_unwritable/);
      expect(((await doctor()).details as { denied_logins: string[] }).denied_logins).toContain(WRITER);
    } finally {
      await admin.executeRaw(`DROP POLICY ${read} ON owner_only_marks`);
      await admin.executeRaw(`CREATE POLICY ${read} ON owner_only_marks FOR SELECT TO ${WRITER} USING (true)`);
    }
    expect(await readMode(writer)).toBe('closed');
    await admin.executeRaw(`CREATE POLICY ${WRITER}_narrow ON owner_only_marks AS RESTRICTIVE FOR SELECT TO ${WRITER} USING (row_table <> '*')`);
    try {
      expect(await readMode(writer)).toBe('source');
      await expect(writer.deletePage('notes/shape-victim', { sourceId: OPEN })).rejects.toThrow(/owner_only_marks_unwritable/);
      expect(((await doctor()).details as { denied_logins: string[] }).denied_logins).toContain(WRITER);
    } finally {
      await admin.executeRaw(`DROP POLICY ${WRITER}_narrow ON owner_only_marks`);
    }
    expect(((await doctor()).details as { denied_logins?: string[] }).denied_logins ?? []).not.toContain(WRITER);
  }, 240_000);

  test('(f) two sessions that record the held flag at once both commit, under READ COMMITTED and REPEATABLE READ', async () => {
    const { default: postgres } = await import('#postgres');
    for (const isolation of ['read committed', 'repeatable read']) {
      await admin.executeRaw('COMMENT ON TABLE owner_only_marks IS NULL');
      expect(await held()).toBe(false);
      const [a, b] = [postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} }), postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} })];
      try {
        let second: Promise<unknown> | undefined;
        await a.begin(async sql => {
          await sql.unsafe(`INSERT INTO sources (id, name, config) VALUES ('race-a', 'race-a', '{"kind":"imessage"}'::jsonb)`);
          // The second session takes its snapshot while the first has not committed, then records the flag too.
          second = b.begin(`isolation level ${isolation}`, async sql2 => {
            await sql2.unsafe('SELECT 1');
            await sql2.unsafe(`INSERT INTO sources (id, name, config) VALUES ('race-b', 'race-b', '{"owner_only":true}'::jsonb)`);
          });
          await new Promise(resolve => setTimeout(resolve, 500));
        });
        await second;
      } finally {
        await a.end(); await b.end();
      }
      expect({ isolation, rows: (await admin.executeRaw<{ id: string }>(`SELECT id FROM sources WHERE id LIKE 'race-%' ORDER BY id`)).map(r => r.id) })
        .toEqual({ isolation, rows: ['race-a', 'race-b'] });
      expect(await held()).toBe(true);
      await admin.executeRaw(`DELETE FROM sources WHERE id LIKE 'race-%'`);
    }
  }, 120_000);

  test('FORCE ROW LEVEL SECURITY on a lineage table the deleting owner owns: an open delete closes lineage, an owner-only one is refused', async () => {
    await admin.executeRaw(`CREATE ROLE ${OWNER2} LOGIN PASSWORD 'oom-example' NOSUPERUSER NOBYPASSRLS`);
    await admin.executeRaw(`GRANT USAGE ON SCHEMA public TO ${OWNER2}`);
    await admin.executeRaw(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${OWNER2}`);
    await admin.executeRaw(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${OWNER2}`);
    for (const table of LINEAGE_TABLES) await admin.executeRaw(`ALTER TABLE ${table} OWNER TO ${OWNER2}`);
    const others = (await admin.executeRaw<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'owner_only_marks'`)).map(r => r.t);
    for (const table of others) await admin.executeRaw(`CREATE POLICY ${OWNER2}_open ON ${table} FOR ALL TO ${OWNER2} USING (true) WITH CHECK (true)`);
    for (const half of ['read', 'add']) await admin.executeRaw(`DROP POLICY IF EXISTS owner_only_marks_${half}_${READER} ON owner_only_marks`);
    await admin.executeRaw(docsRecipe('owner-only-marks-recipe', { '<writer-role>': OWNER2, '<reader-role>': READER }));
    const owner = await connectAs(OWNER2);
    const open = await fact(OPEN, 'open before force');
    await owner.executeRaw('DELETE FROM facts WHERE id = $1', [open]);
    expect(await marks()).not.toContain('*:row_security');
    await admin.executeRaw('ALTER TABLE links FORCE ROW LEVEL SECURITY');
    try {
      const open2 = await fact(OPEN, 'open under force');
      await owner.executeRaw('DELETE FROM facts WHERE id = $1', [open2]);
      expect(await marks()).toContain('*:row_security');
      const ownerOnly = await fact(CHATS, 'owner-only under force');
      await expect(owner.executeRaw('DELETE FROM facts WHERE id = $1', [ownerOnly])).rejects.toThrow(/owner_only_lineage_unreadable/);
    } finally {
      await admin.executeRaw('ALTER TABLE links NO FORCE ROW LEVEL SECURITY');
    }
  }, 240_000);

  test('(h) a login whose sources policy hides an owner-only source reads the pages and facts in it as owner-only, with or without the marks', async () => {
    const secret = await page('notes/vault-secret', CHATS);
    const secretFact = await fact(CHATS, 'a fact in the hidden owner-only source');
    const plain = await pageId('notes/plain');
    await admin.executeRaw(`CREATE ROLE ${HIDER} LOGIN PASSWORD 'oom-example' NOSUPERUSER NOBYPASSRLS`);
    await admin.executeRaw(`GRANT USAGE ON SCHEMA public TO ${HIDER}`);
    await admin.executeRaw(`GRANT SELECT ON config, ${LINEAGE_TABLES.join(', ')} TO ${HIDER}`);
    await admin.executeRaw(`CREATE POLICY ${HIDER}_read ON config FOR SELECT TO ${HIDER} USING (true)`);
    for (const table of LINEAGE_TABLES.filter(t => t !== 'sources')) await admin.executeRaw(`CREATE POLICY ${HIDER}_read ON ${table} FOR SELECT TO ${HIDER} USING (true)`);
    await admin.executeRaw(`CREATE POLICY ${HIDER}_read ON sources FOR SELECT TO ${HIDER} USING (id <> '${CHATS}')`);
    const facts = (engine: BrainEngine) => engine.executeRaw<{ owner_only: boolean }>(`SELECT ${ownerOnlyFactSql('f', ownerOnlyForm(328))} AS owner_only FROM facts f WHERE f.id = $1`, [secretFact]);

    const hider = await connectAs(HIDER);
    expect(await readMode(hider)).toBe('source');
    expect(await openTo(hider, [secret, plain])).toEqual([plain]);
    expect((await facts(hider))[0]!.owner_only).toBe(true);

    await admin.executeRaw(`GRANT SELECT ON owner_only_marks TO ${HIDER}`);
    await admin.executeRaw(`CREATE POLICY owner_only_marks_read_${HIDER} ON owner_only_marks FOR SELECT TO ${HIDER} USING (true)`);
    const withMarks = await connectAs(HIDER);
    expect(await readMode(withMarks)).toBe('closed');
    expect(await openTo(withMarks, [secret, plain])).toEqual([plain]);
    expect((await facts(withMarks))[0]!.owner_only).toBe(true);
    expect(await openTo(admin, [secret, plain])).toEqual([plain]);
  }, 120_000);

  test('the reader role, which cannot read the lineage tables, reads every row closed and never an error, also after the last owner-only source is removed', async () => {
    const reader = await connectAs(READER);
    const plain = await pageId('notes/plain');
    expect(await openTo(reader, [plain])).toEqual([]);
    await admin.executeRaw('DELETE FROM sources WHERE id = $1', [CHATS]);
    expect(await held()).toBe(true);
    expect(await openTo(reader, [plain])).toEqual([]);
    expect(await openTo(admin, [plain])).toEqual([plain]);
  }, 120_000);

  test('(g) doctor names each login that reads owner-only lineage closed, with the statements that open its reads; after them the scoped writer reads the exact lineage', async () => {
    await admin.executeRaw(`DELETE FROM owner_only_marks WHERE row_table = '*'`);
    const [plain, fromPlain] = [await pageId('notes/plain'), await pageId('notes/from-plain')];
    const writer = await connectAs(WRITER);
    expect(await readMode(writer)).toBe('closed');
    expect(await openTo(writer, [plain, fromPlain])).toEqual([plain]);

    const denied = (await doctor()).details as { sql?: string[] };
    if (denied.sql?.length) await admin.executeRaw(denied.sql.join('\n'));
    const check = await doctor();
    const details = check.details as { closed_logins: string[]; lineage_sql: string[] };
    expect({ status: check.status, logins: details.closed_logins }).toEqual({ status: 'warn', logins: [HIDER, READER, WRITER].sort() });
    expect(check.message).toContain('needs no action');
    expect(details.lineage_sql).toContain(`CREATE POLICY gbrain_lineage_read_${READER} ON public.derivation_inputs FOR SELECT TO ${READER} USING (true);`);
    expect(details.lineage_sql).toContain(`GRANT SELECT ON public.pages TO ${WRITER};`);
    expect(details.lineage_sql.every(s => [HIDER, READER, WRITER].some(l => s.includes(`TO ${l}`)) || s.startsWith('DROP POLICY IF EXISTS gbrain_lineage_read_'))).toBe(true);

    // Nothing is granted automatically: the operator runs the writer's statements, and only then does it read exactly.
    await admin.executeRaw(details.lineage_sql.filter(s => s.includes(WRITER)).join('\n'));
    const opened = await connectAs(WRITER);
    expect(await readMode(opened)).toBe('exact');
    expect(await openTo(opened, [plain, fromPlain])).toEqual([plain, fromPlain]);
    expect(((await doctor()).details as { closed_logins: string[] }).closed_logins).toEqual([HIDER, READER].sort());
    expect(await readMode(await connectAs(READER))).toBe('all');
  }, 120_000);
});
