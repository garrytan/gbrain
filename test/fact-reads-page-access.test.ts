/**
 * Fact, timeline, tag and observation reads follow the page they are about.
 *
 * 1. Protects: a fact, timeline entry, tag or ontology observation is never wider than its page. A remote caller who
 *    cannot read a page (it names readers the caller is not among, or it is visibility: private) gets nothing about it
 *    from any fact read, even when the observation itself is world-visible. A soft-deleted page's facts, timeline and
 *    tags are hidden from every caller, local included, until restore_page brings them back unchanged. A new page
 *    written over the deleted one takes its tags from its own content; it hides and expires none of the old facts.
 * 2. Fails when: a world observation about a restricted or private page reaches a caller who cannot read that page
 *    (ontology_get, volunteer_chronicle, delta, find_trajectory, recall, hot memory); a deleted page's facts, timeline
 *    or tags come back from recall, get_timeline, get_tags, ontology_get, find_trajectory, volunteer_chronicle, delta or
 *    the entity card; a restore changes its facts; a new page at the slug shows the old page's tags; or a fact row is
 *    deleted or expired instead of hidden.
 * 3. Existing coverage: member-read-access pins page reads and facts held on a restricted page (provenance), not facts
 *    about one held elsewhere; pages-soft-delete pins the page row only.
 * 4. Real seams: tokens minted by the token service and verified by the serve --http verifier, dispatched through MCP
 *    dispatch; writes through the persistence coordinator; a repo-less source and a managed brain; embeddings stubbed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { parseRescopeTokenArgs, rescopeLegacyToken } from '../src/core/grants/legacy-token.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { getBrainHotMemoryMeta } from '../src/core/facts/meta-hook.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain } from './helpers/managed-brain.ts';

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

type Out = { isError: boolean; text: string };
const textOf = (out: { isError?: boolean; content: Array<{ text: string }>; _meta?: Record<string, unknown> }): Out => ({
  isError: out.isError === true,
  text: out.content.map(c => c.text).join('\n') + (out._meta?.brain_hot_memory ? `\n${JSON.stringify(out._meta.brain_hot_memory)}` : ''),
});

/** One engine and source, with local and token-authenticated remote callers through MCP dispatch. */
function callers(engine: () => BrainEngine, source: string) {
  const tokens: Record<string, string> = {};
  const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine()), transaction: fn => engine().transaction(tx => fn(sqlQueryForEngine(tx))) });
  return {
    tokens,
    async local(op: string, params: Record<string, unknown>): Promise<Out> {
      return textOf(await dispatchToolCall(engine(), op, { ...params }, { remote: false, sourceId: source }) as never);
    },
    async write(op: string, params: Record<string, unknown>): Promise<string> {
      const out = textOf(await dispatchToolCall(engine(), op, { ...params }, { remote: false, sourceId: source }) as never);
      if (out.isError) throw new Error(`fixture ${op}: ${out.text}`);
      return out.text;
    },
    async remote(who: string, op: string, params: Record<string, unknown>): Promise<Out> {
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine(), auth.hasSourceGrant, sourceId);
      return textOf(await dispatchToolCall(engine(), op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        metaHook: getBrainHotMemoryMeta, sessionId: `fact-reads-${who}`,
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      }) as never);
    },
    async mint(name: string, member?: string) {
      const minted = await mintLegacyToken(engine(), { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [source] });
      tokens[name] = minted.token;
      if (member) await engine().executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
    },
  };
}

/** Every fact, timeline, tag and observation read that answers about `slug`, with arguments that reach it. */
function factReads(slug: string): Array<[string, string, Record<string, unknown>]> {
  return [
    ['recall entity', 'recall', { entity: slug }],
    ['recall since', 'recall', { since: '2000-01-01' }],
    ['recall question', 'recall', { question: 'harbor canary' }],
    ['ontology_get', 'ontology_get', { entity: slug }],
    ['volunteer_chronicle', 'volunteer_chronicle', { entities: slug, days: 36500 }],
    ['delta', 'delta', { since: '2000-01-01' }],
    ['find_trajectory', 'find_trajectory', { entity_slug: slug }],
    ['entity card', 'entity', { name: slug }],
    ['get_timeline', 'get_timeline', { slug }],
    ['get_tags', 'get_tags', { slug }],
  ];
}

const PAGES = {
  restricted: { slug: 'people/vesper-example', fm: 'readable_by: [alice-example]', canary: 'canaryobsrestricted' },
  private: { slug: 'people/quiet-example', fm: 'visibility: private', canary: 'canaryobsprivate' },
  open: { slug: 'people/open-example', fm: '', canary: 'canaryobsopen' },
} as const;
type PageKey = keyof typeof PAGES;

