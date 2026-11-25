/**
 * Postgres twin of test/shadow-privacy.test.ts: the per-item privacy check, the stable rerun outcomes and the exact vector
 * reference (scenarios in test/helpers/shadow-checks-scenarios.ts) against a real Postgres primary, where the policy
 * read and the follower's reads use a dedicated connection and the vector index is pgvector's HNSW. Needs DATABASE_URL.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe } from 'bun:test';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase } from './helpers.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { defineCheckScenarios } from '../helpers/shadow-checks-scenarios.ts';

let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;

(hasDatabase() ? describe : describe.skip)('shadow privacy, rerun and vector reference on Postgres', () => {
  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    template = await persistencePostgresTemplate(process.env.DATABASE_URL!);
  }, 120_000);
  afterAll(async () => { await template.dispose(); resetGateway(); });
  beforeEach(async () => { ({ engine, close } = await template.clone()); }, 60_000);
  afterEach(async () => { await close(); });

  defineCheckScenarios({ primary: () => engine, dialect: 'postgres' });
});
