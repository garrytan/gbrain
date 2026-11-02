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
 *    remove_link on an edge of an unreadable page answers as for a missing
 *    page and removes nothing. The remote links effect skips an unreadable
 *    mention target as missing (no edge, no wanted row), hatch or not.
 * 2. Fails when: add_link, remove_link, put_raw_data or any persistence write lands on an
 *    unreadable page, a listed member is refused its own page, a malformed or
 *    lock-out readable_by is written, or a stored write still publishes after
 *    its member was disabled.
 *    A member who satisfies a folder rule writes the pages under it (the
 *    publication fast path must not read folder-ruled pages as unopenable).
 *    A stdio server bound through mcp.stdio_member writes as that member.
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
import { remoteCallerAccess, STDIO_MEMBER_KEY } from '../src/core/access/caller.ts';
import { submissionAuthority, authorizeStoredRequest } from '../src/core/persistence/authority.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
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
      // GBRA-218: the graph and raw-data ops on an existing target answer a hidden page exactly as a missing slug (no existence oracle).
      const asMissing = new Set(['add_link from', 'add_link to', 'add_timeline_entry', 'put_raw_data']);
      const swap = <T,>(v: T): T => JSON.parse(JSON.stringify(v).replaceAll(ALICE_PAGE, 'notes/never-written'));
      for (const who of ['bob', 'unbound']) {
        for (const [label, op, params] of await mutations(who)) {
          const out = await call(who, op, params);
          if (asMissing.has(label)) {
            const missing = await call(who, op, swap(params));
            expect({ who, label, isError: out.isError, json: swap(out.json) }).toEqual({ who, label, isError: true, json: missing.json });
            expect({ who, label, code: out.json.code }).toEqual({ who, label, code: 'page_not_found' });
          } else {
            expect({ who, label, code: out.json.code, suggestion: out.json.suggestion }).toEqual({ who, label, code: 'page_not_found',
              suggestion: expect.stringContaining('Do not retry this slug as a create; ask the user') });
          }
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

    test('a member satisfying a folder rule writes pages under it through the durable write path; an unlisted member is still refused', async () => {
      const slug = 'partners/alice-example/plan';
      await importFromContent(engine, slug, '---\ntype: note\ntitle: Alice plan\n---\n# Alice plan\n\nPlan canaryawfolder.', { sourceId: SRC, noEmbed: true });
      const applied = await proposeRevision(engine, SRC, [{ id: 'alice', prefix: 'partners/alice-example/', readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
      expect(applied.state).toBe('applied');
      expect((await call('alice', 'get_page', { slug })).text).toContain('canaryawfolder');
      const before = await state(slug);
      for (const [op, params] of [['put_page', { slug, content: '---\ntype: note\ntitle: Alice plan\n---\n# Alice plan\n\nBob rewrote this.', expected_revision: await revision(slug) }],
        ['add_tag', { slug, tag: 'bob-tag' }], ['delete_page', { slug }]] as const) {
        const out = await call('bob', op, params as Record<string, unknown>);
        expect({ op, code: out.json.code }).toEqual({ op, code: 'page_not_found' });
        expect(out.text).not.toContain('canaryawfolder');
      }
      expect(await state(slug)).toEqual(before);
      const put = await call('alice', 'put_page', { slug, content: '---\ntype: note\ntitle: Alice plan\n---\n# Alice plan\n\nPlan canaryawfolder. Alice wrote this.', expected_revision: await revision(slug) });
      expect({ op: 'put_page', isError: put.isError, code: put.json.code }).toEqual({ op: 'put_page', isError: false, code: undefined });
      for (const [op, params] of [['add_tag', { slug, tag: 'alice-tag' }], ['add_timeline_entry', { slug, date: '2026-01-03', summary: 'Plan call' }]] as const) {
        const out = await call('alice', op, params as Record<string, unknown>);
        expect({ op, isError: out.isError, code: out.json.code }).toEqual({ op, isError: false, code: undefined });
      }
      const after = await state(slug);
      expect({ body: after.body.includes('Alice wrote this.'), tags: after.tags, timeline: after.timeline }).toEqual({ body: true, tags: 1, timeline: 1 });
      const del = await call('alice', 'delete_page', { slug, expected_revision: await revision(slug) });
      expect({ op: 'delete_page', isError: del.isError, code: del.json.code }).toEqual({ op: 'delete_page', isError: false, code: undefined });
      expect((await state(slug)).deleted).toBe(true);
    }, 240_000);

    test('remove_link on an edge of a page the caller cannot read answers exactly as for a missing page and removes nothing', async () => {
      await local('add_link', { from: ALICE_PAGE, to: OPEN_PAGE, link_type: 'mentions' });
      await local('add_link', { from: OPEN_PAGE, to: ALICE_PAGE, link_type: 'mentions' });
      const before = (await state()).links;
      expect(before).toBeGreaterThanOrEqual(2);
      const missing = await call('bob', 'remove_link', { from: 'notes/never-written', to: OPEN_PAGE, link_type: 'mentions' });
      for (const who of ['bob', 'unbound']) {
        for (const [from, to] of [[ALICE_PAGE, OPEN_PAGE], [OPEN_PAGE, ALICE_PAGE]]) {
          const out = await call(who, 'remove_link', { from, to, link_type: 'mentions' });
          expect({ who, from, isError: out.isError, json: out.json }).toEqual({ who, from, isError: missing.isError, json: missing.json });
        }
      }
      expect((await state()).links).toBe(before);
      const own = await call('alice', 'remove_link', { from: ALICE_PAGE, to: OPEN_PAGE, link_type: 'mentions' });
      expect({ isError: own.isError, removed: own.json.removed }).toEqual({ isError: false, removed: 1 });
    }, 120_000);

    test('the remote links effect skips a page the writer cannot read exactly as a missing one, under a privacy hatch too', async () => {
      const folderSlug = 'partners/alice-example/brief';
      await importFromContent(engine, folderSlug, '---\ntype: note\ntitle: Alice brief\n---\n# Alice brief\n\nBrief canaryawbrief.', { sourceId: SRC, noEmbed: true });
      await proposeRevision(engine, SRC, [{ id: 'alice', prefix: 'partners/alice-example/', readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
      const targets = [ALICE_PAGE, folderSlug, OPEN_PAGE, 'notes/never-written'];
      for (const hatch of [undefined, '1']) {
        await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: hatch }, async () => {
          for (const who of ['bob', 'unbound', 'alice']) {
            const slug = 'notes/mentions-' + who + (hatch ? '-hatch' : '');
            const put = await call(who, 'put_page', { slug, content: '---\ntype: note\ntitle: Mentions\n---\n# Mentions by ' + who + (hatch ? ' with the hatch' : '') + '\n\nSee ' + targets.map(t => '[[' + t + ']]').join(', ') + '.' });
            expect({ who, hatch, isError: put.isError }).toEqual({ who, hatch, isError: false });
            const settled = async () => (await engine.executeRaw<{ outcome: { added: number; skipped_targets: { slug: string; reason: string }[] } | null }>(
              "SELECT outcome FROM persistence_effects WHERE kind='links' AND source_id=$1 AND data->>'slug'=$2 ORDER BY id DESC LIMIT 1", [SRC, slug]))[0];
            for (let i = 0; i < 20 && !(await settled())?.outcome; i++) {
              await runPersistenceEffects(engine, { engine: 'pglite', embedding_disabled: true } as never, { hostId: localHostId() });
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            const effect = await settled();
            const edges = await engine.executeRaw<{ slug: string }>('SELECT t.slug FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id'
              + ' WHERE f.source_id=$1 AND f.slug=$2 ORDER BY t.slug', [SRC, slug]);
            const wanted = await engine.executeRaw<{ target_ref: string }>('SELECT w.target_ref FROM wanted_links w JOIN pages p ON p.id=w.origin_page_id'
              + ' WHERE p.source_id=$1 AND p.slug=$2 ORDER BY w.target_ref', [SRC, slug]);
            const reader = who === 'alice';
            expect({ who, hatch, added: effect?.outcome?.added, edges: edges.map(e => e.slug), wanted: wanted.map(w => w.target_ref),
              skipped: Object.fromEntries(effect?.outcome?.skipped_targets.map(t => [t.slug, t.reason]) ?? []) }).toEqual({ who, hatch,
              added: reader ? 3 : 1, edges: reader ? [ALICE_PAGE, OPEN_PAGE, folderSlug].sort() : [OPEN_PAGE], wanted: ['notes/never-written'],
              skipped: reader ? { 'notes/never-written': 'missing' } : { [ALICE_PAGE]: 'missing', [folderSlug]: 'missing', 'notes/never-written': 'missing' } });
          }
        });
      }
    }, 240_000);

    test('a stdio server bound to a member through mcp.stdio_member writes that member\'s pages; unbound it is refused', async () => {
      async function stdio(op: string, params: Record<string, unknown>) {
        const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'stdio', sourceId: SRC, takesHoldersAllowList: ['world'] });
        const text = out.content.map(c => c.text).join('\n');
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(text); } catch { /* prose */ }
        return { isError: out.isError === true, text, json };
      }
      const before = await state();
      const unbound = await stdio('add_tag', { slug: ALICE_PAGE, tag: 'stdio-tag' });
      expect({ code: unbound.json.code }).toEqual({ code: 'page_not_found' });
      expect(await state()).toEqual(before);
      await engine.setConfig(STDIO_MEMBER_KEY, 'alice-example');
      try {
        const appended = await stdio('append_page', { slug: ALICE_PAGE, text: 'Stdio wrote this.', request_id: randomUUID() });
        expect({ op: 'append_page', isError: appended.isError, code: appended.json.code }).toEqual({ op: 'append_page', isError: false, code: undefined });
        const tag = await stdio('add_tag', { slug: ALICE_PAGE, tag: 'stdio-tag' });
        expect({ op: 'add_tag', isError: tag.isError, code: tag.json.code }).toEqual({ op: 'add_tag', isError: false, code: undefined });
        const created = await stdio('put_page', { slug: 'notes/alice-stdio', content: alicePage('Stdio page.', '[alice-example]') });
        expect({ op: 'put_page new', isError: created.isError, code: created.json.code }).toEqual({ op: 'put_page new', isError: false, code: undefined });
        expect((await state()).tags).toBe(before.tags + 1);
        expect((await state('notes/alice-stdio')).frontmatter.readable_by).toEqual(['alice-example']);
      } finally {
        await engine.setConfig(STDIO_MEMBER_KEY, '');
      }
      const after = await stdio('remove_tag', { slug: ALICE_PAGE, tag: 'stdio-tag' });
      expect({ code: after.json.code }).toEqual({ code: 'page_not_found' });
    }, 240_000);

    test('under a privacy hatch the links effect resolves a stdio writer bound to a reader as that member: its mention edge is kept', async () => {
      await engine.setConfig(STDIO_MEMBER_KEY, 'alice-example');
      try {
        await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
          const slug = 'notes/mentions-stdio';
          const out = await dispatchToolCall(engine, 'put_page', { slug, content: '---\ntype: note\ntitle: Stdio mentions\n---\n# Stdio mentions\n\nSee [[' + ALICE_PAGE + ']].' },
            { remote: true, transport: 'stdio', sourceId: SRC, takesHoldersAllowList: ['world'] });
          expect(out.isError === true).toBe(false);
          const settled = async () => (await engine.executeRaw<{ outcome: { added: number } | null }>(
            "SELECT outcome FROM persistence_effects WHERE kind='links' AND source_id=$1 AND data->>'slug'=$2 ORDER BY id DESC LIMIT 1", [SRC, slug]))[0];
          for (let i = 0; i < 20 && !(await settled())?.outcome; i++) {
            await runPersistenceEffects(engine, { engine: 'pglite', embedding_disabled: true } as never, { hostId: localHostId() });
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          const edges = await engine.executeRaw<{ slug: string }>('SELECT t.slug FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id'
            + ' WHERE f.source_id=$1 AND f.slug=$2', [SRC, slug]);
          expect({ added: (await settled())?.outcome?.added, edges: edges.map(e => e.slug) }).toEqual({ added: 1, edges: [ALICE_PAGE] });
        });
      } finally {
        await engine.setConfig(STDIO_MEMBER_KEY, '');
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
