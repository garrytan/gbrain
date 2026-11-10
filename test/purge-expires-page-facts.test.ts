/**
 * A retention purge of a soft-deleted page expires that page's active facts, in the same transaction as the purge.
 *
 * 1. Protects: after the purge removes a deleted page's row, the facts filed on the page and the facts about it that no
 *    page row holds are expired (kept, never deleted), so they don't come back for any reader, local or remote, and a
 *    new page written at the slug starts clean. A fact another page holds about the slug stays active, live or
 *    soft-deleted (a restore brings it back), and so does an ontology observation about a live entity sourced from the
 *    purged page, and facts about other pages.
 * 2. Fails when: a purge deletes the page row and leaves its facts with expired_at NULL (facts have no foreign key to
 *    pages), on the bulk purge (purgeDeletedPages) or the belief-ledger purge of a recorded source
 *    (expireRecordedTombstones); or the fix deletes a fact row instead of expiring it, or expires it with no write attribution. The managed purge, which already
 *    sweeps the facts filed on the page, is pinned alongside.
 * 3. Real seams: writes and reads dispatched through MCP dispatch, remote reads with a minted token verified by the
 *    OAuth provider; a repo-less source, an unmanaged source the belief ledger records, and a managed brain; embeddings stubbed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { beliefBrain } from './helpers/belief-ledger.ts';

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
const text = (out: { content: Array<{ text: string }> }) => out.content.map(c => c.text).join('\n');

const SLUG = 'people/carol-example', OTHER = 'people/dan-example', SHELVED = 'people/erin-example';
const person = (title: string, body: string) => `---\ntype: person\ntitle: ${title}\n---\n# ${title}\n\n${body}`;

/** A fixture write outside coordination; on a managed brain the writer guard is paused around it. */
async function fixture(engine: BrainEngine, sql: string, params: unknown[]): Promise<void> {
  const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton = 1');
  if (brain?.enabled) await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
  try { await engine.executeRaw(sql, params); }
  finally { if (brain?.enabled) await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1'); }
}

/**
 * Seeds a page with a fact about it, a fact a live page holds about it and a fact about another page, deletes the page,
 * ages the tombstone past the window and runs `purge`; then checks every reader and a new page at the slug.
 */
async function purgedPageScenario(engine: BrainEngine, source: string, purge: () => Promise<string[]>, opts: { remoteReader?: boolean; sweepsFiled?: boolean } = {}) {
  const remoteReader = opts.remoteReader === true;
  __resetPrivateVisibilityCacheForTests();
  const local = async (op: string, params: Record<string, unknown>) =>
    dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId: source }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  const write = async (op: string, params: Record<string, unknown>) => {
    const out = await local(op, params);
    if (out.isError) throw new Error(`fixture ${op}: ${text(out)}`);
    return text(out);
  };
  let token = '';
  const remote = async (op: string, params: Record<string, unknown>) => {
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const auth = await provider.verifyAccessToken(token) as unknown as AuthInfo;
    return dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? source,
      takesHoldersAllowList: ['world'], sessionId: 'purge-expires-page-facts' }) as Promise<{ content: Array<{ text: string }> }>;
  };
  if (remoteReader) token = (await mintLegacyToken(engine, { name: 'reader', scopes: ['read'], takesHolders: ['world'], sourceGrant: [source] })).token;
  const revision = async () => (JSON.parse(await write('get_page', { slug: SLUG, include_deleted: true })) as { revision: string }).revision;
  const facts = () => engine.executeRaw<{ fact: string; expired: boolean }>(
    'SELECT fact, expired_at IS NOT NULL AS expired FROM facts WHERE source_id = $1 ORDER BY fact', [source]);

  await write('put_page', { slug: OTHER, content: person('Dan Example', 'Dan notes.') });
  await write('put_page', { slug: SHELVED, content: person('Erin Example', 'Erin notes.') });
  await write('put_page', { slug: SLUG, content: person('Carol Example', 'Carol notes.') });
  await write('remember', { fact: 'Carol Example harbor canarypurgedfact', entity: SLUG, provenance: 'fixture', visibility: 'world' });
  await write('remember', { fact: 'Carol Example harbor canaryheldelsewhere', entity: SLUG, provenance: 'fixture', visibility: 'world' });
  await write('remember', { fact: 'Dan Example harbor canaryotherpage', entity: OTHER, provenance: 'fixture', visibility: 'world' });
  await write('remember', { fact: 'Carol Example harbor canarynoholder', entity: SLUG, provenance: 'fixture', visibility: 'world' });
  await write('remember', { fact: 'Carol Example harbor canaryshelvedholder', entity: SLUG, provenance: 'fixture', visibility: 'world' });
  await write('ontology_propose', { entity: OTHER, dimension: 'employer', value: 'harbor canaryobservation', source: SLUG, confidence: 0.9, visibility: 'world' });
  // Facts about SLUG held by the live page OTHER, by no page, and by SHELVED (soft-deleted below, still restorable).
  await fixture(engine, "UPDATE facts SET source_markdown_slug = $2 WHERE source_id = $1 AND fact LIKE '%canaryheldelsewhere'", [source, OTHER]);
  await fixture(engine, "UPDATE facts SET source_markdown_slug = NULL WHERE source_id = $1 AND fact LIKE '%canarynoholder'", [source]);
  await fixture(engine, "UPDATE facts SET source_markdown_slug = $2 WHERE source_id = $1 AND fact LIKE '%canaryshelvedholder'", [source, SHELVED]);
  const shelvedRevision = async () => (JSON.parse(await write('get_page', { slug: SHELVED, include_deleted: true })) as { revision: string }).revision;
  await write('delete_page', { slug: SHELVED, expected_revision: await shelvedRevision() });
  expect((await facts()).every(f => !f.expired)).toBe(true);

  await write('delete_page', { slug: SLUG, expected_revision: await revision() });
  await fixture(engine, "UPDATE pages SET deleted_at = deleted_at - interval '100 hours' WHERE source_id = $1 AND slug = $2", [source, SLUG]);
  expect(await purge()).toContain(SLUG);
  expect((await engine.executeRaw('SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2', [source, SLUG])).length).toBe(0);

  // The managed purge sweeps the facts filed on the page (page-purge.ts); the other purges keep the row, expired.
  // The managed purge (page-purge.ts) sweeps the rows filed on the page and leaves facts held by no page alone.
  const expected = [
    { fact: 'Carol Example harbor canaryheldelsewhere', expired: false },
    { fact: 'Carol Example harbor canarynoholder', expired: !opts.sweepsFiled },
    ...(opts.sweepsFiled ? [] : [{ fact: 'Carol Example harbor canarypurgedfact', expired: true }]),
    { fact: 'Carol Example harbor canaryshelvedholder', expired: false },
    { fact: 'Dan Example harbor canaryotherpage', expired: false },
    // The managed purge also deletes the observations sourced from the page; the other purges keep them.
    ...(opts.sweepsFiled ? [] : [{ fact: expect.stringContaining('canaryobservation'), expired: false }]),
  ];
  expect(await facts()).toEqual(expected);
  // The expiry is attributed to the maintenance principal, like every other fact write.
  expect(await engine.executeRaw('SELECT fact FROM facts WHERE source_id = $1 AND expired_at IS NOT NULL AND last_write_principal_kind IS NULL', [source])).toEqual([]);
  // The soft-deleted holder comes back with its fact about the purged page.
  await write('restore_page', { slug: SHELVED, expected_revision: await shelvedRevision() });
  expect((await facts()).find(f => f.fact.includes('canaryshelvedholder'))?.expired).toBe(false);
  const reads = async () => {
    const out = [['local', text(await local('recall', { entity: SLUG }))]];
    if (remoteReader) out.push(['remote', text(await remote('recall', { entity: SLUG }))]);
    return out;
  };
  for (const [who, seen] of await reads()) {
    expect({ who, purged: seen.includes('canarypurgedfact') }).toEqual({ who, purged: false });
    expect({ who, held: seen.includes('canaryheldelsewhere') }).toEqual({ who, held: true });
  }

  await write('put_page', { slug: SLUG, content: person('Carol Two', 'A different page. canarynewpage') });
  for (const [who, seen] of await reads()) expect({ who, purged: seen.includes('canarypurgedfact') }).toEqual({ who, purged: false });
  expect(await facts()).toEqual(expected);
}

