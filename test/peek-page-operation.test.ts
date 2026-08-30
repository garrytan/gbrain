import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { AuthInfo } from '../src/core/operations.ts';
import type { PagePeekSnapshot } from '../src/core/types.ts';
import {
  dispatchToolCall,
  operationAvailableOnTransport,
  suppressOperationTelemetry,
} from '../src/mcp/dispatch.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

interface AdmittedCagPeekFixture {
  consumer_contract: string;
  schema: 'gbrain_page_peek/v1';
  status: 'ok';
  source_id: string;
  slug: string;
  body: string;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
  body_sha256: string;
  deleted: boolean;
  deleted_at: null;
  retrievable: boolean;
  quarantined: boolean;
  embed_skipped: boolean;
  readback_mode: 'non_mutating_page_readback/v1';
  access_recorded: boolean;
}

const ADMITTED_CAG_PEEK = JSON.parse(
  readFileSync(new URL('./fixtures/gbrain-page-peek-admitted-cag-v1.json', import.meta.url), 'utf8'),
) as AdmittedCagPeekFixture;

const BODY_WITH_PRIVATE_FENCES = `# Exact page

Public prose remains.

## Takes

${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | PRIVATE_TAKE_PROOF | take | garry | 0.9 | 2026-08-29 | test |
${TAKES_FENCE_END}

## Facts

${FACTS_FENCE_BEGIN}
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | PRIVATE_FACT_PROOF | fact | 1.0 | private | high | 2026-08-29 |  | test |  |
| 2 | WORLD_FACT_PROOF | fact | 1.0 | world | high | 2026-08-29 |  | test |  |
${FACTS_FENCE_END}
`;

function auth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    token: 'test-token',
    clientId: 'peek-test-client',
    scopes: ['readback'],
    sourceId: 'source-a',
    allowedSources: ['source-a'],
    ...overrides,
  };
}

function snapshot(overrides: Partial<PagePeekSnapshot> = {}): PagePeekSnapshot {
  return {
    source_id: 'source-a',
    slug: 'wiki/exact',
    compiled_truth: BODY_WITH_PRIVATE_FENCES,
    frontmatter: { retained: 'frontmatter-value' },
    content_hash: 'sha256:page-content',
    deleted_at: null,
    quarantined: false,
    quarantine: null,
    embed_skipped: false,
    embed_skip: null,
    chunks: [
      {
        chunk_index: 0,
        chunk_source: 'compiled_truth',
        modality: 'text',
        model: 'test-model',
        token_count: 17,
        embedded_at: new Date('2026-08-29T12:00:00.000Z'),
        keyword_indexed: true,
        vector_indexed: true,
      },
    ],
    ...overrides,
  };
}

function fakeEngine(
  peek: (sourceId: string, slug: string, opts?: { includeDeleted?: boolean }) => Promise<PagePeekSnapshot | null>,
): BrainEngine {
  return { peekPage: peek } as unknown as BrainEngine;
}

function parseResult(result: Awaited<ReturnType<typeof dispatchToolCall>>): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('peek_page transport ownership', () => {
  const op = operationsByName.peek_page;

  test('is discoverable only on OAuth HTTP and has no CLI registration hints', () => {
    expect(op).toBeDefined();
    expect(operationAvailableOnTransport(op, 'oauth-http')).toBe(true);
    expect(operationAvailableOnTransport(op, 'stdio')).toBe(false);
    expect(operationAvailableOnTransport(op, 'legacy-http')).toBe(false);
    expect(operationAvailableOnTransport(op, 'local-cli')).toBe(false);
    expect(operationAvailableOnTransport(op, undefined)).toBe(false);
    expect(op.cliHints).toBeUndefined();
    expect(suppressOperationTelemetry(op)).toBe(true);
  });

  test('guessed stdio, legacy HTTP, and unidentified calls are unknown and never touch the engine', async () => {
    let calls = 0;
    const engine = fakeEngine(async () => {
      calls += 1;
      return snapshot();
    });
    for (const transport of ['stdio', 'legacy-http', undefined] as const) {
      const result = await dispatchToolCall(
        engine,
        'peek_page',
        { source_id: 'source-a', slug: 'wiki/exact' },
        { remote: true, transport, sourceId: 'source-a', auth: auth() },
      );
      expect(result.isError).toBe(true);
      expect(parseResult(result).error).toBe('unknown_tool');
    }
    expect(calls).toBe(0);
  });

  test('trusted local compatibility dispatch rejects the hidden operation', async () => {
    const engine = fakeEngine(async () => snapshot());
    await expect(handleToolCall(engine, 'peek_page', {
      source_id: 'source-a',
      slug: 'wiki/exact',
    })).rejects.toThrow('Unknown tool: peek_page');
  });
});

