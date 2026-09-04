/**
 * Preferred-type recall regression.
 *
 * A federated corpus can contain enough bulk lexical matches to consume the
 * ordinary candidate window before a tiny, semantically authoritative type is
 * considered. These fixtures keep the bulk and derived sources separate and
 * prove the classifier's preferred types add recall without widening the
 * caller's source grant.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch, type HybridSearchOpts } from '../../src/core/search/hybrid.ts';
import type { HybridSearchMeta, PageType, SearchResult } from '../../src/core/types.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

const DIMS = 1536;
const QUERY_VECTOR = Array.from({ length: DIMS }, (_, i) => i === 0 ? 1 : 0);
const BULK_COUNT = 110;

let engine: PGLiteEngine;
let embedCalls = 0;
let previousGbrainHome: string | undefined;
let isolatedHome: string;

/** Install a deterministic embedding transport and count query embeds. */
function installWorkingEmbedTransport(): void {
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
    embedCalls += values.length;
    return { embeddings: values.map(() => QUERY_VECTOR) } as never;
  });
}

beforeAll(async () => {
  previousGbrainHome = process.env.GBRAIN_HOME;
  isolatedHome = mkdtempSync(join(tmpdir(), 'gbrain-preferred-type-recall-'));
  process.env.GBRAIN_HOME = isolatedHome;

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

});

afterAll(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  if (previousGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = previousGbrainHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});

beforeEach(async () => {
  resetGateway();
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  installWorkingEmbedTransport();
  await resetPgliteState(engine);
  embedCalls = 0;
});

afterEach(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
});

/** Add a federated source for source-scope fixtures. */
async function addSource(id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, '{"federated": true}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    [id],
  );
}

/** Persist one page and its compiled-truth search chunk. */
async function seedPage(input: {
  sourceId: string;
  slug: string;
  type: string;
  title: string;
  body: string;
  frontmatter?: Record<string, unknown>;
}): Promise<void> {
  await engine.putPage(input.slug, {
    type: input.type,
    title: input.title,
    compiled_truth: input.body,
    ...(input.frontmatter ? { frontmatter: input.frontmatter } : {}),
  }, { sourceId: input.sourceId });
  await engine.upsertChunks(input.slug, [{
    chunk_index: 0,
    chunk_text: input.body,
    chunk_source: 'compiled_truth',
  }], { sourceId: input.sourceId });
}

/** Fill an ordinary source beyond the pre-fusion pool floor. */
async function seedBulkMail(sourceId: string, phrase: string): Promise<void> {
  for (let i = 0; i < BULK_COUNT; i++) {
    await seedPage({
      sourceId,
      slug: `mail/bulk-message-${String(i).padStart(3, '0')}`,
      type: 'email',
      title: `Bulk message ${i}`,
      body: `${phrase} ${phrase} ${phrase} routine email thread ${i}`,
    });
  }
}

/** Keep integration searches deterministic and disable unrelated ranking stages. */
function searchOpts(sourceIds: string[], withQueryEmbedding = true): HybridSearchOpts {
  const opts: HybridSearchOpts = {
    limit: 20,
    sourceIds,
    detail: 'high' as const,
    expansion: false,
    reranker: { enabled: false, topNIn: 20, topNOut: null },
    autocut: false,
    adaptiveReturn: false,
    graph_signals: false,
    relationalRetrieval: false,
    salience: 'off' as const,
    recency: 'off' as const,
  };
  if (!withQueryEmbedding) return opts;
  return {
    ...opts,
    queryEmbedFn: async () => {
      embedCalls += 1;
      return Float32Array.from(QUERY_VECTOR);
    },
  };
}

