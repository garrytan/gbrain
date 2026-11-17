/**
 * GST-2891: a private fact restated as world is stored private until the owner accepts the widening (#9196 for a
 * put_page fence row, GST-2875 for remember), but the page body kept the world cell, so get_page, fetch, search and
 * the rest handed the restatement to callers who cannot read the private row. These tests pin, on PGLite and Postgres,
 * on a repo brain and a repo-less one: a caller whose fact reads are world-only never reads a held row's text, the
 * owner's callers and the local CLI still read it, a re-derive keeps the row private, a member still reads their own
 * member page, and accept / reject / undo keep working.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { memberPageFrontmatter, memberPageSlug } from '../src/core/access/member-facts.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { dropHeldFenceRows } from '../src/core/eligibility/stamp.ts';
import { withCoordinatedWrite, withTrustPromotion } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { decideTrustProposal } from '../src/core/trust/decide.ts';
import { parseTrustProposalRef } from '../src/core/trust/proposals.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const DIMS = 1536;
function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % DIMS] += 1; }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}
const row = (n: number, claim: string, visibility = 'world') => ({ rowNum: n, claim, kind: 'fact', confidence: 1, visibility, notability: 'medium', active: true });
const pageText = (title: string, rows: ReturnType<typeof row>[], prose = 'Profile.') =>
  '---\ntype: person\ntitle: ' + title + '\n---\n# ' + title + '\n\n' + prose + '\n\n## Facts\n\n' + renderFactsTable(rows as never) + '\n';
const OWNER = 'owner-example';
const BOB = 'bob-example';
/** The remember path (GST-2875), the put_page path (#9196), and on a repo brain a private copy nobody confirmed. */
const LIA = { slug: 'people/lia-example', title: 'Lia Example', claim: 'Lia keeps bees zebracornheld', canary: 'zebracornheld' };
const KIM = { slug: 'people/kim-example', title: 'Kim Example', claim: 'Kim keeps bees quokkaheld', canary: 'quokkaheld' };
const MAX = { slug: 'people/max-example', title: 'Max Example', claim: 'Max keeps bees okapiheld', canary: 'okapiheld' };
type Held = typeof LIA;
const turin = (p: Held) => p.title.split(' ')[0] + ' lives in Turin';
const seed = (p: Held) => pageText(p.title, [row(1, turin(p)), row(2, p.claim, 'private')]);

