import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import {
  legacyModelTarget,
  legacyUnprefixedModel,
  sameEmbeddingModel,
} from '../src/core/embedding-model-identity.ts';
import {
  applyEmbeddingMigration,
  MIGRATION_STATE_KEY,
  planEmbeddingMigration,
} from '../src/core/embedding-migration.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveManagedFactsEmbedding } from '../src/core/persistence/facts-maintenance.ts';
import { planMigrationFlow } from '../src/commands/migrate-embeddings.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

describe('embedding model identity', () => {
  test('recognizes only the supported legacy-to-prefixed equivalence', () => {
    expect(sameEmbeddingModel('text-embedding-3-large', 'openai:text-embedding-3-large')).toBe(true);
    expect(sameEmbeddingModel('3-small', 'openai:3-large')).toBe(false);
    expect(sameEmbeddingModel('voyage:x', 'openai:x')).toBe(false);
    expect(sameEmbeddingModel('openai:x', 'openai:x')).toBe(true);
    expect(sameEmbeddingModel(null, 'openai:x')).toBe(false);
    expect(sameEmbeddingModel(undefined, 'openai:x')).toBe(false);
    expect(sameEmbeddingModel('', 'openai:x')).toBe(false);
    expect(sameEmbeddingModel('text embedding', 'openai:text embedding')).toBe(false);
    expect(sameEmbeddingModel('org/x', 'openai:org/x')).toBe(false);
  });

  test('exposes the legacy predicate and target without broadening it', () => {
    expect(legacyUnprefixedModel('text-embedding-3-large')).toBe(true);
    expect(legacyUnprefixedModel('org/x')).toBe(false);
    expect(legacyModelTarget('text-embedding-3-large', 'openai:text-embedding-3-large'))
      .toBe('openai:text-embedding-3-large');
    expect(legacyModelTarget('voyage:x', 'openai:x')).toBeNull();
  });
});

let engine: PGLiteEngine;
let dimensions: number;
const legacyLarge = 'text-embedding-3-large';
const targetLarge = 'openai:text-embedding-3-large';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const [row] = await engine.executeRaw<{ dimensions: number }>(`SELECT atttypmod AS dimensions
    FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'
      AND attnum>0 AND NOT attisdropped`);
  dimensions = Number(row!.dimensions);
}, 60_000);

afterAll(async () => {
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  resetGateway();
  await resetPgliteState(engine);
});

afterEach(() => {
  resetGateway();
});

type CompanionState = {
  identity: Array<{ key: string; value: string }>;
  migrationState: string | null;
  columnTypes: Array<{ table_name: string; type: string }>;
  facts: Array<{ embedding: string; embedding_model: string; embedded_text_hash: string; embedded_at: string }>;
  takes: Array<{ embedding: string; embedding_model: string; embedded_text_hash: string; embedded_at: string }>;
};

async function seedRetainedCompanions(storedModel: string, storedDimensions = dimensions): Promise<void> {
  await engine.setConfig('embedding_model', storedModel);
  await engine.setConfig('embedding_dimensions', String(storedDimensions));
  await engine.putPage('notes/retained', {
    type: 'note', title: 'Retained', compiled_truth: '', frontmatter: { embed_skip: true },
  });
  const vector = new Float32Array(dimensions).fill(0.125);
  await engine.insertFact({
    fact: 'Synthetic retained fact', source: 'synthetic', embedding: vector, embedding_model: storedModel,
  }, { source_id: 'default' });
  await engine.executeRaw(`UPDATE facts SET embedded_text_hash=md5(fact),embedded_at='2026-01-02T03:04:05Z'
    WHERE fact='Synthetic retained fact'`);
  await engine.executeRaw(`INSERT INTO takes
      (page_id,row_num,claim,kind,holder,embedding,embedding_model,embedded_text_hash,embedded_at)
    SELECT id,0,'Synthetic retained take','take','self',$1::vector,$2,md5('Synthetic retained take'),
      '2026-01-03T04:05:06Z'::timestamptz
    FROM pages WHERE source_id='default' AND slug='notes/retained'`, [`[${Array(dimensions).fill(0.25).join(',')}]`, storedModel]);
}

async function companionState(): Promise<CompanionState> {
  const [migrationState, identity, columnTypes, facts, takes] = await Promise.all([
    engine.getConfig(MIGRATION_STATE_KEY),
    engine.executeRaw<{ key: string; value: string }>(`SELECT key,value FROM config
      WHERE key IN ('embedding_model','embedding_dimensions') ORDER BY key`),
    engine.executeRaw<{ table_name: string; type: string }>(`SELECT c.relname AS table_name,
        format_type(a.atttypid,a.atttypmod) AS type
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('facts','takes','content_chunks')
        AND a.attname='embedding' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname`),
    engine.executeRaw<{ embedding: string; embedding_model: string; embedded_text_hash: string; embedded_at: string }>(
      `SELECT embedding::text AS embedding,embedding_model,embedded_text_hash,embedded_at::text AS embedded_at
       FROM facts WHERE fact='Synthetic retained fact'`),
    engine.executeRaw<{ embedding: string; embedding_model: string; embedded_text_hash: string; embedded_at: string }>(
      `SELECT embedding::text AS embedding,embedding_model,embedded_text_hash,embedded_at::text AS embedded_at
       FROM takes WHERE claim='Synthetic retained take'`),
  ]);
  return { identity, migrationState, columnTypes, facts, takes };
}

