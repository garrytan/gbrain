/**
 * #8395: auxiliary page reads must use the same caller policy as get_page.
 * Protects core delivery (including withdrawal snapshots), strict entity lookup,
 * refusal candidates, retrieval pointers and brief edits from empty-identity
 * over-hiding after member access is enabled. Real storage and MCP dispatch;
 * no models, private transcripts or mocked SQL. Existing member-read-access
 * covers the main engine read matrix, not these auxiliary query paths.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { listCorePages } from '../src/core/core-memory.ts';
import { entityReferenceCandidates, resolveStrictEntityReference } from '../src/core/entities/resolve.ts';
import { assembleBrief, resolvePullCounterparty } from '../src/core/context/proactive-brief.ts';
import { resolveEntitiesToPointers } from '../src/core/context/retrieval-reflex.ts';
import { readRemotePolicyNow, resolveExcludePrivatePages, withCallerAccess, __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { folderAccessFor } from '../src/core/access/caller.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SRC = 'delivery-example';
const SLUG = 'people/alice-example';

for (const kind of testBackends()) {
  describe(`caller-aware page delivery (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function asCaller<T>(who: 'alice' | 'bob' | 'guest', privacy: 'hidden' | 'visible', work: () => Promise<T>): Promise<T> {
      await engine.setConfig('search.remote_private_pages', privacy);
      __resetPrivateVisibilityCacheForTests();
      const policy = await readRemotePolicyNow(engine);
      expect(policy.restricted).toBe(true);
      const identity = who === 'guest' ? [] : [`member:${who}-example`];
      return withCallerAccess({ identity, ...await folderAccessFor(engine, identity), hidePrivate: !policy.privacyRelaxed, restricted: policy.restricted, remotePolicy: policy }, work);
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1), ($2, $2)', [SRC, 'other-example']);
      await engine.setConfig('memory.core.enabled', 'true');
      for (const who of ['alice', 'bob']) {
        await addMember(engine, `${who}-example`);
        const minted = await mintLegacyToken(engine, { name: `delivery-${who}`, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[who] = minted.token;
        await bindCredential(engine, { kind: 'token', id: minted.id }, { member: `${who}-example` });
      }
      for (const [slug, title, fm] of [
        [SLUG, 'Alice Example', { readable_by: ['member:alice-example'] }],
        ['people/private-example', 'Private Example', { visibility: 'private' }],
        ['people/bob-example', 'Bob Example', { readable_by: ['member:bob-example'] }],
        ['people/private-alice', 'Private Alice', { visibility: 'private', readable_by: ['member:alice-example'] }],
      ] as const) {
        await engine.putPage(slug, { type: 'person', title, compiled_truth: `Harbor standing guidance ${slug}.`, frontmatter: { always_load: true, ...fm } }, { sourceId: SRC });
        await engine.addTimelineEntry(slug, { date: new Date().toISOString().slice(0, 10), summary: `Harbor timeline ${slug}` }, { sourceId: SRC });
      }
      await engine.putPage(SLUG, { type: 'person', title: 'Alice Other Source', compiled_truth: 'outside-source-canary', frontmatter: { always_load: true } }, { sourceId: 'other-example' });
    }, 120_000);

    afterAll(async () => { __resetPrivateVisibilityCacheForTests(); await close?.(); }, 60_000);

    test('core listing preserves member and privacy policy, without source widening', async () => {
      for (const privacy of ['hidden', 'visible'] as const) {
        const alice = await asCaller('alice', privacy, async () => {
          expect(await resolveExcludePrivatePages(engine, true)).toBe(true);
          return (await listCorePages(engine, { sourceIds: [SRC], excludePrivate: true })).map(p => p.slug).sort();
        });
        expect(alice).toEqual((privacy === 'hidden' ? [SLUG] : [SLUG, 'people/private-alice', 'people/private-example']).sort());
        const bob = await asCaller('bob', privacy, async () => (await listCorePages(engine, { sourceIds: [SRC], excludePrivate: true })).map(p => p.slug).sort());
        expect(bob).toEqual((privacy === 'hidden' ? ['people/bob-example'] : ['people/bob-example', 'people/private-example']).sort());
        const guest = await asCaller('guest', privacy, async () => (await listCorePages(engine, { sourceIds: [SRC], excludePrivate: true })).map(p => p.slug));
        expect(guest).toEqual(privacy === 'hidden' ? [] : ['people/private-example']);
      }
    });

    test('strict resolution and refusal candidates retain readable member pages only', async () => {
      for (const privacy of ['hidden', 'visible'] as const) {
        await asCaller('alice', privacy, async () => {
          expect(await resolveStrictEntityReference(engine, SRC, SLUG, { excludePrivate: true })).toEqual({ slug: SLUG, arm: 'exact_page' });
          expect(await entityReferenceCandidates(engine, SRC, 'Alice Example', { excludePrivate: true })).toContain(SLUG);
          expect((await resolveStrictEntityReference(engine, SRC, 'people/private-example', { excludePrivate: true })).slug).toBe(privacy === 'visible' ? 'people/private-example' : null);
          expect((await resolveStrictEntityReference(engine, SRC, 'people/bob-example', { excludePrivate: true })).slug).toBeNull();
        });
        await asCaller('bob', privacy, async () => {
          expect((await resolveStrictEntityReference(engine, SRC, SLUG, { excludePrivate: true })).slug).toBeNull();
          expect(await entityReferenceCandidates(engine, SRC, 'Alice Example', { excludePrivate: true })).not.toContain(SLUG);
        });
      }
    });

    test('retrieval pointers and pull briefs keep the same readable counterparties', async () => {
      for (const who of ['alice', 'bob', 'guest'] as const) {
        await asCaller(who, 'hidden', async () => {
          const pointers = await resolveEntitiesToPointers(engine, SRC, [{ query: 'Alice Example', display: 'Alice Example' }], { excludePrivate: true });
          expect(pointers?.pointers.some(p => p.slug === SLUG) ?? false).toBe(who === 'alice');
          const cp = await resolvePullCounterparty(engine, SRC, SLUG, { excludePrivate: true });
          expect(cp?.slug ?? null).toBe(who === 'alice' ? SLUG : null);
          // Even a previously resolved counterparty must be rechecked by the edit arm.
          const brief = await assembleBrief(engine, { trigger: 'pull', counterparties: [{ slug: SLUG, source_id: SRC, display: 'Alice Example', confidence: 1 }], local: false, clock: { now: Date.now(), stopAt: Date.now() + 30_000 } });
          expect(brief?.text.includes(`Harbor timeline ${SLUG}`) ?? false).toBe(who === 'alice');
        });
      }
      await asCaller('guest', 'visible', async () => {
        const cp = await resolvePullCounterparty(engine, SRC, 'people/private-example', { excludePrivate: true });
        expect(cp?.slug).toBe('people/private-example');
      });
    }, 60_000);

    test('a private-source grant relaxes privacy but never other members\' readers', async () => {
      await asCaller('alice', 'hidden', () => withCallerAccess({ privateReadableSources: [SRC] }, async () => {
        const pages = await listCorePages(engine, { sourceIds: [SRC], excludePrivate: true });
        expect(pages.map(p => p.slug).sort()).toEqual([SLUG, 'people/private-alice', 'people/private-example'].sort());
        expect((await resolveStrictEntityReference(engine, SRC, 'people/private-alice', { excludePrivate: true })).slug).toBe('people/private-alice');
        expect((await resolveStrictEntityReference(engine, SRC, 'people/bob-example', { excludePrivate: true })).slug).toBeNull();
      }));
    });

    test('withdrawal-aware core snapshots and the real MCP context_pack agree', async () => {
      await engine.executeRaw(`INSERT INTO fact_withdrawals (source_id, subject, visibility, fact_hash) VALUES ($1, $2, 'world', gbrain_fact_fingerprint('retired example claim')) ON CONFLICT DO NOTHING`, [SRC, SLUG]);
      for (const who of ['alice', 'bob'] as const) {
        await asCaller(who, 'hidden', async () => {
          const pages = await listCorePages(engine, { sourceIds: [SRC], excludePrivate: true });
          expect(pages.some(p => p.slug === SLUG)).toBe(who === 'alice');
          const auth = await provider().verifyAccessToken(tokens[who]) as unknown as AuthInfo;
          const out = await dispatchToolCall(engine, 'context_pack', { entities: SLUG }, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'] });
          expect(out.isError, JSON.stringify(out)).not.toBe(true);
          const text = JSON.stringify(out);
          expect(text.includes(`Harbor standing guidance ${SLUG}`)).toBe(who === 'alice');
          expect(text).not.toContain('outside-source-canary');
        });
      }
    }, 60_000);

    test('folder access stays mandatory under the privacy opt-out on every repaired page surface', async () => {
      await engine.putPage('people/folder-example', { type: 'person', title: 'Folder Example', compiled_truth: 'Folder standing guidance.', frontmatter: { always_load: true, visibility: 'private' } }, { sourceId: SRC });
      const result = await proposeRevision(engine, SRC, [{ id: 'delivery', prefix: 'people/folder-example/', readable_by: ['member:alice-example'] }], { origin: 'cli' });
      expect(result.state).toBe('applied');
      // The prefix must cover a descendant, not the similarly named parent page.
      const slug = 'people/folder-example/contact';
      await engine.putPage(slug, { type: 'person', title: 'Folder Contact', compiled_truth: 'Folder member guidance.', frontmatter: { always_load: true, visibility: 'private' } }, { sourceId: SRC });
      for (const who of ['alice', 'bob', 'guest'] as const) {
        await asCaller(who, 'visible', async () => {
          expect((await listCorePages(engine, { sourceIds: [SRC], excludePrivate: true })).some(p => p.slug === slug)).toBe(who === 'alice');
          expect((await resolveStrictEntityReference(engine, SRC, slug, { excludePrivate: true })).slug).toBe(who === 'alice' ? slug : null);
          expect((await resolvePullCounterparty(engine, SRC, slug, { excludePrivate: true }))?.slug ?? null).toBe(who === 'alice' ? slug : null);
        });
      }
    }, 60_000);
  });
}
