import { expect, test } from 'bun:test';
import type { MBrainConfig } from '../src/core/config.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

const databaseUrl = process.env.DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;
const NOW = '2026-05-20T12:00:00.000Z';

postgresTest('postgres assertion retrieval operation uses persisted lifecycle state', async () => {
  await withPostgresAssertionHarness(async (engine) => {
    await insertPostgresAssertion(engine, { id: 'assertion:postgres-active', property: 'runtime.active', lifecycle_state: 'active' });
    await insertPostgresAssertion(engine, { id: 'assertion:postgres-stale', property: 'runtime.stale', lifecycle_state: 'stale', claim_type: 'code_claim' });
    await insertPostgresAssertion(engine, { id: 'assertion:postgres-expired', property: 'runtime.expired', lifecycle_state: 'expired' });

    const ctx = operationContext(engine, {
      engine: 'postgres',
      database_url: databaseUrl!,
      offline: false,
      embedding_provider: 'none',
      query_rewrite_provider: 'none',
    });
    const defaults = await operationsByName.list_retrievable_assertions.handler(ctx, {
      target_slug: 'systems/mbrain',
    }) as any[];
    const audit = await operationsByName.list_retrievable_assertions.handler(ctx, {
      target_slug: 'systems/mbrain',
      mode: 'audit',
    }) as any[];

    expect(defaults.map((entry) => ({
      id: entry.assertion.id,
      activation: entry.activation,
      reason_codes: entry.reason_codes,
    }))).toEqual([
      { id: 'assertion:postgres-active', activation: 'answer_ground', reason_codes: ['canonical_active'] },
      { id: 'assertion:postgres-stale', activation: 'verify_first', reason_codes: ['canonical_stale', 'code_claim'] },
    ]);
    expect(audit.map((entry) => entry.assertion.id)).toEqual([
      'assertion:postgres-active',
      'assertion:postgres-stale',
      'assertion:postgres-expired',
    ]);
  });
}, 20_000);

async function withPostgresAssertionHarness(
  fn: (engine: PostgresEngine) => Promise<void>,
): Promise<void> {
  if (!databaseUrl) return;

  const engine = new PostgresEngine();
  const schemaName = `assertion_retrieval_${crypto.randomUUID().replaceAll('-', '_')}`;

  await engine.connect({ engine: 'postgres', database_url: databaseUrl, poolSize: 1 });
  await engine.sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
  await engine.sql.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public');
  await engine.sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
  await engine.sql.unsafe(`SET search_path TO "${schemaName}", public`);

  try {
    await engine.initSchema();
    await fn(engine);
  } finally {
    await engine.sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await engine.disconnect();
  }
}

function operationContext(engine: OperationContext['engine'], config: MBrainConfig): OperationContext {
  return {
    engine,
    config,
    dryRun: false,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

async function insertPostgresAssertion(
  engine: PostgresEngine,
  input: {
    id: string;
    property: string;
    lifecycle_state: 'active' | 'stale' | 'expired' | 'archived' | 'purged';
    claim_type?: string;
  },
) {
  await engine.sql`
    INSERT INTO assertions (
      id, claim_type, target_type, target_id, target_slug, property, value_json,
      normalized_claim, authority_summary, confidence, evidence_count,
      authority_state, lifecycle_state, valid_from, valid_until,
      supersedes_assertion_id, superseded_by_assertion_id, conflict_set_id,
      created_at, updated_at
    ) VALUES (
      ${input.id},
      ${input.claim_type ?? 'architecture_claim'},
      ${'system'},
      ${'systems/mbrain'},
      ${'systems/mbrain'},
      ${input.property},
      ${engine.sql.json({ status: input.lifecycle_state })},
      ${`${input.property} = ${input.lifecycle_state}`},
      ${engine.sql.json({ support: 1 })},
      ${0.9},
      ${1},
      ${'canonical'},
      ${input.lifecycle_state},
      ${null},
      ${null},
      ${null},
      ${null},
      ${null},
      ${NOW},
      ${NOW}
    )
  `;
}