describe('peek_page authentication and exact source grant', () => {
  test('read/admin scopes do not inherit the dedicated readback capability', async () => {
    const engine = fakeEngine(async () => snapshot());
    for (const scopes of [['read'], ['admin'], ['write']] as const) {
      const result = await dispatchToolCall(
        engine,
        'peek_page',
        { source_id: 'source-a', slug: 'wiki/exact' },
        {
          remote: true,
          transport: 'oauth-http',
          sourceId: 'source-a',
          auth: auth({ scopes: [...scopes] }),
        },
      );
      expect(result.isError).toBe(true);
      expect(parseResult(result).error).toBe('insufficient_scope');
    }
  });

  test('rejects absent OAuth identity and source ids outside the token grant before engine access', async () => {
    let calls = 0;
    const engine = fakeEngine(async () => {
      calls += 1;
      return snapshot();
    });

    const unauthenticated = await dispatchToolCall(
      engine,
      'peek_page',
      { source_id: 'source-a', slug: 'wiki/exact' },
      { remote: true, transport: 'oauth-http', sourceId: 'source-a' },
    );
    expect(unauthenticated.isError).toBe(true);
    expect(parseResult(unauthenticated).error).toBe('permission_denied');

    const outsideGrant = await dispatchToolCall(
      engine,
      'peek_page',
      { source_id: 'source-b', slug: 'wiki/exact' },
      {
        remote: true,
        transport: 'oauth-http',
        sourceId: 'source-a',
        auth: auth(),
      },
    );
    expect(outsideGrant.isError).toBe(true);
    expect(parseResult(outsideGrant).error).toBe('permission_denied');
    expect(calls).toBe(0);
  });

  test('accepts an exact source from either the scalar or federated read grant', async () => {
    const seen: string[] = [];
    const engine = fakeEngine(async (sourceId) => {
      seen.push(sourceId);
      return snapshot({ source_id: sourceId });
    });

    for (const sourceId of ['source-a', 'source-b']) {
      const result = await dispatchToolCall(
        engine,
        'peek_page',
        { source_id: sourceId, slug: 'wiki/exact' },
        {
          remote: true,
          transport: 'oauth-http',
          sourceId: 'source-a',
          auth: auth({ sourceId: 'source-a', allowedSources: ['source-b'] }),
        },
      );
      expect(result.isError).toBeFalsy();
    }
    expect(seen).toEqual(['source-a', 'source-b']);
  });

  test('rejects federated sentinel, blank source, and blank slug before engine access', async () => {
    let calls = 0;
    const engine = fakeEngine(async () => {
      calls += 1;
      return snapshot();
    });
    for (const params of [
      { source_id: '__all__', slug: 'wiki/exact' },
      { source_id: ' ', slug: 'wiki/exact' },
      { source_id: 'source-a', slug: ' ' },
    ]) {
      const result = await dispatchToolCall(engine, 'peek_page', params, {
        remote: true,
        transport: 'oauth-http',
        sourceId: 'source-a',
        auth: auth({ allowedSources: ['source-a', '__all__'] }),
      });
      expect(result.isError).toBe(true);
      expect(parseResult(result).error).toBe('invalid_params');
    }
    expect(calls).toBe(0);
  });
});

