/**
 * Discussion #8194 (GBRA-575 part 2): the per-credential private-facts grant (`private_facts: granted_sources`).
 *
 * 1. Protects: a remote token or OAuth client whose grant carries `private_facts: granted_sources` (set only by the
 *    local `gbrain auth rescope --private-facts`) reads facts stamped `visibility = 'private'` in the sources its grant
 *    names explicitly, without any stored fact changing; every other remote caller keeps world-only facts. Facts held
 *    on, provenanced from or about a private, reader-restricted or member page stay hidden with the grant on.
 *    `--private-facts none` turns it off on the next request; an upgraded brain starts every credential at none; no MCP
 *    operation or admin HTTP grant edit can set it.
 * 2. Fails when: a private fact reaches a credential at none, a credential with no source grant, a source the grant
 *    does not list (federated, even after the grant is written, or named by the request), another credential, or comes
 *    from a private, readable_by, member or derivation-private page, or has no page to check (no holding page, or a
 *    transcript lane); or the granted credential does not see a private fact on a world page in its granted source; or
 *    the axis or its plain warning is missing from `auth list`, `auth clients`, the help or the rescope output.
 * 3. Existing coverage (repair-open-facts-8194, private-pages-grant) pins world-only facts for every non-owner caller.
 * 4. Real seams: tokens and clients minted and rescoped through the grant service and CLI parsers, verified by the serve
 *    --http verifier, dispatched through MCP dispatch with remote=true; PGLite, and Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { parseRescopeTokenArgs, rescopeLegacyToken } from '../src/core/grants/legacy-token.ts';
import { parseClientRescopeArgs } from '../src/core/grants/cli.ts';
import { readClientGrant, rescopeClientGrant } from '../src/core/grants/service.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { getBrainHotMemoryMeta, __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { operations } from '../src/core/operations.ts';
import { parseAdminGrantRequest } from '../src/commands/serve-http-grants.ts';
import { runAuth } from '../src/commands/auth.ts';
import { runSources } from '../src/commands/sources.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { v319 } from '../src/core/schema-migrations/v319-principal-private-facts.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const GRANTED = 'pf-alpha';
const TEAM = 'pf-team';
const OTHER = 'pf-bravo';
const FED = 'pf-fed';
/** A source created and federated after every grant is written: the floor credential reaches it, no grant lists it. */
const LATE = 'pf-late';
const ENTITY = 'companies/acme-example';

/** The one private fact the switch opens: on a world page in the granted source. */
const OPENS = 'orchardline canary alpha private';
const WORLD = 'orchardline canary alpha world';
const WORLD_FED = 'orchardline canary fed world';
const WORLD_LATE = 'orchardline canary late world';
/** Private facts the switch never opens, by why. */
const CLOSED: Record<string, string> = {
  other_source: 'orchardline canary bravo private',
  federated_source: 'orchardline canary fed private',
  default_source: 'orchardline canary default private',
  private_page: 'orchardline canary held private page',
  readers_page: 'orchardline canary readers page',
  member_page: 'orchardline canary member page',
  derived_page: 'orchardline canary derived private',
  quarantined_page: 'orchardline canary quarantined page',
  unpaged: 'orchardline canary unpaged private',
  transcript_lane: 'orchardline canary transcript lane private',
  late_federated: 'orchardline canary late private',
};
/** The plain warning `auth rescope` prints when the switch turns on. */
const WARNING = 'This key will read every private fact in the sources its grant names, including facts saved private on purpose';

const worldPage = (title: string) => '---\ntype: company\ntitle: ' + title + '\n---\n\n# ' + title + '\n\nOrchardline company page.\n';

async function dbFact(engine: BrainEngine, sourceId: string, fact: string, visibility: 'private' | 'world', holder: string | null, opts: { source?: string; session?: string } = {}): Promise<void> {
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(
    'INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_session, source_markdown_slug) VALUES ($1, $2, $3, \'fact\', $4, $5, $6, $7)', // gbrain-allow-direct-insert: legacy database-only fact fixture
    [sourceId, ENTITY, fact, visibility, opts.source ?? 'mcp:extract_facts', opts.session ?? null, holder]), TEST_WRITE_ATTRIBUTION));
}

