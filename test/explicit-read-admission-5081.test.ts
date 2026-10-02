/**
 * #5081 — a stdio connection bound by GBRAIN_SOURCE (or a .gbrain-source pin)
 * may name a federated source in an explicit `source_id` read.
 *
 * Pre-fix, `resolveRequestedScope` denied every explicit id outside the
 * scalar bound source, because `localFederatedSourceIds` returns undefined
 * for the explicit tiers. The fix (ENG-O6): the stdio transport computes
 * `explicitReadBinding` (bound source + non-archived `federated === true`
 * sources; just the bound source when it opted out, E-T2) and
 * `federatedSearchScope` alone passes it to `resolveRequestedScope` as the
 * explicit-read admission set. Unqualified reads stay scalar; image, loops
 * and code-intel keep denying; `requireWritablePage` is unchanged.
 *
 * Contexts are built by the real stdio scope resolver
 * (`resolveMcpStdioSourceScope`) and calls go through `dispatchToolCall`, the
 * same path `gbrain serve` uses. The subprocess transport test lives in
 * test/serve-stdio-bound-explicit-read.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import type { AuthInfo, OperationContext } from '../src/core/operations.ts';
import { requireWritablePage, resolveCodeIntelScope } from '../src/core/ops/context.ts';
import { dispatchToolCall, buildOperationContext, type DispatchOpts } from '../src/mcp/dispatch.ts';
import { resolveMcpStdioSourceScope } from '../src/mcp/server.ts';
import { withEnv } from './helpers/with-env.ts';
import { encodeDeepResearchId } from '../src/core/deep-research-id.ts';

let engine: PGLiteEngine;
let outsideCwd: string;
const SOURCES = ['default', 'work', 'notes', 'private', 'iso'] as const;
const MARKER = 'zebratelescope';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  outsideCwd = mkdtempSync(join(tmpdir(), 'gbrain-5081-cwd-'));
  // Seeded 'default' is federated=true. work: the bound anchor (federated
  // unset). notes: federated. private: never federated. iso: opted out.
  const configs: Record<string, string> = {
    work: '{}', notes: '{"federated": true}', private: '{}', iso: '{"federated": false}',
  };
  for (const [id, config] of Object.entries(configs)) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)`,
      [id, mkdtempSync(join(tmpdir(), `gbrain-5081-${id}-`)), config],
    );
  }
  for (const id of SOURCES) {
    const result = await importFromContent(engine, `topics/${id}-topic`,
      serializeMarkdown({}, `the ${MARKER} lives in ${id}`, '', { type: 'note', title: `Topic in ${id}`, tags: [] }),
      { sourceId: id, noEmbed: true, forceRechunk: true });
    expect(result.status).toBe('imported');
  }
  await engine.setConfig('search.mcp_keyword_only', 'true');
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

/** Dispatch options exactly as src/mcp/server.ts builds them for one call. */
async function stdioOpts(env: Record<string, string | undefined>, cwd = outsideCwd): Promise<DispatchOpts> {
  const scope = await withEnv(env, () => resolveMcpStdioSourceScope(engine, cwd));
  return {
    remote: true,
    transport: 'stdio',
    takesHoldersAllowList: ['world'],
    sourceId: scope.sourceId,
    ...(scope.localFederatedSourceIds ? { localFederatedSourceIds: scope.localFederatedSourceIds } : {}),
    ...(scope.explicitReadBinding ? { explicitReadBinding: scope.explicitReadBinding } : {}),
  };
}

const bound = (id = 'work') => stdioOpts({ GBRAIN_SOURCE: id });

async function call(opts: DispatchOpts, name: string, params: Record<string, unknown>) {
  const result = await dispatchToolCall(engine, name, params, opts);
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
}

function sourcesOf(body: unknown): string[] {
  const rows = Array.isArray(body) ? body : ((body as { results?: unknown[] }).results ?? []);
  return [...new Set(rows.map((row) => (row as { source_id: string }).source_id))].sort();
}