async function directApply(storedModel: string, targetModel: string, targetDimensions = dimensions,
  storedDimensions = dimensions) {
  await seedRetainedCompanions(storedModel, storedDimensions);
  const plan = await planEmbeddingMigration(engine, {
    to: targetModel, dim: targetDimensions, fromModel: storedModel, fromDims: storedDimensions,
  });
  const before = await companionState();
  const result = await applyEmbeddingMigration(engine, plan);
  return { before, result, after: await companionState() };
}

describe('legacy embedding identity migration retention', () => {
  test('(a) same-width legacy identity rewrite keeps vectors and provenance byte-equal', async () => {
    const { before, result, after } = await directApply(legacyLarge, targetLarge);
    expect(result.status).toBe('applied');
    expect(after.identity).toEqual([
      { key: 'embedding_dimensions', value: String(dimensions) },
      { key: 'embedding_model', value: targetLarge },
    ]);
    expect(after.facts).toEqual(before.facts);
    expect(after.takes).toEqual(before.takes);
  });

  test('(b) different dimensions remain blocked with all state unchanged', async () => {
    const { before, result, after } = await directApply(legacyLarge, targetLarge, dimensions, dimensions - 1);
    expect(result).toMatchObject({ status: 'failed' });
    if (result.status === 'failed') expect(result.reason).toContain('retained_vectors_blocked');
    expect(after).toEqual(before);
  });

  test('(c) a different unprefixed model remains blocked with all state unchanged', async () => {
    const { before, result, after } = await directApply('text-embedding-3-small', targetLarge);
    expect(result).toMatchObject({ status: 'failed' });
    if (result.status === 'failed') expect(result.reason).toContain('retained_vectors_blocked');
    expect(after).toEqual(before);
  });

  test('(d) provider-qualified cross-provider suffixes remain blocked with all state unchanged', async () => {
    const { before, result, after } = await directApply('voyage:voyage-4', 'openai:voyage-4');
    expect(result).toMatchObject({ status: 'failed' });
    if (result.status === 'failed') expect(result.reason).toContain('retained_vectors_blocked');
    expect(after).toEqual(before);
  });

  test('(e) gateway-prefixed plan plus legacy stored row applies and keeps vectors byte-equal', async () => {
    configureGateway({
      embedding_model: targetLarge, embedding_dimensions: dimensions,
      env: { OPENAI_API_KEY: 'synthetic-only' },
    });
    await seedRetainedCompanions(legacyLarge);
    const before = await companionState();
    const context = await planMigrationFlow(engine, { to: targetLarge, dim: dimensions });
    expect(context.plan.from_model).toBe(targetLarge);
    const result = await applyEmbeddingMigration(engine, context.plan);
    expect(result.status).toBe('applied');
    const after = await companionState();
    expect(after.facts).toEqual(before.facts);
    expect(after.takes).toEqual(before.takes);
  });

  test('(f) a divergent gateway still blocks despite a legacy-equal stored row', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: dimensions,
      env: { OPENAI_API_KEY: 'synthetic-only' },
    });
    await seedRetainedCompanions(legacyLarge);
    const before = await companionState();
    const context = await planMigrationFlow(engine, { to: targetLarge, dim: dimensions });
    expect(context.plan.from_model).toBe('openai:text-embedding-3-small');
    const result = await applyEmbeddingMigration(engine, context.plan);
    expect(result).toMatchObject({ status: 'failed' });
    if (result.status === 'failed') expect(result.reason).toContain('retained_vectors_blocked');
    expect(await companionState()).toEqual(before);
  });

  test('facts maintenance preserves the legacy refusal and inferred migration target', async () => {
    configureGateway({
      embedding_model: targetLarge, embedding_dimensions: dimensions,
      env: { OPENAI_API_KEY: 'synthetic-only' },
    });
    await engine.setConfig('embedding_model', legacyLarge);
    await engine.setConfig('embedding_dimensions', String(dimensions));
    const error = await resolveManagedFactsEmbedding(engine, { engine: 'pglite' } as GBrainConfig)
      .then(() => null, caught => caught);
    expect(error).toMatchObject({ code: 'embedding_configuration' });
    expect(error.suggestion).toContain(`gbrain migrate embeddings --to ${targetLarge} --dry-run`);
  });
});
