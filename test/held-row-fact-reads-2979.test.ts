/**
 * GST-2979: one rule for who reads a held fact row (a private restatement whose visibility proposal names the copy it
 * restates), applied to every fact read and to the page overlay alike.
 *
 * | Caller                                             | Reads the held row |
 * |----------------------------------------------------|--------------------|
 * | the writer, a member, on its own member page       | yes                |
 * | another member                                     | no                 |
 * | a private_facts grant that reads every named copy  | yes                |
 * | a private_facts grant that cannot read one of them | no                 |
 * | (a copy that is itself held counts only when the   |                    |
 * |  grant reads that copy's own copies too)           |                    |
 * | a world-only caller                                | no                 |
 * | the owner's remote caller, the local caller        | yes (as before)    |
 *
 * "As before" is master's answer: the owner's credential, bound to its own member, does not read another member's page,
 * and the local caller's delta and context_pack leave private facts out unless asked. A grant's fact reads of a held row it
 * may read match its fact reads of any private fact on an open page, and its page read shows the row's world cell.
 *
 * Every read goes through MCP dispatch with the serve --http verifier's AuthInfo, on PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { parseRescopeTokenArgs, rescopeLegacyToken } from '../src/core/grants/legacy-token.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { memberPageFrontmatter, memberPageSlug } from '../src/core/access/member-facts.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { withCoordinatedWrite, withTrustPromotion } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const row = (n: number, claim: string, visibility = 'world') => ({ rowNum: n, claim, kind: 'fact', confidence: 1, visibility, notability: 'medium', active: true });
const pageText = (title: string, rows: ReturnType<typeof row>[]) =>
  '---\ntype: person\ntitle: ' + title + '\n---\n# ' + title + '\n\nProfile of ' + title + ', who keeps bees.\n\n## Facts\n\n' + renderFactsTable(rows as never) + '\n';
const OWNER = 'owner-example';
const BOB = 'bob-example';
const CAROL = 'carol-example';
/** Restates an unpaged private copy the grant cannot read (the reviewer's cross-page probe). */
const UNPAGED = { slug: 'people/ana-example', title: 'Ana Example', claim: 'Ana keeps bees unpagedheldcanary', canary: 'unpagedheldcanary' };
/** Restates a private copy on an open page of the granted source, which the grant reads. */
const OPEN = { slug: 'people/ben-example', title: 'Ben Example', claim: 'Ben keeps bees openheldcanary', canary: 'openheldcanary' };
/** Restates a copy that no longer exists. */
const GONE = { slug: 'people/cy-example', title: 'Cy Example', claim: 'Cy keeps bees goneheldcanary', canary: 'goneheldcanary' };
/** Restates a copy on an open page that is itself a held row restating an unpaged copy (a hold chain). */
const CHAIN = { slug: 'people/eve-example', title: 'Eve Example', claim: 'Eve keeps bees chainheldcanary', canary: 'chainheldcanary' };
/** A private fact on an open page that was never restated: what the grant reads of any private fact. */
const PLAIN = { slug: 'people/dee-example', title: 'Dee Example', claim: 'Dee keeps bees plainprivatecanary', canary: 'plainprivatecanary' };
/** A member's own restatement, on its own member page, of an unpaged private copy it cannot read. */
const OWN = { slug: memberPageSlug(BOB), claim: 'Bob keeps bees ownheldcanary', canary: 'ownheldcanary' };

