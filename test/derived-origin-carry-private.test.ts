/**
 * GST-2689: a page that reads as world by its own label but is hidden from non-owners because its origin is private
 * (a declared derived_from origin, an atom's source_slug origin, or a concept whose provenance atom has such an origin)
 * stays hidden once that origin's row is gone.
 *
 * 1. Protects: before an origin row is removed (an explicit `delete_page purge: true`, the backdated retention purge,
 *    and after a remote delete), every live same-source dependent that would gain a reader gets `visibility: private`
 *    through the label door, so a non-owner reads it neither before nor after through get_page, get_versions,
 *    list_pages and search. The owner, a granted_sources credential and a listed member read the same before and after.
 *    Pages already private, naming readers, pinned or not lineage-dependent are never changed; trust tiers are kept and
 *    no lowering proposal is filed. A remote delete's response names no stamped page and counts none. A page that names
 *    readers gets the label too (its readable_by kept), so its listed reader does not gain it either. When the stamp
 *    fails, the origin is parked (never purged), doctor names it with the page that blocks it, and the derived page
 *    stays hidden; once the cause is fixed the next purge stamps and purges. Nothing of a purged origin is kept.
 * 2. Fails when: any of those reads opens to a non-owner after the origin goes, a read changes for a reader who had it,
 *    an untouched page changes, the remote response leaks a stamped page, or a parked origin is purged or silent.
 * 3. Real seams: tokens minted by the token service and verified as serve --http does, dispatched through MCP dispatch
 *    (remote: true), on a repo-less brain without managed persistence; PGLite always, Postgres with DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { consentedPurgeDeletedPages, purgeDeletedPagesCoordinated, selectPurgeCandidates } from '../src/core/persistence/purge-deleted.ts';
import { checkDerivedOriginParked } from '../src/commands/doctor/checks/purge-parks.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import * as labelWrite from '../src/core/repair/label-write.ts';
import * as privateVisibility from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { withEnv } from './helpers/with-env.ts';

const SRC = 'source-a';
const OWNER = 'owner-example';
const ALICE = 'alice-example';
/** Pages that gain a reader once the origin goes, then the pages the stamp must never change. */
const CARRIED = ['digest', 'atom', 'concept'] as const;
const UNTOUCHED = ['own', 'pinned', 'plain'] as const;
type Shape = 'origin' | typeof CARRIED[number] | 'listed' | typeof UNTOUCHED[number];
const SHAPES: Shape[] = ['origin', ...CARRIED, 'listed', ...UNTOUCHED];
const CALLERS = ['owner', 'granted', 'alice', 'unbound'] as const;
type Caller = typeof CALLERS[number];

const slugOf = (k: string, shape: Shape) => `${k}/${shape}`;
const canaryOf = (k: string, shape: Shape) => `canary${k}${shape}`;
function frontmatter(k: string, shape: Shape): string[] {
  const origin = slugOf(k, 'origin');
  switch (shape) {
    case 'origin': return ['type: note', 'visibility: private'];
    case 'digest': return ['type: note', `derived_from: ${origin}.md`];
    case 'atom': return ['type: atom', 'visibility: world', `source_slug: ${origin}`];
    case 'concept': return ['type: concept', 'synthesized_by: test', 'visibility: world'];
    case 'own': return ['type: note', 'visibility: private', `derived_from: [${origin}]`];
    case 'listed': return ['type: note', `readable_by: [${ALICE}]`, `derived_from: [${origin}]`];
    case 'pinned': return ['type: note', 'pinned_question: true', `derived_from: [${origin}]`];
    case 'plain': return ['type: note'];
  }
}
const pageText = (k: string, shape: Shape) => ['---', `title: ${k} ${shape}`, ...frontmatter(k, shape), '---', `# ${k} ${shape}`, '',
  `Harbor ledger planning notes ${canaryOf(k, shape)} for the roadmap.`].join('\n');

