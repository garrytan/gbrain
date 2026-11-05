/**
 * GBRA-218 (A2): what is derived from a page under a folder rule is private,
 * exactly as for a page whose frontmatter is private. A meeting under a rule
 * does not fan "Discussed in <title>" onto a public attendee's timeline, facts
 * extracted from it do not land world on a public entity page, and outside any
 * caller record a page under a pending prefix stays hidden. Repo-less PGLite,
 * keyless; remote reads go through MCP dispatch with an unbound token.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { extractTimelineFromMeetings } from '../src/core/extract-timeline-from-meetings.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';
import { privatePagesFilterFragment } from '../src/core/search/private-visibility.ts';
import { privacyClass } from '../src/core/persistence/git-declared.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';

const SRC = 'fold-derive';
const DIMS = 1536;
const SECRET = 'partners/secret-example/';
let engine: PGLiteEngine;
let token = '';
const page = (type: string, title: string, body: string) => ['---', 'type: ' + type, 'title: ' + title, '---', '# ' + title, '', body].join('\n');

async function remote(op: string, params: Record<string, unknown>): Promise<string> {
  const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) })
    .verifyAccessToken(token) as unknown as AuthInfo;
  const out = await dispatchToolCall(engine, op, params, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'] });
  return out.content.map(c => c.text).join('\n');
}

describe('derivations from a page under a folder rule (pglite, repo-less)', () => {
  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array.from({ length: DIMS }, (_, i) => (i === 0 ? 1 : 0))) })) as never);
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [SRC]);
    await importFromContent(engine, 'people/bob-example', page('person', 'Bob Example', 'Bob profile.'), { sourceId: SRC, noEmbed: true });
    token = (await mintLegacyToken(engine, { name: 'unbound', scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] })).token;
    await proposeRevision(engine, SRC, [{ id: 'secret', prefix: SECRET, readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
  }, 120_000);
  afterAll(async () => {
    __setChatTransportForTests(null);
    __setEmbedTransportForTests(null);
    resetGateway();
    await engine.disconnect();
  });

  test('a meeting under a rule writes no timeline row onto a public attendee', async () => {
    await engine.putPage(SECRET + 'board', { type: 'meeting', title: 'Board Session Secretexample', compiled_truth: 'Board notes.', timeline: '',
      frontmatter: {}, effective_date: new Date('2026-04-20T00:00:00.000Z') }, { sourceId: SRC });
    await engine.addLinksBatch([{ from_slug: SECRET + 'board', to_slug: 'people/bob-example', link_type: 'attended', link_source: 'manual', from_source_id: SRC, to_source_id: SRC } as never]);
    await extractTimelineFromMeetings(engine, { gazetteer: new Map(), sourceIdFilter: SRC });
    const rows = await engine.executeRaw<{ summary: string }>(
      "SELECT t.summary FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.source_id = $1 AND p.slug = 'people/bob-example'", [SRC]);
    expect(rows.map(r => r.summary)).toEqual([]);
    expect(await remote('get_timeline', { slug: 'people/bob-example' })).not.toContain('Secretexample');
    expect(await remote('get_page', { slug: 'people/bob-example', include_timeline_entries: true })).not.toContain('Secretexample');
  }, 120_000);

  test('facts extracted from a page under a rule are private, not world on the public entity page', async () => {
    await engine.setConfig('facts.default_visibility', 'world');
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({ facts: [{ fact: 'Bob Example backs the secretexample merger.', kind: 'fact', entity: 'people/bob-example', confidence: 1.0, notability: 'high' }] }),
      blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test',
    }));
    const body = 'Bob Example said he backs the secretexample merger and will present it to the partners next week. '.repeat(8);
    const r = await runFactsBackstop({ slug: SECRET + 'notes', type: 'note', compiled_truth: body, frontmatter: {} },
      { engine, sourceId: SRC, sessionId: 'sync:' + SECRET + 'notes', source: 'sync:import', mode: 'inline' });
    expect(r.mode === 'inline' && r.inserted).toBe(1);
    const rows = await engine.executeRaw<{ visibility: string }>("SELECT visibility FROM facts WHERE source_id = $1 AND fact LIKE '%secretexample%'", [SRC]);
    expect(rows.map(f => f.visibility)).toEqual(['private']);
    expect(await remote('recall', { entity: 'people/bob-example' })).not.toContain('secretexample');
  }, 120_000);

  test('access does not decide where a page lives: a derived page and a page under a rule still belong in Git', async () => {
    expect(await privacyClass(engine, SRC, { slug: 'concepts/roadmap', type: 'concept', frontmatter: {} })).toBeNull();
    expect(await privacyClass(engine, SRC, { slug: SECRET + 'plan', type: 'note', frontmatter: { derived_from: ['people/bob-example'] } })).toBeNull();
  }, 60_000);

  test('outside any caller record, a page under a pending prefix is hidden', async () => {
    await importFromContent(engine, 'hr/salaries', page('note', 'Salaries', 'Pay bands.'), { sourceId: SRC, noEmbed: true });
    await engine.executeRaw("INSERT INTO access_pending_coverage (source_id, prefix, reason) VALUES ($1, 'hr/', 'pending')", [SRC]);
    try {
      const rows = await engine.executeRaw<{ slug: string }>(`SELECT p.slug FROM pages p WHERE p.source_id = $1 AND p.slug LIKE 'hr/%' AND ${privatePagesFilterFragment('p')}`, [SRC]);
      expect(rows).toEqual([]);
    } finally {
      await engine.executeRaw("DELETE FROM access_pending_coverage WHERE source_id = $1 AND prefix = 'hr/'", [SRC]);
    }
  }, 60_000);
});
