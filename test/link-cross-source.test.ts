/**
 * #4680 / #4381 — cross-source automatic links follow the source policy on every writer.
 *
 * Protects: (1) an outbound edge the source policy approved (`link_resolution.cross_source`,
 * or a `[[source:slug]]` reference from a federated origin) is written by put_page's link
 * preparation and kept by the source reconciliation sweep and the stale re-extract, with
 * `skipped_cross_source` reporting the drops instead of hiding them; (2) with the flag off
 * and a non-federated origin, cross-source candidates are dropped exactly as before and
 * counted; (3) canonical attendance keeps its foreign-person exception and the endpoint
 * revision fence still refuses a stale foreign endpoint; (4) a derived edge records whether
 * its reference was authored qualified (`links.resolution_type`), never because a resolver
 * picked another source; (5) read side: a reader granted one source never sees the other
 * source's endpoint through get_links, get_backlinks or the entity card, whether `remote`
 * is true or omitted, while a reader granted both sources does.
 * Fails when: the preparation gate or the sweep drops approved edges (the admitted rows
 * are then deleted by the next preserving replacement), the count is missing, the
 * attendance exception or revision fence is lost, resolution_type is not written, or a
 * link read scopes only one endpoint for an untrusted caller.
 * Seams: none (production entry points only). PGLite always, Postgres when DATABASE_URL
 * is set (test/postgres-unit-arms.txt lane).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName, type AuthInfo, type OperationContext } from '../src/core/operations.ts';
import { reconcileSourceLinks } from '../src/core/link-reconciliation.ts';
import { prepareAutomaticLinks } from '../src/core/persistence/links-preparation.ts';
import { extractManagedStaleLinks } from '../src/core/persistence/links-maintenance.ts';
import { loadActivePackForLocalEngine } from '../src/core/schema-pack/best-effort.ts';
import { readLineGrammarSettings } from '../src/core/line-grammar.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const ON = { GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: '1' };
const OFF = { GBRAIN_LINK_RESOLUTION_CROSS_SOURCE: undefined };

async function page(engine: BrainEngine, sourceId: string, slug: string, type: string, body = 'A page.') {
  await engine.putPage(slug, { type, title: slug.split('/').pop()!, compiled_truth: body, frontmatter: {} }, { sourceId });
}

async function setFederated(engine: BrainEngine, sourceId: string, federated: boolean) {
  await engine.executeRaw(`UPDATE sources SET config=$2::text::jsonb WHERE id=$1`, [sourceId, JSON.stringify(federated ? { federated: true } : {})]);
}

/** Every edge touching (sourceId, slug) as `from > to type producer`. */
async function edges(engine: BrainEngine, sourceId: string, slug: string) {
  const rows = await engine.executeRaw<{ edge: string }>(`SELECT f.source_id||':'||f.slug||' > '||t.source_id||':'||t.slug||' '||l.link_type||' '||l.link_source AS edge
    FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
    WHERE (f.source_id=$1 AND f.slug=$2) OR (t.source_id=$1 AND t.slug=$2)`, [sourceId, slug]);
  return rows.map(row => row.edge).sort();
}

/** put_page's automatic link pass for one page: prepare, lock, apply. */
async function derive(engine: BrainEngine, sourceId: string, slug: string) {
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const prepared = await prepareAutomaticLinks(engine, slug, { ...snapshot.page, frontmatter: snapshot.page.frontmatter ?? {} }, sourceId);
  return engine.transaction(async tx => { await tx.lockPageKeys(prepared.pageKeys); return prepared.apply(tx); });
}