for (const kind of testBackends()) {
  describe(`derived pages stay private when their origin row goes (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-origin-carry-'));
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const local = { remote: false, sourceId: SRC } as const;

    async function call(who: string, op: string, params: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await withEnv({ GBRAIN_HOME: home }, () => dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      }));
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
    }
    const localCall = async (op: string, params: Record<string, unknown>) => {
      const out = await withEnv({ GBRAIN_HOME: home }, () => dispatchToolCall(engine, op, params, local));
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
    };

    /** What `who` reads of one page on each read path; the content canary decides (a not_found echoes the slug). */
    async function seen(who: Caller, k: string, shape: Shape) {
      const slug = slugOf(k, shape), canary = canaryOf(k, shape);
      return {
        get_page: (await call(who, 'get_page', { slug })).text.includes(canary),
        get_versions: (await call(who, 'get_versions', { slug, include_body: true })).text.includes(canary),
        list_pages: (await call(who, 'list_pages', { limit: 100 })).text.includes(`"${slug}"`),
        search: (await call(who, 'search', { query: canary, match: 'keyword', fields: 'full', limit: 20 })).text.includes(canary),
      };
    }
    async function readsOf(k: string, shapes: readonly Shape[]) {
      const out: Record<string, unknown> = {};
      for (const who of CALLERS) for (const shape of shapes) out[`${who}:${shape}`] = await seen(who, k, shape);
      return out;
    }
    const none = { get_page: false, get_versions: false, list_pages: false, search: false };
    const every = { get_page: true, get_versions: true, list_pages: true, search: true };

    const row = async (slug: string) => (await engine.executeRaw<{ id: number; frontmatter: Record<string, unknown> | string; trust_tier: string; deleted_at: string | null }>(
      'SELECT id, frontmatter, trust_tier, deleted_at FROM pages WHERE source_id=$1 AND slug=$2', [SRC, slug]))[0];
    const fm = async (slug: string) => { const r = await row(slug); return typeof r!.frontmatter === 'string' ? JSON.parse(r!.frontmatter) : r!.frontmatter; };
    const state = async (k: string) => Object.fromEntries(await Promise.all(SHAPES.filter(s => s !== 'origin').map(async s => [s, { fm: await fm(slugOf(k, s)), tier: (await row(slugOf(k, s)))!.trust_tier }])));
    const proposals = async () => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM trust_proposals WHERE source_id=$1', [SRC]))[0]!.n);

    async function seed(k: string): Promise<void> {
      for (const shape of SHAPES) {
        const result = await importFromContent(engine, slugOf(k, shape), pageText(k, shape), { sourceId: SRC, noEmbed: true });
        expect(result.status).toBe('imported');
        await engine.createVersion(slugOf(k, shape), { sourceId: SRC });
      }
      await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
        SELECT c.id, a.id, 'synthesized_from', 'concept-provenance' FROM pages c, pages a WHERE c.source_id=$1 AND a.source_id=$1 AND c.slug=$2 AND a.slug=$3`,
      [SRC, slugOf(k, 'concept'), slugOf(k, 'atom')]);
    }
    const backdate = (slug: string) => engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE source_id=$1 AND slug=$2 AND deleted_at IS NOT NULL", [SRC, slug]);
    const softDelete = async (slug: string) => { expect(await engine.softDeletePages([slug], { sourceId: SRC })).toEqual([slug]); };
    const revision = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: SRC, includeDeleted: true }))!.revision;
    /** Nothing that names the purged origin is kept: its row, and any park or checkpoint row naming its slug. */
    async function nothingKept(slug: string): Promise<void> {
      expect(await row(slug)).toBeUndefined();
      expect((await engine.executeRaw('SELECT 1 FROM op_checkpoints WHERE completed_keys::text LIKE $1', [`%${slug}%`])).length).toBe(0);
    }

    /** The before/after contract shared by every removal path. */
    async function expectCarried(k: string, before: Record<string, unknown>, beforeState: Record<string, any>, beforeProposals: number): Promise<void> {
      __resetPrivateVisibilityCacheForTests();
      const others = SHAPES.filter(s => s !== 'origin');
      expect(before['alice:listed']).toEqual(none);
      expect(await readsOf(k, others)).toEqual(Object.fromEntries(Object.entries(before).filter(([key]) => !key.endsWith(':origin'))));
      const after = await state(k);
      for (const shape of CARRIED) {
        expect({ shape, visibility: after[shape].fm.visibility }).toEqual({ shape, visibility: 'private' });
        expect({ shape, tier: after[shape].tier }).toEqual({ shape, tier: beforeState[shape].tier });
      }
      // A page that names readers gets the label and keeps its readers: its listed member reads it neither before nor after.
      expect({ ...after.listed, fm: { ...after.listed.fm, visibility: undefined } }).toEqual({ ...beforeState.listed, fm: { ...beforeState.listed.fm, visibility: undefined } });
      expect(after.listed.fm.visibility).toBe('private');
      expect(after.listed.fm.readable_by).toEqual([ALICE]);
      for (const shape of UNTOUCHED) expect({ shape, ...after[shape] }).toEqual({ shape, ...beforeState[shape] });
      expect(await proposals()).toBe(beforeProposals);
    }

    async function baseline(k: string) {
      __resetPrivateVisibilityCacheForTests();
      const before = await readsOf(k, SHAPES);
      for (const shape of CARRIED) {
        for (const who of ['unbound', 'alice'] as const) expect({ who, shape, seen: before[`${who}:${shape}`] }).toEqual({ who, shape, seen: none });
        for (const who of ['owner', 'granted'] as const) expect({ who, shape, seen: before[`${who}:${shape}`] }).toEqual({ who, shape, seen: every });
      }
      return { before, state: await state(k), proposals: await proposals() };
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const id of [OWNER, ALICE]) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      const mint = async (name: string, scopes: string[], member?: string) => {
        const minted = await mintLegacyToken(engine, { name, scopes, takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
        else await readsUnscopedOnPurpose(engine, minted.id);
        return minted.id;
      };
      await mint('owner', ['read'], OWNER);
      await mint('owner-writer', ['read', 'write'], OWNER);
      await mint('alice', ['read'], ALICE);
      await mint('unbound', ['read']);
      const granted = await mint('granted', ['read']);
      await engine.executeRaw("UPDATE access_tokens SET private_pages = 'granted_sources' WHERE id = $1::uuid", [granted]);
      await setOwner(engine, OWNER);
    }, 240_000);

    afterAll(async () => { await close?.(); rmSync(home, { recursive: true, force: true }); }, 60_000);

    test('an explicit purge of a private origin stamps its derived pages private first', async () => {
      const k = 'purge';
      await seed(k);
      const base = await baseline(k);
      const origin = slugOf(k, 'origin');
      const out = await localCall('delete_page', { slug: origin, purge: true, request_id: randomUUID(), expected_revision: await revision(origin) });
      expect(out.isError).toBe(false);
      expect(JSON.parse(out.text).status).toBe('purged');
      await nothingKept(origin);
      await expectCarried(k, base.before, base.state, base.proposals);
    }, 240_000);

    test('the retention purge of a backdated tombstone stamps its derived pages private before the row goes', async () => {
      const k = 'expiry';
      await seed(k);
      const base = await baseline(k);
      const origin = slugOf(k, 'origin');
      await softDelete(origin);
      await backdate(origin);
      const result = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
      expect(result.slugs).toContain(origin);
      await nothingKept(origin);
      await expectCarried(k, base.before, base.state, base.proposals);
    }, 240_000);

    test('a remote delete stamps the derived pages as maintenance and its response names none of them and counts none', async () => {
      const k = 'remote';
      await seed(k);
      const base = await baseline(k);
      const origin = slugOf(k, 'origin'), control = 'remote-control/plain';
      expect((await importFromContent(engine, control, ['---', 'title: control', 'type: note', '---', '# control', '', 'Nothing derives from this page.'].join('\n'), { sourceId: SRC, noEmbed: true })).status).toBe('imported');
      // A remote write reaches a private page only while the operator relaxes remote privacy (search.remote_private_pages).
      await engine.setConfig('search.remote_private_pages', 'visible');
      __resetPrivateVisibilityCacheForTests();
      const response = await call('owner-writer', 'delete_page', { slug: origin, request_id: randomUUID(), expected_revision: await revision(origin) });
      await engine.setConfig('search.remote_private_pages', 'hidden');
      __resetPrivateVisibilityCacheForTests();
      expect(response.isError ? response.text : '').toBe('');
      for (const shape of [...CARRIED, ...UNTOUCHED]) expect({ shape, named: response.text.includes(slugOf(k, shape)) }).toEqual({ shape, named: false });
      for (const shape of CARRIED) expect({ shape, visibility: (await fm(slugOf(k, shape))).visibility }).toEqual({ shape, visibility: 'private' });
      // Same response shape as the delete of a page nothing derives from: no extra field, so no count.
      const controlResponse = await call('owner-writer', 'delete_page', { slug: control, request_id: randomUUID(), expected_revision: await revision(control) });
      const keys = (text: string) => Object.keys(JSON.parse(text)).sort();
      expect(keys(response.text)).toEqual(keys(controlResponse.text));
      expect(response.text).not.toMatch(/carried|stamped|dependent/i);
      await backdate(origin);
      const result = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
      expect(result.slugs).toContain(origin);
      await nothingKept(origin);
      await expectCarried(k, base.before, base.state, base.proposals);
    }, 240_000);

    test('a purge sent with a mixed-case slug stamps the derived pages first, as the lowercase slug does', async () => {
      const k = 'mixedcase';
      await seed(k);
      const base = await baseline(k);
      const origin = slugOf(k, 'origin');
      const out = await localCall('delete_page', { slug: 'MixedCase/Origin', purge: true, request_id: randomUUID(), expected_revision: await revision(origin) });
      expect(out.isError ? out.text : '').toBe('');
      expect(JSON.parse(out.text).status).toBe('purged');
      await nothingKept(origin);
      await expectCarried(k, base.before, base.state, base.proposals);
    }, 240_000);

    test('a derived page soft-deleted when its origin expires parks the origin; restored, it is stamped before the origin goes', async () => {
      const k = 'tomb';
      await seed(k);
      const origin = slugOf(k, 'origin'), digest = slugOf(k, 'digest');
      await softDelete(origin);
      await backdate(origin);
      await softDelete(digest);
      const held = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
      expect(held.slugs).not.toContain(origin);
      expect(held.blocked.find(b => b.slug === origin)?.code).toBe('derived_origin_parked');
      expect((await row(origin))?.deleted_at).not.toBeNull();
      const doctor = await checkDerivedOriginParked(engine);
      expect((doctor.details as { origins: Array<{ slug: string; blocking_slug: string }> }).origins)
        .toContainEqual(expect.objectContaining({ slug: origin, blocking_slug: digest }));
      const restored = await localCall('restore_page', { slug: digest, request_id: randomUUID(), expected_revision: await revision(digest) });
      expect(restored.isError ? restored.text : '').toBe('');
      expect((await purgeDeletedPagesCoordinated(engine, 72, { automatic: true })).slugs).not.toContain(origin);
      expect((await fm(digest)).visibility).toBe('private');
      const result = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
      expect(result.slugs).toContain(origin);
      await nothingKept(origin);
      __resetPrivateVisibilityCacheForTests();
      for (const who of ['unbound', 'alice'] as const) expect({ who, seen: await seen(who, k, 'digest') }).toEqual({ who, seen: none });
      expect({ owner: await seen('owner', k, 'digest') }).toEqual({ owner: every });
    }, 240_000);

    test('a page private through two expired origins more than 200 apart is stamped before both rows go', async () => {
      const k = 'wide', first = 'wide/first', last = 'wide/last', page = 'wide/joined';
      const privatePage = (slug: string) => importFromContent(engine, slug, ['---', `title: ${slug}`, 'type: note', 'visibility: private', '---', `# ${slug}`, '', 'Private origin.'].join('\n'), { sourceId: SRC, noEmbed: true });
      expect((await privatePage(first)).status).toBe('imported');
      for (let i = 0; i < 199; i++) expect((await privatePage(`wide/filler-${i}`)).status).toBe('imported');
      expect((await privatePage(last)).status).toBe('imported');
      expect((await importFromContent(engine, page, ['---', 'title: joined', 'type: note', `derived_from: [${first}.md, ${last}.md]`, '---', '# joined', '',
        `Harbor ledger planning notes ${canaryOf(k, 'digest')} for the roadmap.`].join('\n'), { sourceId: SRC, noEmbed: true })).status).toBe('imported');
      await engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE source_id=$1 AND slug LIKE 'wide/%' AND slug <> $2", [SRC, page]);
      const result = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
      expect(result.slugs).toEqual(expect.arrayContaining([first, last]));
      expect((await fm(page)).visibility).toBe('private');
      __resetPrivateVisibilityCacheForTests();
      for (const who of ['unbound', 'alice'] as const) expect({ who, get_page: (await call(who, 'get_page', { slug: page })).text.includes(canaryOf(k, 'digest')) }).toEqual({ who, get_page: false });
    }, 240_000);

    test('a derived page that expires with its origin but is kept by another hold keeps the origin; restored, it is stamped before the origin goes', async () => {
      const k = 'cohold';
      await seed(k);
      const origin = slugOf(k, 'origin'), digest = slugOf(k, 'digest');
      await softDelete(origin);
      await softDelete(digest);
      await backdate(origin);
      await backdate(digest);
      const held = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true, only: page => page.slug !== digest });
      expect(held.slugs).not.toContain(origin);
      expect(held.slugs).not.toContain(digest);
      expect(held.blocked.find(b => b.slug === origin)?.code).toBe('derived_origin_parked');
      expect((await row(origin))?.deleted_at).not.toBeNull();
      const restored = await localCall('restore_page', { slug: digest, request_id: randomUUID(), expected_revision: await revision(digest) });
      expect(restored.isError ? restored.text : '').toBe('');
      expect((await purgeDeletedPagesCoordinated(engine, 72, { automatic: true })).slugs).not.toContain(origin);
      expect((await fm(digest)).visibility).toBe('private');
      expect((await purgeDeletedPagesCoordinated(engine, 72, { automatic: true })).slugs).toContain(origin);
      __resetPrivateVisibilityCacheForTests();
      for (const who of ['unbound', 'alice'] as const) expect({ who, seen: await seen(who, k, 'digest') }).toEqual({ who, seen: none });
    }, 240_000);

    test('an origin that expires within the next day is carried by this purge, so it cannot cross the cutoff uncarried mid-run', async () => {
      const k = 'lead';
      await seed(k);
      const origin = slugOf(k, 'origin');
      await softDelete(origin);
      await engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '71 hours' WHERE source_id=$1 AND slug=$2", [SRC, origin]);
      const result = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
      expect(result.slugs).not.toContain(origin);
      for (const shape of CARRIED) expect({ shape, visibility: (await fm(slugOf(k, shape))).visibility }).toEqual({ shape, visibility: 'private' });
      await backdate(origin);
      expect((await purgeDeletedPagesCoordinated(engine, 72, { automatic: true })).slugs).toContain(origin);
    }, 240_000);

    test('a consented manual purge whose only expired page is a fixed parked origin retries the label and purges it', async () => {
      const k = 'manual';
      await seed(k);
      const origin = slugOf(k, 'origin'), blocking = slugOf(k, 'digest');
      const checkout = mkdtempSync(join(tmpdir(), 'gbrain-origin-carry-checkout-'));
      await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [SRC, checkout]);
      await engine.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [SRC, blocking, blocking + '.md']);
      await engine.setConfig('sync.write_through', 'false');
      try {
        await softDelete(origin);
        await backdate(origin);
        expect((await purgeDeletedPagesCoordinated(engine, 72, { automatic: true })).slugs).not.toContain(origin);
      } finally {
        await engine.setConfig('sync.write_through', 'true');
        await engine.executeRaw('UPDATE pages SET source_path=NULL WHERE source_id=$1 AND slug=$2', [SRC, blocking]);
        await engine.executeRaw('UPDATE sources SET local_path=NULL WHERE id=$1', [SRC]);
        rmSync(checkout, { recursive: true, force: true });
      }
      expect((await selectPurgeCandidates(engine, 72)).count).toBe(0);
      const result = await consentedPurgeDeletedPages(engine, 72, true);
      expect(result.slugs).toContain(origin);
      expect((await fm(blocking)).visibility).toBe('private');
      await nothingKept(origin);
    }, 240_000);

    /** Writes a world-labelled page derived from the origin once, between the purge's carry and its row delete. */
    function lateDerivedPage(k: string): string {
      const late = `${k}/late`;
      let fired = false;
      installFaultHook(async point => {
        if (point !== 'purge:after_carry' || fired) return;
        fired = true;
        expect((await importFromContent(engine, late, ['---', 'title: late', 'type: note', `derived_from: ${slugOf(k, 'origin')}.md`, '---', '# late', '',
          `Harbor ledger planning notes ${canaryOf(k, 'plain')}late for the roadmap.`].join('\n'), { sourceId: SRC, noEmbed: true })).status).toBe('imported');
      });
      return late;
    }
    async function expectLateHidden(k: string, late: string): Promise<void> {
      __resetPrivateVisibilityCacheForTests();
      for (const who of ['unbound', 'alice'] as const) expect({ who, read: (await call(who, 'get_page', { slug: late })).text.includes(`${canaryOf(k, 'plain')}late`) }).toEqual({ who, read: false });
    }

    /** Parks the origin the way a failed label does: an explicit purge whose label write fails soft-deletes and parks it. */
    async function parkByFailedLabel(origin: string): Promise<void> {
      const failing = spyOn(labelWrite, 'importAtRevision').mockImplementation(async () => { throw new Error('forced label failure'); });
      try {
        const first = JSON.parse((await localCall('delete_page', { slug: origin, purge: true, request_id: randomUUID(), expected_revision: await revision(origin) })).text);
        expect(first.purge_held?.code).toBe('derived_origin_parked');
      } finally { failing.mockRestore(); }
      expect((await row(origin))?.deleted_at).not.toBeNull();
      expect((await checkDerivedOriginParked(engine)).status).toBe('warn');
    }
    async function expectCarriedHidden(k: string): Promise<void> {
      __resetPrivateVisibilityCacheForTests();
      for (const who of ['unbound', 'alice'] as const) for (const shape of CARRIED) {
        expect({ who, shape, read: (await call(who, 'get_page', { slug: slugOf(k, shape) })).text.includes(canaryOf(k, shape)) }).toEqual({ who, shape, read: false });
      }
    }

    test('an explicit purge rechecks inside its transaction: a derived page written after the carry keeps the origin soft-deleted and parked', async () => {
      const k = 'midsingle';
      await seed(k);
      const origin = slugOf(k, 'origin');
      const late = lateDerivedPage(k);
      let out: { isError: boolean; text: string };
      try { out = await localCall('delete_page', { slug: origin, purge: true, request_id: randomUUID(), expected_revision: await revision(origin) }); }
      finally { installFaultHook(undefined); }
      expect(out.isError ? out.text : '').toBe('');
      const receipt = JSON.parse(out.text);
      expect(receipt.status).not.toBe('purged');
      expect(receipt.purge_held?.code).toBe('derived_origin_parked');
      expect((await row(origin))?.deleted_at).not.toBeNull();
      await expectLateHidden(k, late);
      await backdate(origin);
      expect((await purgeDeletedPagesCoordinated(engine, 72, { automatic: true })).slugs).not.toContain(origin);
      expect((await fm(late)).visibility).toBe('private');
      expect((await purgeDeletedPagesCoordinated(engine, 72, { automatic: true })).slugs).toContain(origin);
      await expectLateHidden(k, late);
    }, 240_000);

    test('the bulk retention purge rechecks inside its transaction: a derived page written after the carry parks the origin and skips its row', async () => {
      const k = 'midbulk';
      await seed(k);
      const origin = slugOf(k, 'origin');
      await softDelete(origin);
      await backdate(origin);
      const late = lateDerivedPage(k);
      let held: Awaited<ReturnType<typeof purgeDeletedPagesCoordinated>>;
      try { held = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true }); }
      finally { installFaultHook(undefined); }
      expect(held.slugs).not.toContain(origin);
      expect(held.blocked.find(b => b.slug === origin)?.code).toBe('derived_origin_parked');
      expect((await row(origin))?.deleted_at).not.toBeNull();
      await expectLateHidden(k, late);
      expect((await purgeDeletedPagesCoordinated(engine, 72, { automatic: true })).slugs).not.toContain(origin);
      expect((await fm(late)).visibility).toBe('private');
      expect((await purgeDeletedPagesCoordinated(engine, 72, { automatic: true })).slugs).toContain(origin);
      await expectLateHidden(k, late);
    }, 240_000);

    test('an explicit purge of an origin parked by an earlier failed label still rechecks inside its transaction once the label retry succeeds', async () => {
      const k = 'reparked';
      await seed(k);
      const origin = slugOf(k, 'origin');
      const failing = spyOn(labelWrite, 'importAtRevision').mockImplementation(async () => { throw new Error('forced label failure'); });
      try {
        const first = JSON.parse((await localCall('delete_page', { slug: origin, purge: true, request_id: randomUUID(), expected_revision: await revision(origin) })).text);
        expect(first.purge_held?.code).toBe('derived_origin_parked');
      } finally { failing.mockRestore(); }
      expect((await checkDerivedOriginParked(engine)).status).toBe('warn');
      const late = lateDerivedPage(k);
      let out: { isError: boolean; text: string };
      try { out = await localCall('delete_page', { slug: origin, purge: true, request_id: randomUUID(), expected_revision: await revision(origin) }); }
      finally { installFaultHook(undefined); }
      expect(out.isError ? out.text : '').toBe('');
      expect(JSON.parse(out.text).purge_held?.code).toBe('derived_origin_parked');
      expect((await row(origin))?.deleted_at).not.toBeNull();
      await expectLateHidden(k, late);
      for (const shape of CARRIED) expect({ shape, visibility: (await fm(slugOf(k, shape))).visibility }).toEqual({ shape, visibility: 'private' });
      await backdate(origin);
      expect((await purgeDeletedPagesCoordinated(engine, 72, { automatic: true })).slugs).not.toContain(origin);
      expect((await purgeDeletedPagesCoordinated(engine, 72, { automatic: true })).slugs).toContain(origin);
      await expectLateHidden(k, late);
    }, 240_000);

    test('a soft delete whose carry fails after the delete committed returns the normal receipt', async () => {
      const k = 'carryfail';
      await seed(k);
      const origin = slugOf(k, 'origin');
      const original = privateVisibility.readHonorAliases;
      const failing = spyOn(privateVisibility, 'readHonorAliases').mockImplementation(async (...args: Parameters<typeof original>) => {
        if (new Error().stack?.includes('carryPrivate')) throw new Error('forced honor-alias failure');
        return original(...args);
      });
      let out: { isError: boolean; text: string };
      try { out = await localCall('delete_page', { slug: origin, request_id: randomUUID(), expected_revision: await revision(origin) }); }
      finally { failing.mockRestore(); }
      expect(out.isError ? out.text : '').toBe('');
      expect(JSON.parse(out.text).status).toBe('soft_deleted');
      expect((await row(origin))?.deleted_at).not.toBeNull();
      await backdate(origin);
      expect((await purgeDeletedPagesCoordinated(engine, 72, { automatic: true })).slugs).toContain(origin);
      for (const shape of CARRIED) expect({ shape, visibility: (await fm(slugOf(k, shape))).visibility }).toEqual({ shape, visibility: 'private' });
    }, 240_000);

    test('an explicit purge whose origin lookup fails is held: a parked origin is not purged and the pages derived from it stay hidden', async () => {
      const k = 'lookupfail';
      await seed(k);
      const origin = slugOf(k, 'origin');
      await parkByFailedLabel(origin);
      const original = privateVisibility.readHonorAliases;
      let thrown = 0;
      const failing = spyOn(privateVisibility, 'readHonorAliases').mockImplementation(async (...args: Parameters<typeof original>) => {
        if (new Error().stack?.includes('originOf')) { thrown++; throw new Error('forced origin lookup failure'); }
        return original(...args);
      });
      let out: { isError: boolean; text: string };
      try { out = await localCall('delete_page', { slug: origin, purge: true, request_id: randomUUID(), expected_revision: await revision(origin) }); }
      finally { failing.mockRestore(); }
      expect(out.isError ? out.text : '').toBe('');
      const receipt = JSON.parse(out.text);
      expect(receipt.status).not.toBe('purged');
      expect(receipt.purge_held?.code).toBe('derived_origin_unchecked');
      expect(thrown).toBeGreaterThan(0);
      expect((await row(origin))?.deleted_at).not.toBeNull();
      expect((await checkDerivedOriginParked(engine)).status).toBe('warn');
      await expectCarriedHidden(k);
      const retried = JSON.parse((await localCall('delete_page', { slug: origin, purge: true, request_id: randomUUID(), expected_revision: await revision(origin) })).text);
      expect(retried.status).toBe('purged');
      await nothingKept(origin);
      await expectCarriedHidden(k);
    }, 240_000);

    test('the single-page purge transaction rechecks a parked origin: submitted without the carry, it is held and its derived pages stay hidden', async () => {
      const k = 'parkedtx';
      await seed(k);
      const origin = slugOf(k, 'origin');
      await parkByFailedLabel(origin);
      const ctx = { engine, config: { engine: engine.kind }, remote: false, sourceId: SRC, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as never;
      const receipt = await withEnv({ GBRAIN_HOME: home }, async () => submitPageMutation(ctx, { operation: 'delete_page',
        params: { slug: origin, source_id: SRC, purge: true, request_id: randomUUID(), expected_revision: await revision(origin) } }));
      expect(receipt.status).not.toBe('purged');
      expect((receipt.purge_held as { code?: string } | undefined)?.code).toBe('derived_origin_parked');
      expect((await row(origin))?.deleted_at).not.toBeNull();
      await expectCarriedHidden(k);
      const retried = JSON.parse((await localCall('delete_page', { slug: origin, purge: true, request_id: randomUUID(), expected_revision: await revision(origin) })).text);
      expect(retried.status).toBe('purged');
      await nothingKept(origin);
      await expectCarriedHidden(k);
    }, 240_000);

    test('a stamp that fails parks the origin: never purged, named by doctor with the page that blocks it, the derived page stays hidden; fixed, the next purge stamps and unparks and the one after purges', async () => {
      const k = 'park';
      await seed(k);
      const base = await baseline(k);
      const origin = slugOf(k, 'origin'), blocking = slugOf(k, 'digest');
      // A page with a file in its source's checkout that this host cannot write (sync.write_through off): the label door holds it.
      const checkout = mkdtempSync(join(tmpdir(), 'gbrain-origin-carry-checkout-'));
      await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [SRC, checkout]);
      await engine.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [SRC, blocking, `${blocking}.md`]);
      await engine.setConfig('sync.write_through', 'false');
      try {
        const out = await localCall('delete_page', { slug: origin, purge: true, request_id: randomUUID(), expected_revision: await revision(origin) });
        expect(out.isError).toBe(false);
        const receipt = JSON.parse(out.text);
        expect(receipt.status).not.toBe('purged');
        expect(receipt.purge_held?.code).toBe('derived_origin_parked');
        expect((await row(origin))?.deleted_at).not.toBeNull();
        await backdate(origin);
        const held = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
        expect(held.slugs).not.toContain(origin);
        expect(held.blocked.find(b => b.slug === origin)?.code).toBe('derived_origin_parked');
        expect((await row(origin))?.deleted_at).not.toBeNull();
        const doctor = await checkDerivedOriginParked(engine);
        expect(doctor.status).toBe('warn');
        expect(doctor.message).toContain(`${SRC}/${origin}`);
        expect(doctor.message).toContain(blocking);
        expect((doctor.details as { origins: Array<{ slug: string; blocking_slug: string; reason: string }> }).origins)
          .toEqual([expect.objectContaining({ slug: origin, blocking_slug: blocking })]);
        __resetPrivateVisibilityCacheForTests();
        for (const who of ['unbound', 'alice'] as const) expect({ who, seen: await seen(who, k, 'digest') }).toEqual({ who, seen: none });
      } finally {
        await engine.setConfig('sync.write_through', 'true');
        await engine.executeRaw('UPDATE pages SET source_path=NULL WHERE source_id=$1 AND slug=$2', [SRC, blocking]);
        await engine.executeRaw('UPDATE sources SET local_path=NULL WHERE id=$1', [SRC]);
        rmSync(checkout, { recursive: true, force: true });
      }
      // Fixed: the next purge labels the page and unparks the origin but keeps it, since it was parked when that purge
      // began (so it was in no preview); the one after purges it.
      expect((await purgeDeletedPagesCoordinated(engine, 72, { automatic: true })).slugs).not.toContain(origin);
      expect((await checkDerivedOriginParked(engine)).status).toBe('ok');
      expect((await purgeDeletedPagesCoordinated(engine, 72, { automatic: true })).slugs).toContain(origin);
      await nothingKept(origin);
      await expectCarried(k, base.before, base.state, base.proposals);
    }, 240_000);
  });
}
