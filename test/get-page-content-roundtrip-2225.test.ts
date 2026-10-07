/**
 * #2225 — get_page must hand clients a round-trippable `content` field.
 *
 * Pre-fix, get_page returned compiled_truth and timeline as separate fields
 * with no canonical serialized form; a naive MCP client reassembling them
 * (or putting compiled_truth back alone) destroyed pages.timeline on the
 * next put_page. Post-fix:
 *   - get_page with include_content: true returns `content` — serializeMarkdown
 *     output with the `<!-- timeline -->` sentinel — so get→edit→put preserves
 *     the timeline. Opt-in: `content` roughly duplicates compiled_truth +
 *     timeline, and get_page is the most-called read op, so read-only callers
 *     don't pay double payload by default.
 *   - splitBody's bare `## Timeline` heading fallback (see markdown.test.ts)
 *     rescues clients that still hand-concatenate.
 *
 * Hermetic in-memory PGLite.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';

let engine: PGLiteEngine;
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

const getPage = operations.find((o) => o.name === 'get_page')!;
const putPage = operations.find((o) => o.name === 'put_page')!;

function localCtx(sourceId = 'default'): OperationContext {
  return {
    engine,
    config: {} as GBrainConfig,
    logger: noopLogger,
    dryRun: false,
    remote: false,
    sourceId,
  } as OperationContext;
}

beforeAll(async () => {
  // Keyless gateway so put_page's embed path degrades instead of calling out.
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  resetGateway(); // R5: restore the preload baseline for later files in this shard
  await engine.disconnect();
}, 30_000);

const ORIGINAL = `---
type: company
title: Acme Example
---

Acme builds widgets and has 42 employees.

<!-- timeline -->

- 2024-05-01: Series A closed
- 2025-02-10: Widget 2.0 launched
`;

describe('get_page content round-trip (#2225)', () => {
  test('get_page with include_content: true returns canonical `content` with the timeline sentinel', async () => {
    await putPage.handler(localCtx(), { slug: 'companies/acme-example', content: ORIGINAL });

    const page = (await getPage.handler(localCtx(), { slug: 'companies/acme-example', include_content: true })) as Record<string, unknown>;
    expect(typeof page.content).toBe('string');
    const content = page.content as string;
    expect(content).toContain('<!-- timeline -->');
    expect(content).toContain('Series A closed');
    expect(content).toContain('Acme builds widgets');
  }, 30_000);

  test('content is opt-in: absent by default so the hot read path does not double its payload', async () => {
    await putPage.handler(localCtx(), { slug: 'companies/optin-example', content: ORIGINAL });

    const page = (await getPage.handler(localCtx(), { slug: 'companies/optin-example' })) as Record<string, unknown>;
    expect('content' in page).toBe(false);
    // The split fields are still there for read-only consumers.
    expect(page.compiled_truth as string).toContain('Acme builds widgets');
    expect(page.timeline as string).toContain('Series A closed');
  }, 30_000);

  test('content_only: the round-trip fields without the duplicated compiled_truth / timeline / frontmatter', async () => {
    await putPage.handler(localCtx(), { slug: 'companies/contentonly-example', content: ORIGINAL });

    const full = (await getPage.handler(localCtx(), { slug: 'companies/contentonly-example', include_content: true })) as Record<string, unknown>;
    const lean = (await getPage.handler(localCtx(), { slug: 'companies/contentonly-example', include_content: true, content_only: true })) as Record<string, unknown>;
    expect(lean.content).toBe(full.content);
    expect(lean.revision).toBe(full.revision);
    expect(lean.slug).toBe('companies/contentonly-example');
    expect(lean.title).toBe('Acme Example');
    for (const dup of ['compiled_truth', 'timeline', 'frontmatter']) expect(dup in lean).toBe(false);
    expect(JSON.stringify(lean).length).toBeLessThan(JSON.stringify(full).length);

    // The lean read is enough for a revision-checked round trip.
    const edited = (lean.content as string).replace('42 employees', '44 employees');
    await putPage.handler(localCtx(), { slug: 'companies/contentonly-example', content: edited, expected_revision: lean.revision });
    const row = await engine.getPage('companies/contentonly-example', { sourceId: 'default' });
    expect(row!.compiled_truth ?? '').toContain('44 employees');
    expect(row!.timeline ?? '').toContain('Series A closed');
  }, 30_000);

  test('content_only without include_content is ignored (the default read shape is unchanged)', async () => {
    await putPage.handler(localCtx(), { slug: 'companies/contentonly-ignored', content: ORIGINAL });
    const page = (await getPage.handler(localCtx(), { slug: 'companies/contentonly-ignored', content_only: true })) as Record<string, unknown>;
    expect('content' in page).toBe(false);
    expect(page.compiled_truth as string).toContain('Acme builds widgets');
  }, 30_000);

  test('naive get_page.content → put_page preserves pages.timeline', async () => {
    await putPage.handler(localCtx(), { slug: 'companies/roundtrip-example', content: ORIGINAL });

    const before = (await getPage.handler(localCtx(), { slug: 'companies/roundtrip-example', include_content: true })) as Record<string, unknown>;
    expect((before.timeline as string)).toContain('Series A closed');

    // The naive client edit: take `content` verbatim (or with a body edit
    // above the sentinel) and put it straight back.
    const edited = (before.content as string).replace('42 employees', '43 employees');
    await putPage.handler(localCtx(), { slug: 'companies/roundtrip-example', content: edited, expected_revision: before.revision });

    const row = await engine.getPage('companies/roundtrip-example', { sourceId: 'default' });
    expect(row).not.toBeNull();
    expect(row!.timeline ?? '').toContain('Series A closed');
    expect(row!.timeline ?? '').toContain('Widget 2.0 launched');
    expect(row!.compiled_truth ?? '').toContain('43 employees');
    expect(row!.compiled_truth ?? '').not.toContain('Series A closed');
  }, 30_000);

  test('hand-concatenated compiled_truth + ## Timeline + timeline also survives put_page (splitBody fallback)', async () => {
    await putPage.handler(localCtx(), { slug: 'companies/concat-example', content: ORIGINAL });
    const page = (await getPage.handler(localCtx(), { slug: 'companies/concat-example' })) as Record<string, unknown>;

    const naive = `---
type: company
title: Acme Example
---

${page.compiled_truth as string}

## Timeline

${page.timeline as string}
`;
    await putPage.handler(localCtx(), { slug: 'companies/concat-example', content: naive, expected_revision: page.revision });

    const row = await engine.getPage('companies/concat-example', { sourceId: 'default' });
    expect(row!.timeline ?? '').toContain('Series A closed');
    expect(row!.compiled_truth ?? '').not.toContain('Series A closed');
  }, 30_000);
});

/**
 * The lean shape carries source_id, so a get→edit→put_page round trip on a
 * page outside the caller's default source writes back to that source. A
 * client that drops it gets a revision_conflict naming the source it read,
 * but only when the caller may read that source and page.
 */
