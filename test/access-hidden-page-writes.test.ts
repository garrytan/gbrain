/**
 * GBRA-431: a remote caller who cannot read a page gets the answer a missing page gets, on every op the audit found
 * open, and a fact is never wider than the page it is about.
 *
 * 1. Protects: put_raw_data, add_link (either endpoint) and remove_link on a `visibility: private` page answer a
 *    write token without a private-pages grant exactly as for a missing slug and change nothing, on an unmanaged and
 *    a managed brain. ontology_propose refuses an entity page the caller cannot read (as put_page's create on it does)
 *    and stores an observation no wider than the page. A `world` observation about a restricted or private entity
 *    page is withheld from every remote caller who cannot read that page (ontology_get, volunteer_chronicle, delta,
 *    find_trajectory, the hot-memory `_meta`), while a member the page names still reads it. get_ingest_log names no
 *    hidden slug and no host path, and get_health's most_connected names no hidden page. Trusted local callers keep
 *    every answer they had.
 * 2. Fails when: any of those ops writes to, or reveals, a page its remote caller cannot read, or a reader of the page
 *    loses its observation.
 * 3. Existing coverage: test/access-writes.test.ts pins the same answers for a page whose readers omit the caller.
 * 4. Real seams: tokens minted by the token service and bound with SQL, verified by the serve --http verifier,
 *    dispatched through MCP dispatch; a repo-less brain, and a managed repo brain for the graph ops.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { getBrainHotMemoryMeta, __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

const SRC = 'hp-team';
const OPEN = 'notes/open-plan';
const HUB = 'notes/shared-roadmap';
const RESTRICTED = 'people/vesper-example';
const PRIVATE = 'notes/quiet-plan';
const MISSING = 'notes/never-written';
const note = (title: string, body: string, extra: string[] = []) => ['---', ...extra, 'title: ' + title, '---', '# ' + title, '', body].join('\n');
const swap = <T,>(v: T, from = PRIVATE): T => JSON.parse(JSON.stringify(v).replaceAll(from, MISSING));
const json = (text: string): Record<string, unknown> => { try { return JSON.parse(text); } catch { return {}; } };

type Call = { isError: boolean; text: string; json: Record<string, unknown> };

for (const kind of testBackends()) {
  describe('remote callers and pages they cannot read (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(who: string, op: string, params: Record<string, unknown>): Promise<Call> {
      const auth = await provider().verifyAccessToken(tokens[who]) as unknown as AuthInfo;
      const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default',
        takesHoldersAllowList: ['world'], metaHook: getBrainHotMemoryMeta, sessionId: 'hp-' + who + '-' + randomUUID() } as never);
      const text = out.content.map(c => c.text).join('\n');
      const hot = (out._meta as Record<string, unknown> | undefined)?.brain_hot_memory;
      return { isError: out.isError === true, text: text + (hot ? '\n_META_HOT: ' + JSON.stringify(hot) : ''), json: json(text) };
    }
    async function local(op: string, params: Record<string, unknown>): Promise<Call> {
      const out = await dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId: SRC });
      const text = out.content.map(c => c.text).join('\n');
      return { isError: out.isError === true, text, json: json(text) };
    }
    async function state(slug: string) {
      const [row] = await engine.executeRaw<{ raw: unknown; out_links: number; in_links: number; facts: number; timeline: number }>(
        `SELECT (SELECT json_agg(r.data ORDER BY r.source) FROM raw_data r JOIN pages p ON p.id=r.page_id WHERE p.slug=$1 AND p.source_id=$2) AS raw,
           (SELECT count(*)::int FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.slug=$1 AND p.source_id=$2) AS out_links,
           (SELECT count(*)::int FROM links l JOIN pages p ON p.id=l.to_page_id WHERE p.slug=$1 AND p.source_id=$2) AS in_links,
           (SELECT count(*)::int FROM facts f WHERE f.entity_slug=$1 AND f.source_id=$2) AS facts,
           (SELECT count(*)::int FROM timeline_entries e JOIN pages p ON p.id=e.page_id WHERE p.slug=$1 AND p.source_id=$2) AS timeline`, [slug, SRC]);
      return row;
    }

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } } as never);
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      __resetHotMemoryCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      await importFromContent(engine, HUB, note('Shared roadmap', 'The shared roadmap.', ['type: note']), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, OPEN, note('Open plan', 'Open planning notes.', ['type: note']), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, RESTRICTED, note('Vesper Example', 'Person notes.', ['type: person', 'readable_by: [alice-example]']), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, 'people/hidden-successor-example', note('Hidden Successor', 'Person notes.', ['type: person', 'visibility: private']), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, 'people/olden-example', note('Olden Example', 'Retired.', ['type: person', 'superseded_by: people/hidden-successor-example']), { sourceId: SRC, noEmbed: true });
      await importFromContent(engine, PRIVATE, note('Quiet plan', 'Quiet planning notes.', ['type: note', 'visibility: private']), { sourceId: SRC, noEmbed: true });
      for (const slug of [OPEN, RESTRICTED, PRIVATE]) {
        await engine.addLink(slug, HUB, 'roadmap', 'mentions', 'manual', undefined, undefined, { fromSourceId: SRC, toSourceId: SRC }); // gbrain-allow-direct-insert: test fixture edges
        if (slug !== OPEN) await engine.addLink(OPEN, slug, 'context', 'mentions', 'manual', undefined, undefined, { fromSourceId: SRC, toSourceId: SRC }); // gbrain-allow-direct-insert: test fixture edges
        await engine.putRawData(slug, 'acme-example', { note: 'fixture' }, { sourceId: SRC });
      }
      for (const id of ['alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      for (const [name, scopes, member] of [['reader', ['read'], null], ['writer', ['read', 'write'], null], ['bob', ['read', 'write'], 'bob-example'],
        ['alice', ['read', 'write'], 'alice-example'], ['admin', ['read', 'write', 'admin'], null]] as const) {
        const minted = await mintLegacyToken(engine, { name, scopes: [...scopes], takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        if (member) await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
      }
    }, 240_000);
    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await close?.(); }, 60_000);

    test('put_raw_data, add_link and remove_link answer a private page exactly as a missing one and change nothing', async () => {
      const before = await state(PRIVATE);
      const ops: Array<[string, string, Record<string, unknown>]> = [
        ['put_raw_data', 'put_raw_data', { slug: PRIVATE, source: 'acme-example', data: { note: 'overwritten' } }],
        ['add_link from', 'add_link', { from: PRIVATE, to: OPEN, link_type: 'mentions' }],
        ['add_link to', 'add_link', { from: OPEN, to: PRIVATE, link_type: 'mentions' }],
        ['remove_link from', 'remove_link', { from: PRIVATE, to: HUB }],
        ['remove_link to', 'remove_link', { from: OPEN, to: PRIVATE }],
      ];
      for (const who of ['writer', 'bob']) {
        for (const [label, op, params] of ops) {
          const out = await call(who, op, params);
          const missing = await call(who, op, swap(params));
          expect({ who, label, isError: out.isError, json: swap(out.json) }).toEqual({ who, label, isError: missing.isError, json: missing.json });
        }
      }
      expect(await state(PRIVATE)).toEqual(before);
      expect(await state(MISSING)).toEqual({ raw: null, out_links: 0, in_links: 0, facts: 0, timeline: 0 });
    }, 240_000);

    test('extract_entities treats a source page its caller cannot read as a missing one, and skips an entity page it cannot read', async () => {
      const text = 'Carol Example met with Dana Example.';
      const shape = (out: Call) => ({ isError: out.isError, entities: (out.json.entities as Array<Record<string, unknown>> | undefined)?.map(e => ({ slug: e.slug, action: e.action, backlinkCreated: e.backlinkCreated, timelineAdded: e.timelineAdded })) });
      for (const [who, slug] of [['bob', RESTRICTED], ['writer', PRIVATE]] as const) {
        await call(who, 'extract_entities', { text, source_slug: MISSING });
        const before = await state(slug);
        const hidden = await call(who, 'extract_entities', { text, source_slug: slug });
        const missing = await call(who, 'extract_entities', { text, source_slug: MISSING });
        expect({ who, slug, ...shape(hidden) }).toEqual({ who, slug, ...shape(missing) });
        expect({ who, slug, after: await state(slug) }).toEqual({ who, slug, after: before });
      }
      const restricted = await state(RESTRICTED);
      for (const who of ['bob', 'writer']) {
        const out = await call(who, 'extract_entities', { text: 'Vesper Example joined Erin Example on the planning call.', source_slug: OPEN });
        const entities = out.json.entities as Array<{ slug: string; action: string; skipped_reason?: string; backlinkCreated: boolean }>;
        expect({ who, isError: out.isError, hidden: entities.find(e => e.slug === RESTRICTED) })
          .toEqual({ who, isError: false, hidden: expect.objectContaining({ action: 'skipped', skipped_reason: 'page_not_found', backlinkCreated: false }) });
        expect(entities.some(e => e.slug !== RESTRICTED && e.action !== 'skipped')).toBe(true);
      }
      for (const who of ['bob', 'writer']) {
        const out = await call(who, 'extract_entities', { text: 'Olden Example joined the planning call.', source_slug: OPEN });
        expect({ who, isError: out.isError, leaked: out.text.includes('hidden-successor') }).toEqual({ who, isError: false, leaked: false });
      }
      expect(await state(RESTRICTED)).toEqual(restricted);
      const alice = await call('alice', 'extract_entities', { text: 'Vesper Example joined the planning call.', source_slug: OPEN });
      expect((alice.json.entities as Array<{ slug: string; action: string }>).find(e => e.slug === RESTRICTED)?.action).toBe('updated');
    }, 240_000);

    test('a trusted local caller still writes the private page', async () => {
      expect((await local('put_raw_data', { slug: PRIVATE, source: 'local-example', data: { note: 'local' } })).json).toEqual({ status: 'ok' });
      expect((await local('remove_link', { from: PRIVATE, to: HUB })).json).toMatchObject({ removed: 1 });
      expect((await local('add_link', { from: PRIVATE, to: HUB, link_type: 'mentions' })).isError).toBe(false);
    }, 120_000);

    test('get_ingest_log names no page a remote reader cannot read and no host path; local callers see the row whole', async () => {
      await engine.logIngest({ source_id: SRC, source_type: 'git_sync', source_ref: '/srv/brains/acme-example @ abcdef12', pages_updated: [OPEN], summary: 'Sync: +1 ~0 -0' });
      await engine.logIngest({ source_id: SRC, source_type: 'fixture', source_ref: 'ref-mixed', pages_updated: [OPEN, RESTRICTED, PRIVATE], summary: 'Ingested canaryhpmixed' });
      await engine.logIngest({ source_id: SRC, source_type: 'fixture', source_ref: 'ref-gone', pages_updated: [MISSING], summary: 'Ingested canaryhpgone' });
      await engine.logIngest({ source_id: SRC, source_type: 'fixture', source_ref: 'ref-hidden-only', pages_updated: [RESTRICTED, PRIVATE], summary: 'Ingested canaryhphidden' });
      await engine.logIngest({ source_id: SRC, source_type: 'fixture', source_ref: 'ref-alice', pages_updated: [RESTRICTED], summary: 'Ingested canaryhpalice' });
      await engine.logIngest({ source_id: SRC, source_type: 'write-verify-guard', source_ref: PRIVATE, pages_updated: [], summary: 'read-back failed canaryhpguard' });
      await engine.logIngest({ source_id: SRC, source_type: 'note', source_ref: RESTRICTED, pages_updated: [], summary: 'canaryhpref' });
      await engine.logIngest({ source_id: SRC, source_type: 'git_sync', source_ref: '/home/alice-example/Mobile Documents/brain @ 0123abcd', pages_updated: [OPEN], summary: 'Sync: +1 ~0 -0' });
      await engine.logIngest({ source_id: SRC, source_type: 'directory', source_ref: './brain-example', pages_updated: [OPEN], summary: 'Import' });
      const remote = await call('reader', 'get_ingest_log', { limit: 20 });
      expect(remote.isError).toBe(false);
      const refs = (JSON.parse(remote.text.split('\n_META_HOT')[0]) as Array<{ source_ref: string; pages_updated: string[] }>).map(r => r.source_ref);
      expect(refs).toEqual(expect.arrayContaining(['<local path> @ abcdef12', '<local path> @ 0123abcd', '<local path>']));
      for (const hidden of [RESTRICTED, PRIVATE, MISSING, 'canaryhpmixed', 'canaryhpgone', 'canaryhphidden', 'canaryhpalice', 'canaryhpguard', 'canaryhpref', 'Mobile Documents', 'brain-example', '/srv/brains']) {
        expect({ hidden, shown: remote.text.includes(hidden) }).toEqual({ hidden, shown: false });
      }
      const alice = (await call('alice', 'get_ingest_log', { limit: 20 })).text;
      expect({ alice: alice.includes('canaryhpalice'), ref: alice.includes('canaryhpref'), mixed: alice.includes('canaryhpmixed') }).toEqual({ alice: true, ref: true, mixed: false });
      const whole = await local('get_ingest_log', { limit: 20 });
      for (const shown of ['/srv/brains/acme-example', PRIVATE, 'canaryhphidden', 'canaryhpmixed', 'canaryhpguard']) expect({ shown, ok: whole.text.includes(shown) }).toEqual({ shown, ok: true });
    }, 120_000);

    test('ontology_propose refuses an entity page its caller cannot read, and keeps an observation no wider than the page', async () => {
      expect((await local('ontology_propose', { entity: RESTRICTED, dimension: 'role', value: 'director', visibility: 'private' })).isError).toBe(false);
      expect((await local('ontology_propose', { entity: PRIVATE, dimension: 'status', value: 'paused', visibility: 'private' })).isError).toBe(false);
      const before = [await state(RESTRICTED), await state(PRIVATE)];
      for (const [who, slug] of [['bob', RESTRICTED], ['writer', RESTRICTED], ['writer', PRIVATE], ['bob', PRIVATE]] as const) {
        const out = await call(who, 'ontology_propose', { entity: slug, dimension: 'role', value: 'intern' });
        expect({ who, slug, isError: out.isError, code: out.json.code, action: out.json.action }).toEqual({ who, slug, isError: true, code: 'page_not_found', action: undefined });
      }
      expect([await state(RESTRICTED), await state(PRIVATE)]).toEqual(before);
      expect((await call('bob', 'ontology_propose', { entity: 'people/nobody-example', dimension: 'role', value: 'intern' })).json.action).toBe('inserted');
      const alice = await call('alice', 'ontology_propose', { entity: RESTRICTED, dimension: 'team', value: 'ledger', visibility: 'world' });
      expect(alice.isError).toBe(false);
      const [stored] = await engine.executeRaw<{ visibility: string }>(`SELECT visibility FROM facts WHERE source_id=$1 AND entity_slug=$2 AND dimension='team'`, [SRC, RESTRICTED]);
      expect(stored.visibility).toBe('private');
    }, 240_000);

    test('get_health most_connected names no page its caller cannot read', async () => {
      expect((await call('admin', 'get_page', { slug: RESTRICTED })).json.code).toBe('page_not_found');
      const remote = await call('admin', 'get_health', {});
      expect(remote.isError).toBe(false);
      const slugs = (remote.json.most_connected as Array<{ slug: string }>).map(e => e.slug);
      expect(slugs).not.toContain(RESTRICTED);
      expect(slugs).not.toContain(PRIVATE);
      const whole = await local('get_health', {});
      expect((whole.json.most_connected as Array<{ slug: string }>).map(e => e.slug)).toContain(RESTRICTED);
    }, 120_000);
  });
}

for (const kind of testBackends()) {
  describe('remote callers and pages they cannot read (' + kind + ', managed repo brain)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-gbra431-' + kind + '-'));
    const root = join(home, 'default-repo');
    const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

    async function call(who: string, op: string, params: Record<string, unknown>): Promise<Call> {
      const auth = await provider().verifyAccessToken(tokens[who]) as unknown as AuthInfo;
      const out = await withEnv(env, () => dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: ['world'] }));
      const text = out.content.map(c => c.text).join('\n');
      return { isError: out.isError === true, text, json: json(text) };
    }
    async function state(slug: string) {
      const [row] = await engine.executeRaw<{ raw: unknown; out_links: number; in_links: number }>(
        `SELECT (SELECT json_agg(r.data ORDER BY r.source) FROM raw_data r JOIN pages p ON p.id=r.page_id WHERE p.slug=$1 AND p.source_id='default') AS raw,
           (SELECT count(*)::int FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.slug=$1 AND p.source_id='default') AS out_links,
           (SELECT count(*)::int FROM links l JOIN pages p ON p.id=l.to_page_id WHERE p.slug=$1 AND p.source_id='default') AS in_links`, [slug]);
      return { ...row, file: git('log', '--format=%H', '-1') };
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      mkdirSync(join(root, 'notes'), { recursive: true });
      git('init', '-q');
      writeFileSync(join(root, OPEN + '.md'), note('Open plan', 'Open planning notes.', ['type: note']));
      writeFileSync(join(root, HUB + '.md'), note('Shared roadmap', 'The shared roadmap.', ['type: note']));
      writeFileSync(join(root, PRIVATE + '.md'), note('Quiet plan', 'Quiet planning notes.', ['type: note', 'visibility: private']));
      git('add', '-A'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'synthetic content');
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
      await withEnv(env, () => claimWorktree(engine, 'default', root));
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      expect((await withEnv(env, () => performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true }))).status).toBe('first_sync');
      await engine.addLink(PRIVATE, HUB, 'roadmap', 'mentions', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' }); // gbrain-allow-direct-insert: test fixture edge
      await engine.putRawData(PRIVATE, 'acme-example', { note: 'fixture' }, { sourceId: 'default' });
      const minted = await mintLegacyToken(engine, { name: 'writer', scopes: ['read', 'write'], takesHolders: ['world'] });
      tokens.writer = minted.token;
    }, 240_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await close?.(); rmSync(home, { recursive: true, force: true }); }, 60_000);

    test('put_raw_data, add_link and remove_link answer a private page exactly as a missing one and change nothing', async () => {
      const before = await state(PRIVATE);
      for (const [label, op, params] of [
        ['put_raw_data', 'put_raw_data', { slug: PRIVATE, source: 'acme-example', data: { note: 'overwritten' } }],
        ['add_link from', 'add_link', { from: PRIVATE, to: OPEN, link_type: 'mentions', request_id: randomUUID() }],
        ['add_link to', 'add_link', { from: OPEN, to: PRIVATE, link_type: 'mentions', request_id: randomUUID() }],
        ['remove_link from', 'remove_link', { from: PRIVATE, to: HUB, request_id: randomUUID() }],
      ] as Array<[string, string, Record<string, unknown>]>) {
        const out = await call('writer', op, params);
        const missing = await call('writer', op, swap(params));
        const strip = (v: Record<string, unknown>) => { const { request_id: _r, ...rest } = v; return rest; };
        expect({ label, isError: out.isError, json: strip(swap(out.json)) }).toEqual({ label, isError: missing.isError, json: strip(missing.json) });
      }
      expect(await state(PRIVATE)).toEqual(before);
    }, 240_000);

    test('extract_entities treats a private source page as a missing one', async () => {
      const text = 'Carol Example met with Dana Example.';
      const shape = (out: Call) => ({ isError: out.isError, code: out.json.code, entities: (out.json.entities as Array<Record<string, unknown>> | undefined)?.map(e => ({ slug: e.slug, action: e.action, backlinkCreated: e.backlinkCreated, timelineAdded: e.timelineAdded })) });
      await call('writer', 'extract_entities', { text, source_slug: MISSING });
      const before = await state(PRIVATE);
      const hidden = await call('writer', 'extract_entities', { text, source_slug: PRIVATE });
      const missing = await call('writer', 'extract_entities', { text, source_slug: MISSING });
      expect(shape(hidden)).toEqual(shape(missing));
      expect({ ...await state(PRIVATE), file: undefined }).toEqual({ ...before, file: undefined });
    }, 240_000);
  });
}
