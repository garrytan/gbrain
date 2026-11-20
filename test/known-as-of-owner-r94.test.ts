/**
 * GST-3252 (R94): a recorded-time read (get_page and get_versions with known_as_of) shows each remote caller what its
 * current-time get_page shows it, no more and no less.
 *
 * 1. Protects: a credential bound to the brain owner reads its private pages' recorded history, private editions and
 *    the private rows of a page's Facts fence included, as its current-time get_page reads them; another member and an
 *    unbound token keep the world-only history rule; member access (readable_by) stays mandatory for the owner.
 * 2. Fails when: the owner's recorded-time read returns page_not_found or a narrower body for a page its current-time
 *    read returns, or any other caller sees a private edition.
 * 3. Real seams: tokens minted by the token service and verified by the serve --http verifier, dispatched through MCP
 *    dispatch (remote: true) on a repo-less PGLite brain, and on Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { renamePageOntoSlug } from '../src/commands/sync/rename-collision.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';

const OWNER = 'owner-example';
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const at = async (b: BeliefBrain) => {
  await pause();
  const [row] = await b.engine.executeRaw<{ t: string }>(`SELECT date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' AS t`);
  await pause();
  return new Date(row!.t).toISOString();
};
const priv = (prose: string) => beliefPage({ prose, frontmatter: { visibility: 'private' } });
const PIN_SLUGS = ['companies/secret-example', 'companies/opening-example', 'companies/fenced-example', 'companies/bob-example', 'companies/handover-example',
  'companies/moved-example', 'companies/closed-a-example', 'companies/reused-example', 'companies/reused-c-example', 'companies/fence-reused-example', 'companies/purged-example'];
/**
 * What the world-only ledger rule answers on each fixture page at each instant: get_page's outcome, then get_versions'
 * interval count or refusal, then any private canary the two returned. Recorded from the base before this change for
 * another member, an unbound token and the owner's credential speaking for a channel audience; all three matched.
 */
const WORLD_ONLY: Record<string, unknown[]> = {
  'companies/secret-example@t1': ['page_not_found', 'page_not_found'],
  'companies/secret-example@t2': ['page_not_found', 'page_not_found'],
  'companies/opening-example@t1': ['page_not_found', 'page_not_found'],
  'companies/opening-example@t2': ['ok', 1],
  'companies/fenced-example@t1': ['ok', 1],
  'companies/fenced-example@t2': ['ok', 1],
  'companies/bob-example@t1': ['page_not_found', 'page_not_found'],
  'companies/bob-example@t2': ['page_not_found', 'page_not_found'],
  'companies/handover-example@t1': ['page_not_found', 'page_not_found'],
  'companies/handover-example@t2': ['ok', 1],
  'companies/moved-example@t1': ['page_not_found', 'page_not_found'],
  'companies/moved-example@t2': ['ok', 1],
  'companies/closed-a-example@t1': ['page_not_found', 'page_not_found'],
  'companies/closed-a-example@t2': ['page_not_found', 'page_not_found'],
  'companies/reused-example@t1': ['page_not_found', 'page_not_found'],
  'companies/reused-example@t2': ['ok', 1],
  'companies/reused-c-example@t1': ['page_not_found', 'page_not_found'],
  'companies/reused-c-example@t2': ['page_not_found', 'page_not_found'],
  'companies/fence-reused-example@t1': ['page_not_found', 'page_not_found'],
  'companies/fence-reused-example@t2': ['ok', 2],
  'companies/purged-example@t1': ['page_not_found', 'page_not_found'],
  'companies/purged-example@t2': ['ok', 3],
};
/** Text only a read wider than the world-only rule returns. */
const PRIVATE_CANARIES = ['Secret first draft.', 'Secret second draft.', 'Private at first.', 'canaryprivrow', 'Bob only notes.', 'Bob era notes.', 'Lifetime A', 'Reused C private.', 'canaryerow'];