for (const kind of testBackends()) for (const shape of ['repo', 'repo-less'] as const) {
  describe('GST-2891 held rows on page reads (' + kind + ', ' + shape + ')', () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    const home = mkdtempSync(join(tmpdir(), 'gst2891-'));
    const root = join(home, 'repo');
    const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: 'test' };
    const tokens: Record<string, string> = {};
    const refs: Record<string, number> = {};
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const commit = () => { git('add', '-A'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'synthetic'); };
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    async function call(who: string, op: string, params: Record<string, unknown>): Promise<string> {
      __resetPrivateVisibilityCacheForTests();
      if (who === 'local') return (await withEnv(env, () => dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId: 'default' }))).content.map(c => c.text).join('\n');
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const o = await withEnv(env, () => dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: ['world'] }));
      return o.content.map(c => c.text).join('\n');
    }
    const confirmAll = async (slug: string) => {
      for (const r of await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', ['default', slug]))
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw("UPDATE facts SET trust_tier='user_confirmed' WHERE id=$1", [r.id])), TEST_WRITE_ATTRIBUTION));
    };
    const stored = async (claim: string) => (await engine.executeRaw<{ visibility: string }>(
      'SELECT visibility FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL ORDER BY id', ['default', claim])).map(r => r.visibility);
    const pages: Held[] = shape === 'repo' ? [LIA, KIM, MAX] : [LIA, KIM];
    const reads = (p: Held): Array<[string, string, Record<string, unknown>]> => [
      ['get_page', 'get_page', { slug: p.slug }],
      ['get_page include_content', 'get_page', { slug: p.slug, include_content: true }],
      ['get_page lines', 'get_page', { slug: p.slug, lines: { from: 1, count: 200 } }],
      ['get_page grep', 'get_page', { slug: p.slug, grep: 'keeps bees' }],
      ['get_page section', 'get_page', { slug: p.slug, section: 'Facts' }],
      ['get_page outline', 'get_page', { slug: p.slug, body: 'outline' }],
      ['fetch', 'fetch', { id: p.slug }],
      ['search keyword', 'search', { query: p.canary, match: 'keyword', fields: 'full', limit: 20 }],
      ['search', 'search', { query: 'keeps bees ' + p.canary, fields: 'full', limit: 20 }],
      ['query', 'query', { query: 'keeps bees ' + p.canary, expand: false, fields: 'full', limit: 20 }],
      ['search_exact', 'search_exact', { phrase: p.canary }],
      ['get_chunks', 'get_chunks', { slug: p.slug }],
      ['entity', 'entity', { name: p.slug }],
    ];
    /** A read's text without the request it echoes back (search_exact's phrase). */
    const shown = (label: string, t: string) => (label === 'search_exact' ? t.replace(/"phrase":"[^"]*"/, '') : t);

    beforeAll(async () => withEnv(env, async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await registerLocalWriter(engine, 'cli');
      if (shape === 'repo') {
        mkdirSync(join(root, 'people'), { recursive: true });
        git('init', '-q');
        for (const p of pages) writeFileSync(join(root, p.slug + '.md'), seed(p));
        commit();
        await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
        await claimWorktree(engine, 'default', root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
      } else {
        for (const p of pages) await call('local', 'put_page', { slug: p.slug, content: seed(p), request_id: randomUUID() });
      }
      await confirmAll(LIA.slug); await confirmAll(KIM.slug);
      for (const id of [OWNER, BOB]) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      const mint = async (name: string, member?: string, scopes = ['read']) => {
        const m = await mintLegacyToken(engine, { name, scopes, takesHolders: ['world'] });
        tokens[name] = m.token;
        if (member) await bindCredential(engine, { kind: 'token', id: m.id }, { member }); else await readsUnscopedOnPurpose(engine, m.id);
      };
      await mint('owner', OWNER); await mint('bob', BOB); await mint('unbound'); await mint('writer', undefined, ['read', 'write']);
      await setOwner(engine, OWNER);
      for (const p of shape === 'repo' ? [LIA, MAX] : [LIA]) {
        const res = await call('writer', 'remember', { fact: p.claim, provenance: 'chat', entity: p.slug, request_id: randomUUID() });
        refs[p.slug] = parseTrustProposalRef(res.match(/tp\d+/)![0])!;
      }
      const cur = JSON.parse(await call('writer', 'get_page', { slug: KIM.slug, include_content: true }));
      await call('writer', 'put_page', { slug: KIM.slug, content: pageText(KIM.title, [row(1, turin(KIM)), row(2, KIM.claim)]), expected_revision: cur.revision, request_id: randomUUID() });
      refs[KIM.slug] = Number((await engine.executeRaw<{ id: number }>("SELECT id::int AS id FROM trust_proposals WHERE status='pending' ORDER BY id DESC LIMIT 1"))[0]!.id);
    }), 300_000);
    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await disposePersistenceConsumer(engine); await close?.(); rmSync(home, { recursive: true, force: true }); }, 60_000);

    test('the restatement is stored private with a pending widening while the page body carries a world cell', async () => {
      const cell = (p: Held) => new RegExp(p.canary + ' \\| fact \\| 1\\.0 \\| world');
      for (const p of pages) {
        expect(await stored(p.claim)).not.toContain('world');
        expect((await engine.executeRaw<{ status: string }>('SELECT status FROM trust_proposals WHERE id=$1', [refs[p.slug]]))[0]?.status).toBe('pending');
        expect(await call('local', 'get_page', { slug: p.slug, include_content: true })).toMatch(cell(p));
      }
      if (shape === 'repo') expect(readFileSync(join(root, KIM.slug + '.md'), 'utf8')).toMatch(cell(KIM));
    }, 120_000);

    test('a caller who cannot read the private row reads no held text; the owner and the local CLI still do', async () => {
      for (const p of pages) for (const [label, op, params] of reads(p)) for (const who of ['bob', 'unbound']) {
        const leaks = shown(label, await call(who, op, params)).includes(p.canary);
        expect({ who, label, slug: p.slug, leaks }).toEqual({ who, label, slug: p.slug, leaks: false });
      }
      for (const p of pages) for (const who of ['bob', 'unbound']) {
        expect(await call(who, 'get_page', { slug: p.slug, include_content: true })).toContain(turin(p));
        expect(await call(who, 'search', { query: turin(p), match: 'keyword', fields: 'full', limit: 20 })).toContain(turin(p) + ' | fact');
      }
      for (const p of pages) for (const who of ['local', 'owner']) for (const label of ['get_page include_content', 'fetch', 'search keyword', 'search_exact', 'get_chunks']) {
        const [, op, params] = reads(p).find(r => r[0] === label)!;
        const shows = shown(label, await call(who, op, params)).includes(p.canary);
        expect({ who, label, slug: p.slug, shows }).toEqual({ who, label, slug: p.slug, shows: true });
      }
    }, 300_000);

    test('a window around any chunk of the page holds no held text for such a caller', async () => {
      for (const p of pages) {
        const chunks = await engine.executeRaw<{ id: number }>('SELECT c.id::int AS id FROM content_chunks c JOIN pages pg ON pg.id=c.page_id WHERE pg.slug=$1 ORDER BY c.id', [p.slug]);
        expect(chunks.length).toBeGreaterThan(0);
        for (const c of chunks) for (const who of ['bob', 'unbound']) expect(await call(who, 'get_page', { slug: p.slug, around_chunk_id: c.id })).not.toContain(p.canary);
      }
    }, 120_000);

    test('a chunk boundary that cuts a held row leaves none of its text behind', async () => {
      const kept = await dropHeldFenceRows(engine, [
        { slug: LIA.slug, source_id: 'default', chunk_text: 'bees zebracornheld | fact | 1.0 | world | medium |  |  |  |  |\nProfile prose.' },
        { slug: LIA.slug, source_id: 'default', chunk_text: 'Profile prose.\n| 3 | Lia keeps bees zebra' },
        { slug: LIA.slug, source_id: 'default', chunk_text: 'in Turin | fact | 1.0 | world | medium |  |  |  |  |\nProfile prose.' },
      ] as never) as Array<{ chunk_text: string }>;
      expect(kept.map(k => k.chunk_text)).toEqual(['Profile prose.', 'Profile prose.', 'in Turin | fact | 1.0 | world | medium |  |  |  |  |\nProfile prose.']);
    }, 60_000);

    test('a member still reads a held row on their own member page', async () => {
      const slug = memberPageSlug(BOB);
      await call('local', 'put_page', { slug, content: memberPageFrontmatter(BOB) + '# Memory\n\n## Facts\n\n' + renderFactsTable([row(1, 'Bob likes tea'), row(2, 'Bob owes rent walrusheld')] as never) + '\n', request_id: randomUUID() });
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw("UPDATE facts SET visibility='private' WHERE source_markdown_slug=$1 AND fact LIKE '%walrusheld'", [slug]), TEST_WRITE_ATTRIBUTION));
      expect(await stored('Bob owes rent walrusheld')).toEqual(['private']);
      expect(await call('bob', 'get_page', { slug, include_content: true })).toContain('walrusheld');
      expect(await call('unbound', 'get_page', { slug, include_content: true })).not.toContain('walrusheld');
    }, 120_000);

    test('re-deriving the page does not lift the hold', async () => withEnv(env, async () => {
      if (shape === 'repo') {
        for (const p of pages) { const f = join(root, p.slug + '.md'); writeFileSync(f, readFileSync(f, 'utf8').replace('Profile.', 'Profile. Edited by hand.')); }
        commit();
        await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });
        for (const p of pages) expect({ slug: p.slug, after: 'sync', world: (await stored(p.claim)).includes('world') }).toEqual({ slug: p.slug, after: 'sync', world: false });
      }
      for (const p of pages) {
        const page = JSON.parse(await call('local', 'get_page', { slug: p.slug, include_content: true }));
        await call('local', 'put_page', { slug: p.slug, content: String(page.content).replace('Profile.', 'Profile. Local edit.'), expected_revision: page.revision, request_id: randomUUID() });
        expect({ slug: p.slug, after: 'put_page', world: (await stored(p.claim)).includes('world') }).toEqual({ slug: p.slug, after: 'put_page', world: false });
        expect(await call('bob', 'get_page', { slug: p.slug, include_content: true })).not.toContain(p.canary);
      }
    }), 300_000);

    test('accept makes the restatement world and readable; undo and reject keep it from such a caller', async () => withEnv(env, async () => {
      const owner = { confirmation: { via: 'tty' as const } };
      expect((await decideTrustProposal(engine, refs[LIA.slug]!, 'accept', owner)).status).toBe('accepted');
      expect(await stored(LIA.claim)).toContain('world');
      expect(await call('bob', 'get_page', { slug: LIA.slug, include_content: true })).toContain(LIA.canary);
      expect(await call('unbound', 'search', { query: LIA.canary, match: 'keyword', fields: 'full', limit: 20 })).toContain(LIA.canary);
      const undone = await decideTrustProposal(engine, refs[LIA.slug]!, 'undo', owner);
      expect(undone.status).toBe('undone');
      expect(await call('bob', 'get_page', { slug: LIA.slug, include_content: true })).not.toContain(LIA.canary);
      expect((await decideTrustProposal(engine, refs[KIM.slug]!, 'reject', owner)).status).toBe('rejected');
      expect(await call('bob', 'get_page', { slug: KIM.slug, include_content: true })).not.toContain(KIM.canary);
      expect(await call('owner', 'get_page', { slug: KIM.slug, include_content: true })).toContain(turin(KIM));
    }), 300_000);
  });
}