describe('peek_page response privacy and no-mutation contract', () => {
  test('returns the v1 schema, privacy-filtered body, flags, and chunk metadata only', async () => {
    const seen: Array<{ sourceId: string; slug: string; includeDeleted: boolean }> = [];
    let metaCalls = 0;
    const engine = fakeEngine(async (sourceId, slug, opts) => {
      seen.push({ sourceId, slug, includeDeleted: opts?.includeDeleted === true });
      return snapshot();
    });

    const result = await dispatchToolCall(
      engine,
      'peek_page',
      { source_id: 'source-a', slug: 'wiki/exact', include_deleted: true },
      {
        remote: true,
        transport: 'oauth-http',
        sourceId: 'source-a',
        auth: auth(),
        metaHook: async () => {
          metaCalls += 1;
          return { brain_hot_memory: { should_not_appear: true } };
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(result._meta).toBeUndefined();
    expect(metaCalls).toBe(0);
    expect(seen).toEqual([{ sourceId: 'source-a', slug: 'wiki/exact', includeDeleted: true }]);

    const body = parseResult(result);
    expect(body.schema).toBe('gbrain_page_peek/v1');
    expect(body.schema_version).toBe('gbrain_page_peek/v1');
    expect(body.status).toBe('ok');
    expect(body.source_id).toBe('source-a');
    expect(body.slug).toBe('wiki/exact');
    expect(body.access_recorded).toBe(false);
    expect(body.content_hash).toBe('sha256:page-content');
    expect(body.quarantined).toBe(false);
    expect(body.embed_skipped).toBe(false);
    expect(body.retrievable).toBe(true);
    expect(body.readback_mode).toBe('non_mutating_page_readback/v1');
    expect(body.frontmatter).toEqual({ retained: 'frontmatter-value' });

    const compiledTruth = body.compiled_truth as string;
    expect(body.body).toBe(compiledTruth);
    expect(body.body_sha256).toBe(createHash('sha256').update(compiledTruth).digest('hex'));
    expect(compiledTruth).toContain('Public prose remains.');
    expect(compiledTruth).toContain('WORLD_FACT_PROOF');
    expect(compiledTruth).not.toContain('PRIVATE_FACT_PROOF');
    expect(compiledTruth).not.toContain('PRIVATE_TAKE_PROOF');
    expect(compiledTruth).not.toContain(TAKES_FENCE_BEGIN);

    const retrievability = body.retrievability as {
      chunk_count: number;
      indexed_chunks: number;
      keyword_indexed_chunks: number;
      vector_indexed_chunks: number;
      chunks: Array<Record<string, unknown>>;
    };
    expect(retrievability.chunk_count).toBe(1);
    expect(retrievability.indexed_chunks).toBe(1);
    expect(retrievability.keyword_indexed_chunks).toBe(1);
    expect(retrievability.vector_indexed_chunks).toBe(1);
    expect(retrievability.chunks[0]).toEqual({
      chunk_index: 0,
      chunk_source: 'compiled_truth',
      modality: 'text',
      model: 'test-model',
      token_count: 17,
      embedded_at: '2026-08-29T12:00:00.000Z',
      keyword_indexed: true,
      vector_indexed: true,
    });
    expect(retrievability.chunks[0]).not.toHaveProperty('chunk_text');
    expect(retrievability.chunks[0]).not.toHaveProperty('embedding');
  });

  test('matches the frozen admitted-CAG active-state consumer contract exactly', async () => {
    // Frozen compatibility boundary:
    // Agent/services/rlm-runtime/gateway/knowledge_federation.py::_gbrain_active_state
    expect(ADMITTED_CAG_PEEK.consumer_contract).toBe(
      'Agent/services/rlm-runtime/gateway/knowledge_federation.py::_gbrain_active_state',
    );
    const result = await dispatchToolCall(
      fakeEngine(async () => snapshot({
        source_id: ADMITTED_CAG_PEEK.source_id,
        slug: ADMITTED_CAG_PEEK.slug,
        compiled_truth: ADMITTED_CAG_PEEK.body,
        frontmatter: ADMITTED_CAG_PEEK.frontmatter,
      })),
      'peek_page',
      { source_id: ADMITTED_CAG_PEEK.source_id, slug: ADMITTED_CAG_PEEK.slug },
      {
        remote: true,
        transport: 'oauth-http',
        sourceId: ADMITTED_CAG_PEEK.source_id,
        auth: auth({
          sourceId: ADMITTED_CAG_PEEK.source_id,
          allowedSources: [ADMITTED_CAG_PEEK.source_id],
        }),
      },
    );

    expect(result.isError).toBeFalsy();
    const response = parseResult(result);
    const compatibilitySubset = {
      schema: response.schema,
      status: response.status,
      source_id: response.source_id,
      slug: response.slug,
      body: response.body,
      compiled_truth: response.compiled_truth,
      frontmatter: response.frontmatter,
      body_sha256: response.body_sha256,
      deleted: response.deleted,
      deleted_at: response.deleted_at,
      retrievable: response.retrievable,
      quarantined: response.quarantined,
      embed_skipped: response.embed_skipped,
      readback_mode: response.readback_mode,
      access_recorded: response.access_recorded,
    };
    const { consumer_contract: contractName, ...expected } = ADMITTED_CAG_PEEK;
    expect(contractName).toBe(
      'Agent/services/rlm-runtime/gateway/knowledge_federation.py::_gbrain_active_state',
    );
    expect(compatibilitySubset).toEqual(expected);

    // Mirror the consumer's fail-closed admission checks, including its
    // backward-compatible compiled_truth spelling.
    expect(response.compiled_truth).toBe(ADMITTED_CAG_PEEK.body);
    expect(response.retrievable).toBe(true);
    expect(response.access_recorded).toBe(false);
    expect(response.frontmatter).not.toBeNull();
    expect(Array.isArray(response.frontmatter)).toBe(false);
    expect(typeof response.frontmatter).toBe('object');
    expect(response.quarantined).toBe(false);
    expect(response.embed_skipped).toBe(false);
  });

  test('derives the top-level retrievable verdict from every eligibility gate', async () => {
    const cases: Array<{
      name: string;
      overrides: Partial<PagePeekSnapshot>;
      expected: boolean;
      indexedChunks: number;
    }> = [
      { name: 'active indexed page', overrides: {}, expected: true, indexedChunks: 1 },
      {
        name: 'deleted page',
        overrides: { deleted_at: new Date('2026-08-29T12:30:00.000Z') },
        expected: false,
        indexedChunks: 1,
      },
      {
        name: 'quarantined page',
        overrides: {
          frontmatter: { quarantine: { reason: 'review-required' } },
          quarantined: true,
          quarantine: { reason: 'review-required' },
        },
        expected: false,
        indexedChunks: 1,
      },
      {
        name: 'embed-skipped page',
        overrides: {
          frontmatter: { embed_skip: { reason: 'operator-requested' } },
          embed_skipped: true,
          embed_skip: { reason: 'operator-requested' },
        },
        expected: false,
        indexedChunks: 1,
      },
      {
        name: 'unindexed chunk',
        overrides: {
          chunks: [{
            ...snapshot().chunks[0]!,
            keyword_indexed: false,
            vector_indexed: false,
          }],
        },
        expected: false,
        indexedChunks: 0,
      },
      { name: 'no chunks', overrides: { chunks: [] }, expected: false, indexedChunks: 0 },
    ];

    for (const policyCase of cases) {
      const result = await dispatchToolCall(
        fakeEngine(async () => snapshot(policyCase.overrides)),
        'peek_page',
        { source_id: 'source-a', slug: 'wiki/exact', include_deleted: true },
        {
          remote: true,
          transport: 'oauth-http',
          sourceId: 'source-a',
          auth: auth(),
        },
      );
      const response = parseResult(result);
      expect(response.retrievable, policyCase.name).toBe(policyCase.expected);
      expect(
        (response.retrievability as Record<string, unknown>).indexed_chunks,
        policyCase.name,
      ).toBe(policyCase.indexedChunks);
    }
  });
});
