import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { __clearQueryEmbedCacheForTests, configureGateway, embed, embedQuery, resetGateway } from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { compareRelevance, latencyPercentiles, rankDocuments, summarizeRelevance } from './metrics.ts';

const MODEL = 'embeddinggemma:latest';
const MODEL_ID = `ollama:${MODEL}`;
const DIMENSIONS = 768;
const QUERY_PREFIX = 'task: search result | query: ';
const REPEATS = 3;
const PRIMER = 'EmbeddingGemma evaluation warm primer.';
const UPSTREAM_BASE = 'f95338f94d3c679b5d0cb1182de052cce4b8e44f';
const DATASET_SHA256 = '8d19b7db7eb73cbaf50b6ee66e82e3a4bf4df19a0e1960996f55610b7a36156b';
const EXPECTED_MODEL_DIGEST = '85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1';
const datasetBytes = readFileSync(new URL('./dataset.json', import.meta.url));
const datasetHash = createHash('sha256').update(datasetBytes).digest('hex');
let failureStage = 'preflight';
const dataset = JSON.parse(datasetBytes.toString('utf8')) as {
  version: number;
  license: string;
  documents: Array<{ id: string; title: string; language: string; chunks: string[] }>;
  queries: Array<{ id: string; text: string; language: string; relevant: string[] }>;
};

type Arm = 'A' | 'B' | 'C';
type RequestPurpose = { arm: 'primer' | Arm; purpose: 'warmup' | 'index' | 'query'; id?: string; repetition?: number };
type VectorChunk = { documentId: string; chunkIndex: number; vector: Float32Array };
type SelectedProcess = { loaded: boolean; digest: string | null; size: number | null; sizeVram: number | null };
type ArmRun = {
  documentVectors: VectorChunk[];
  queryVectors: Array<{ queryId: string; repetition: number; vector: Float32Array }>;
  queryRuns: Array<{ queryId: string; language: string; relevant: string[]; repetition: number; ranked: ReturnType<typeof rankDocuments> }>;
  indexSamples: Array<{ documentId: string; chunkIndex: number; ms: number }>;
  queryLatencySamples: number[];
};

function args(argv: string[]) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: bun run.ts --endpoint <local Ollama base URL> --out <new evidence directory>');
    process.exit(0);
  }
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!['--endpoint', '--out'].includes(key) || !value || values.has(key)) throw new Error('args');
    values.set(key, value);
  }
  if (values.size !== 2) throw new Error('args');
  const endpoint = new URL(values.get('--endpoint')!);
  if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname)) throw new Error('endpoint');
  return { endpoint, out: values.get('--out')! };
}

function hashJson(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertVector(vector: Float32Array) {
  if (vector.length !== DIMENSIONS || [...vector].some((value) => !Number.isFinite(value)) ||
      vector.every((value) => value === 0)) throw new Error('vector');
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function json(url: URL, init?: RequestInit): Promise<unknown> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error('ollama');
    return await response.json();
  } catch {
    throw new Error('ollama');
  }
}

function selectedTag(metadata: unknown) {
  const models = record(metadata)?.models;
  if (!Array.isArray(models)) throw new Error('tag');
  const selected = models.map(record).find((item) => item && (item.name === MODEL || item.model === MODEL));
  if (!selected || typeof selected.digest !== 'string' || typeof selected.size !== 'number') throw new Error('tag');
  const details = record(selected.details);
  return {
    tag: MODEL,
    digest: selected.digest,
    size: selected.size,
    quantizationLevel: typeof details?.quantization_level === 'string' ? details.quantization_level : null,
    embeddingLength: typeof details?.embedding_length === 'number' ? details.embedding_length : null,
    dimensions: DIMENSIONS,
  };
}

function selectedProcess(metadata: unknown): SelectedProcess {
  const models = record(metadata)?.models;
  if (!Array.isArray(models)) throw new Error('process');
  const selected = models.map(record).find((item) => item && (item.name === MODEL || item.model === MODEL));
  return selected ? {
    loaded: true,
    digest: typeof selected.digest === 'string' ? selected.digest : null,
    size: typeof selected.size === 'number' ? selected.size : null,
    sizeVram: typeof selected.size_vram === 'number' ? selected.size_vram : null,
  } : { loaded: false, digest: null, size: null, sizeVram: null };
}