for (const kind of testBackends()) {
  describe('private_facts grant axis (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const clients: Record<string, string> = {};
    const setupErrors: string[] = [];

    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const verify = async (token: string) => await provider().verifyAccessToken(token) as unknown as AuthInfo & { privateFacts?: unknown };
    const rescopeToken = async (name: string, ...args: string[]) => rescopeLegacyToken(engine, parseRescopeTokenArgs([name, ...args]));
    const rescopeClient = async (clientId: string, ...args: string[]) =>
      rescopeClientGrant(engine, clientId, parseClientRescopeArgs(clientId, args).patch, { actor: 'test', expectedRevision: (await readClientGrant(engine, clientId)).revision });

    /** One MCP call as serve --http makes it: the verifier's AuthInfo, read live, and the transport's dispatch options. */
    async function call(token: string, op: string, params: Record<string, unknown>, extra: { metaHook?: typeof getBrainHotMemoryMeta; sessionId?: string } = {}): Promise<{ isError: boolean; text: string; meta?: Record<string, unknown> }> {
      __resetPrivateVisibilityCacheForTests();
      const auth = await verify(token);
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}), ...extra,
      });
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n'), meta: (out as { _meta?: Record<string, unknown> })._meta };
    }
    const local = async (op: string, params: Record<string, unknown>) =>
      (await dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId: GRANTED })).content.map(c => c.text).join('\n');
    const reads = (): Array<[string, string, Record<string, unknown>]> => [
      ['recall entity', 'recall', { entity: ENTITY }],
      ['recall query', 'recall', { query: 'orchardline canary' }],
      ['search', 'search', { query: 'orchardline canary', fields: 'full' }],
    ];
    const closedSeen = (text: string) => Object.entries(CLOSED).filter(([, fact]) => text.includes(fact)).map(([why]) => why);

    beforeAll(async () => {
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.setConfig('brain.audience', 'shared');
      for (const id of [GRANTED, TEAM, OTHER]) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
      await engine.executeRaw('INSERT INTO sources (id, name, config) VALUES ($1, $1, \'{"federated": true}\'::jsonb) ON CONFLICT (id) DO NOTHING', [FED]);
      await engine.executeRaw('UPDATE sources SET config = jsonb_set(COALESCE(config, \'{}\'::jsonb), \'{federated}\', \'true\'::jsonb) WHERE id = \'default\'');
      for (const source of [GRANTED, OTHER, FED, 'default']) await importFromContent(engine, ENTITY, worldPage('Acme Example'), { sourceId: source });
      await importFromContent(engine, 'notes/private-src', '---\ntype: note\ntitle: Private source\nvisibility: private\n---\n\n# Private source\n\nPrivate notes.\n', { sourceId: GRANTED });
      await importFromContent(engine, 'notes/readers-only', '---\ntype: note\ntitle: Readers only\nreadable_by: [alice-example]\n---\n\n# Readers only\n\nRestricted notes.\n', { sourceId: GRANTED });
      await importFromContent(engine, 'notes/held-back', worldPage('Held back'), { sourceId: GRANTED });
      await engine.transaction(tx => withCoordinatedWrite(tx, [GRANTED], () => tx.executeRaw(
        `UPDATE pages SET frontmatter = frontmatter || '{"quarantine":{"reason":"junk_pattern","detail":"fixture","assessed_at":"2026-09-01T00:00:00Z"}}'::jsonb WHERE source_id = $1 AND slug = 'notes/held-back'`,
        [GRANTED]), TEST_WRITE_ATTRIBUTION));
      await importFromContent(engine, 'memory/members/alice-example', '---\ntype: note\ntitle: Memory of alice-example\nreadable_by:\n  - member:alice-example\n---\n\n# Memory\n', { sourceId: GRANTED });
      await dbFact(engine, GRANTED, OPENS, 'private', ENTITY);
      await dbFact(engine, GRANTED, WORLD, 'world', ENTITY);
      await dbFact(engine, OTHER, CLOSED.other_source, 'private', ENTITY);
      await dbFact(engine, FED, CLOSED.federated_source, 'private', ENTITY);
      await dbFact(engine, FED, WORLD_FED, 'world', ENTITY);
      await dbFact(engine, 'default', CLOSED.default_source, 'private', ENTITY);
      await dbFact(engine, GRANTED, CLOSED.private_page, 'private', 'notes/private-src');
      await dbFact(engine, GRANTED, CLOSED.readers_page, 'private', 'notes/readers-only');
      await dbFact(engine, GRANTED, CLOSED.member_page, 'private', 'memory/members/alice-example');
      await dbFact(engine, GRANTED, CLOSED.quarantined_page, 'private', 'notes/held-back');
      await dbFact(engine, GRANTED, CLOSED.derived_page, 'private', ENTITY, { source: 'mcp:put_page', session: 'put_page:notes/private-src' });
      await dbFact(engine, GRANTED, CLOSED.unpaged, 'private', null);
      await dbFact(engine, GRANTED, CLOSED.transcript_lane, 'private', ENTITY, { source: 'cli:extract-conversation-facts' });

      const mint = async (name: string, sources?: string[]) => {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], ...(sources ? { sourceGrant: sources } : {}) });
        await readsUnscopedOnPurpose(engine, minted.id);
        tokens[name] = minted.token;
      };
      await mint('facts-bot', [GRANTED, TEAM]);
      await mint('facts-plain', [GRANTED, TEAM]);
      await mint('facts-floor');
      const register = async (name: string, sourceId: string, read: string[]) => {
        const p = provider();
        const { clientId, clientSecret } = await p.registerClientManual(name, ['client_credentials'], 'read', [], sourceId, read);
        await readsUnscopedOnPurpose(engine, clientId, 'client');
        clients[name] = clientId;
        tokens[name] = (await p.exchangeClientCredentials(clientId, clientSecret!)).access_token;
      };
      await register('client-facts', GRANTED, [GRANTED, TEAM]);
      await register('client-plain', GRANTED, [GRANTED, TEAM]);
      for (const step of [() => rescopeToken('facts-bot', '--private-facts', 'granted-sources'), () => rescopeToken('facts-floor', '--private-facts', 'granted-sources'),
        () => rescopeClient(clients['client-facts'], '--private-facts', 'granted-sources')]) {
        await step().catch((e: unknown) => { setupErrors.push(e instanceof Error ? e.message : String(e)); });
      }
    }, 240_000);

    afterAll(async () => {
      resetGateway();
      await disposePersistenceConsumer(engine);
      await close?.();
    }, 60_000);

    test('fixture control: the trusted local caller recalls the private facts; a credential left at none sees only world ones', async () => {
      const all = await local('recall', { entity: ENTITY, source_id: GRANTED });
      expect({ opens: all.includes(OPENS), world: all.includes(WORLD), page: all.includes(CLOSED.private_page), unpaged: all.includes(CLOSED.unpaged), transcript: all.includes(CLOSED.transcript_lane) })
        .toEqual({ opens: true, world: true, page: true, unpaged: true, transcript: true });
      expect(await local('recall', { entity: ENTITY, source_id: FED })).toContain(CLOSED.federated_source);
      for (const who of ['facts-plain', 'client-plain']) {
        for (const [label, op, params] of reads()) {
          const out = await call(tokens[who], op, params);
          expect({ who, label, isError: out.isError, opens: out.text.includes(OPENS), closed: closedSeen(out.text) }).toEqual({ who, label, isError: false, opens: false, closed: [] });
        }
        expect((await call(tokens[who], 'recall', { entity: ENTITY })).text).toContain(WORLD);
      }
    }, 120_000);

    test('the CLI sets the switch: the stored column and the verifier carry it, for the grant sources only', async () => {
      expect(setupErrors).toEqual([]);
      const rows = await engine.executeRaw<{ name: string; private_facts: string }>("SELECT name, private_facts FROM access_tokens WHERE name LIKE 'facts-%' ORDER BY name");
      expect(rows.map(r => [r.name, r.private_facts])).toEqual([['facts-bot', 'granted_sources'], ['facts-floor', 'granted_sources'], ['facts-plain', 'none']]);
      expect((await verify(tokens['facts-bot'])).privateFacts).toEqual({ mode: 'granted_sources', sources: [GRANTED, TEAM] });
      expect((await verify(tokens['client-facts'])).privateFacts).toEqual({ mode: 'granted_sources', sources: [GRANTED, TEAM] });
      for (const who of ['facts-plain', 'client-plain', 'facts-floor']) expect({ who, pf: (await verify(tokens[who])).privateFacts }).toEqual({ who, pf: undefined });
      const [stored] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE fact LIKE 'orchardline canary%' AND visibility = 'private'");
      expect(stored.n).toBe(11);
    });

    test('with the switch on, recall and search read the private fact on a world page in the granted source, and nothing it must not', async () => {
      for (const who of ['facts-bot', 'client-facts']) {
        for (const [label, op, params] of reads()) {
          const out = await call(tokens[who], op, params);
          expect({ who, label, isError: out.isError, opens: out.text.includes(OPENS), closed: closedSeen(out.text) }).toEqual({ who, label, isError: false, opens: true, closed: [] });
        }
      }
    }, 120_000);

    test('facts with no page to check stay hidden with the switch on: an unpaged fact and a transcript-lane fact with a holding page', async () => {
      for (const who of ['facts-bot', 'client-facts']) {
        for (const [label, op, params] of reads()) {
          const out = await call(tokens[who], op, params);
          expect({ who, label, opens: out.text.includes(OPENS), unpaged: out.text.includes(CLOSED.unpaged), transcript: out.text.includes(CLOSED.transcript_lane) })
            .toEqual({ who, label, opens: true, unpaged: false, transcript: false });
        }
      }
    }, 120_000);

    test('the page exclusions are the grant\'s own: they hold with the remote privacy hatch on, which relaxes only private pages', async () => {
      await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
        const bot = await call(tokens['facts-bot'], 'recall', { entity: ENTITY });
        expect({ opens: bot.text.includes(OPENS), closed: closedSeen(bot.text) }).toEqual({ opens: true, closed: [] });
        const plain = await call(tokens['facts-plain'], 'recall', { entity: ENTITY });
        expect({ opens: plain.text.includes(OPENS), closed: closedSeen(plain.text) }).toEqual({ opens: false, closed: [] });
      });
    }, 120_000);

    test('the hot-memory cache never serves a payload read under the grant to a credential without it', async () => {
      const hot = async (who: string) => JSON.stringify((await call(tokens[who], 'search', { query: 'orchardline canary', fields: 'full' }, { metaHook: getBrainHotMemoryMeta, sessionId: 'pf-hot-session' })).meta?.brain_hot_memory ?? null);
      __resetHotMemoryCacheForTests();
      const cold = await hot('facts-plain');
      __resetHotMemoryCacheForTests();
      const granted = await hot('facts-bot');
      const plain = await hot('facts-plain');
      __resetHotMemoryCacheForTests();
      expect({ cold: cold.includes(OPENS), granted: granted.includes(OPENS), plain: plain.includes(OPENS), closed: closedSeen(granted + plain) }).toEqual({ cold: false, granted: true, plain: false, closed: [] });
      expect(plain).toBe(cold);
    }, 120_000);

    test('another credential with the same sources and no switch is unaffected', async () => {
      for (const who of ['facts-plain', 'client-plain']) {
        const out = await call(tokens[who], 'recall', { entity: ENTITY });
        expect({ who, opens: out.text.includes(OPENS), world: out.text.includes(WORLD) }).toEqual({ who, opens: false, world: true });
      }
    }, 120_000);

    test('a source the grant does not name stays closed, even when the request names it', async () => {
      for (const args of [{ source_id: OTHER }, { source_ids: [OTHER] }, { source_ids: [FED] }, { source_id: 'default' }]) {
        const out = await call(tokens['facts-bot'], 'recall', { entity: ENTITY, ...args });
        expect({ args, closed: closedSeen(out.text), opens: out.text.includes(OPENS) }).toEqual({ args, closed: [], opens: false });
      }
      const team = await call(tokens['facts-bot'], 'recall', { entity: ENTITY, source_ids: [TEAM] });
      expect(team.text).not.toContain(OPENS);
    }, 120_000);

    test('a source the credential reaches but its grant does not list never opens, though federated after the grant is written', async () => {
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [LATE]);
      await importFromContent(engine, ENTITY, worldPage('Acme Example'), { sourceId: LATE });
      await dbFact(engine, LATE, CLOSED.late_federated, 'private', ENTITY);
      await dbFact(engine, LATE, WORLD_LATE, 'world', ENTITY);
      await runSources(engine, ['federate', LATE]);
      const [config] = await engine.executeRaw<{ federated: unknown }>("SELECT config->'federated' AS federated FROM sources WHERE id = $1", [LATE]);
      expect(String(config.federated)).toBe('true');
      expect(await local('recall', { entity: ENTITY, source_id: LATE })).toContain(CLOSED.late_federated);
      expect((await verify(tokens['facts-bot'])).privateFacts).toEqual({ mode: 'granted_sources', sources: [GRANTED, TEAM] });
      expect((await verify(tokens['client-facts'])).privateFacts).toEqual({ mode: 'granted_sources', sources: [GRANTED, TEAM] });
      expect((await verify(tokens['facts-floor'])).privateFacts).toBeUndefined();
      const reached = await call(tokens['facts-floor'], 'recall', { entity: ENTITY, source_ids: [LATE] });
      expect({ reached: reached.text.includes(WORLD_LATE), closed: closedSeen(reached.text) }).toEqual({ reached: true, closed: [] });
      for (const who of ['facts-floor', 'facts-bot', 'client-facts']) {
        for (const [label, op, params] of [...reads(), ['recall late', 'recall', { entity: ENTITY, source_ids: [LATE] }] as [string, string, Record<string, unknown>]]) {
          const out = await call(tokens[who], op, params);
          expect({ who, label, closed: closedSeen(out.text) }).toEqual({ who, label, closed: [] });
        }
      }
      for (const who of ['facts-bot', 'client-facts']) expect((await call(tokens[who], 'recall', { entity: ENTITY })).text).toContain(OPENS);
    }, 120_000);

    test('a credential with no source grant gets nothing from the switch, in default or a federated source it reads', async () => {
      for (const args of [{}, { source_ids: [FED] }, { source_id: 'default' }]) {
        const out = await call(tokens['facts-floor'], 'recall', { entity: ENTITY, ...args });
        expect({ args, isError: out.isError, closed: closedSeen(out.text), opens: out.text.includes(OPENS) }).toEqual({ args, isError: false, closed: [], opens: false });
      }
      expect((await call(tokens['facts-floor'], 'recall', { entity: ENTITY, source_ids: [FED] })).text).toContain(WORLD_FED);
      const search = await call(tokens['facts-floor'], 'search', { query: 'orchardline canary', fields: 'full' });
      expect(closedSeen(search.text)).toEqual([]);
    }, 120_000);

    test('--private-facts none turns it off on the next request (token and client)', async () => {
      expect((await call(tokens['facts-bot'], 'recall', { entity: ENTITY })).text).toContain(OPENS);
      await rescopeToken('facts-bot', '--private-facts', 'none');
      await rescopeClient(clients['client-facts'], '--private-facts', 'none');
      try {
        for (const who of ['facts-bot', 'client-facts']) {
          for (const [label, op, params] of reads()) {
            const out = await call(tokens[who], op, params);
            expect({ who, label, opens: out.text.includes(OPENS) }).toEqual({ who, label, opens: false });
          }
        }
      } finally {
        await rescopeToken('facts-bot', '--private-facts', 'granted-sources');
        await rescopeClient(clients['client-facts'], '--private-facts', 'granted-sources');
      }
      expect((await call(tokens['facts-bot'], 'recall', { entity: ENTITY })).text).toContain(OPENS);
    }, 120_000);

    test('no MCP operation or admin HTTP grant edit can set it', async () => {
      const exposing = operations.filter(op => Object.keys(op.params ?? {}).some(k => /private_?facts/i.test(k))).map(op => op.name);
      expect(exposing).toEqual([]);
      const before = await readClientGrant(engine, clients['client-plain']);
      const parsed = parseAdminGrantRequest({ clientId: clients['client-plain'], privateFacts: 'granted_sources', private_facts: 'granted_sources', scopes: 'read' }, before);
      expect(Object.keys(parsed.patch)).not.toContain('privateFacts');
      const out = await call(tokens['client-plain'], 'recall', { entity: ENTITY, private_facts: 'granted_sources' });
      expect(out.text).not.toContain(OPENS);
      const [row] = await engine.executeRaw<{ private_facts: string }>('SELECT private_facts FROM oauth_clients WHERE client_id = $1', [clients['client-plain']]);
      expect(row.private_facts).toBe('none');
    });
  });
}