/** Seed ordinary mail plus one allowed and one out-of-scope conversation page. */
async function seedConversationCorpus(): Promise<string[]> {
  const allowed = ['bulk-mail', 'derived-conversations'];
  for (const sourceId of [...allowed, 'outside-grant']) await addSource(sourceId);
  await seedBulkMail('bulk-mail', 'what was actually said at the kickoff call');
  await seedPage({
    sourceId: 'derived-conversations',
    slug: 'conversations/kickoff-call-2026-08-01',
    type: 'conversation',
    title: 'Kickoff Call 2026-08-01',
    body: 'What was actually said at the kickoff call? The recording captures each speaker turn.',
  });
  await seedPage({
    sourceId: 'outside-grant',
    slug: 'conversations/outside-kickoff-decoy',
    type: 'conversation',
    title: 'Outside Kickoff Call',
    body: 'what was actually said at the kickoff call '.repeat(12),
  });
  return allowed;
}

/** Build a stable synthetic result for reranker and ordering tests. */
function syntheticResult(
  slug: string,
  type: PageType,
  rank: number,
  sourceId = 'synthetic-source',
): SearchResult {
  return {
    slug,
    source_id: sourceId,
    page_id: 10_000 + rank,
    title: slug,
    type,
    chunk_text: `${slug} unique retrieval document`,
    chunk_source: 'compiled_truth',
    chunk_id: 20_000 + rank,
    chunk_index: 0,
    score: 1 - rank / 10_000,
    stale: false,
  };
}

/** Replace all recall engines with deterministic ordinary and typed pools. */
function installSyntheticSearchArms(preferred: SearchResult[]): {
  ordinary: SearchResult[];
  restore: () => void;
} {
  const ordinaryTypes = ['note', 'email', 'person', 'company'];
  const ordinary = Array.from({ length: 60 }, (_, i) =>
    syntheticResult(
      `ordinary/result-${String(i).padStart(2, '0')}`,
      ordinaryTypes[i % ordinaryTypes.length]!,
      i,
    ));
  const preferredTypes = new Set(['meeting', 'conversation']);
  const originalSearchKeyword = engine.searchKeyword.bind(engine);
  const originalSearchTitles = engine.searchTitles.bind(engine);
  const originalSearchVector = engine.searchVector.bind(engine);
  /** Route typed and ordinary calls to their deterministic candidate pools. */
  const resultsFor = (types: readonly string[] | undefined): SearchResult[] =>
    types?.some((type) => preferredTypes.has(type)) ? preferred : ordinary;

  engine.searchKeyword = async (_query, opts) => resultsFor(opts?.types);
  engine.searchTitles = async (_query, opts) => resultsFor(opts?.types);
  engine.searchVector = async (_embedding, opts) => resultsFor(opts?.types);

  return {
    ordinary,
    restore: () => {
      engine.searchKeyword = originalSearchKeyword;
      engine.searchTitles = originalSearchTitles;
      engine.searchVector = originalSearchVector;
    },
  };
}

