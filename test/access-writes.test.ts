/**
 * GBRA-218: remote writes under per-member read access (frontmatter readable_by).
 *
 * 1. Protects: a remote writer cannot touch an existing page it cannot read on
 *    any mutating op; it gets the canonical page_not_found ("do not retry this
 *    slug as a create") and the page is unchanged. A listed member writes its
 *    own page. A remote readable_by is validated before anything is written
 *    (readable_by_invalid names the bad entry and the corrected form), and a
 *    remote write can neither lock its writer out nor drop readable_by.
 *    Publication re-resolves the writer's member from the stored principal, so
 *    a member disabled after submission (a queued job, a replay) loses the page
 *    before commit; no operator hatch relaxes that.
 * 2. Fails when: add_link, put_raw_data or any persistence write lands on an
 *    unreadable page, a listed member is refused its own page, a malformed or
 *    lock-out readable_by is written, or a stored write still publishes after
 *    its member was disabled.
 * 3. Existing coverage (member-read-access) pins reads only.
 * 4. Real seams: tokens minted by the token service and bound with SQL, verified
 *    by the serve --http verifier, dispatched through MCP dispatch; the durable
 *    write path of a repo-less brain (no git checkout).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { remoteCallerAccess } from '../src/core/access/caller.ts';
import { submissionAuthority, authorizeStoredRequest } from '../src/core/persistence/authority.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { randomUUID } from 'node:crypto';

const SRC = 'aw-team';
const ALICE_PAGE = 'notes/alice-ledger';
const OPEN_PAGE = 'notes/open-ledger';
const CANARY = 'canaryawalice';
const alicePage = (body = 'Ledger ' + CANARY + '.', readers = '[alice-example]') =>
  ['---', 'type: note', 'title: Alice ledger', ...(readers ? ['readable_by: ' + readers] : []), '---', '# Alice ledger', '', body].join('\n');

for (const kind of testBackends()) {
  describe('remote writes under member read access (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const verify = async (who: string) => await provider().verifyAccessToken(tokens[who]) as unknown as AuthInfo;

    async function call(who: string, op: string, params: Record<string, unknown>) {
      const auth = await verify(who);
      const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: ['world'] });
      const text = out.content.map(c => c.text).join('\n');
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text); } catch { /* prose */ }
      return { isError: out.isError === true, text, json };
    }
    async function local(op: string, params: Record<string, unknown>) {
      const out = await dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId: SRC });
      return out.content.map(c => c.text).join('\n');
    }
    async function state(slug = ALICE_PAGE) {
      const [page] = await engine.executeRaw<{ body: string; deleted: boolean; frontmatter: Record<string, unknown> }>(
        'SELECT compiled_truth AS body, deleted_at IS NOT NULL AS deleted, frontmatter FROM pages WHERE source_id=$1 AND slug=$2', [SRC, slug]);
      const [counts] = await engine.executeRaw<{ tags: number; links: number; raw: number; timeline: number; takes: number }>(
        'SELECT (SELECT count(*)::int FROM tags t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1) AS tags,'
        + ' (SELECT count(*)::int FROM links l JOIN pages p ON p.id IN (l.from_page_id, l.to_page_id) WHERE p.slug=$1) AS links,'
        + ' (SELECT count(*)::int FROM raw_data r JOIN pages p ON p.id=r.page_id WHERE p.slug=$1) AS raw,'
        + ' (SELECT count(*)::int FROM timeline_entries e JOIN pages p ON p.id=e.page_id WHERE p.slug=$1) AS timeline,'
        + ' (SELECT count(*)::int FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.slug=$1) AS takes', [slug]);
      return { ...page, ...counts };
    }
    async function revision(slug = ALICE_PAGE): Promise<string> {
      return (JSON.parse(await local('get_page', { slug, include_content: true })) as { revision: string }).revision;
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      await importFromContent(engine, ALICE_PAGE, alicePage(), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, ALICE_PAGE, alicePage('Ledger ' + CANARY + '. Second draft.'), { sourceId: SRC, noEmbed: true });
      await engine.createVersion(ALICE_PAGE, { sourceId: SRC });
      await importFromContent(engine, OPEN_PAGE, '---\ntype: note\ntitle: Open ledger\n---\n# Open ledger\n\nLedger canaryawopen.', { sourceId: SRC, noEmbed: true });
      for (const id of ['alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      for (const [name, member] of [['alice', 'alice-example'], ['bob', 'bob-example'], ['unbound', null]] as const) {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        if (member) await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
      }
    }, 240_000);
    afterAll(async () => { await close?.(); }, 60_000);

    /** Every mutating op with arguments that touch ALICE_PAGE; the put_page content passes the writer's own readers check, so only the page's readers refuse it. */
    const mutations = async (who = 'bob'): Promise<Array<[string, string, Record<string, unknown>]>> => [
      ['put_page', 'put_page', { slug: ALICE_PAGE, content: alicePage('Rewritten.', who === 'bob' ? '[alice-example, bob-example]' : ''), expected_revision: await revision() }],
      ['edit_page', 'edit_page', { slug: ALICE_PAGE, expected_revision: await revision(), edits: [{ old_text: 'Second draft', new_text: 'Edited' }] }],
      ['append_page', 'append_page', { slug: ALICE_PAGE, text: 'Appended.', request_id: randomUUID() }],
      ['add_link from', 'add_link', { from: ALICE_PAGE, to: OPEN_PAGE }],
      ['add_link to', 'add_link', { from: OPEN_PAGE, to: ALICE_PAGE }],
      ['add_tag', 'add_tag', { slug: ALICE_PAGE, tag: 'x-tag' }],
      ['add_timeline_entry', 'add_timeline_entry', { slug: ALICE_PAGE, date: '2026-01-01', summary: 'Planning call' }],
      ['put_raw_data', 'put_raw_data', { slug: ALICE_PAGE, source: 'acme-example', data: { a: 1 } }],
      ['revert_version', 'revert_version', { slug: ALICE_PAGE, version_id: 1 }],
      ['takes_add', 'takes_add', { slug: ALICE_PAGE, claim: 'A take', holder: 'world', kind: 'take' }],
      ['remove_tag', 'remove_tag', { slug: ALICE_PAGE, tag: 'x-tag' }],
      ['delete_page', 'delete_page', { slug: ALICE_PAGE }],
    ];

    test('an unlisted member and an unbound token get the canonical page_not_found on every mutating op, and the page is unchanged', async () => {
      const before = await state();
      for (const who of ['bob', 'unbound']) {
        for (const [label, op, params] of await mutations(who)) {
          const out = await call(who, op, params);
          expect({ who, label, code: out.json.code, suggestion: out.json.suggestion }).toEqual({ who, label, code: 'page_not_found',
            suggestion: expect.stringContaining('Do not retry this slug as a create; ask the user') });
          expect(out.text).not.toContain(CANARY);
        }
      }
      expect(await state()).toEqual(before);
    }, 240_000);

    test('under GBRAIN_REMOTE_PRIVATE_PAGES=1 an unlisted member is still refused', async () => {
      const before = await state();
      await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
        for (const [label, op, params] of (await mutations()).filter(([l]) => ['put_page', 'add_link from', 'add_tag', 'put_raw_data', 'delete_page'].includes(l))) {
          expect({ label, code: (await call('bob', op, params)).json.code }).toEqual({ label, code: 'page_not_found' });
        }
      });
      expect(await state()).toEqual(before);
    }, 240_000);

    test('a listed member writes its own page through the same ops', async () => {
      const put = await call('alice', 'put_page', { slug: ALICE_PAGE, content: alicePage('Ledger ' + CANARY + '. Second draft. Alice wrote this.'), expected_revision: await revision() });
      expect({ isError: put.isError, text: put.text.slice(0, 200) }).toEqual({ isError: false, text: expect.not.stringContaining('page_not_found') });
      for (const [op, params] of [['add_tag', { slug: ALICE_PAGE, tag: 'x-tag' }], ['add_link', { from: ALICE_PAGE, to: OPEN_PAGE }],
        ['put_raw_data', { slug: ALICE_PAGE, source: 'acme-example', data: { a: 1 } }], ['add_timeline_entry', { slug: ALICE_PAGE, date: '2026-01-02', summary: 'Alice call' }]] as const) {
        const out = await call('alice', op, params as Record<string, unknown>);
        expect({ op, isError: out.isError, code: out.json.code }).toEqual({ op, isError: false, code: undefined });
      }
      const after = await state();
      expect(after.body).toContain('Alice wrote this.');
      expect({ tags: after.tags, raw: after.raw, timeline: after.timeline > 0, links: after.links > 0, readers: after.frontmatter.readable_by })
        .toEqual({ tags: 1, raw: 1, timeline: true, links: true, readers: ['alice-example'] });
    }, 240_000);

    test('a malformed readable_by is refused before anything is written, naming the entry and the corrected form', async () => {
      const out = await call('alice', 'put_page', { slug: 'notes/alice-new', content: alicePage('New.', '[alice-example, Not Valid]') });
      expect(out.json).toMatchObject({ code: 'readable_by_invalid', message: expect.stringContaining('"Not Valid"'),
        suggestion: expect.stringContaining('readable_by: [alice-example]'), docs: expect.stringContaining('write-refusals.md#readable_by_invalid') });
      for (const value of ['[]', '[alice-example, 7]']) {
        expect((await call('alice', 'put_page', { slug: 'notes/alice-new', content: alicePage('New.', value) })).json.code).toBe('readable_by_invalid');
      }
      const [rows] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE slug = 'notes/alice-new'");
      expect(rows.n).toBe(0);
      const [requests] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE slug = 'notes/alice-new'");
      expect(requests.n).toBe(0);
    }, 120_000);

    test('a remote write cannot lock its writer out or drop readable_by', async () => {
      const lockout = await call('alice', 'put_page', { slug: 'notes/alice-new', content: alicePage('New.', '[bob-example]') });
      expect(lockout.json).toMatchObject({ code: 'readable_by_invalid', message: expect.stringContaining('unreadable by this connection') });
      const unbound = await call('unbound', 'put_page', { slug: 'notes/unbound-new', content: alicePage('New.', '[alice-example]') });
      expect(unbound.json.code).toBe('readable_by_invalid');
      const edit = await call('alice', 'edit_page', { slug: ALICE_PAGE, expected_revision: await revision(), edits: [{ old_text: '- alice-example', new_text: '- bob-example' }] });
      expect({ code: edit.json.code, text: edit.text.slice(0, 300) }).toEqual({ code: 'readable_by_invalid', text: expect.stringContaining('unreadable by this connection') });
      expect((await state()).frontmatter.readable_by).toEqual(['alice-example']);
      const ok = await call('alice', 'put_page', { slug: 'notes/alice-new', content: alicePage('New.', '[alice-example, group:team-a]') });
      expect(ok.isError).toBe(false);
      const drop = await call('alice', 'put_page', { slug: 'notes/alice-new', content: alicePage('New, now open.', ''), expected_revision: await revision('notes/alice-new') });
      expect(drop.json).toMatchObject({ code: 'readable_by_invalid', message: expect.stringContaining('removes readable_by') });
      expect((await state('notes/alice-new')).frontmatter.readable_by).toEqual(['alice-example', 'group:team-a']);
    }, 120_000);

    test('publication re-resolves the writer: a stored write whose member is disabled before commit is refused, and a hatch does not relax it', async () => {
      const auth = await verify('alice');
      const ctx = { engine, config: { engine: 'pglite' }, sourceId: SRC, auth, remote: true, dryRun: false, takesHoldersAllowList: ['world'],
        logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [SRC]);
      const authority = await withCallerAccess(await remoteCallerAccess(engine, auth, undefined),
        () => submissionAuthority(ctx, 'add_tag', SRC, source.incarnation, ALICE_PAGE));
      const row = await admitWrite(engine, { principal: authority.principal, authority, operation: 'add_tag', sourceId: SRC,
        sourceIncarnation: source.incarnation, slug: ALICE_PAGE, requestId: randomUUID(), callerIntent: {}, intent: {} });
      await authorizeStoredRequest(engine, row);
      await engine.executeRaw("UPDATE access_members SET disabled_at = now() WHERE id = 'alice-example'");
      try {
        await expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'page_not_found' });
        await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, () => expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'page_not_found' }));
      } finally {
        await engine.executeRaw("UPDATE access_members SET disabled_at = NULL WHERE id = 'alice-example'");
      }
      await authorizeStoredRequest(engine, row);
      await engine.executeRaw("UPDATE access_tokens SET member_id = NULL WHERE name = 'alice'");
      try {
        await expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'page_not_found' });
      } finally {
        await engine.executeRaw("UPDATE access_tokens SET member_id = 'alice-example' WHERE name = 'alice'");
      }
    }, 120_000);

    test('extract_facts treats a restricted source_slug exactly like a missing one', async () => {
      const hidden = await call('bob', 'extract_facts', { turn_text: 'Bob likes tea.', source_slug: ALICE_PAGE, visibility: 'world' });
      const missing = await call('bob', 'extract_facts', { turn_text: 'Bob likes tea.', source_slug: 'notes/never-written', visibility: 'world' });
      expect(hidden.text.replaceAll(ALICE_PAGE, '<slug>')).toEqual(missing.text.replaceAll('notes/never-written', '<slug>'));
      expect(hidden.text).not.toContain(CANARY);
    }, 120_000);
  });
}