function nativeEmbeddingLength(metadata: unknown) {
  const modelInfo = record(record(metadata)?.model_info);
  if (!modelInfo) return null;
  const entry = Object.entries(modelInfo).find(([key, value]) => /(?:^|\.)embedding_length$/.test(key) && typeof value === 'number');
  return typeof entry?.[1] === 'number' ? entry[1] : null;
}

function validWireInputs(input: unknown): string[] {
  const values = typeof input === 'string' ? [input] : input;
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) throw new Error('wire');
  return values;
}

function sanitizedWireMetadata(body: Record<string, unknown>) {
  return {
    ...(typeof body.dimensions === 'number' ? { dimensions: body.dimensions } : {}),
    ...(typeof body.encoding_format === 'string' ? { encodingFormat: body.encoding_format } : {}),
  };
}

function toVectors(chunks: VectorChunk[]) {
  return chunks.map(({ documentId, chunkIndex, vector }) => ({ documentId, chunkIndex, vector: Array.from(vector) }));
}

function runQuality(run: ArmRun, repeat?: number) {
  const selected = repeat === undefined ? run.queryRuns : run.queryRuns.filter((query) => query.repetition === repeat);
  const rankings = selected.map((query) => ({ id: query.queryId, ranked: query.ranked, relevant: query.relevant }));
  const topK = [1, 3, 5].map((k) => summarizeRelevance(rankings, k));
  const languageSlices = [...new Set(selected.map((query) => query.language))].sort().map((language) => ({
    language,
    topK: [1, 3, 5].map((k) => summarizeRelevance(rankings.filter((_, index) => selected[index]!.language === language), k)),
  }));
  return { queryRunCount: selected.length, topK, languageSlices };
}

function compareArms(before: ArmRun, after: ArmRun) {
  return [1, 3, 5].map((k) => {
    const prior = summarizeRelevance(before.queryRuns.map((q) => ({ id: `${q.queryId}:${q.repetition}`, ranked: q.ranked, relevant: q.relevant })), k);
    const next = summarizeRelevance(after.queryRuns.map((q) => ({ id: `${q.queryId}:${q.repetition}`, ranked: q.ranked, relevant: q.relevant })), k);
    const delta = next.hitQueries - prior.hitQueries;
    const movement = compareRelevance(prior.perQuery, next.perQuery);
    const describe = (ids: string[]) => ids.map((id) => {
      const [queryId, repetition] = id.split(':');
      return { queryId, repetition: Number(repetition) };
    });
    return {
      k,
      hitQueryDelta: delta,
      hitRateDelta: next.hitRate - prior.hitRate,
      gains: describe(movement.gains),
      regressions: describe(movement.regressions),
      unchanged: movement.unchanged,
    };
  });
}