const ORIGIN_BODY = 'Shared [[topics/shared]] and qualified [[beta:topics/shared]].\nBeta only [[topics/beta-only]].';
const SAME = 'alpha:notes/origin > alpha:topics/shared mentions markdown';
const QUALIFIED = 'alpha:notes/origin > beta:topics/shared mentions markdown';
const UNQUALIFIED = 'alpha:notes/origin > beta:topics/beta-only mentions markdown';

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`${backend}: #4680 cross-source automatic links follow the source policy on every writer`, () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    beforeAll(async () => {
      ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl));
      await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('alpha','alpha','{}'),('beta','beta','{}')`);
      await page(engine, 'alpha', 'topics/shared', 'note');
      await page(engine, 'beta', 'topics/shared', 'note');
      await page(engine, 'beta', 'topics/beta-only', 'note');
      await page(engine, 'beta', 'people/bob-example', 'person');
      await page(engine, 'alpha', 'notes/origin', 'note', ORIGIN_BODY);
    }, 120_000);
    afterAll(async () => { await close(); });

    test('policy denies (flag off, origin not federated): cross-source candidates are dropped as before and counted', () => withEnv(OFF, async () => {
      await setFederated(engine, 'alpha', false);
      const applied = await derive(engine, 'alpha', 'notes/origin');
      expect(await edges(engine, 'alpha', 'notes/origin')).toEqual([SAME]);
      expect(applied).toMatchObject({ errors: 0, skipped_cross_source: 2 });
    }), 60_000);

    test('a federated origin admits the qualified reference only; the unqualified foreign-only target is still counted', () => withEnv(OFF, async () => {
      await setFederated(engine, 'alpha', true);
      try {
        const applied = await derive(engine, 'alpha', 'notes/origin');
        expect(await edges(engine, 'alpha', 'notes/origin')).toEqual([SAME, QUALIFIED]);
        expect(applied).toMatchObject({ errors: 0, skipped_cross_source: 1 });
      } finally { await setFederated(engine, 'alpha', false); }
    }), 60_000);

    test('policy approves (flag on): both cross-source edges are kept and skipped_cross_source is 0', () => withEnv(ON, async () => {
      const applied = await derive(engine, 'alpha', 'notes/origin');
      expect(await edges(engine, 'alpha', 'notes/origin')).toEqual([SAME, UNQUALIFIED, QUALIFIED]);
      expect(applied).toMatchObject({ errors: 0, skipped_cross_source: 0 });
    }), 60_000);

    test('the source reconciliation sweep and the stale re-extract keep the admitted edges', () => withEnv(ON, async () => {
      const pack = (await loadActivePackForLocalEngine(engine, { sourceId: 'alpha' }))!.manifest;
      const swept = await reconcileSourceLinks(engine, 'alpha', { pack });
      expect(swept.ok).toBe(true);
      expect(swept.unresolved.filter(ref => ref.originSlug === 'notes/origin')).toEqual([]);
      expect(await edges(engine, 'alpha', 'notes/origin')).toEqual([SAME, UNQUALIFIED, QUALIFIED]);
      const stale = await extractManagedStaleLinks(engine, { sourceId: 'alpha', slugs: ['notes/origin'], maxPages: 1, mentions: false });
      expect(stale).toMatchObject({ pages: 1, removed: 0, skipped: 0 });
      expect(await edges(engine, 'alpha', 'notes/origin')).toEqual([SAME, UNQUALIFIED, QUALIFIED]);
    }), 60_000);

    test('flag off again: the sweep reports the foreign targets as cross_source and removes them, as before', () => withEnv(OFF, async () => {
      const pack = (await loadActivePackForLocalEngine(engine, { sourceId: 'alpha' }))!.manifest;
      const swept = await reconcileSourceLinks(engine, 'alpha', { pack });
      expect(swept.ok).toBe(true);
      expect(swept.unresolved.filter(ref => ref.originSlug === 'notes/origin').map(ref => [ref.target, ref.reason]).sort())
        .toEqual([['beta:topics/shared', 'cross_source'], ['topics/beta-only', 'cross_source']]);
      expect(await edges(engine, 'alpha', 'notes/origin')).toEqual([SAME]);
    }), 60_000);

    test('a preserving stale pass no longer deletes admitted cross-source rows absent from a reduced set (133 → 3)', () => withEnv(ON, async () => {
      for (let i = 0; i < 5; i++) await page(engine, 'beta', `topics/foreign-${i}`, 'note');
      await page(engine, 'alpha', 'notes/bulk', 'note', `See ${Array.from({ length: 5 }, (_, i) => `[[topics/foreign-${i}]]`).join(', ')} and [[topics/shared]].`);
      // The rows `extract links --source db` writes for this page: every approved endpoint, foreign ones included.
      const snapshot = (await engine.readPageSnapshot('notes/bulk', { sourceId: 'alpha' }))!;
      const rows = [...Array.from({ length: 5 }, (_, i) => ({ to_slug: `topics/foreign-${i}`, to_source_id: 'beta' })), { to_slug: 'topics/shared', to_source_id: 'alpha' }]
        .map(to => ({ from_slug: 'notes/bulk', from_source_id: 'alpha', link_type: 'mentions', link_source: 'markdown', origin_source_id: 'alpha', context: 'See', ...to }));
      await engine.replaceDerivedLinks({ slug: 'notes/bulk', sourceId: 'alpha', expectedRevision: snapshot.revision, sourceIncarnation: snapshot.sourceIncarnation },
        rows, { lineGrammar: await readLineGrammarSettings(engine) });
      expect(await edges(engine, 'alpha', 'notes/bulk')).toHaveLength(6);
      const applied = await derive(engine, 'alpha', 'notes/bulk');
      expect(applied).toMatchObject({ errors: 0, removed: 0, skipped_cross_source: 0 });
      expect(await edges(engine, 'alpha', 'notes/bulk')).toHaveLength(6);
    }), 60_000);

    test('canonical attendance keeps admitting a foreign person under the policy; denied, the attendance stays unresolved as before', async () => {
      await page(engine, 'alpha', 'meetings/standup', 'meeting', 'Attendees: [[people/bob-example]]');
      await withEnv(ON, async () => {
        expect(await derive(engine, 'alpha', 'meetings/standup')).toMatchObject({ errors: 0, skipped_cross_source: 0 });
        expect(await edges(engine, 'alpha', 'meetings/standup')).toEqual(['beta:people/bob-example > alpha:meetings/standup attended markdown']);
      });
      await withEnv(OFF, async () => {
        expect(await derive(engine, 'alpha', 'meetings/standup')).toMatchObject({ created: 0, removed: 0, errors: 1, unresolved_count: 1 });
        expect(await edges(engine, 'alpha', 'meetings/standup')).toEqual(['beta:people/bob-example > alpha:meetings/standup attended markdown']);
      });
    }, 60_000);

    test('the endpoint revision fence still refuses a foreign endpoint that changed after preparation', () => withEnv(ON, async () => {
      const snapshot = (await engine.readPageSnapshot('notes/origin', { sourceId: 'alpha' }))!;
      const prepared = await prepareAutomaticLinks(engine, 'notes/origin', { ...snapshot.page, frontmatter: snapshot.page.frontmatter ?? {} }, 'alpha');
      await page(engine, 'beta', 'topics/beta-only', 'note', 'Edited after the links were prepared.');
      const applied = await engine.transaction(async tx => { await tx.lockPageKeys(prepared.pageKeys); return prepared.apply(tx); });
      expect(applied).toMatchObject({ created: 0, removed: 0, errors: 1 });
      expect(await edges(engine, 'alpha', 'notes/origin')).toEqual([SAME]);
    }), 60_000);
  });

  describe(`${backend}: #4381 resolution_type records authored qualification`, () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    beforeAll(async () => {
      ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl));
      await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('alpha','alpha','{}'),('beta','beta','{}')`);
      await page(engine, 'beta', 'topics/beta-only', 'note');
      await page(engine, 'alpha', 'topics/own', 'note');
      await page(engine, 'alpha', 'notes/qualified', 'note', 'See [[beta:topics/beta-only]].');
      await page(engine, 'alpha', 'notes/unqualified', 'note', 'See [[topics/beta-only]] and [[topics/own]].');
    }, 120_000);
    afterAll(async () => { await close(); });

    test('a [[source:slug]] reference writes qualified; a resolver picking another source for a bare reference does not', () => withEnv(ON, async () => {
      for (const slug of ['notes/qualified', 'notes/unqualified']) expect(await derive(engine, 'alpha', slug)).toMatchObject({ errors: 0 });
      const rows = await engine.executeRaw<{ from_slug: string; to_source_id: string; resolution_type: string | null }>(
        `SELECT f.slug from_slug, t.source_id to_source_id, l.resolution_type FROM links l
         JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id='alpha' ORDER BY 1, 2`);
      expect(rows).toEqual([
        { from_slug: 'notes/qualified', to_source_id: 'beta', resolution_type: 'qualified' },
        { from_slug: 'notes/unqualified', to_source_id: 'alpha', resolution_type: 'unqualified' },
        { from_slug: 'notes/unqualified', to_source_id: 'beta', resolution_type: 'unqualified' },
      ]);
    }), 60_000);
  });

  describe(`${backend}: #4680 read side — a reader granted one source never sees the other source's endpoint`, () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    beforeAll(async () => {
      ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl));
      await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('alpha','alpha','{}'),('beta','beta','{}')`);
      await page(engine, 'alpha', 'topics/shared', 'note');
      await page(engine, 'beta', 'topics/shared', 'note');
      await page(engine, 'beta', 'topics/beta-only', 'note');
      await page(engine, 'alpha', 'notes/origin', 'note', ORIGIN_BODY);
      await withEnv(ON, async () => { expect(await derive(engine, 'alpha', 'notes/origin')).toMatchObject({ errors: 0, skipped_cross_source: 0 }); });
      expect(await edges(engine, 'alpha', 'notes/origin')).toEqual([SAME, UNQUALIFIED, QUALIFIED]);
    }, 120_000);
    afterAll(async () => { await close(); });

    const auth = (allowedSources: string[]) => ({ token: '', clientId: 'client-a', scopes: ['read'], sourceId: allowedSources[0], allowedSources,
      principal: { kind: 'oauth_client', id: 'client-a' } }) as AuthInfo;
    const keys = (rows: unknown) => (rows as Array<Record<string, string>>).map(r => `${r.from_source_id}:${r.from_slug} > ${r.to_source_id}:${r.to_slug}`).sort();
    const quiet = { info: () => {}, warn: () => {}, error: () => {} };
    /** The link ops through the MCP dispatcher (`remote: true`) and through a context whose `remote` is omitted (untrusted too). */
    const readers = (grant: string[]) => ({
      async remote(name: string, params: Record<string, unknown>) {
        const result = await dispatchToolCall(engine, name, params, { remote: true, transport: 'http', sourceId: grant[0], auth: auth(grant), config: {} as never });
        return JSON.parse(result.content[0].text);
      },
      async omitted(name: string, params: Record<string, unknown>) {
        const ctx = { engine, config: {} as never, logger: quiet, dryRun: false, sourceId: grant[0], auth: auth(grant), transport: 'http' } as unknown as OperationContext;
        return operationsByName[name].handler(ctx, params);
      },
    });

    for (const how of ['remote', 'omitted'] as const) {
      test(`${how}: granted [alpha] sees no beta endpoint; granted [alpha, beta] sees the admitted edges`, async () => {
        const alpha = readers(['alpha']);
        expect(keys(await alpha[how]('get_links', { slug: 'notes/origin' }))).toEqual(['alpha:notes/origin > alpha:topics/shared']);
        expect(keys(await alpha[how]('get_backlinks', { slug: 'topics/shared' }))).toEqual(['alpha:notes/origin > alpha:topics/shared']);
        expect(await alpha[how]('get_backlinks', { slug: 'topics/beta-only' })).toEqual([]);
        const beta = readers(['beta']);
        expect(await beta[how]('get_backlinks', { slug: 'topics/beta-only' })).toEqual([]);
        expect(await beta[how]('get_backlinks', { slug: 'topics/shared' })).toEqual([]);
        const both = readers(['alpha', 'beta']);
        expect(keys(await both[how]('get_links', { slug: 'notes/origin' }))).toEqual([
          'alpha:notes/origin > alpha:topics/shared', 'alpha:notes/origin > beta:topics/beta-only', 'alpha:notes/origin > beta:topics/shared']);
        expect(keys(await both[how]('get_backlinks', { slug: 'topics/beta-only' }))).toEqual(['alpha:notes/origin > beta:topics/beta-only']);
      }, 60_000);

      test(`${how}: the entity card confines its edges to the card's own source for an untrusted caller`, async () => {
        for (const grant of [['alpha'], ['alpha', 'beta']]) {
          const result = await readers(grant)[how]('entity', { name: 'notes/origin' }) as { found: boolean; card: { edges: Array<{ direction: string; slug: string }> } };
          expect(result.found).toBe(true);
          expect(result.card.edges.map(edge => `${edge.direction} ${edge.slug}`)).toEqual(['out topics/shared']);
        }
      }, 60_000);
    }

    test('the trusted local caller keeps the cross-source far endpoint', async () => {
      const ctx = { engine, config: {} as never, logger: quiet, dryRun: false, remote: false, sourceId: 'alpha' } as OperationContext;
      expect(keys(await operationsByName.get_links.handler(ctx, { slug: 'notes/origin' }))).toEqual([
        'alpha:notes/origin > alpha:topics/shared', 'alpha:notes/origin > beta:topics/beta-only', 'alpha:notes/origin > beta:topics/shared']);
    }, 60_000);
  });
}