for (const kind of testBackends()) {
  describe('GST-2979 held rows on fact reads (' + kind + ')', () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    const home = mkdtempSync(join(tmpdir(), 'gst2979-'));
    const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    async function call(who: string, op: string, params: Record<string, unknown>): Promise<string> {
      __resetPrivateVisibilityCacheForTests();
      if (who === 'local') return (await withEnv(env, () => dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId: 'default' }))).content.map(c => c.text).join('\n');
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const out = await withEnv(env, () => dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: ['world'] }));
      return out.content.map(c => c.text).join('\n');
    }
    const confirm = async (where: string, args: unknown[]) => {
      for (const r of await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND ' + where, ['default', ...args]))
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw("UPDATE facts SET trust_tier='user_confirmed' WHERE id=$1", [r.id])), TEST_WRITE_ATTRIBUTION));
    };
    const stored = async (claim: string) => (await engine.executeRaw<{ visibility: string }>(
      'SELECT visibility FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL ORDER BY id', ['default', claim])).map(r => r.visibility);
    const heldProposals = async (claim: string) => engine.executeRaw<{ id: number; target_id: number | null }>(
      `SELECT tp.id::int AS id, tp.target_id::int AS target_id FROM trust_proposals tp JOIN facts f ON tp.related_table = 'facts' AND f.id = tp.related_id
        WHERE f.fact = $1 AND tp.before_state->'visibility' IS NOT NULL`, [claim]);
    /** Every fact read the issue names, plus the page overlay. */
    const reads = (slug: string, canary: string): Array<[string, string, Record<string, unknown>]> => [
      ['recall', 'recall', { entity: slug }],
      ['delta', 'delta', { since: '2000-01-01T00:00:00Z' }],
      ['query', 'query', { query: 'keeps bees ' + canary, expand: false }],
      ['entity', 'entity', { name: slug }],
      ['context_pack', 'context_pack', { entities: slug }],
      ['get_page', 'get_page', { slug, include_content: true }],
    ];
    const seen = async (who: string, p: { slug: string; canary: string }) => {
      const out: Record<string, boolean> = {};
      for (const [label, op, params] of reads(p.slug, p.canary)) out[label] = (await call(who, op, params)).includes(p.canary);
      return out;
    };
    const every = (p: { slug: string; canary: string }, v: boolean) => Object.fromEntries(reads(p.slug, p.canary).map(([label]) => [label, v]));

    beforeAll(async () => withEnv(env, async () => {
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await registerLocalWriter(engine, 'cli');
      for (const id of [OWNER, BOB, CAROL]) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      const mint = async (name: string, opts: { member?: string; scopes?: string[]; grant?: boolean } = {}) => {
        const m = await mintLegacyToken(engine, { name, scopes: opts.scopes ?? ['read'], takesHolders: ['world'], ...(opts.grant ? { sourceGrant: ['default'] } : {}) });
        tokens[name] = m.token;
        if (opts.member) await bindCredential(engine, { kind: 'token', id: m.id }, { member: opts.member }); else await readsUnscopedOnPurpose(engine, m.id);
        if (opts.grant) await rescopeLegacyToken(engine, parseRescopeTokenArgs([name, '--private-facts', 'granted-sources']));
      };
      await mint('owner', { member: OWNER }); await mint('unbound'); await mint('writer', { scopes: ['read', 'write'] }); await mint('grant', { grant: true });
      await mint('bob', { member: BOB, scopes: ['read', 'write'] }); await mint('carol', { member: CAROL });
      await setOwner(engine, OWNER);

      for (const p of [UNPAGED, GONE]) {
        await call('local', 'remember', { fact: p.claim, provenance: 'chat', entity: p.slug, visibility: 'private', request_id: randomUUID() });
        await confirm('fact=$2', [p.claim]);
        await call('writer', 'put_page', { slug: p.slug, content: pageText(p.title, [row(1, p.claim)]), request_id: randomUUID() });
      }
      for (const p of [OPEN, CHAIN]) {
        await call('local', 'put_page', { slug: p.slug, content: pageText(p.title, [row(1, p.claim, 'private')]), request_id: randomUUID() });
        await confirm('source_markdown_slug=$2', [p.slug]);
        const cur = JSON.parse(await call('writer', 'get_page', { slug: p.slug, include_content: true }));
        await call('writer', 'put_page', { slug: p.slug, content: pageText(p.title, [row(1, p.claim)]), expected_revision: cur.revision, request_id: randomUUID() });
      }
      await call('local', 'put_page', { slug: PLAIN.slug, content: pageText(PLAIN.title, [row(1, PLAIN.claim, 'private')]), request_id: randomUUID() });
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
        `UPDATE trust_proposals SET target_id = (SELECT max(id) + 1000 FROM facts)
          WHERE related_table = 'facts' AND related_id IN (SELECT id FROM facts WHERE fact = $1) AND before_state->'visibility' IS NOT NULL`, [GONE.claim]), TEST_WRITE_ATTRIBUTION));
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
        `UPDATE trust_proposals SET target_table = 'facts', target_id = (SELECT id FROM facts WHERE fact = $2 AND source_markdown_slug = $3 AND expired_at IS NULL)
          WHERE related_table = 'facts' AND related_id IN (SELECT id FROM facts WHERE fact = $1) AND before_state->'visibility' IS NOT NULL`, [CHAIN.claim, UNPAGED.claim, UNPAGED.slug]), TEST_WRITE_ATTRIBUTION));
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
        `UPDATE facts SET expired_at = now() WHERE fact = $1 AND expired_at IS NULL
          AND id NOT IN (SELECT related_id FROM trust_proposals WHERE related_table = 'facts' AND related_id IS NOT NULL AND before_state->'visibility' IS NOT NULL)`, [CHAIN.claim]), TEST_WRITE_ATTRIBUTION));

      await call('local', 'remember', { fact: OWN.claim, provenance: 'chat', entity: OWN.slug, visibility: 'private', request_id: randomUUID() });
      await confirm('fact=$2', [OWN.claim]);
      await call('bob', 'put_page', { slug: OWN.slug, content: memberPageFrontmatter(BOB) + '# Memory\n\n## Facts\n\n' + renderFactsTable([row(1, OWN.claim)] as never) + '\n', request_id: randomUUID() });
    }), 300_000);
    afterAll(async () => { resetGateway(); await disposePersistenceConsumer(engine); await close?.(); rmSync(home, { recursive: true, force: true }); }, 60_000);

    test('each restatement is stored as a private held row with a proposal naming its copy', async () => {
      for (const p of [UNPAGED, OPEN, GONE, OWN, CHAIN]) {
        expect({ claim: p.claim, world: (await stored(p.claim)).includes('world') }).toEqual({ claim: p.claim, world: false });
        expect({ claim: p.claim, proposals: (await heldProposals(p.claim)).length > 0 }).toEqual({ claim: p.claim, proposals: true });
      }
    });

    test('a private_facts grant reads a held row only when it reads every copy the proposals name', async () => {
      expect(await seen('grant', UNPAGED)).toEqual(every(UNPAGED, false));
      expect(await seen('grant', GONE)).toEqual(every(GONE, false));
      expect(await seen('grant', CHAIN)).toEqual(every(CHAIN, false));
      const plain = await seen('grant', PLAIN);
      expect(plain.recall).toBe(true);
      expect(await seen('grant', OPEN)).toEqual({ ...plain, get_page: true });
    }, 120_000);

    test('the writer reads its own held row back; another member and a world-only caller do not', async () => {
      const bob = await seen('bob', OWN);
      expect(bob.get_page).toBe(true);
      expect(bob.recall).toBe(true);
      for (const who of ['carol', 'unbound']) for (const p of [UNPAGED, OPEN, GONE, OWN, CHAIN]) expect({ who, claim: p.claim, ...(await seen(who, p)) }).toEqual({ who, claim: p.claim, ...every(p, false) });
    }, 180_000);

    test("the owner's remote caller and the local caller read every held row, as before", async () => {
      for (const who of ['owner', 'local']) for (const p of [UNPAGED, OPEN, GONE, OWN, CHAIN]) {
        const before = who === 'local' ? { ...every(p, true), delta: false, context_pack: false } : every(p, p !== OWN);
        expect({ who, claim: p.claim, ...(await seen(who, p)) }).toEqual({ who, claim: p.claim, ...before });
      }
    }, 120_000);
  });
}