async function main() {
  failureStage = 'corpus-hash';
  if (datasetHash !== DATASET_SHA256) throw new Error('dataset');
  const { endpoint, out } = args(Bun.argv.slice(2));
  mkdirSync(out, { recursive: false });
  writeFileSync(join(out, 'dataset.json'), datasetBytes);

  const api = (path: string) => new URL(path, endpoint);
  failureStage = 'selected-tag-preflight';
  const tagBefore = selectedTag(await json(api('/api/tags')));
  if (tagBefore.digest !== EXPECTED_MODEL_DIGEST) throw new Error('digest');
  failureStage = 'native-dimension-preflight';
  const show = await json(api('/api/show'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: MODEL }) });
  const nativeDimensions = nativeEmbeddingLength(show) ?? tagBefore.embeddingLength;
  if (nativeDimensions !== null && nativeDimensions !== DIMENSIONS) throw new Error('dimensions');
  failureStage = 'selected-process-preflight';
  const processBefore = selectedProcess(await json(api('/api/ps')));
  if (processBefore.digest && processBefore.digest !== EXPECTED_MODEL_DIGEST) throw new Error('digest');
  const recipe = getRecipe('ollama');
  const embedding = recipe?.touchpoints?.embedding;
  const formatInput = embedding?.format_input;
  if (!embedding || !formatInput || formatInput('body', { model: MODEL, input_type: 'document' }) !== 'title: none | text: body' ||
      formatInput('body', { model: MODEL, input_type: 'document', document_title: 'Title' }) !== 'title: Title | text: body') throw new Error('formatter');

  let activePurpose: RequestPurpose | null = null;
  const wireRequests: Array<RequestPurpose & { model: string; inputs: string[]; dimensions?: number; encodingFormat?: string }> = [];
  const forwarder = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/v1/embeddings' || request.method !== 'POST' || !activePurpose) return new Response(null, { status: 404 });
    try {
      const body = record(await request.json());
      if (!body) return new Response(null, { status: 400 });
      const inputs = validWireInputs(body.input);
      if (body.model !== MODEL) return new Response(null, { status: 400 });
      wireRequests.push({ ...activePurpose, model: MODEL, inputs: [...inputs], ...sanitizedWireMetadata(body) });
      const response = await fetch(api('/v1/embeddings'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return new Response(response.body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } });
    } catch {
      return new Response(null, { status: 502 });
    }
  } });

  const runs: Record<Arm, ArmRun> = {
    A: { documentVectors: [], queryVectors: [], queryRuns: [], indexSamples: [], queryLatencySamples: [] },
    B: { documentVectors: [], queryVectors: [], queryRuns: [], indexSamples: [], queryLatencySamples: [] },
    C: { documentVectors: [], queryVectors: [], queryRuns: [], indexSamples: [], queryLatencySamples: [] },
  };
  let primerMs = 0;
  let processAfterPrimer: SelectedProcess = { loaded: false, digest: null, size: null, sizeVram: null };
  const wallStart = performance.now();
  const queryArm = async (arm: Arm) => {
    failureStage = `query-arm-${arm.toLowerCase()}`;
    for (const query of dataset.queries) {
      for (let repetition = 1; repetition <= REPEATS; repetition++) {
        __clearQueryEmbedCacheForTests();
        activePurpose = { arm, purpose: 'query', id: query.id, repetition };
        const start = performance.now();
        const vector = await embedQuery(query.text, { ...(arm === 'A' ? {} : { queryPrefix: QUERY_PREFIX }) });
        const ms = performance.now() - start;
        assertVector(vector);
        const vectorChunks = runs[arm === 'C' ? 'C' : 'A'].documentVectors;
        const documents = dataset.documents.map((document) => ({
          id: document.id,
          chunks: vectorChunks.filter((chunk) => chunk.documentId === document.id).map((chunk) => chunk.vector),
        }));
        runs[arm].queryVectors.push({ queryId: query.id, repetition, vector });
        runs[arm].queryLatencySamples.push(ms);
        runs[arm].queryRuns.push({ queryId: query.id, language: query.language, relevant: query.relevant, repetition, ranked: rankDocuments(vector, documents) });
      }
    }
  };
  try {
    failureStage = 'gateway-configuration';
    configureGateway({ embedding_model: MODEL_ID, embedding_dimensions: DIMENSIONS, env: {}, base_urls: { ollama: `http://127.0.0.1:${forwarder.port}/v1` } });
    failureStage = 'warm-primer';
    activePurpose = { arm: 'primer', purpose: 'warmup' };
    const primerStart = performance.now();
    const [primerVector] = await embed([PRIMER], { inputType: 'document', maxRetries: 0 });
    primerMs = performance.now() - primerStart;
    if (!primerVector) throw new Error('primer');
    assertVector(primerVector);
    processAfterPrimer = selectedProcess(await json(api('/api/ps')));
    if (processAfterPrimer.digest && processAfterPrimer.digest !== EXPECTED_MODEL_DIGEST) throw new Error('digest');
    if (!processAfterPrimer.loaded || !processAfterPrimer.sizeVram || processAfterPrimer.sizeVram <= 0) throw new Error('gpu');

    failureStage = 'raw-index-arm-a';
    embedding.format_input = undefined;
    for (const document of dataset.documents) {
      for (let chunkIndex = 0; chunkIndex < document.chunks.length; chunkIndex++) {
        activePurpose = { arm: 'A', purpose: 'index', id: `${document.id}:${chunkIndex}` };
        const start = performance.now();
        const [vector] = await embed([document.chunks[chunkIndex]!], { inputType: 'document', maxRetries: 0 });
        if (!vector) throw new Error('index');
        assertVector(vector);
        runs.A.documentVectors.push({ documentId: document.id, chunkIndex, vector });
        runs.A.indexSamples.push({ documentId: document.id, chunkIndex, ms: performance.now() - start });
      }
    }
    runs.B.documentVectors = runs.A.documentVectors;
    runs.B.indexSamples = runs.A.indexSamples;
    await queryArm('A');
    await queryArm('B');

    failureStage = 'titled-index-arm-c';
    embedding.format_input = formatInput;
    for (const document of dataset.documents) {
      for (let chunkIndex = 0; chunkIndex < document.chunks.length; chunkIndex++) {
        activePurpose = { arm: 'C', purpose: 'index', id: `${document.id}:${chunkIndex}` };
        const start = performance.now();
        const [vector] = await embed([document.chunks[chunkIndex]!], { inputType: 'document', documentTitle: document.title, maxRetries: 0 });
        if (!vector) throw new Error('index');
        assertVector(vector);
        runs.C.documentVectors.push({ documentId: document.id, chunkIndex, vector });
        runs.C.indexSamples.push({ documentId: document.id, chunkIndex, ms: performance.now() - start });
      }
    }
    await queryArm('C');

    failureStage = 'post-run-metadata';
    const tagAfter = selectedTag(await json(api('/api/tags')));
    if (tagAfter.digest !== EXPECTED_MODEL_DIGEST || tagBefore.digest !== tagAfter.digest) throw new Error('digest');
    const processAfterRun = selectedProcess(await json(api('/api/ps')));
    if (!processAfterRun.loaded || !processAfterRun.sizeVram || processAfterRun.sizeVram <= 0 ||
        (processAfterRun.digest && processAfterRun.digest !== EXPECTED_MODEL_DIGEST)) throw new Error('gpu');
    const queriesHash = hashJson(dataset.queries);
    const labelsHash = hashJson(dataset.queries.map(({ id, relevant }) => ({ id, relevant })));
    const indexSummary = (run: ArmRun) => ({
      ...latencyPercentiles(run.indexSamples.map(({ ms }) => ms)),
      totalMs: run.indexSamples.reduce((sum, sample) => sum + sample.ms, 0),
      perDocumentChunk: run.indexSamples,
    });
    const quality = Object.fromEntries((['A', 'B', 'C'] as const).map((arm) => [arm, {
      primaryFirstRepeat: runQuality(runs[arm], 1),
      repeated: { pooledQueryRuns: runQuality(runs[arm]),
      repeats: Array.from({ length: REPEATS }, (_, index) => runQuality(runs[arm], index + 1)),
      },
      indexingLatency: arm === 'B'
        ? { status: 'reused immutable raw-document index from A', reusedIndexTiming: indexSummary(runs.A) }
        : indexSummary(runs[arm]),
      queryLatency: latencyPercentiles(runs[arm].queryLatencySamples),
    }]));
    const byK = (rows: ReturnType<typeof compareArms>) => Object.fromEntries(rows.map((row) => [String(row.k), row]));
    const firstRepeat = (run: ArmRun): ArmRun => ({ ...run, queryRuns: run.queryRuns.filter((query) => query.repetition === 1) });
    const comparisons = {
      primaryFirstRepeat: { 'B-vs-A': byK(compareArms(firstRepeat(runs.A), firstRepeat(runs.B))), 'C-vs-B': byK(compareArms(firstRepeat(runs.B), firstRepeat(runs.C))) },
      repeatedPooled: { 'B-vs-A': byK(compareArms(runs.A, runs.B)), 'C-vs-B': byK(compareArms(runs.B, runs.C)) },
    };
    const armInputs = (arm: Arm) => wireRequests.filter((request) => request.arm === arm);
    const evidence = {
      schemaVersion: 1,
      upstreamBase: UPSTREAM_BASE,
      experimentGitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8' }).trim(),
      repeatableCommand: 'bun evals/embeddinggemma-follow-up/run.ts --endpoint <LOCAL_OLLAMA_BASE_URL> --out <NEW_EVIDENCE_DIRECTORY>',
      model: { ...tagBefore, nativeEmbeddingLength: nativeDimensions, digestBefore: tagBefore.digest, digestAfter: tagAfter.digest },
      corpus: {
        sha256: datasetHash,
        querySha256: queriesHash,
        labelSha256: labelsHash,
        license: dataset.license,
        frozenCopy: 'dataset.json',
      },
      initialState: { selectedModelLoaded: processBefore.loaded, selectedModelDigest: processBefore.digest, selectedModelSize: processBefore.size, selectedModelSizeVram: processBefore.sizeVram },
      warmConditions: {
        primerInput: PRIMER,
        primerMs,
        afterPrimer: processAfterPrimer,
        afterRun: processAfterRun,
        backgroundConsumerLoad: 'not controlled or measured',
        allArmsWarm: true,
        order: ['A', 'B', 'C'],
        stages: ['A.index', 'A.query', 'B.query (reuses A index)', 'C.index', 'C.query'],
        repeatsPerQuery: REPEATS,
        queriesPerRepeat: dataset.queries.length,
        wallMs: performance.now() - wallStart,
        caveat: 'No cold-latency claim: a model already loaded at startup is recorded; one separately timed primer precedes all arms, and fixed arm order plus uncontrolled background consumers may affect latency.',
      },
      retrievalConfiguration: {
        mode: 'vector-only cosine',
        documents: 'per-chunk vectors grouped by document; maximum chunk cosine per document',
        tieBreak: 'document ID ascending',
        lexical: false,
        reranking: false,
        queryExpansion: false,
        queryCacheClearedBeforeEveryTimedCall: true,
      },
      arms: {
        A: { queryInput: 'raw query', documentInput: 'raw chunk', exactWireInputs: armInputs('A'),
          vectors: { rawDocuments: toVectors(runs.A.documentVectors), queries: runs.A.queryVectors.map(({ queryId, repetition, vector }) => ({ queryId, repetition, vector: Array.from(vector) })) },
          queryResults: runs.A.queryRuns.map(({ queryId, language, relevant, repetition, ranked }) => ({ queryId, language, repetition, relevant, ranked })) },
        B: { queryInput: `task: search result | query: {query}`, documentInput: 'raw chunk', documentsReusedFromArm: 'A',
          exactWireInputs: armInputs('B'),
          reusedDocumentInputs: dataset.documents.flatMap((document) => document.chunks.map((input, chunkIndex) => ({ documentId: document.id, chunkIndex, input }))),
          vectors: { rawDocumentsSharedWithArm: 'A', queries: runs.B.queryVectors.map(({ queryId, repetition, vector }) => ({ queryId, repetition, vector: Array.from(vector) })) },
          queryResults: runs.B.queryRuns.map(({ queryId, language, relevant, repetition, ranked }) => ({ queryId, language, repetition, relevant, ranked })) },
        C: { queryInput: `task: search result | query: {query}`, documentInput: 'title: {real dataset title} | text: {raw chunk}', exactWireInputs: armInputs('C'),
          vectors: { titledDocuments: toVectors(runs.C.documentVectors), queries: runs.C.queryVectors.map(({ queryId, repetition, vector }) => ({ queryId, repetition, vector: Array.from(vector) })) },
          queryResults: runs.C.queryRuns.map(({ queryId, language, relevant, repetition, ranked }) => ({ queryId, language, repetition, relevant, ranked })) },
      },
      warmupExactWireInputs: wireRequests.filter((request) => request.arm === 'primer'),
      report: { quality, comparisons },
      safety: { endpointAndCredentialsStored: false, headersStored: false, modelInventoryStored: false, realVectorValidation: 'gateway dimensions plus finite/nonzero assertion' },
    };
    failureStage = 'write-evidence';
    writeFileSync(join(out, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    console.log('Evaluation complete; sanitized evidence and frozen corpus copy were written to the new output directory.');
  } finally {
    embedding.format_input = formatInput;
    resetGateway();
    forwarder.stop(true);
  }
}

if (import.meta.main) {
  main().catch(() => {
    console.error(`Evaluation failed at ${failureStage}. No endpoint, credentials, request headers, or private paths were printed.`);
    process.exitCode = 1;
  });
}