describe('content_only round trip across sources', () => {
  const CLIENT = 'client-roundtrip-example';
  const PAGE = (body: string) => `---\ntype: company\ntitle: Acme Example\n---\n\n${body}\n`;
  const lean = async (slug: string, sourceId: string) => (await getPage.handler(localCtx(), {
    slug, source_id: sourceId, include_content: true, content_only: true })) as Record<string, string>;
  const remoteCtx = (readable: string[]): OperationContext => ({ ...localCtx(), remote: true, transport: 'http',
    auth: { token: 'fixture', clientId: CLIENT, principal: { kind: 'oauth_client', id: CLIENT }, scopes: ['read', 'write'],
      sourceId: 'default', allowedSources: readable } } as unknown as OperationContext);
  const refusal = async (ctx: OperationContext, params: Record<string, unknown>): Promise<OperationError> => {
    try { await putPage.handler(ctx, params); } catch (e) { if (e instanceof OperationError) return e; throw e; }
    throw new Error('put_page was expected to refuse');
  };
  const shape = (e: OperationError) => {
    const { write_request: _w, ...rest } = e.toJSON() as Record<string, unknown>;
    return { ...rest, suggestion: String(rest.suggestion).replace(/request_id [0-9a-f-]{36}/, 'request_id <id>') };
  };

  beforeAll(async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('work','work') ON CONFLICT DO NOTHING");
    await putPage.handler(localCtx(), { slug: 'companies/warmup-example', content: PAGE('Warm-up.') });
    await registerLocalWriter(engine, 'cli');
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id)
      VALUES($1,'fixture-hash','example-client','read write','default')`, [CLIENT]);
  }, 30_000);

  test('lean keys are pinned and include source_id', async () => {
    await putPage.handler(localCtx('work'), { slug: 'companies/keys-example', content: PAGE('Keys.') });
    const page = await lean('companies/keys-example', 'work');
    expect(Object.keys(page).sort()).toEqual(['content', 'revision', 'slug', 'source_id', 'tags', 'title', 'type']);
    expect(page.source_id).toBe('work');
  }, 30_000);

  test('passing the returned source_id writes back to the page that was read', async () => {
    await putPage.handler(localCtx('work'), { slug: 'companies/route-example', content: PAGE('Work copy, 42 employees.') });
    await putPage.handler(localCtx(), { slug: 'companies/route-example', content: PAGE('Default copy.') });
    const page = await lean('companies/route-example', 'work');
    await putPage.handler(localCtx(), { slug: 'companies/route-example', source_id: page.source_id,
      content: page.content.replace('42 employees', '44 employees'), expected_revision: page.revision });
    expect((await engine.getPage('companies/route-example', { sourceId: 'work' }))!.compiled_truth).toContain('44 employees');
    expect((await engine.getPage('companies/route-example', { sourceId: 'default' }))!.compiled_truth).toContain('Default copy.');
  }, 30_000);

  test('a naive write-back without source_id is refused with a refusal naming work', async () => {
    await putPage.handler(localCtx('work'), { slug: 'companies/naive-example', content: PAGE('Work only.') });
    const page = await lean('companies/naive-example', 'work');
    const error = await refusal(localCtx(), { slug: 'companies/naive-example', content: page.content.replace('only', 'edited'), expected_revision: page.revision });
    expect(error.code).toBe('revision_conflict');
    expect(error.suggestion).toContain('source work');
    expect(error.fix?.argv).toEqual(['gbrain', 'get', '--source', 'work', '--', 'companies/naive-example']);
    expect(error.fix?.mcp).toEqual({ tool: 'get_page', arguments: { slug: 'companies/naive-example', source_id: 'work', include_content: true } });
    expect(await engine.getPage('companies/naive-example', { sourceId: 'default' })).toBeNull();
    expect((await engine.getPage('companies/naive-example', { sourceId: 'work' }))!.compiled_truth).toContain('Work only.');
  }, 30_000);

  test('a remote caller that cannot read work gets the unchanged refusal: same shape, no hint', async () => {
    await putPage.handler(localCtx('work'), { slug: 'companies/unreadable-example', content: PAGE('Work only.') });
    const page = await lean('companies/unreadable-example', 'work');
    const hidden = await refusal(remoteCtx(['default']), { slug: 'companies/unreadable-example', content: page.content, expected_revision: page.revision });
    const control = await refusal(remoteCtx(['default']), { slug: 'companies/nowhere-example', content: page.content, expected_revision: page.revision });
    expect(hidden.code).toBe('revision_conflict');
    expect(hidden.fix).toBeUndefined();
    expect(JSON.stringify(hidden.toJSON())).not.toContain('work');
    expect(shape(hidden)).toEqual(shape(control));
    // The same caller granted work is told where the page lives.
    const granted = await refusal(remoteCtx(['default', 'work']), { slug: 'companies/unreadable-example', content: page.content, expected_revision: page.revision });
    expect(granted.suggestion).toContain('source work');
  }, 30_000);

  test('a private page in a readable source is not named to a remote caller', async () => {
    await putPage.handler(localCtx('work'), { slug: 'companies/private-example', content: `---\ntype: company\ntitle: Acme Example\nvisibility: private\n---\n\nPrivate.\n` });
    const page = await lean('companies/private-example', 'work');
    const error = await refusal(remoteCtx(['default', 'work']), { slug: 'companies/private-example', content: page.content, expected_revision: page.revision });
    expect(error.code).toBe('revision_conflict');
    expect(error.fix).toBeUndefined();
    expect(JSON.stringify(error.toJSON())).not.toContain('work');
    // A trusted local caller reads private pages, so it is told.
    expect((await refusal(localCtx(), { slug: 'companies/private-example', content: page.content, expected_revision: page.revision })).suggestion).toContain('source work');
  }, 30_000);

  test('an ordinary same-source conflict next to a namesake names no other source', async () => {
    await putPage.handler(localCtx('work'), { slug: 'companies/stale-example', content: PAGE('Work copy.') });
    await putPage.handler(localCtx(), { slug: 'companies/stale-example', content: PAGE('Default v1.') });
    const stale = await lean('companies/stale-example', 'default');
    await putPage.handler(localCtx(), { slug: 'companies/stale-example', content: PAGE('Default v2.'), expected_revision: stale.revision });
    const error = await refusal(localCtx(), { slug: 'companies/stale-example', content: PAGE('Default v3.'), expected_revision: stale.revision });
    expect(error.code).toBe('revision_conflict');
    expect(error.fix).toBeUndefined();
    expect(String(error.suggestion)).not.toContain('work');
  }, 30_000);
});