/** Each fixture page is `topics/<source>-topic`, so a slug names its source. */
function sourcesOfSlugs(slugs: string[]): string[] {
  return [...new Set(slugs.map((slug) => slug.replace(/^topics\/(.*)-topic$/, '$1')))].sort();
}

const reads: Array<[name: string, params: (sourceId: string) => Record<string, unknown>, sources: (body: any) => string[]]> = [
  ['search', (s) => ({ query: MARKER, source_id: s }), sourcesOf],
  ['query', (s) => ({ query: MARKER, expand: false, source_id: s }), sourcesOf],
  ['get_page', (s) => ({ slug: `topics/${s}-topic`, source_id: s }), (b) => [b.source_id]],
  ['list_pages', (s) => ({ source_id: s }), sourcesOf],
  ['resolve_slugs', (s) => ({ partial: 'topics', source_id: s }), (b) => sourcesOfSlugs(b)],
  ['recall', (s) => ({ query: MARKER, source_id: s }), (b) => sourcesOfSlugs(b.results.map((r: { slug: string }) => r.slug))],
];

describe('#5081 — transport computes the explicit-read binding', () => {
  test('GBRAIN_SOURCE binding: bound source + federated sources; unqualified scope stays scalar', async () => {
    const scope = await withEnv({ GBRAIN_SOURCE: 'work' }, () => resolveMcpStdioSourceScope(engine, outsideCwd));
    expect(scope.tier).toBe('env');
    expect(scope.localFederatedSourceIds).toBeUndefined();
    expect(scope.explicitReadBinding).toEqual({
      sourceId: 'work', via: 'GBRAIN_SOURCE', sourceIds: ['work', 'default', 'notes'], optedOut: ['iso'],
    });
  });

  test('E-T2: an isolated anchor (federated: false) admits only itself', async () => {
    const scope = await withEnv({ GBRAIN_SOURCE: 'iso' }, () => resolveMcpStdioSourceScope(engine, outsideCwd));
    expect(scope.explicitReadBinding?.sourceIds).toEqual(['iso']);
  });

  test('.gbrain-source pin produces a dotfile binding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-5081-pin-'));
    writeFileSync(join(dir, '.gbrain-source'), 'work\n');
    const scope = await withEnv({ GBRAIN_SOURCE: undefined }, () => resolveMcpStdioSourceScope(engine, dir));
    expect(scope.tier).toBe('dotfile');
    expect(scope.explicitReadBinding?.via).toBe('.gbrain-source');
    expect(scope.explicitReadBinding?.sourceIds).toEqual(['work', 'default', 'notes']);
  });

  test('an unbound stdio connection gets no binding (its federated widening is unchanged)', async () => {
    const scope = await withEnv({ GBRAIN_SOURCE: undefined }, () => resolveMcpStdioSourceScope(engine, outsideCwd));
    expect(scope.explicitReadBinding).toBeUndefined();
    expect(scope.localFederatedSourceIds).toEqual(['default', 'notes']);
  });
});