for (const kind of testBackends()) {
  const databaseUrl = kind === 'postgres' ? process.env.DATABASE_URL! : undefined;
  describe(`a purged page's facts stay expired (${kind})`, () => {
    beforeAll(() => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
    });
    afterAll(() => { __setEmbedTransportForTests(null); resetGateway(); });

    test('repo-less source, bulk purge: the page\'s facts are expired with it, for local and remote readers and a new page at the slug', async () => {
      let engine: BrainEngine, close: () => Promise<void>;
      if (databaseUrl) ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
      else { const pglite = new PGLiteEngine(); await pglite.connect({ engine: 'pglite' } as never); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
      try {
        await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-a', 'source-a') ON CONFLICT (id) DO NOTHING");
        await purgedPageScenario(engine, 'source-a', async () => (await purgeDeletedPagesCoordinated(engine, 72)).slugs, { remoteReader: true });
      } finally { await close(); }
    }, 240_000);

    test('unmanaged source the belief ledger records: the per-tombstone purge expires the page\'s facts too', async () => {
      await beliefBrain(async b => {
        await purgedPageScenario(b.engine, b.sourceId, async () => {
          const result = await purgeDeletedPagesCoordinated(b.engine, 72);
          expect((await b.events()).some(e => e.slug === SLUG && e.event_type === 'page.expired')).toBe(true);
          return result.slugs;
        });
      }, { managed: false, databaseUrl });
    }, 240_000);

    test('managed source: the purge sweeps the facts filed on the page and leaves none active', async () => {
      await managedBrain(async ({ engine }) => {
        await purgedPageScenario(engine, 'default', async () => (await purgeDeletedPagesCoordinated(engine, 72)).slugs, { sweepsFiled: true });
      }, databaseUrl ? { databaseUrl } : {});
    }, 240_000);
  });
}
