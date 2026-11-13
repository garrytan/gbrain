/**
 * #9213: a remember onto an entity page stored in segments, from every credential binding, reads the page's labels and
 * never its body.
 *
 * 1. Protects: the owner-bound remember (explicit visibility "world" and the default visibility) onto a segmented
 *    entity page commits as the unbound one does; a member-bound and an attested remember name it as their entity and
 *    commit; an attested memory_write saves onto a segmented scope page (memory/scope).
 * 2. Fails when: a label check (owner visibility, folder rules, scope-page sharing) spreads the snapshot page, whose
 *    segmented body fields are getters that throw page_body_segmented on purpose.
 * 3. Real seams: OAuth client-credentials tokens bound to the owner, a member and an attested actor, MCP dispatch as
 *    remote callers, a repo-less brain, pages imported large enough to be stored in segments, PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { linkMember } from '../src/core/access/actor.ts';
import { rescopeClientGrant } from '../src/core/grants/service.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SRC = 'source-a';
const SCOPE = 'scope-a';
const OWNER = 'carol-example';
const ENTITY = 'companies/acme-example';
const SCOPE_PAGE = 'memory/scope';
const QM_ALICE = 'U0ALICE';
const MEMORY_OPS = ['forget', 'forget_fact', 'get_write_request', 'memory_recall', 'memory_write', 'remember'];
const DIMS = 1536;
const LONG_LINES = 16_000;
const TEST_MS = 240_000;
const WRITE_WAIT_MS = 30_000;

/** A page body over the 1 MiB inline ceiling, so import stores it in segments. */
function largePage(type: string, title: string): string {
  const prose = Array.from({ length: LONG_LINES }, (_, i) => 'Line ' + i + ' of a long standing note kept on the page so it is stored in segments.').join('\n');
  return '---\ntype: ' + type + '\ntitle: ' + title + '\n---\n# ' + title + '\n\n' + prose + '\n';
}

type Who = 'owner' | 'alice' | 'plain' | 'qm' | 'scopes';
type Call = { isError: boolean; text: string };