describe('hybridSearch preferred-type recall', () => {
  test('explicit scalar and list type filters win without preferred typed lookups', async () => {
    const allowed = await seedConversationCorpus();

    const cases: Array<{
      hardFilter: { type: PageType } | { types: PageType[] };
      expectedType: PageType;
    }> = [
      { hardFilter: { type: 'conversation' }, expectedType: 'conversation' },
      { hardFilter: { types: ['email'] }, expectedType: 'email' },
    ];
    for (const { hardFilter, expectedType } of cases) {
      const originalSearchKeyword = engine.searchKeyword.bind(engine);
      const originalSearchTitles = engine.searchTitles.bind(engine);
      const originalSearchVector = engine.searchVector.bind(engine);
      let preferredTypedCalls = 0;
      const isPreferredLookup = (
        type: string | undefined,
        types: readonly string[] | undefined,
      ): boolean => type === undefined && types?.join(',') === 'meeting,conversation';
      engine.searchKeyword = async (query, opts) => {
        if (isPreferredLookup(opts?.type, opts?.types)) preferredTypedCalls += 1;
        return originalSearchKeyword(query, opts);
      };
      engine.searchTitles = async (query, opts) => {
        if (isPreferredLookup(opts?.type, opts?.types)) preferredTypedCalls += 1;
        return originalSearchTitles(query, opts);
      };
      engine.searchVector = async (embedding, opts) => {
        if (isPreferredLookup(opts?.type, opts?.types)) preferredTypedCalls += 1;
        return originalSearchVector(embedding, opts);
      };

      try {
        const results = await hybridSearch(
          engine,
          'What was actually said at the kickoff call?',
          { ...searchOpts(allowed), ...hardFilter },
        );
        expect(results.length).toBeGreaterThan(0);
        expect(results.every((result) => result.type === expectedType)).toBe(true);
        expect(preferredTypedCalls).toBe(0);
      } finally {
        engine.searchKeyword = originalSearchKeyword;
        engine.searchTitles = originalSearchTitles;
        engine.searchVector = originalSearchVector;
      }
    }
  });

  test('effective image-only modality suppresses every preferred-type lookup', async () => {
    await engine.setConfig('search.cross_modal.llm_intent', 'true');
    __setChatTransportForTests(async () => ({
      text: 'image',
      blocks: [],
      stopReason: 'end',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      model: 'test-model',
      providerId: 'test-provider',
    }));

    const originalSearchKeyword = engine.searchKeyword.bind(engine);
    const originalSearchTitles = engine.searchTitles.bind(engine);
    const originalSearchVector = engine.searchVector.bind(engine);
    let typedCalls = 0;
    engine.searchKeyword = async (query, opts) => {
      if (opts?.types?.length) typedCalls += 1;
      return originalSearchKeyword(query, opts);
    };
    engine.searchTitles = async (query, opts) => {
      if (opts?.types?.length) typedCalls += 1;
      return originalSearchTitles(query, opts);
    };
    engine.searchVector = async (embedding, opts) => {
      if (opts?.types?.length) typedCalls += 1;
      return originalSearchVector(embedding, opts);
    };

    try {
      await hybridSearch(
        engine,
        'What was actually said at the meeting about the chart?',
        searchOpts([]),
      );
      expect(typedCalls).toBe(0);
    } finally {
      engine.searchKeyword = originalSearchKeyword;
      engine.searchTitles = originalSearchTitles;
      engine.searchVector = originalSearchVector;
      __setChatTransportForTests(null);
    }
  });

  test('conversation page ranks first after the ordinary federated window is exhausted', async () => {
    const allowed = await seedConversationCorpus();

    const originalSearchVector = engine.searchVector.bind(engine);
    let typedVectorCalls = 0;
    engine.searchVector = async (embedding, opts) => {
      if (opts?.types?.join(',') === 'meeting,conversation') typedVectorCalls += 1;
      return originalSearchVector(embedding, opts);
    };
    try {
      const results = await hybridSearch(
        engine,
        'What was actually said at the kickoff call?',
        searchOpts(allowed),
      );
      expect(results[0]?.slug).toBe('conversations/kickoff-call-2026-08-01');
      expect(results.every((r) => r.source_id !== undefined && allowed.includes(r.source_id))).toBe(true);
      expect(typedVectorCalls).toBe(1);
      expect(embedCalls).toBe(1);
    } finally {
      engine.searchVector = originalSearchVector;
    }
  });

  test('an ordinary exact alias stays rank 1 while preferred conversation coverage stays visible', async () => {
    const allowed = await seedConversationCorpus();
    await seedPage({
      sourceId: 'bulk-mail',
      slug: 'notes/ordinary-call-alias-owner',
      type: 'note',
      title: 'Ordinary Alias Owner',
      body: 'Archived operations reference with no current call commentary.',
    });
    await engine.setPageAliases(
      'notes/ordinary-call-alias-owner',
      'bulk-mail',
      ['kickoff call verbatim'],
    );

    const results = await hybridSearch(
      engine,
      'kickoff call verbatim',
      searchOpts(allowed),
    );

    expect(results[0]?.slug).toBe('notes/ordinary-call-alias-owner');
    expect(results[0]?.alias_hit).toBe(true);
    expect(results[1]?.slug).toBe('conversations/kickoff-call-2026-08-01');
    expect(embedCalls).toBe(1);
  });

  test('an ordinary exact title stays rank 1 while preferred conversation coverage stays visible', async () => {
    const allowed = await seedConversationCorpus();
    await seedPage({
      sourceId: 'bulk-mail',
      slug: 'notes/kickoff-call-verbatim',
      type: 'note',
      title: 'Kickoff Call Verbatim',
      body: 'A named operating note whose identity exactly matches the lookup.',
    });

    const results = await hybridSearch(engine, 'kickoff call verbatim', searchOpts(allowed));

    expect(results[0]?.slug).toBe('notes/kickoff-call-verbatim');
    expect(results[0]?.exact_lookup).toBe('title');
    expect(results[1]?.slug).toBe('conversations/kickoff-call-2026-08-01');
  });

  test('private preferred candidates are never re-admitted for an excluding caller', async () => {
    const allowed = await seedConversationCorpus();
    await seedPage({
      sourceId: 'derived-conversations',
      slug: 'conversations/private-kickoff-call',
      type: 'conversation',
      title: 'Private Kickoff Call',
      body: 'what was actually said at the kickoff call '.repeat(20),
      frontmatter: { visibility: 'private' },
    });

    const results = await hybridSearch(
      engine,
      'What was actually said at the kickoff call?',
      { ...searchOpts(allowed), excludePrivate: true },
    );

    expect(results.map((result) => result.slug)).toContain('conversations/kickoff-call-2026-08-01');
    expect(results.map((result) => result.slug)).not.toContain('conversations/private-kickoff-call');
  });

  test('preferred lexical candidates survive an embedding-provider outage', async () => {
    const allowed = await seedConversationCorpus();
    const results = await hybridSearch(
      engine,
      'What was actually said at the kickoff call?',
      {
        ...searchOpts(allowed),
        queryEmbedFn: async () => {
          embedCalls += 1;
          throw new Error('synthetic embedding outage');
        },
      },
    );
    expect(results[0]?.slug).toBe('conversations/kickoff-call-2026-08-01');
    expect(results.every((r) => r.source_id !== undefined && allowed.includes(r.source_id))).toBe(true);
    expect(embedCalls).toBe(1);
  });

  test('preferred lexical candidates work without an embedding provider', async () => {
    const allowed = await seedConversationCorpus();
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: DIMS,
      env: {},
    });
    try {
      const results = await hybridSearch(
        engine,
        'What was actually said at the kickoff call?',
        searchOpts(allowed, false),
      );
      expect(results[0]?.slug).toBe('conversations/kickoff-call-2026-08-01');
      expect(results.every((r) => r.source_id !== undefined && allowed.includes(r.source_id))).toBe(true);
      expect(embedCalls).toBe(0);
    } finally {
      configureGateway({
        embedding_model: 'openai:text-embedding-3-large',
        embedding_dimensions: DIMS,
        env: { OPENAI_API_KEY: 'sk-test' },
      });
      installWorkingEmbedTransport();
    }
  });

  test('meeting note stays first while the raw transcript reaches the first 15 results', async () => {
    const allowed = ['bulk-mail', 'curated-meetings', 'raw-transcripts'];
    for (const sourceId of [...allowed, 'outside-grant']) await addSource(sourceId);
    await seedBulkMail('bulk-mail', 'what was actually said at the acme kickoff meeting');
    await seedPage({
      sourceId: 'curated-meetings',
      slug: 'meetings/acme-kickoff',
      type: 'meeting',
      title: 'Acme Kickoff Meeting',
      body: 'What was actually said at the Acme kickoff meeting? This curated note records the decisions.',
    });
    await seedPage({
      sourceId: 'raw-transcripts',
      slug: 'transcripts/acme-kickoff-raw',
      type: 'conversation',
      title: 'Session Recording 2026-08-01',
      body: 'What was actually said at the Acme kickoff meeting? This is the verbatim speaker transcript.',
    });
    await seedPage({
      sourceId: 'outside-grant',
      slug: 'transcripts/outside-acme-decoy',
      type: 'conversation',
      title: 'Outside Session Recording',
      body: 'what was actually said at the acme kickoff meeting '.repeat(12),
    });

    const originalSearchVector = engine.searchVector.bind(engine);
    let typedVectorCalls = 0;
    engine.searchVector = async (embedding, opts) => {
      if (opts?.types?.join(',') === 'meeting,conversation') typedVectorCalls += 1;
      return originalSearchVector(embedding, opts);
    };
    try {
      const results = await hybridSearch(
        engine,
        'What was actually said at the Acme kickoff meeting?',
        searchOpts(allowed),
      );
      const transcriptRank = results.findIndex((r) => r.slug === 'transcripts/acme-kickoff-raw') + 1;
      expect(results[0]?.slug).toBe('meetings/acme-kickoff');
      expect(transcriptRank).toBeGreaterThan(0);
      expect(transcriptRank).toBeLessThanOrEqual(15);
      expect(results.every((r) => r.source_id !== undefined && allowed.includes(r.source_id))).toBe(true);
      expect(typedVectorCalls).toBe(1);
      expect(embedCalls).toBe(1);
    } finally {
      engine.searchVector = originalSearchVector;
    }
  });

  test('tokenmax fail-open reranker input includes the recording winner and returns it first', async () => {
    const recording = syntheticResult('conversations/preferred-recording', 'conversation', 100);
    const { ordinary, restore } = installSyntheticSearchArms([recording]);
    let rerankerDocuments: string[] = [];
    try {
      const results = await hybridSearch(
        engine,
        'What was actually said at the kickoff call?',
        {
          ...searchOpts(['synthetic-source']),
          mode: 'tokenmax',
          limit: 50,
          autocut: true,
          reranker: {
            enabled: true,
            topNIn: 50,
            topNOut: null,
            rerankerFn: async (input) => {
              rerankerDocuments = input.documents;
              throw new Error('synthetic reranker outage');
            },
          },
        },
      );

      expect(rerankerDocuments).toContain(recording.chunk_text);
      expect(results[0]?.slug).toBe(recording.slug);
      expect(results.filter((r) => r.slug.startsWith('ordinary/')).map((r) => r.slug))
        .toEqual(ordinary.slice(0, 49).map((r) => r.slug));
      expect(embedCalls).toBe(1);
    } finally {
      restore();
    }
  });

  test('successful tokenmax rerank cannot drop or displace selected meeting coverage', async () => {
    const meeting = syntheticResult('meetings/preferred-curated', 'meeting', 100);
    const transcript = syntheticResult('transcripts/preferred-best', 'conversation', 101);
    const transcriptDecoy = syntheticResult('transcripts/lower-ranked-decoy', 'conversation', 102);
    const { restore } = installSyntheticSearchArms([meeting, transcript, transcriptDecoy]);
    let rerankerDocuments: string[] = [];
    let expectedNormalOrder: string[] = [];
    let autocutApplied: boolean | undefined;
    try {
      const results = await hybridSearch(
        engine,
        'What was actually said at the kickoff meeting?',
        {
          ...searchOpts(['synthetic-source']),
          mode: 'tokenmax',
          limit: 50,
          autocut: true,
          onMeta: (meta) => { autocutApplied = meta.autocut?.applied; },
          reranker: {
            enabled: true,
            topNIn: 50,
            topNOut: null,
            rerankerFn: async (input) => {
              rerankerDocuments = input.documents;
              const normalIndices = input.documents
                .map((document, index) => ({ document, index }))
                .filter(({ document }) => document.startsWith('ordinary/'))
                .reverse();
              expectedNormalOrder = normalIndices.map(({ document }) => document);
              const preferredIndices = input.documents
                .map((document, index) => ({ document, index }))
                .filter(({ document }) => !document.startsWith('ordinary/'));
              return [
                ...normalIndices.map(({ index }, rank) => ({ index, relevanceScore: 0.9 - rank * 0.001 })),
                ...preferredIndices.map(({ index }, rank) => ({ index, relevanceScore: 0.01 - rank * 0.001 })),
              ];
            },
          },
        },
      );

      expect(rerankerDocuments).toContain(meeting.chunk_text);
      expect(rerankerDocuments).toContain(transcript.chunk_text);
      expect(rerankerDocuments).not.toContain(transcriptDecoy.chunk_text);
      expect(results[0]?.slug).toBe(meeting.slug);
      expect(results.findIndex((r) => r.slug === transcript.slug) + 1).toBeLessThanOrEqual(15);
      expect(results.findIndex((r) => r.slug === transcriptDecoy.slug)).toBe(-1);
      expect(results.filter((r) => r.slug.startsWith('ordinary/')).map((r) => r.chunk_text))
        .toEqual(expectedNormalOrder);
      expect(autocutApplied).toBe(true);
      expect(embedCalls).toBe(1);
    } finally {
      restore();
    }
  });

  test('typed vector pool exhaustion does not pollute ordinary vector telemetry', async () => {
    const recording = syntheticResult('conversations/preferred-recording', 'conversation', 100);
    const { restore } = installSyntheticSearchArms([recording]);
    const syntheticSearchVector = engine.searchVector.bind(engine);
    let meta: HybridSearchMeta | undefined;
    engine.searchVector = async (embedding, opts) => {
      if (opts?.types?.join(',') === 'meeting,conversation') {
        opts.onVectorPoolMeta?.({ underfilled: true, escalations: 3, innerLimit: 50 });
      }
      return syntheticSearchVector(embedding, opts);
    };

    try {
      const results = await hybridSearch(
        engine,
        'What was actually said at the kickoff call?',
        { ...searchOpts(['synthetic-source']), onMeta: (value) => { meta = value; } },
      );

      expect(results[0]?.slug).toBe(recording.slug);
      expect(meta?.vector_pool_underfilled).toBeUndefined();
    } finally {
      restore();
    }
  });

  test('the final relational evidence slot composes after preferred coverage', async () => {
    await seedPage({
      sourceId: 'default',
      slug: 'companies/kickoff-call-verbatim',
      type: 'company',
      title: 'Kickoff Call Verbatim',
      body: 'A company used as the relational seed.',
    });
    await seedPage({
      sourceId: 'default',
      slug: 'people/alice-example',
      type: 'person',
      title: 'Alice Example',
      body: 'A seed-stage investor whose page does not repeat the query.',
    });
    await engine.addLink(
      'people/alice-example',
      'companies/kickoff-call-verbatim',
      '',
      'invested_in',
      'manual',
    );
    const recording = syntheticResult('conversations/preferred-recording', 'conversation', 100, 'default');
    const { restore } = installSyntheticSearchArms([recording]);
    let meta: HybridSearchMeta | undefined;

    try {
      const results = await hybridSearch(
        engine,
        'who invested in kickoff call verbatim',
        {
          ...searchOpts(['default']),
          limit: 3,
          relationalRetrieval: true,
          onMeta: (value) => { meta = value; },
        },
      );

      expect(results[0]?.slug).toBe(recording.slug);
      expect(results[2]?.slug).toBe('people/alice-example');
      expect(meta?.relational_evidence_slot?.slug).toBe('people/alice-example');
    } finally {
      restore();
    }
  });
});