async function mintCallers(engine: BrainEngine, sourceId: string): Promise<Record<string, string>> {
  const tokens: Record<string, string> = {};
  for (const id of [OWNER, 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
  const mint = async (name: string, member?: string, mayActFor?: string[]) => {
    const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [sourceId] });
    tokens[name] = minted.token;
    if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member, ...(mayActFor ? { mayActFor } : {}) });
    else await readsUnscopedOnPurpose(engine, minted.id);
  };
  await mint('owner', OWNER, [`member:${OWNER}`, 'member:bob-example']);
  await mint('bob', 'bob-example');
  await mint('unbound');
  await setOwner(engine, OWNER);
  __resetPrivateVisibilityCacheForTests();
  return tokens;
}

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`recorded-time reads follow the caller's current-time visibility (${engineCase.name}, repo-less)`, () => {
    test('the owner reads its private history as its current-time read shows the page; another member and an unbound token still do not', () => beliefBrain(async b => {
      await b.put('companies/secret-example', priv('Secret first draft.'));
      await b.put('companies/opening-example', priv('Private at first.'));
      await b.put('companies/fenced-example', beliefPage({ prose: 'Fenced profile.', facts: ['Acme sells widgets', { claim: 'Acme payroll canaryprivrow', visibility: 'private' }] }));
      await b.put('companies/bob-example', beliefPage({ prose: 'Bob only notes.', frontmatter: { readable_by: '[bob-example]' } }));
      await b.put('companies/handover-example', beliefPage({ prose: 'Bob era notes.', frontmatter: { readable_by: '[bob-example]' } }));
      await b.put('companies/moved-example', priv('Lifetime A private.'));
      const t1 = await at(b);
      await b.put('companies/handover-example', beliefPage({ prose: 'Open era notes.' }));
      // Lifetime A leaves the slug and is closed to the owner; lifetime B, open, takes the slug.
      await renamePageOntoSlug(b.engine, { sourceId: b.sourceId, oldSlug: 'companies/moved-example', newSlug: 'companies/closed-a-example', to: 'companies/closed-a-example.md' });
      renameSync(join(b.root, 'companies/moved-example.md'), join(b.root, 'companies/closed-a-example.md'));
      await b.put('companies/closed-a-example', beliefPage({ prose: 'Lifetime A closed.', frontmatter: { visibility: 'private', readable_by: '[bob-example]' } }));
      await b.put('companies/moved-example', beliefPage({ prose: 'Lifetime B open.' }));
      // Lifetime C leaves the slug and stays the owner's to read; lifetime D, open, takes the slug.
      await b.put('companies/reused-example', priv('Reused C private.'));
      await renamePageOntoSlug(b.engine, { sourceId: b.sourceId, oldSlug: 'companies/reused-example', newSlug: 'companies/reused-c-example', to: 'companies/reused-c-example.md' });
      renameSync(join(b.root, 'companies/reused-example.md'), join(b.root, 'companies/reused-c-example.md'));
      await b.put('companies/reused-example', beliefPage({ prose: 'Reused D open.' }));
      // Lifetime E, world with a private fence row, leaves the slug; lifetime F takes it.
      await b.put('companies/fence-reused-example', beliefPage({ prose: 'Fence E open.', facts: ['Acme sells gears', { claim: 'Acme payroll canaryerow', visibility: 'private' }] }));
      await renamePageOntoSlug(b.engine, { sourceId: b.sourceId, oldSlug: 'companies/fence-reused-example', newSlug: 'companies/fence-e-example', to: 'companies/fence-e-example.md' });
      renameSync(join(b.root, 'companies/fence-reused-example.md'), join(b.root, 'companies/fence-e-example.md'));
      await b.put('companies/fence-reused-example', beliefPage({ prose: 'Fence F open.' }));
      // A purged lifetime and the one recreated at its slug: world history the other callers list.
      await b.put('companies/purged-example', beliefPage({ prose: 'Before the purge.' }));
      const purgedRevision = (await b.engine.executeRaw<{ r: string }>('SELECT knowledge_revision::text AS r FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, 'companies/purged-example']))[0]!.r;
      await b.op('delete_page', { slug: 'companies/purged-example', purge: true, expected_revision: purgedRevision });
      await b.put('companies/purged-example', beliefPage({ prose: 'After the purge.' }));
      await b.put('companies/secret-example', priv('Secret second draft.'));
      await b.put('companies/opening-example', beliefPage({ prose: 'Now public.' }));
      const t2 = await at(b);

      const tokens = await mintCallers(b.engine, b.sourceId);
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(b.engine), transaction: fn => b.engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      /** `owner-channel`: the owner's credential speaking for a channel audience that holds another member. */
      const call = async (who: string, op: string, params: Record<string, unknown>) => {
        const header = who === 'owner-channel' ? `member:${OWNER},member:bob-example` : undefined;
        const auth = await provider.verifyAccessToken(tokens[header ? 'owner' : who]!) as unknown as AuthInfo;
        const sourceId = auth.sourceId ?? b.sourceId;
        const localFederated = await noGrantFederatedScope(b.engine, auth.hasSourceGrant, sourceId);
        const out = await dispatchToolCall(b.engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId,
          takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'], ...(localFederated ? { localFederatedSourceIds: localFederated } : {}), ...(header ? { onBehalfOf: { header } } : {}) });
        return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
      };
      const now = (who: string, slug: string) => call(who, 'get_page', { slug, source_id: b.sourceId });
      const known = (who: string, slug: string, t: string) => call(who, 'get_page', { slug, known_as_of: t, source_id: b.sourceId });
      const history = (who: string, slug: string, t: string) => call(who, 'get_versions', { slug, known_as_of: t, include_body: true, diff: true, source_id: b.sourceId });
      const listed = async (who: string, slug: string, t: string) => {
        const out = await call(who, 'get_versions', { slug, known_as_of: t, source_id: b.sourceId });
        return out.isError ? JSON.parse(out.text).code : (JSON.parse(out.text).versions as Array<{ event: string }>).length;
      };

      // Pin: no caller but the owner's own credential gains a recorded-time read. Every other caller, the owner's credential
      // speaking for a channel audience included, gets exactly the world-only ledger rule's answer on every fixture page.
      const signature = async (who: string) => {
        const seen: Record<string, unknown> = {};
        for (const slug of PIN_SLUGS) {
          for (const [label, t] of [['t1', t1], ['t2', t2]] as const) {
            const page = await known(who, slug, t);
            const listing = await call(who, 'get_versions', { slug, known_as_of: t, include_body: true, diff: true, source_id: b.sourceId });
            const text = page.text + listing.text;
            seen[`${slug}@${label}`] = [page.isError ? JSON.parse(page.text).code : 'ok',
              listing.isError ? JSON.parse(listing.text).code : (JSON.parse(listing.text).versions as unknown[]).length,
              ...PRIVATE_CANARIES.filter(c => text.includes(c))];
          }
        }
        return seen;
      };
      for (const who of ['bob', 'unbound', 'owner-channel']) expect({ who, seen: await signature(who) }).toEqual({ who, seen: WORLD_ONLY });

      // Fixture control: the owner's current-time read shows the private page and the private fence row; nobody else's does.
      expect((await now('owner', 'companies/secret-example')).text).toContain('Secret second draft.');
      expect((await now('owner', 'companies/fenced-example')).text).toContain('canaryprivrow');
      for (const who of ['bob', 'unbound']) {
        expect({ who, shown: (await now(who, 'companies/secret-example')).text.includes('Secret second draft.') }).toEqual({ who, shown: false });
        expect({ who, shown: (await now(who, 'companies/fenced-example')).text.includes('canaryprivrow') }).toEqual({ who, shown: false });
      }

      // R94: the owner's recorded-time read is no narrower than its current-time read.
      expect(await known('owner', 'companies/secret-example', t2)).toMatchObject({ isError: false });
      expect((await known('owner', 'companies/secret-example', t2)).text).toContain('Secret second draft.');
      expect((await known('owner', 'companies/secret-example', t1)).text).toContain('Secret first draft.');
      const secret = (await history('owner', 'companies/secret-example', t2)).text;
      expect(secret).toContain('Secret first draft.');
      expect(secret).toContain('+Secret second draft.');
      expect((await known('owner', 'companies/opening-example', t1)).text).toContain('Private at first.');
      expect((await history('owner', 'companies/opening-example', t2)).text).toContain('Private at first.');
      expect((await known('owner', 'companies/fenced-example', t2)).text).toContain('canaryprivrow');
      // A metadata-only history lists the same intervals as one with bodies.
      expect(await listed('owner', 'companies/secret-example', t2)).toBe(2);
      expect(await listed('owner', 'companies/opening-example', t2)).toBe(2);

      // Member access stays mandatory for the owner: a page another member's readable_by closes answers neither read.
      for (const read of [await now('owner', 'companies/bob-example'), await known('owner', 'companies/bob-example', t2)]) {
        expect({ error: read.isError, code: read.isError ? JSON.parse(read.text).code : null, shown: read.text.includes('Bob only notes.') }).toEqual({ error: true, code: 'page_not_found', shown: false });
      }
      // ...and an edition whose own readers closed it to the owner stays closed after the page opens (as get_page as_of judges it).
      expect((await known('owner', 'companies/handover-example', t2)).text).toContain('Open era notes.');
      expect((await known('owner', 'companies/handover-example', t1)).text).not.toContain('Bob era notes.');
      const handover = await history('owner', 'companies/handover-example', t2);
      expect({ error: handover.isError, open: handover.text.includes('Open era notes.'), bob: handover.text.includes('Bob era notes.') }).toEqual({ error: false, open: true, bob: false });
      expect(await listed('owner', 'companies/handover-example', t2)).toBe(1);
      // ...and an earlier lifetime at the slug answers only while its own page is one the owner reads now.
      const moved = await history('owner', 'companies/moved-example', t2);
      expect({ error: moved.isError, b: moved.text.includes('Lifetime B open.'), a: moved.text.includes('Lifetime A') }).toEqual({ error: false, b: true, a: false });
      expect(await listed('owner', 'companies/moved-example', t2)).toBe(1);
      // An earlier lifetime keeps the world-only rule even while the owner reads its page: the live page's quarantine and held rows are not its own.
      expect((await now('owner', 'companies/reused-c-example')).text).toContain('Reused C private.');
      const fenceReused = await history('owner', 'companies/fence-reused-example', t2);
      expect({ error: fenceReused.isError, e: fenceReused.text.includes('Fence E open.'), row: fenceReused.text.includes('canaryerow') }).toEqual({ error: false, e: true, row: false });
      const reused = await history('owner', 'companies/reused-example', t2);
      expect({ error: reused.isError, d: reused.text.includes('Reused D open.'), c: reused.text.includes('Reused C') }).toEqual({ error: false, d: true, c: false });
      // The owner never lists less than the world-only rule lists every other remote caller.
      for (const slug of ['companies/purged-example', 'companies/opening-example', 'companies/handover-example', 'companies/moved-example']) {
        const [ownerCount, bobCount, unboundCount] = [await listed('owner', slug, t2), await listed('bob', slug, t2), await listed('unbound', slug, t2)];
        expect({ slug, ownerAtLeastBob: ownerCount >= bobCount, ownerAtLeastUnbound: ownerCount >= unboundCount }).toEqual({ slug, ownerAtLeastBob: true, ownerAtLeastUnbound: true });
      }
      expect(await listed('owner', 'companies/purged-example', t2)).toBe(await listed('unbound', 'companies/purged-example', t2));

      // Every other remote caller reads no more than before: world-only history, no private fence rows.
      for (const who of ['bob', 'unbound']) {
        for (const t of [t1, t2]) {
          const secretRead = await known(who, 'companies/secret-example', t);
          expect({ who, t, error: secretRead.isError, shown: secretRead.text.includes('Secret') }).toEqual({ who, t, error: true, shown: false });
        }
        expect({ who, shown: (await known(who, 'companies/opening-example', t1)).text.includes('Private at first.') }).toEqual({ who, shown: false });
        const opened = await history(who, 'companies/opening-example', t2);
        expect({ who, now: opened.text.includes('Now public.'), before: opened.text.includes('Private at first.') }).toEqual({ who, now: true, before: false });
        const fenced = await known(who, 'companies/fenced-example', t2);
        expect({ who, profile: fenced.text.includes('Fenced profile.'), row: fenced.text.includes('canaryprivrow') }).toEqual({ who, profile: true, row: false });
      }

    }, { managed: false, databaseUrl: engineCase.databaseUrl }), 180_000);
  });
}