for (const kind of testBackends()) {
  describe('remember onto a segmented page (' + kind + ', repo-less, #9213)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Partial<Record<Who, string>> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(who: Who, op: string, params: Record<string, unknown>): Promise<Call> {
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const actor = who === 'qm' || who === 'scopes' ? { actor: { header: QM_ALICE } } : {};
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'], writeWaitMs: WRITE_WAIT_MS, ...actor,
      });
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
    }
    const factRow = async (canary: string) => (await engine.executeRaw<{ source_id: string; visibility: string; source_markdown_slug: string | null; entity_slug: string | null }>(
      'SELECT source_id, visibility, source_markdown_slug, entity_slug FROM facts WHERE fact LIKE $1 ORDER BY id DESC LIMIT 1', ['%' + canary + '%']))[0];
    const storage = async (sourceId: string, slug: string) => (await engine.executeRaw<{ body_storage: string }>(
      'SELECT body_storage FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]))[0]?.body_storage;
    const canary = (tag: string) => 'canary' + tag + randomUUID().slice(0, 8);

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array.from({ length: DIMS }, (_, i) => (i === 0 ? 1 : 0))) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      for (const id of [SRC, SCOPE]) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
      for (const id of [OWNER, 'alice-example']) await addMember(engine, id);
      await setOwner(engine, OWNER);
      await linkMember(engine, 'alice-example', 'qm', QM_ALICE);
      await importFromContent(engine, ENTITY, largePage('company', 'Acme Example'), { sourceId: SRC });
      await importFromContent(engine, SCOPE_PAGE, largePage('note', 'Scope memory'), { sourceId: SCOPE });
      const bindings: Record<Who, Parameters<typeof bindCredential>[2] | null> = {
        owner: { member: OWNER }, alice: { member: 'alice-example' }, plain: null,
        qm: { attestActor: 'qm', attestOps: MEMORY_OPS },
        scopes: { attestActor: 'qm', attestOps: MEMORY_OPS.filter(op => op !== 'remember'), attestSources: [SCOPE] },
      };
      for (const [name, binding] of Object.entries(bindings) as Array<[Who, Parameters<typeof bindCredential>[2] | null]>) {
        const c = await provider().registerClientManual('s9213-' + name + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
        if (binding) await bindCredential(engine, { kind: 'client', id: c.clientId }, binding);
        if (name === 'scopes') await rescopeClientGrant(engine, c.clientId, { federatedRead: [SRC, SCOPE] }, { actor: 'test' });
        tokens[name] = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
      }
    }, TEST_MS);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await disposePersistenceConsumer(engine).catch(() => undefined);
      await close?.();
    }, TEST_MS);

    test('both pages are stored in segments', async () => {
      expect(await storage(SRC, ENTITY)).toBe('segmented');
      expect(await storage(SCOPE, SCOPE_PAGE)).toBe('segmented');
    }, TEST_MS);

    test('the owner-bound remember with visibility "world" is saved world on the entity page', async () => {
      const c = canary('ownerworld');
      const out = await call('owner', 'remember', { fact: 'Standing rule ' + c, entity: ENTITY, visibility: 'world', provenance: 'test' });
      expect(out.text).not.toContain('page_body_segmented');
      expect(out.isError).toBe(false);
      expect(await factRow(c)).toMatchObject({ source_id: SRC, visibility: 'world', source_markdown_slug: ENTITY, entity_slug: ENTITY });
    }, TEST_MS);

    test('the owner-bound remember with the default visibility is saved world on the entity page', async () => {
      const c = canary('ownerdefault');
      const out = await call('owner', 'remember', { fact: 'Standing rule ' + c, entity: ENTITY, provenance: 'test' });
      expect(out.text).not.toContain('page_body_segmented');
      expect(out.isError).toBe(false);
      expect(await factRow(c)).toMatchObject({ source_id: SRC, visibility: 'world', source_markdown_slug: ENTITY, entity_slug: ENTITY });
    }, TEST_MS);

    test('the owner-bound remember with visibility "private" goes to the owner page, keyed to the entity', async () => {
      const c = canary('ownerprivate');
      const out = await call('owner', 'remember', { fact: 'Standing rule ' + c, entity: ENTITY, visibility: 'private', provenance: 'test' });
      expect(out.text).not.toContain('page_body_segmented');
      expect(out.isError).toBe(false);
      expect(await factRow(c)).toMatchObject({ visibility: 'private', source_markdown_slug: 'memory/members/' + OWNER, entity_slug: ENTITY });
    }, TEST_MS);

    test('an unbound, a member-bound and an attested remember naming the entity are saved', async () => {
      const expected: Record<string, { visibility: string; source_markdown_slug: string }> = {
        plain: { visibility: 'world', source_markdown_slug: ENTITY },
        alice: { visibility: 'private', source_markdown_slug: 'memory/members/alice-example' },
        qm: { visibility: 'private', source_markdown_slug: 'memory/members/alice-example' },
      };
      for (const who of ['plain', 'alice', 'qm'] as const) {
        const c = canary(who);
        const out = await call(who, 'remember', { fact: 'Standing rule ' + c, entity: ENTITY, provenance: 'test' });
        expect({ who, isError: out.isError, text: out.isError ? out.text : '' }).toEqual({ who, isError: false, text: '' });
        expect(await factRow(c)).toMatchObject({ ...expected[who], entity_slug: ENTITY });
      }
    }, TEST_MS);

    test('an attested memory_write onto a segmented scope page is saved world there', async () => {
      const c = canary('scope');
      const out = await call('scopes', 'memory_write', { facts: [{ fact: 'Scope rule ' + c, provenance: 'test' }], idempotency_key: randomUUID(), source_id: SCOPE });
      expect(out.text).not.toContain('page_body_segmented');
      expect(out.isError).toBe(false);
      expect(await factRow(c)).toMatchObject({ source_id: SCOPE, visibility: 'world', source_markdown_slug: SCOPE_PAGE });
    }, TEST_MS);
  });
}
