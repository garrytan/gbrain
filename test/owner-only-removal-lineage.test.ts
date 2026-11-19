/**
 * GST-3032: pages and facts derived from an owner-only source stay owner-only after their origin is gone.
 *
 * 1. Protects: another member never reads a page, a two-hop derived page, a synthesized concept or a fact derived from an
 *    iMessage page after the iMessage source is removed or the page is hard-deleted, and nothing derived is deleted.
 * 2. Fails when: removing the origin (sources remove, a hard page delete) lets the member read a derived canary, or the
 *    removal deletes a derived row.
 * 3. Real seams: tokens minted by the token service and verified by the OAuth provider, dispatched through MCP dispatch
 *    with remote: true, the removal through deleteSourceRow (every removal route calls it) and engine.deletePage.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { deleteSourceRow } from '../src/core/source-delete.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { OWNER_ONLY_FLAG, OWNER_ONLY_KINDS, ownerOnlySourcesPresent } from '../src/core/access/owner-only.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { OWNER_ONLY_HELD, v322 } from '../src/core/schema-migrations/v322-owner-only-marks.ts';
import { ownerOnlyTriggersLeftLine } from '../src/core/access/owner-only-marks.ts';
import { ownerOnlyMarksTriggersEntry } from '../src/commands/doctor/checks/owner-only-marks-triggers.ts';
import type { Check } from '../src/commands/doctor.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { randomUUID } from 'node:crypto';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const OPEN_SRC = 'own-src';
const OWNER = 'owner-example';
const pageText = (title: string, canary: string, type = 'note') =>
  ['---', `type: ${type}`, `title: ${title}`, '---', `# ${title}`, '', `Harbor ledger planning notes ${canary} for the roadmap.`].join('\n');

for (const kind of testBackends()) {
  describe(`owner-only lineage outlives its origin (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let databaseUrl = '';
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function read(who: string, op: string, params: Record<string, unknown>): Promise<string> {
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? OPEN_SRC;
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      });
      return out.content.map(c => c.text).join('\n');
    }

    /** The derived canaries of origin `tag` that `who` reads on get_page, search and recall. */
    async function seen(who: string, tag: string): Promise<string[]> {
      const canaries = ['derived', 'twice', 'concept', 'fact'].map(k => `canary${tag}${k}`);
      const texts = [
        ...await Promise.all(['derived', 'twice', 'concept'].map(k => read(who, 'get_page', { slug: `notes/${tag}-${k}` }))),
        await read(who, 'search', { query: 'harbor ledger planning notes', match: 'keyword', fields: 'full', limit: 100, source_id: OPEN_SRC }),
        await read(who, 'recall', { question: `Harbor ledger planning notes canary${tag}fact` }),
      ];
      return canaries.filter(c => texts.some(t => t.includes(c)));
    }

    const id = async (slug: string, sourceId: string) =>
      String((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1 AND source_id=$2', [slug, sourceId]))[0]!.id);

    /** An iMessage source `src` with one chat page, and in the open source a page derived from it, one derived twice, a
     *  synthesized concept and a derived fact, all carrying canaries tagged `tag`. */
    async function origin(src: string, tag: string): Promise<void> {
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"kind":"imessage","federated":true}'::jsonb)`, [src]);
      await importFromContent(engine, 'imessage/chat/2026-06-14', pageText('Chat', `canary${tag}chat`), { sourceId: src });
      for (const k of ['derived', 'twice']) await importFromContent(engine, `notes/${tag}-${k}`, pageText(k, `canary${tag}${k}`), { sourceId: OPEN_SRC });
      await importFromContent(engine, `notes/${tag}-concept`, pageText('Concept', `canary${tag}concept`, 'concept'), { sourceId: OPEN_SRC });
      const chat = await id('imessage/chat/2026-06-14', src);
      const derived = await id(`notes/${tag}-derived`, OPEN_SRC);
      await engine.executeRaw(`INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES
        ('pages', $1, 'pages', $2, $4), ('pages', $3, 'pages', $1, $4)`, [derived, chat, await id(`notes/${tag}-twice`, OPEN_SRC), OPEN_SRC]);
      await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source) VALUES ($1, $2, 'synthesized_from', 'concept-provenance')`,
        [Number(await id(`notes/${tag}-concept`, OPEN_SRC)), Number(chat)]);
      const [fact] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source) VALUES ($1, $2, $3, 'fact', 'world', 'fixture') RETURNING id`,
        [OPEN_SRC, 'notes/open', `Harbor ledger planning notes canary${tag}fact`]);
      await engine.executeRaw(`INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES ('facts', $1, 'pages', $2, $3)`, [String(fact!.id), chat, OPEN_SRC]);
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close, databaseUrl } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [OPEN_SRC]);
      await importFromContent(engine, 'notes/open', pageText('Open', 'canaryopen'), { sourceId: OPEN_SRC, noEmbed: true });
      await origin('messages-a', 'removed');
      await origin('messages-b', 'purged');
      for (const member of [OWNER, 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [member]);
      for (const [name, member] of [['owner', OWNER], ['bob', 'bob-example']] as const) {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [OPEN_SRC, 'messages-a', 'messages-b'] });
        tokens[name] = minted.token;
        await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
      }
      await engine.executeRaw(`UPDATE access_tokens SET private_pages = 'granted_sources', private_facts = 'granted_sources'`);
      await setOwner(engine, OWNER);
    }, 240_000);

    afterAll(async () => { await close?.(); }, 60_000);

    test('fixture control: the owner reads the derived canaries, another member reads none of them but reads the open page', async () => {
      for (const tag of ['removed', 'purged']) {
        expect({ tag, owner: await seen('owner', tag) }).toEqual({ tag, owner: ['derived', 'twice', 'concept', 'fact'].map(k => `canary${tag}${k}`) });
        expect({ tag, bob: await seen('bob', tag) }).toEqual({ tag, bob: [] });
      }
      expect(await read('bob', 'get_page', { slug: 'notes/open' })).toContain('canaryopen');
    }, 240_000);

    test('after sources remove, another member still reads nothing derived from the removed iMessage source, and nothing derived is deleted', async () => {
      expect(await deleteSourceRow(engine, 'messages-a')).toBe(true);
      __resetPrivateVisibilityCacheForTests();
      expect({ bob: await seen('bob', 'removed') }).toEqual({ bob: [] });
      expect({ owner: await seen('owner', 'removed') }).toEqual({ owner: ['derived', 'twice', 'concept', 'fact'].map(k => `canaryremoved${k}`) });
      const left = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND slug LIKE 'notes/removed-%'`, [OPEN_SRC]);
      expect(left[0]!.n).toBe(3);
      expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE fact LIKE '%canaryremovedfact%'`))[0]!.n).toBe(1);
    }, 240_000);

    test('after a hard delete of the iMessage page, another member still reads nothing derived from it', async () => {
      await engine.deletePage('imessage/chat/2026-06-14', { sourceId: 'messages-b' });
      __resetPrivateVisibilityCacheForTests();
      expect({ bob: await seen('bob', 'purged') }).toEqual({ bob: [] });
    }, 240_000);

    test('a hard-deleted owner-only fact or take marks what was derived from it, and a deleted open row marks nothing', async () => {
      const lineage = async (table: string, rowId: string) =>
        (await engine.executeRaw<{ v: boolean }>(`SELECT gbrain_owner_only_lineage($1, $2::bigint) AS v`, [table, rowId]))[0]!.v;
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('messages-c', 'messages-c', '{"owner_only":true}'::jsonb)`);
      await importFromContent(engine, 'notes/held', pageText('Held', 'canaryheld'), { sourceId: 'messages-c', noEmbed: true });
      const held = await id('notes/held', 'messages-c');
      const fact = async (src: string, text: string) => String((await engine.executeRaw<{ id: number }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source) VALUES ($1, 'notes/open', $2, 'fact', 'world', 'fixture') RETURNING id`, [src, text]))[0]!.id);
      const origin = await fact('messages-c', 'origin fact');
      const fromFact = await fact(OPEN_SRC, 'derived from the fact');
      const [take] = await engine.executeRaw<{ id: number }>(`INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 1, 'a take', 'take', 'world') RETURNING id`, [Number(held)]);
      const fromTake = await fact(OPEN_SRC, 'derived from the take');
      const open = await fact(OPEN_SRC, 'open origin');
      const fromOpen = await fact(OPEN_SRC, 'derived from the open fact');
      await engine.executeRaw(`INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES
        ('facts', $1, 'facts', $2, $7), ('facts', $3, 'takes', $4, $7), ('facts', $5, 'facts', $6, $7)`, [fromFact, origin, fromTake, String(take!.id), fromOpen, open, OPEN_SRC]);
      expect([await lineage('facts', fromFact), await lineage('facts', fromTake), await lineage('facts', fromOpen)]).toEqual([true, true, false]);
      await engine.executeRaw('DELETE FROM facts WHERE id = ANY($1::bigint[])', [[origin, open]]);
      await engine.executeRaw('DELETE FROM takes WHERE id = $1', [take!.id]);
      expect([await lineage('facts', fromFact), await lineage('facts', fromTake), await lineage('facts', fromOpen)]).toEqual([true, true, false]);
      const marks = await engine.executeRaw<{ row_table: string; row_id: string }>(`SELECT row_table, row_id FROM owner_only_marks WHERE row_table = 'facts' AND row_id = ANY($1::text[]) ORDER BY row_id::bigint`, [[fromFact, fromTake, fromOpen]]);
      expect(marks).toEqual([{ row_table: 'facts', row_id: fromFact }, { row_table: 'facts', row_id: fromTake }].sort((a, b) => Number(a.row_id) - Number(b.row_id)));
    }, 120_000);

    test('a row ten derivations from an iMessage page is owner-only before and after the page is removed (no depth limit opens it)', async () => {
      const lineage = async (rowId: string) => (await engine.executeRaw<{ v: boolean }>(`SELECT gbrain_owner_only_lineage('pages', $1::bigint) AS v`, [rowId]))[0]!.v;
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('messages-d', 'messages-d', '{"kind":"imessage","federated":true}'::jsonb)`);
      await importFromContent(engine, 'imessage/chat/2026-06-14', pageText('Chat', 'canarydeepchat'), { sourceId: 'messages-d', noEmbed: true });
      let prev = await id('imessage/chat/2026-06-14', 'messages-d');
      for (let hop = 1; hop <= 10; hop++) {
        await importFromContent(engine, `notes/deep-${hop}`, pageText(`Deep ${hop}`, `canarydeep${hop}hop`), { sourceId: OPEN_SRC, noEmbed: true });
        const next = await id(`notes/deep-${hop}`, OPEN_SRC);
        await engine.executeRaw(`INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES ('pages', $1, 'pages', $2, $3)`, [next, prev, OPEN_SRC]);
        prev = next;
      }
      // A cycle in the recorded inputs ends the walk instead of looping.
      await engine.executeRaw(`INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES ('pages', $1, 'pages', $2, $3)`,
        [await id('notes/deep-5', OPEN_SRC), prev, OPEN_SRC]);
      expect(await lineage(prev)).toBe(true);
      expect(await read('bob', 'get_page', { slug: 'notes/deep-10' })).not.toContain('canarydeep10hop');
      expect(await deleteSourceRow(engine, 'messages-d')).toBe(true);
      expect(await lineage(prev)).toBe(true);
      __resetPrivateVisibilityCacheForTests();
      expect(await read('bob', 'get_page', { slug: 'notes/deep-10' })).not.toContain('canarydeep10hop');
      expect(await read('owner', 'get_page', { slug: 'notes/deep-10' })).toContain('canarydeep10hop');
    }, 120_000);

    test('soft delete, restore, soft delete again and purge of the iMessage page: another member reads nothing derived at every step', async () => {
      await origin('messages-soft', 'soft');
      const local = (op: string, params: Record<string, unknown>) => dispatchToolCall(engine, op, params, { remote: false, sourceId: 'messages-soft' });
      const step = async (label: string) => { __resetPrivateVisibilityCacheForTests(); expect({ label, bob: await seen('bob', 'soft') }).toEqual({ label, bob: [] }); };
      await step('before');
      const slug = 'imessage/chat/2026-06-14';
      const del = await local('delete_page', { slug, source_id: 'messages-soft', force: true });
      expect({ error: del.isError ? del.content.map(x => x.text).join('') : null }).toEqual({ error: null });
      await step('soft-deleted');
      const restored = await local('restore_page', { slug, source_id: 'messages-soft', force: true });
      expect({ error: restored.isError ? restored.content.map(x => x.text).join('') : null }).toEqual({ error: null });
      await step('restored');
      expect((await local('delete_page', { slug, source_id: 'messages-soft', force: true })).isError).not.toBe(true);
      await step('soft-deleted again');
      await engine.executeRaw(`UPDATE pages SET deleted_at = now() - interval '4 days' WHERE source_id = 'messages-soft' AND slug = $1`, [slug]);
      // The automatic purge phase's call (cycle.ts), past the 72-hour window.
      const { purgeDeletedPagesCoordinated } = await import('../src/core/persistence/purge-deleted.ts');
      await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
      expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE source_id = 'messages-soft'`))[0]!.n).toBe(0);
      await step('purged');
      expect({ owner: await seen('owner', 'soft') }).toEqual({ owner: ['derived', 'twice', 'concept', 'fact'].map(k => `canarysoft${k}`) });
    }, 240_000);

    test('sources remove --keep-storage: another member reads nothing derived from the removed source', async () => {
      await origin('messages-kept', 'kept');
      const { runSources } = await import('../src/commands/sources.ts');
      await runSources(engine, ['remove', 'messages-kept', '--yes', '--confirm-destructive', '--keep-storage']);
      expect((await engine.executeRaw('SELECT 1 FROM sources WHERE id = $1', ['messages-kept'])).length).toBe(0);
      __resetPrivateVisibilityCacheForTests();
      expect({ bob: await seen('bob', 'kept') }).toEqual({ bob: [] });
    }, 240_000);

    test('with a delete trigger missing, owner-only lineage reads closed until the owner clears it, and the next run recreates an owned trigger', async () => {
      const lineage = async (table: string, rowId: string) =>
        (await engine.executeRaw<{ v: boolean }>(`SELECT gbrain_owner_only_lineage($1, $2::bigint) AS v`, [table, rowId]))[0]!.v;
      const derivedOpen = (await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE fact = 'derived from the open fact'`))[0]!.id;
      const openPage = await id('notes/open', OPEN_SRC);
      expect([await lineage('facts', String(derivedOpen)), await lineage('pages', openPage)]).toEqual([false, false]);
      await engine.executeRaw('DROP TRIGGER gbrain_owner_only_row_deleted_trg ON takes');
      // What ownerOnlyMarkTriggers({ ensure }) sets when a trigger stays missing (the Postgres other-role case below).
      await engine.executeRaw(`INSERT INTO owner_only_marks (row_table, row_id) VALUES ('*', 'unguarded')`);
      expect({ missing: (await engine.ownerOnlyMarkTriggers()).missing.map(m => m.table) }).toEqual({ missing: ['takes'] });
      // A row with a recorded input reads as owner-only; a page with none stays open.
      expect([await lineage('facts', String(derivedOpen)), await lineage('pages', openPage)]).toEqual([true, false]);
      const state = await engine.ownerOnlyMarkTriggers({ ensure: true });
      expect({ missing: state.missing, closed: state.closed }).toEqual({ missing: [], closed: true });
      expect(await lineage('facts', String(derivedOpen))).toBe(true);
      await engine.executeRaw(`DELETE FROM owner_only_marks WHERE row_table = '*'`);
      expect(await lineage('facts', String(derivedOpen))).toBe(false);
    }, 120_000);

    test('doctor names an owned missing trigger with the migration fix, a migration run recreates it, and doctor warns while lineage still reads closed', async () => {
      const doctor = async () => (await ownerOnlyMarksTriggersEntry.run({ engine, progress: { heartbeat() {} } } as never) as Check[])[0]!;
      expect((await doctor()).status).toBe('ok');
      await engine.executeRaw('DROP TRIGGER gbrain_owner_only_row_deleted_trg ON timeline_entries');
      const missing = await doctor();
      expect({ status: missing.status, names: missing.message.includes('timeline_entries (owner '), argv: (missing.fix as { argv?: string[] } | undefined)?.argv })
        .toEqual({ status: 'fail', names: true, argv: ['gbrain', 'apply-migrations', '--force-schema'] });
      // The gap may have let a delete through unmarked, so the run that re-creates the trigger reads lineage closed.
      await runMigrations(engine);
      expect(await engine.ownerOnlyMarkTriggers()).toMatchObject({ missing: [], closed: true });
      try {
        const closed = await doctor();
        expect({ status: closed.status, closed: closed.message.includes('still reads closed') }).toEqual({ status: 'warn', closed: true });
      } finally {
        await engine.executeRaw(`DELETE FROM owner_only_marks WHERE row_table = '*'`);
      }
      expect((await doctor()).status).toBe('ok');
    }, 120_000);

    test('a disabled delete trigger counts as missing and closes lineage, and ensure re-creates it enabled', async () => {
      await engine.executeRaw('ALTER TABLE facts DISABLE TRIGGER gbrain_owner_only_row_deleted_trg');
      try {
        expect((await engine.ownerOnlyMarkTriggers()).missing.map(m => m.table)).toEqual(['facts']);
        expect(await engine.ownerOnlyMarkTriggers({ ensure: true })).toMatchObject({ missing: [], closed: true });
      } finally {
        await engine.executeRaw(`DELETE FROM owner_only_marks WHERE row_table = '*'`);
      }
    }, 120_000);

    test('a derivation recorded after its owner-only origin is gone reads as owner-only', async () => {
      await origin('messages-late', 'late');
      const chat = await id('imessage/chat/2026-06-14', 'messages-late');
      expect(await deleteSourceRow(engine, 'messages-late')).toBe(true);
      const [late] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source)
        VALUES ($1, 'notes/open', 'written after the origin went', 'fact', 'world', 'fixture') RETURNING id`, [OPEN_SRC]);
      await engine.executeRaw(`INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES ('facts', $1, 'pages', $2, $3)`,
        [String(late!.id), chat, OPEN_SRC]);
      expect((await engine.executeRaw<{ v: boolean }>(`SELECT gbrain_owner_only_lineage('facts', $1::bigint) AS v`, [late!.id]))[0]!.v).toBe(true);
    }, 240_000);

    test('the closed mode never writes a permanent mark: an open derived row deleted while it is on marks nothing', async () => {
      const page = async (slug: string) => {
        await importFromContent(engine, slug, pageText(slug, 'gap'), { sourceId: OPEN_SRC, noEmbed: true });
        return id(slug, OPEN_SRC);
      };
      const [a, b, c] = [await page('notes/gap-a'), await page('notes/gap-b'), await page('notes/gap-c')];
      await engine.executeRaw(`INSERT INTO derivation_inputs (derived_table, derived_id, input_table, input_id, source_id) VALUES
        ('pages', $2, 'pages', $1, $4), ('pages', $3, 'pages', $2, $4)`, [a, b, c, OPEN_SRC]);
      await engine.executeRaw(`INSERT INTO owner_only_marks (row_table, row_id) VALUES ('*', 'unguarded')`);
      try {
        await engine.deletePage('notes/gap-b', { sourceId: OPEN_SRC });
        expect(await engine.executeRaw(`SELECT row_id FROM owner_only_marks WHERE row_table = 'pages' AND row_id IN ($1, $2)`, [String(b), String(c)])).toEqual([]);
      } finally {
        await engine.executeRaw(`DELETE FROM owner_only_marks WHERE row_table = '*'`);
      }
    }, 240_000);

    test.if(kind === 'postgres')('a role whose reads row-level security limits cannot hard-delete an owner-only origin', async () => {
      await origin('messages-rls', 'rls');
      const chat = await id('imessage/chat/2026-06-14', 'messages-rls');
      const role = `gbrain_scoped_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
      const admin = (await engine.executeRaw<{ u: string }>('SELECT current_user AS u'))[0]!.u;
      const wasOn = (await engine.executeRaw<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'pages'::regclass`))[0]!.on;
      await engine.executeRaw(`CREATE ROLE ${role} LOGIN PASSWORD 'scoped-example'`);
      for (const grant of ['ALL ON SCHEMA public', 'ALL ON ALL TABLES IN SCHEMA public', 'ALL ON ALL SEQUENCES IN SCHEMA public', 'EXECUTE ON ALL FUNCTIONS IN SCHEMA public']) {
        await engine.executeRaw(`GRANT ${grant} TO ${role}`);
      }
      await engine.executeRaw('ALTER TABLE pages ENABLE ROW LEVEL SECURITY');
      await engine.executeRaw(`CREATE POLICY gst3032_probe ON pages TO ${role} USING (true)`);
      await engine.executeRaw(`CREATE POLICY gst3032_sources ON sources FOR SELECT TO ${role} USING (true)`);
      await engine.executeRaw(`CREATE POLICY gst3032_marks_read ON owner_only_marks FOR SELECT TO ${role} USING (true)`);
      await engine.executeRaw(`CREATE POLICY gst3032_marks_add ON owner_only_marks FOR INSERT TO ${role} WITH CHECK (true)`);
      const url = new URL(databaseUrl); url.username = role; url.password = 'scoped-example';
      const asRole = new PostgresEngine();
      await asRole.connect({ database_url: url.toString(), poolSize: 1 });
      try {
        await expect(asRole.executeRaw('DELETE FROM pages WHERE id = $1', [chat])).rejects.toThrow(/owner_only_lineage_unreadable: this row is owner-only/);
        expect((await engine.executeRaw('SELECT 1 FROM pages WHERE id = $1', [chat])).length).toBe(1);
      } finally {
        await asRole.disconnect();
        await engine.executeRaw('DROP POLICY gst3032_probe ON pages');
        await engine.executeRaw('DROP POLICY gst3032_sources ON sources');
        await engine.executeRaw('DROP POLICY gst3032_marks_read ON owner_only_marks');
        await engine.executeRaw('DROP POLICY gst3032_marks_add ON owner_only_marks');
        if (!wasOn) await engine.executeRaw('ALTER TABLE pages DISABLE ROW LEVEL SECURITY');
        await engine.executeRaw(`REASSIGN OWNED BY ${role} TO ${admin}`);
        await engine.executeRaw(`DROP OWNED BY ${role}`);
        await engine.executeRaw(`DROP ROLE ${role}`);
      }
    }, 120_000);

    test.if(kind === 'postgres')('a trigger on a table another role owns is named with its owner fix by the migration step and doctor, and lineage reads closed', async () => {
      const runner = `gbrain_runner_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
      const admin = (await engine.executeRaw<{ u: string }>('SELECT current_user AS u'))[0]!.u;
      await engine.executeRaw(`CREATE ROLE ${runner} LOGIN PASSWORD 'runner-example' BYPASSRLS`);
      for (const grant of ['ALL ON SCHEMA public', 'ALL ON ALL TABLES IN SCHEMA public', 'ALL ON ALL SEQUENCES IN SCHEMA public', 'EXECUTE ON ALL FUNCTIONS IN SCHEMA public']) {
        await engine.executeRaw(`GRANT ${grant} TO ${runner}`);
      }
      await engine.executeRaw('DROP TRIGGER gbrain_owner_only_row_deleted_trg ON takes');
      const url = new URL(databaseUrl); url.username = runner; url.password = 'runner-example';
      const asRunner = new PostgresEngine();
      await asRunner.connect({ database_url: url.toString(), poolSize: 1 });
      try {
        const state = await asRunner.ownerOnlyMarkTriggers({ ensure: true });
        expect({ missing: state.missing, closed: state.closed }).toEqual({ missing: [{ table: 'takes', owner: admin, owned: false }], closed: true });
        expect(ownerOnlyTriggersLeftLine(state)).toContain(`ALTER TABLE public.takes OWNER TO ${runner};`);
        const [check] = await ownerOnlyMarksTriggersEntry.run({ engine: asRunner, progress: { heartbeat() {} } } as never) as Check[];
        expect({ status: check!.status, names: check!.message.includes('takes (owner ' + admin + ')'), fix: check!.message.includes(`ALTER TABLE public.takes OWNER TO ${runner};`), closed: check!.message.includes('reads closed') })
          .toEqual({ status: 'fail', names: true, fix: true, closed: true });
        const derivedOpen = (await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE fact = 'derived from the open fact'`))[0]!.id;
        expect((await asRunner.executeRaw<{ v: boolean }>(`SELECT gbrain_owner_only_lineage('facts', $1::bigint) AS v`, [derivedOpen]))[0]!.v).toBe(true);
        await engine.executeRaw(`ALTER TABLE takes OWNER TO ${runner}`);
        expect((await asRunner.ownerOnlyMarkTriggers({ ensure: true })).missing).toEqual([]);
      } finally {
        await asRunner.disconnect();
        await engine.executeRaw(`REASSIGN OWNED BY ${runner} TO ${admin}`);
        await engine.executeRaw(`DROP OWNED BY ${runner}`);
        await engine.executeRaw(`DROP ROLE ${runner}`);
        await engine.executeRaw(`DELETE FROM owner_only_marks WHERE row_table = '*'`);
      }
    }, 120_000);

    test('the migration names the owner-only kinds and flag of access/owner-only.ts', () => {
      expect(v322.sql).toContain(`IN (${OWNER_ONLY_KINDS.map(k => `'${k}'`).join(', ')})`);
      expect(v322.sql).toContain(`config->>'${OWNER_ONLY_FLAG}' = 'true'`);
    });
  });
}