for (const kind of testBackends()) {
  describe(`an observation is never wider than the page it is about (${kind}, repo-less)`, () => {
    const SRC = 'source-a';
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const c = callers(() => engine, SRC);

    /** Which pages' world observations `who` sees on each fact read (a reader that echoes the slug counts only the canary). */
    async function visibleTo(who: string): Promise<Record<string, PageKey[]>> {
      const seen: Record<string, PageKey[]> = {};
      for (const key of Object.keys(PAGES) as PageKey[]) {
        for (const [label, op, params] of factReads(PAGES[key].slug)) {
          if (label === 'get_timeline' || label === 'get_tags') continue;
          const { text } = who === 'local' ? await c.local(op, params) : await c.remote(who, op, params);
          if (text.includes(PAGES[key].canary)) (seen[label] ??= []).push(key);
        }
      }
      return seen;
    }

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({ engine: 'pglite' } as never);
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const key of Object.keys(PAGES) as PageKey[]) {
        const { slug, fm, canary } = PAGES[key];
        await importFromContent(engine, slug, ['---', 'type: person', `title: ${key} person`, ...(fm ? [fm] : []), '---', `# ${key} person`, '', 'Person notes.'].join('\n'), { sourceId: SRC });
        // A world observation held on no page (provenance 'manual'): only the entity page can gate it.
        await c.write('ontology_propose', { entity: slug, dimension: 'employer', value: `harbor ${canary}`, confidence: 0.9, visibility: 'world' });
      }
      for (const id of ['alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      await c.mint('reader');
      await c.mint('bob', 'bob-example');
      await c.mint('alice', 'alice-example');
      await c.mint('alice-granted', 'alice-example');
      await rescopeLegacyToken(engine, parseRescopeTokenArgs(['alice-granted', '--private-pages', 'granted-sources']));
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('an unbound token and an unlisted member get no observation about a restricted or private page; the open page still answers', async () => {
      for (const who of ['reader', 'bob']) {
        const seen = await visibleTo(who);
        for (const [label, keys] of Object.entries(seen)) expect({ who, label, keys }).toEqual({ who, label, keys: ['open'] });
        for (const label of ['ontology_get', 'find_trajectory', 'recall entity']) expect({ who, label, keys: seen[label] }).toEqual({ who, label, keys: ['open'] });
      }
    }, 240_000);

    test('a listed member reads the restricted page\'s observations, and a private_pages grant opens the private one', async () => {
      const alice = await visibleTo('alice');
      expect(alice['ontology_get']).toEqual(['restricted', 'open']);
      for (const keys of Object.values(alice)) expect(keys).not.toContain('private');
      const granted = await visibleTo('alice-granted');
      expect(granted['ontology_get']).toEqual(['restricted', 'private', 'open']);
    }, 240_000);

    test('a trusted local caller keeps every observation', async () => {
      const local = await visibleTo('local');
      for (const label of ['ontology_get', 'find_trajectory', 'recall entity']) expect({ label, keys: local[label] }).toEqual({ label, keys: ['restricted', 'private', 'open'] });
    }, 240_000);
  });

  /** Seeds one page with a fact, a tag, a timeline entry and a world observation, then deletes, restores and replaces it. */
  async function deletedPageScenario(engine: BrainEngine, source: string, remoteReader: boolean) {
    const c = callers(() => engine, source);
    const slug = 'people/carol-example';
    const old = { fact: 'canaryoldfact', tag: 'canary-old-tag', tl: 'canaryoldtimeline', obs: 'canaryoldobs' };
    const canaries = Object.values(old);
    const revision = async () => (JSON.parse(await c.write('get_page', { slug, include_deleted: true })) as { revision: string }).revision;
    const rows = () => engine.executeRaw<{ id: number; fact: string; expired_at: unknown; row_num: number | null }>(
      'SELECT id::int AS id, fact, expired_at, row_num FROM facts WHERE source_id = $1 AND entity_slug = $2 ORDER BY id', [source, slug]);
    if (remoteReader) await c.mint('reader');
    /** The reads that still mention one of the old canaries, local and (when minted) remote. */
    const leaks = async (): Promise<string[]> => {
      const out: string[] = [];
      for (const [label, op, params] of factReads(slug)) {
        const reads: Array<[string, Out]> = [['local', await c.local(op, params)]];
        if (remoteReader) reads.push(['remote', await c.remote('reader', op, params)]);
        for (const [who, { text }] of reads) for (const canary of canaries) if (text.includes(canary)) out.push(`${who} ${label}: ${canary}`);
      }
      if (remoteReader) {
        const hot = await c.remote('reader', 'get_tags', { slug: 'people/other-example' });
        for (const canary of canaries) if (hot.text.includes(canary)) out.push(`remote hot memory: ${canary}`);
      }
      return out.sort();
    };

    await c.write('put_page', { slug: 'people/other-example', content: '---\ntype: person\ntitle: Other Example\n---\n# Other Example\n\nAn unrelated page.' });
    await c.write('put_page', { slug, content: `---\ntype: person\ntitle: Carol Example\ntags: [${old.tag}]\n---\n# Carol Example\n\nCarol notes.` });
    await c.write('remember', { fact: `Carol Example harbor ${old.fact}`, entity: slug, provenance: 'fixture', visibility: 'world' });
    await c.write('add_timeline_entry', { slug, date: '2026-01-02', summary: `Met Carol ${old.tl}` });
    await c.write('ontology_propose', { entity: slug, dimension: 'employer', value: `harbor ${old.obs}`, confidence: 0.9, visibility: 'world' });
    const before = await rows();
    const live = await leaks();
    for (const label of ['recall entity', 'get_timeline', 'get_tags', 'ontology_get']) expect(live.some(l => l.startsWith(`local ${label}:`))).toBe(true);

    await c.write('delete_page', { slug, expected_revision: await revision() });
    expect(await leaks()).toEqual([]);

    await c.write('restore_page', { slug, expected_revision: await revision() });
    expect(await rows()).toEqual(before);
    expect(await leaks()).toEqual(live);

    await c.write('delete_page', { slug, expected_revision: await revision() });
    await c.write('put_page', { slug, expected_revision: await revision(),
      content: '---\ntype: person\ntitle: Carol Two\ntags: [new-tag]\n---\n# Carol Two\n\nA different page. canarynewpage' });
    const replaced = await leaks();
    expect(replaced.filter(l => l.includes(old.tag))).toEqual([]);
    expect(replaced).toContain(`local recall entity: ${old.fact}`);
    expect((await c.local('get_tags', { slug })).text).toContain('new-tag');
    expect((await c.local('get_page', { slug })).text).toContain('canarynewpage');
    expect(await rows()).toEqual(before);
  }

  describe(`a deleted page takes its facts, timeline and tags with it (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({ engine: 'pglite' } as never);
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
    }, 240_000);
    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await close?.(); }, 60_000);

    test('repo-less source: hidden while deleted for local and remote readers, back unchanged on restore, tags not inherited by a new page', async () => {
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT (id) DO NOTHING");
      await deletedPageScenario(engine, 'source-b', true);
    }, 240_000);

    test('managed source: the same', async () => {
      await managedBrain(async ({ engine }) => {
        __resetPrivateVisibilityCacheForTests();
        await deletedPageScenario(engine, 'default', true);
      }, kind === 'postgres' ? { databaseUrl: process.env.DATABASE_URL! } : {});
    }, 240_000);

    test('managed source: an unbound token gets no observation about a restricted page', async () => {
      await managedBrain(async ({ engine }) => {
        __resetPrivateVisibilityCacheForTests();
        const c = callers(() => engine, 'default');
        await c.mint('reader');
        for (const key of ['restricted', 'open'] as const) {
          const { slug, fm, canary } = PAGES[key];
          await c.write('put_page', { slug, content: ['---', 'type: person', `title: ${key} person`, ...(fm ? [fm] : []), '---', `# ${key} person`, '', 'Person notes.'].join('\n') });
          await c.write('ontology_propose', { entity: slug, dimension: 'employer', value: `harbor ${canary}`, confidence: 0.9, visibility: 'world' });
        }
        const seen: string[] = [];
        for (const key of ['restricted', 'open'] as const) {
          for (const [label, op, params] of factReads(PAGES[key].slug)) {
            if ((await c.remote('reader', op, params)).text.includes(PAGES[key].canary)) seen.push(`${key} ${label}`);
            if (key === 'restricted') expect((await c.local(op, params)).isError).toBe(false);
          }
        }
        expect(seen.filter(s => s.startsWith('restricted'))).toEqual([]);
        expect(seen).toContain('open ontology_get');
        expect((await c.local('ontology_get', { entity: PAGES.restricted.slug })).text).toContain(PAGES.restricted.canary);
      }, kind === 'postgres' ? { databaseUrl: process.env.DATABASE_URL! } : {});
    }, 240_000);
  });
}