describe('#5081 — explicit reads from a GBRAIN_SOURCE-bound stdio connection', () => {
  for (const [name, params, sources] of reads) {
    test(`${name}: an explicit federated source is admitted and returns only that source`, async () => {
      const { isError, body } = await call(await bound(), name, params('notes'));
      expect(isError).toBe(false);
      expect(sources(body)).toEqual(['notes']);
    });

    test(`${name}: a source that is not federated is denied with the bound-connection hint`, async () => {
      const { isError, body } = await call(await bound(), name, params('private'));
      expect(isError).toBe(true);
      expect(['permission_denied', 'scope_denied']).toContain(body.error);
      expect(body.suggestion).toBe(
        'This connection is bound to source work (GBRAIN_SOURCE). private is not federated; the brain owner can run '
        + '`gbrain sources federate private` on the brain host, or start this connection without GBRAIN_SOURCE.',
      );
    });
  }

  test('fetch accepts the id of an admitted explicit search result and hides an unadmitted one', async () => {
    const { body: results } = await call(await bound(), 'search', { query: MARKER, source_id: 'notes' });
    const fetched = await call(await bound(), 'fetch', { id: results[0].id });
    expect(fetched.isError).toBe(false);
    expect(fetched.body.metadata.source_id).toBe('notes');
    const hidden = await call(await bound(), 'fetch', { id: encodeDeepResearchId('private', 'topics/private-topic') });
    expect(hidden.body.error).toBe('page_not_found');
  });

  test('denials carry the docs anchor', async () => {
    const { body } = await call(await bound(), 'search', { query: MARKER, source_id: 'private' });
    expect(body.docs).toBe('docs/guides/multi-source-brains.md#explicit-reads-from-a-bound-agent-connection');
  });

  test('a target that opted out is named as opted out', async () => {
    const { body } = await call(await bound(), 'search', { query: MARKER, source_id: 'iso' });
    expect(body.error).toBe('permission_denied');
    expect(body.suggestion).toContain('iso opted out of federation (federated: false)');
    expect(body.suggestion).toContain('`gbrain sources federate iso`');
  });

  test('unqualified reads stay scalar on the bound source', async () => {
    expect(sourcesOf((await call(await bound(), 'search', { query: MARKER })).body)).toEqual(['work']);
    expect(sourcesOf((await call(await bound(), 'list_pages', {})).body)).toEqual(['work']);
    const hidden = await call(await bound(), 'get_page', { slug: 'topics/notes-topic' });
    expect(hidden.isError).toBe(true);
  });

  test('__all__ is unchanged: it stays on the bound source', async () => {
    const { body } = await call(await bound(), 'search', { query: MARKER, source_id: '__all__' });
    expect(sourcesOf(body)).toEqual(['work']);
  });

  test('E-T2: an isolated anchor is refused with its own opt-out hint', async () => {
    const { isError, body } = await call(await bound('iso'), 'search', { query: MARKER, source_id: 'notes' });
    expect(isError).toBe(true);
    expect(body.suggestion).toBe(
      'This connection is bound to source iso (GBRAIN_SOURCE). iso opted out of federation (federated: false), so it '
      + 'reads no other source; the brain owner can run `gbrain sources federate iso` on the brain host, or start this '
      + 'connection without GBRAIN_SOURCE.',
    );
    const own = await call(await bound('iso'), 'search', { query: MARKER, source_id: 'iso' });
    expect(sourcesOf(own.body)).toEqual(['iso']);
  });

  test('.gbrain-source binding names the pin in its hint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-5081-pin-'));
    writeFileSync(join(dir, '.gbrain-source'), 'work\n');
    const opts = await stdioOpts({ GBRAIN_SOURCE: undefined }, dir);
    expect(sourcesOf((await call(opts, 'search', { query: MARKER, source_id: 'notes' })).body)).toEqual(['notes']);
    const { body } = await call(opts, 'search', { query: MARKER, source_id: 'private' });
    expect(body.suggestion).toBe(
      'This connection is bound to source work (.gbrain-source). private is not federated; the brain owner can run '
      + '`gbrain sources federate private` on the brain host, or start this connection outside the directory pinned by .gbrain-source.',
    );
  });
});

describe('#5081 — callers that pass no admission set keep denying (ENG-O6 pins)', () => {
  const ORIGINAL_HINT = 'Request access to this source, or omit source_id to search within your grant.';

  test('search_by_image still denies an explicit federated source', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const { isError, body } = await call(await bound(), 'search_by_image', { image_data: png, source_id: 'notes' });
    expect(isError).toBe(true);
    expect(body.error).toBe('permission_denied');
    expect(body.suggestion).toBe(ORIGINAL_HINT);
  });

  test('open_loops still denies an explicit federated source', async () => {
    const { isError, body } = await call(await bound(), 'open_loops', { source_id: 'notes' });
    expect(isError).toBe(true);
    expect(body.error).toBe('permission_denied');
    expect(body.suggestion).toBe(ORIGINAL_HINT);
  });

  test('code-intel scope resolution still denies an explicit federated source', async () => {
    // The code_* ops are closed to agent callers outright, so pin the resolver they share.
    const ctx = buildOperationContext(engine, {}, await bound()) as OperationContext;
    expect(() => resolveCodeIntelScope(ctx, 'notes')).toThrow(expect.objectContaining({
      code: 'permission_denied', suggestion: ORIGINAL_HINT,
    }));
  });

  test('requireWritablePage is unchanged: a page in an admitted source is still not writable or disclosed', async () => {
    const opts = await bound();
    const ctx = buildOperationContext(engine, {}, opts) as OperationContext;
    await expect(requireWritablePage(ctx, 'topics/notes-topic', 'add_link', 'from')).rejects.toMatchObject({
      code: 'page_not_found',
    });
  });
});