describe('the owner-only guard after the last owner-only source is gone', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('a brain that never held owner-only data skips the guard without reading the marks; the one-way flag keeps it on', async () => {
    expect(await ownerOnlySourcesPresent(engine)).toBe(false);
    await engine.executeRaw(`INSERT INTO owner_only_marks (row_table, row_id) VALUES ('pages', '1')`);
    expect(await ownerOnlySourcesPresent(engine)).toBe(false);
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('held-once', 'held-once', '{"owner_only":true}'::jsonb)`);
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'held-once'`);
    expect(await ownerOnlySourcesPresent(engine)).toBe(true);
    expect((await engine.executeRaw<{ c: string }>(`SELECT obj_description('owner_only_marks'::regclass, 'pg_class') AS c`))[0]!.c).toBe(OWNER_ONLY_HELD);
  });

  test('marks copied in without the flag (a data-only restore): doctor names it, the next migration run sets it, and a marked row reads owner-only', async () => {
    const lineage = async () => (await engine.executeRaw<{ v: boolean }>(`SELECT gbrain_owner_only_lineage() AND gbrain_owner_only_lineage('pages', 1) AS v`))[0]!.v;
    expect(await lineage()).toBe(true);
    await engine.executeRaw('COMMENT ON TABLE owner_only_marks IS NULL');
    expect(await lineage()).toBe(false);
    const [check] = await ownerOnlyMarksTriggersEntry.run({ engine, progress: { heartbeat() {} } } as never) as Check[];
    expect({ status: check!.status, unflagged: (check!.details as { unflagged?: boolean }).unflagged, fix: check!.fix?.argv }).toEqual({
      status: 'fail', unflagged: true, fix: ['gbrain', 'apply-migrations', '--force-schema'] });
    await runMigrations(engine);
    expect(await lineage()).toBe(true);
    expect(((await ownerOnlyMarksTriggersEntry.run({ engine, progress: { heartbeat() {} } } as never) as Check[])[0]!).status).toBe('ok');
  });
});