describe('private_facts migration and operator output', () => {
  let root: string, home: string, db: string;
  const env = () => ({ GBRAIN_HOME: home, HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined });
  const GRANTED_LABEL = 'granted-sources (private facts in the sources this grant names)';
  async function withBrain<T>(run: (engine: BrainEngine) => Promise<T>): Promise<T> {
    const config = { engine: 'pglite' as const, database_path: db };
    const engine = await createEngine(config);
    await engine.connect(config);
    try { return await run(engine); } finally { await engine.disconnect(); }
  }
  async function auth(args: string[]): Promise<string> {
    const lines: string[] = [];
    const original = console.log;
    const exit = process.exit;
    console.log = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`auth exited ${code}`); }) as typeof process.exit;
    try { await withEnv(env(), () => runAuth(args)); } finally { console.log = original; process.exit = exit; }
    return lines.join('\n');
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gb-private-facts-'));
    home = join(root, 'home');
    db = join(root, 'db');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: db }));
    await withBrain(async engine => {
      await engine.initSchema();
      await mintLegacyToken(engine, { name: 'alice-example', scopes: ['read'], takesHolders: ['world'], sourceGrant: ['default'] });
      await mintLegacyToken(engine, { name: 'bob-example', scopes: ['read'], takesHolders: ['world'], sourceGrant: ['default'] });
      await engine.executeRaw("INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read) VALUES ('client-a', 'client-a', 'read', 'default', ARRAY['default'])");
    });
  }, 120_000);
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  test('the migration on an existing brain leaves every token and client at none', async () => {
    await withBrain(async engine => {
      await engine.executeRaw('ALTER TABLE access_tokens DROP COLUMN IF EXISTS private_facts');
      await engine.executeRaw('ALTER TABLE oauth_clients DROP COLUMN IF EXISTS private_facts');
      // Value: protects=before the migration, --private-facts on a client or token refuses grant_schema_required and writes nothing; fails_when=the column guard or schemaError mapping is removed; why_new=no test drove a rescope on a brain without the column; seam=none; no_claim=Postgres error codes (PGLite only)
      const clientRefusal = await rescopeClientGrant(engine, 'client-a', { privateFacts: 'granted_sources' }, { actor: 'test' }).then(() => null, (e: { code?: string }) => e);
      expect(clientRefusal?.code).toBe('grant_schema_required');
      const tokenRefusal = await rescopeLegacyToken(engine, parseRescopeTokenArgs(['alice-example', '--private-facts', 'granted-sources'])).then(() => null, (e: { code?: string }) => e);
      expect(tokenRefusal?.code).toBe('grant_schema_required');
      await engine.setConfig('version', String(v319.version - 1));
      await runMigrations(engine);
      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      const tokens = await engine.executeRaw<{ private_facts: string }>('SELECT private_facts FROM access_tokens');
      const clients = await engine.executeRaw<{ private_facts: string }>('SELECT private_facts FROM oauth_clients');
      expect(tokens.map(r => r.private_facts)).toEqual(['none', 'none']);
      expect(clients.map(r => r.private_facts)).toEqual(['none']);
      await expect(engine.executeRaw("UPDATE access_tokens SET private_facts = 'all'")).rejects.toThrow();
    });
  }, 120_000);

  test('auth rescope prints the before and after for a token and a client; auth list and auth clients show it', async () => {
    const token = await auth(['rescope', '--token', 'alice-example', '--private-facts', 'granted-sources']);
    expect(token).toContain('  Private facts: none -> ' + GRANTED_LABEL);
    expect(token).toContain(WARNING);
    const client = await auth(['rescope', '--client', 'client-a', '--private-facts', 'granted-sources', '--dry-run']);
    expect(client).toContain('  Private facts: none -> ' + GRANTED_LABEL);
    expect(client).toContain(WARNING);
    const help = (await auth(['--help'])).replace(/\s+/g, ' ');
    expect(help).toContain('including facts saved private on purpose');
    expect(help).toContain('a fact with no page to check');
    await auth(['rescope', '--client', 'client-a', '--private-facts', 'granted-sources']);
    const listed = JSON.parse(await auth(['list', '--json'])) as Array<Record<string, unknown>>;
    expect(Object.fromEntries(listed.map(t => [t.name, t.private_facts]))).toEqual({ 'alice-example': 'granted_sources', 'bob-example': 'none' });
    const text = await auth(['list']);
    expect(text.split('\n')[0]).toContain('Private facts');
    expect(text.split('\n').find(l => l.includes('alice-example'))).toMatch(/active\s+granted-sources\s+none$/);
    expect(text.split('\n').find(l => l.includes('bob-example'))).toMatch(/active\s+none\s+none$/);
    const clients = await auth(['clients']);
    expect(clients).toContain('  private facts: ' + GRANTED_LABEL);
    const json = JSON.parse(await auth(['clients', '--json'])) as { clients: Array<{ client_id: string; private_facts: string }> };
    expect(json.clients.find(c => c.client_id === 'client-a')?.private_facts).toBe('granted_sources');
    const off = await auth(['rescope', '--token', 'alice-example', '--private-facts', 'none']);
    expect(off).toContain('  Private facts: ' + GRANTED_LABEL + ' -> none');
    expect(off).not.toContain(WARNING);
  }, 120_000);
});