describe('#5081 — HTTP tokens and unbound stdio keep the no-widening rule', () => {
  async function noGrantOpts(): Promise<DispatchOpts> {
    const auth = { token: '', clientId: 'legacy', scopes: ['read'], sourceId: 'default', hasSourceGrant: false } as AuthInfo;
    return {
      remote: true, transport: 'http', sourceId: 'default', auth,
      localFederatedSourceIds: await noGrantFederatedScope(engine, false, 'default'),
    };
  }

  test('no-grant token: an explicit federated read is admitted and is a subset of its unqualified read', async () => {
    const opts = await noGrantOpts();
    const explicit = sourcesOf((await call(opts, 'search', { query: MARKER, source_id: 'notes' })).body);
    const unqualified = sourcesOf((await call(opts, 'search', { query: MARKER })).body);
    expect(explicit).toEqual(['notes']);
    for (const id of explicit) expect(unqualified).toContain(id);
  });

  test('no-grant token: a source outside the federated set is denied as not federated', async () => {
    const { body } = await call(await noGrantOpts(), 'search', { query: MARKER, source_id: 'private' });
    expect(body.error).toBe('permission_denied');
    expect(body.suggestion).toBe(
      'private is not federated; the brain owner can run `gbrain sources federate private` on the brain host, '
      + 'or omit source_id to read within this connection\'s sources.',
    );
  });

  test('unbound stdio: an explicit federated read is a subset of its unqualified read', async () => {
    const opts = await stdioOpts({ GBRAIN_SOURCE: undefined });
    const explicit = sourcesOf((await call(opts, 'search', { query: MARKER, source_id: 'notes' })).body);
    const unqualified = sourcesOf((await call(opts, 'search', { query: MARKER })).body);
    expect(explicit).toEqual(['notes']);
    for (const id of explicit) expect(unqualified).toContain(id);
    expect((await call(opts, 'search', { query: MARKER, source_id: 'private' })).isError).toBe(true);
  });

  test('a granted OAuth token is told about its grant, with the filled rescope command', async () => {
    const auth = {
      token: '', clientId: 'client-a', scopes: ['read'], sourceId: 'work', allowedSources: ['work'],
      principal: { kind: 'oauth_client', id: 'client-a' },
    } as AuthInfo;
    const opts: DispatchOpts = {
      remote: true, transport: 'http', sourceId: 'work', auth,
      localFederatedSourceIds: ['work', 'default', 'notes'],
    };
    const { body } = await call(opts, 'search', { query: MARKER, source_id: 'notes' });
    expect(body.error).toBe('permission_denied');
    expect(body.suggestion).toBe(
      'Your token is not granted notes; ask the brain owner to grant it '
      + '(gbrain auth rescope-client client-a --federated-read work,notes).',
    );
  });

  test('a granted legacy token is told to ask for a grant', async () => {
    const auth = { token: '', clientId: 'legacy', scopes: ['read'], sourceId: 'work', hasSourceGrant: true } as AuthInfo;
    const { body } = await call({ remote: true, transport: 'http', sourceId: 'work', auth }, 'search', { query: MARKER, source_id: 'notes' });
    expect(body.error).toBe('permission_denied');
    expect(body.suggestion).toBe('Your token is not granted notes; ask the brain owner to grant it.');
  });
});
