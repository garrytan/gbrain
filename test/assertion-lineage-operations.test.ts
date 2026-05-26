import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { MBrainConfig } from '../src/core/config.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const tempPaths: string[] = [];
const NOW = '2026-05-20T12:00:00.000Z';

afterEach(() => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe('assertion audit explain operations', () => {
  test('operations are exposed through MCP and CLI contract', () => {
    expect(operationsByName.explain_assertion?.cliHints?.name).toBe('assertion-explain');
    expect(operationsByName.explain_assertion?.params.assertion_id).toMatchObject({ type: 'string' });
    expect(operationsByName.explain_assertion?.params.target_slug).toMatchObject({ type: 'string' });

    expect(operationsByName.explain_projection?.cliHints?.name).toBe('projection-explain');
    expect(operationsByName.explain_projection?.params.projection_target_id).toMatchObject({ type: 'string' });
    expect(operationsByName.explain_projection?.params.target_type).toMatchObject({ type: 'string' });
    expect(operationsByName.explain_projection?.params.target_id).toMatchObject({ type: 'string' });
  });

  test('SQLite explain_assertion traces redacted source to claim, assertion, write, and projection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-assertion-lineage-sqlite-'));
    tempPaths.push(dir);
    const engine = new SQLiteEngine();
    try {
      await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
      await engine.initSchema();
      seedLineageFixture(engine);
      const ctx = operationContext(engine, {
        engine: 'sqlite',
        database_path: join(dir, 'brain.db'),
        offline: true,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      });

      const result = await operationsByName.explain_assertion.handler(ctx, {
        assertion_id: 'assertion:runtime',
      }) as any;

      expect(result.query).toEqual({ assertion_id: 'assertion:runtime' });
      expect(result.assertions).toEqual([
        expect.objectContaining({
          id: 'assertion:runtime',
          target_slug: 'systems/mbrain',
          normalized_claim: '[REDACTED_SECRET]',
          value_json: { redacted: true },
          authority_state: 'canonical',
          lifecycle_state: 'active',
        }),
      ]);
      expect(result.extracted_claims).toEqual([
        expect.objectContaining({
          id: 'claim:runtime',
          source_chunk_id: 'chunk:runtime',
          claim_text: '[REDACTED_SECRET]',
          value_json: { redacted: true },
        }),
      ]);
      expect(result.assertion_evidence).toEqual([
        expect.objectContaining({
          id: 'evidence:runtime',
          assertion_id: 'assertion:runtime',
          extracted_claim_id: 'claim:runtime',
          source_id: 'source:design',
          source_item_id: 'item:design',
          source_chunk_id: 'chunk:runtime',
        }),
      ]);
      expect(result.source_refs).toEqual([
        {
          source: expect.objectContaining({
            id: 'source:design',
            kind: 'document',
            display_name: 'Runtime design',
          }),
          source_item: expect.objectContaining({
            id: 'item:design',
            title: 'Phase 12 design',
          }),
          source_chunk: expect.objectContaining({
            id: 'chunk:runtime',
            chunk_index: 0,
            chunk_hash: 'sha256:runtime-chunk',
            redacted_text: 'MBrain supports managed Postgres. [REDACTED_SECRET]',
            secret_risk: 'redacted',
          }),
        },
      ]);
      expect(result.canonical_write_attempts).toEqual([
        expect.objectContaining({
          id: 'write:runtime',
          policy_decision: 'auto_canonical',
          policy_explanation: '[REDACTED_SECRET]',
          target_projection_ids: ['projection:systems-mbrain'],
        }),
      ]);
      expect(result.projection_targets).toEqual([
        expect.objectContaining({
          id: 'projection:systems-mbrain',
          target_type: 'system_doc',
          target_id: 'systems/mbrain',
          source_assertion_ids: ['assertion:runtime'],
        }),
      ]);
      expect(result.projection_mutations).toEqual([
        expect.objectContaining({
          id: 'mutation:runtime',
          canonical_write_attempt_id: 'write:runtime',
          projection_kind: 'system_doc',
          projection_slug: 'systems/mbrain',
        }),
      ]);
      expect(result.missing_links).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('SUPER_SECRET');
    } finally {
      await engine.disconnect();
    }
  });

  test('SQLite explain_assertion finds linked audit rows older than unrelated ledger noise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-assertion-lineage-noise-sqlite-'));
    tempPaths.push(dir);
    const engine = new SQLiteEngine();
    try {
      await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
      await engine.initSchema();
      seedLineageFixture(engine);
      seedUnrelatedAuditNoise(engine, 425);
      const ctx = operationContext(engine, {
        engine: 'sqlite',
        database_path: join(dir, 'brain.db'),
        offline: true,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      });

      const result = await operationsByName.explain_assertion.handler(ctx, {
        assertion_id: 'assertion:runtime',
      }) as any;

      expect(result.canonical_write_attempts.map((attempt: any) => attempt.id)).toContain('write:runtime');
      expect(result.projection_targets.map((target: any) => target.id)).toContain('projection:systems-mbrain');
      expect(result.projection_mutations.map((mutation: any) => mutation.id)).toContain('mutation:runtime');
      expect(result.missing_links).toEqual([]);
    } finally {
      await engine.disconnect();
    }
  });

  test('SQLite explain_projection traces projection back to assertion evidence and source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-projection-lineage-sqlite-'));
    tempPaths.push(dir);
    const engine = new SQLiteEngine();
    try {
      await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
      await engine.initSchema();
      seedLineageFixture(engine);
      const ctx = operationContext(engine, {
        engine: 'sqlite',
        database_path: join(dir, 'brain.db'),
        offline: true,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      });

      const result = await operationsByName.explain_projection.handler(ctx, {
        target_type: 'system_doc',
        target_id: 'systems/mbrain',
      }) as any;

      expect(result.query).toEqual({ target_type: 'system_doc', target_id: 'systems/mbrain' });
      expect(result.projection_targets.map((target: any) => target.id)).toEqual(['projection:systems-mbrain']);
      expect(result.assertions.map((assertion: any) => assertion.id)).toEqual(['assertion:runtime']);
      expect(result.assertion_evidence.map((evidence: any) => evidence.id)).toEqual(['evidence:runtime']);
      expect(result.extracted_claims.map((claim: any) => claim.id)).toEqual(['claim:runtime']);
      expect(result.source_refs.map((ref: any) => ref.source_chunk.id)).toEqual(['chunk:runtime']);
      expect(JSON.stringify(result)).not.toContain('SUPER_SECRET');
    } finally {
      await engine.disconnect();
    }
  });

  test('PGLite explain_assertion uses JSONB membership queries for audit lineage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-assertion-lineage-pglite-'));
    tempPaths.push(dir);
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ engine: 'pglite', database_path: dir });
      await engine.initSchema();
      await seedLineageFixturePGLite(engine);
      const ctx = operationContext(engine, {
        engine: 'pglite',
        database_path: dir,
        offline: true,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      });

      const result = await operationsByName.explain_assertion.handler(ctx, {
        assertion_id: 'assertion:runtime',
      }) as any;

      expect(result.assertions.map((assertion: any) => assertion.id)).toEqual(['assertion:runtime']);
      expect(result.extracted_claims.map((claim: any) => claim.id)).toEqual(['claim:runtime']);
      expect(result.canonical_write_attempts.map((attempt: any) => attempt.id)).toEqual(['write:runtime']);
      expect(result.projection_targets.map((target: any) => target.id)).toEqual(['projection:systems-mbrain']);
      expect(result.projection_mutations.map((mutation: any) => mutation.id)).toEqual(['mutation:runtime']);
      expect(result.missing_links).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('SUPER_SECRET');
    } finally {
      await engine.disconnect();
    }
  }, 20_000);
});

function operationContext(engine: OperationContext['engine'], config: MBrainConfig): OperationContext {
  return {
    engine,
    config,
    dryRun: false,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

function seedUnrelatedAuditNoise(engine: SQLiteEngine, count: number) {
  const database = (engine as any).database;
  for (let i = 0; i < count; i++) {
    const stamp = new Date(Date.parse(NOW) + (i + 1) * 1000).toISOString();
    database.run(`
      INSERT INTO canonical_projection_targets (
        id, target_type, target_id, locator, source_assertion_ids, projection_hash,
        rendered_markdown, last_rendered_at, last_reconciled_at, status,
        runtime_only, canonical_changed_since_projection, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `projection:noise-${i}`,
      'system_doc',
      `systems/noise-${i}`,
      `brain/systems/noise-${i}.md`,
      JSON.stringify([`assertion:noise-${i}`]),
      `sha256:projection-noise-${i}`,
      `noise projection ${i}`,
      stamp,
      stamp,
      'applied',
      0,
      0,
      JSON.stringify({ noise: true }),
      stamp,
      stamp,
    ]);

    database.run(`
      INSERT INTO canonical_write_attempts (
        id, policy_decision, policy_explanation, policy_explanation_hash,
        assertion_ids, assertion_evidence_ids, extracted_claim_ids, source_refs,
        target_projection_ids, before_db_hash, after_db_hash, before_markdown_hash,
        after_markdown_hash, actor, session_id, job_id, runner_id, status,
        error_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `write:noise-${i}`,
      'auto_canonical',
      `noise write ${i}`,
      `sha256:write-noise-${i}`,
      JSON.stringify([`assertion:noise-${i}`]),
      JSON.stringify([`evidence:noise-${i}`]),
      JSON.stringify([`claim:noise-${i}`]),
      JSON.stringify([]),
      JSON.stringify([`projection:noise-${i}`]),
      null,
      null,
      null,
      null,
      'test',
      null,
      null,
      null,
      'applied',
      JSON.stringify({}),
      JSON.stringify({ noise: true }),
      stamp,
    ]);

    database.run(`
      INSERT INTO canonical_projection_mutations (
        id, canonical_write_attempt_id, projection_kind, projection_slug,
        mutation_kind, assertion_ids, assertion_evidence_ids, extracted_claim_ids,
        source_refs, before_markdown_hash, after_markdown_hash, status,
        error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `mutation:noise-${i}`,
      `write:noise-${i}`,
      'system_doc',
      `systems/noise-${i}`,
      'update',
      JSON.stringify([`assertion:noise-${i}`]),
      JSON.stringify([`evidence:noise-${i}`]),
      JSON.stringify([`claim:noise-${i}`]),
      JSON.stringify([]),
      null,
      null,
      'applied',
      null,
      stamp,
    ]);
  }
}

async function seedLineageFixturePGLite(engine: PGLiteEngine) {
  await engine.db.query(`
    INSERT INTO sources (
      id, kind, display_name, connector_id, locator, consent_state, enabled,
      paused_at, policy_id, metadata_json, created_at, updated_at, archived_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
  `, [
    'source:design',
    'document',
    'Runtime design',
    'connector:docs',
    'docs/superpowers/specs/phase-12.md',
    'granted',
    true,
    null,
    null,
    JSON.stringify({ phase: 12 }),
    NOW,
    NOW,
    null,
  ]);

  await engine.db.query(`
    INSERT INTO source_items (
      id, source_id, external_id, origin_event, locator, title, source_created_at,
      source_updated_at, ingested_at, content_hash, metadata_json, raw_copy_mode,
      raw_copy_ref, sensitivity_level, ingest_status, retention_policy_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16)
  `, [
    'item:design',
    'source:design',
    'phase-12',
    'manual_entry',
    'docs/superpowers/specs/phase-12.md',
    'Phase 12 design',
    NOW,
    NOW,
    NOW,
    'sha256:runtime-item',
    JSON.stringify({ source: 'test' }),
    'stored',
    'raw:design',
    'normal',
    'ready',
    null,
  ]);

  await engine.db.query(`
    INSERT INTO source_chunks (
      id, source_item_id, chunk_index, chunk_hash, chunk_text, redacted_text,
      token_count, parser_version, extractor_version, sensitivity_flags,
      prompt_injection_risk, secret_risk, created_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14)
  `, [
    'chunk:runtime',
    'item:design',
    0,
    'sha256:runtime-chunk',
    'MBrain supports managed Postgres. SUPER_SECRET',
    'MBrain supports managed Postgres. [REDACTED_SECRET]',
    8,
    'parser:test',
    'extractor:test',
    JSON.stringify(['secret']),
    'none',
    'redacted',
    NOW,
    null,
  ]);

  await engine.db.query(`
    INSERT INTO extracted_claims (
      id, source_id, source_item_id, source_chunk_id, extractor_kind,
      extractor_version, runner_job_id, claim_text, claim_type, target_hint,
      property_hint, value_json, confidence, sensitivity_level,
      prompt_injection_flag, secret_flag, status, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18)
  `, [
    'claim:runtime',
    'source:design',
    'item:design',
    'chunk:runtime',
    'llm',
    'extractor:test',
    'job:extract',
    'MBrain supports managed Postgres. SUPER_SECRET_CLAIM',
    'architecture_claim',
    'systems/mbrain',
    'runtime.profile',
    JSON.stringify({ runtime: 'postgres', secret: 'SUPER_SECRET_CLAIM_VALUE' }),
    0.94,
    'normal',
    false,
    true,
    'resolved',
    NOW,
  ]);

  await engine.db.query(`
    INSERT INTO assertions (
      id, claim_type, target_type, target_id, target_slug, property, value_json,
      normalized_claim, authority_summary, confidence, evidence_count,
      authority_state, lifecycle_state, valid_from, valid_until,
      supersedes_assertion_id, superseded_by_assertion_id, conflict_set_id,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
  `, [
    'assertion:runtime',
    'architecture_claim',
    'system',
    'systems/mbrain',
    'systems/mbrain',
    'runtime.profile',
    JSON.stringify({ runtime: 'postgres', secret: 'SUPER_SECRET_ASSERTION_VALUE' }),
    'MBrain supports a managed Postgres runtime profile. SUPER_SECRET_ASSERTION',
    JSON.stringify({ support: 1 }),
    0.94,
    1,
    'canonical',
    'active',
    null,
    null,
    null,
    null,
    null,
    NOW,
    NOW,
  ]);

  await engine.db.query(`
    INSERT INTO assertion_evidence (
      id, assertion_id, extracted_claim_id, source_id, source_item_id,
      source_chunk_id, session_id, task_event_id, contribution_type,
      evidence_authority, evidence_confidence, valid_from, valid_until,
      revocation_state, forgetting_state, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
  `, [
    'evidence:runtime',
    'assertion:runtime',
    'claim:runtime',
    'source:design',
    'item:design',
    'chunk:runtime',
    'session:runtime',
    'task:runtime',
    'supports',
    'primary_source',
    0.94,
    null,
    null,
    'active',
    'retained',
    NOW,
  ]);

  await engine.db.query(`
    INSERT INTO canonical_write_attempts (
      id, policy_decision, policy_explanation, policy_explanation_hash,
      assertion_ids, assertion_evidence_ids, extracted_claim_ids, source_refs,
      target_projection_ids, before_db_hash, after_db_hash, before_markdown_hash,
      after_markdown_hash, actor, session_id, job_id, runner_id, status,
      error_json, metadata_json, created_at
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20::jsonb, $21)
  `, [
    'write:runtime',
    'auto_canonical',
    'trusted design source SUPER_SECRET_WRITE',
    'sha256:explanation',
    JSON.stringify(['assertion:runtime']),
    JSON.stringify(['evidence:runtime']),
    JSON.stringify(['claim:runtime']),
    JSON.stringify([{ source_id: 'source:design', source_item_id: 'item:design', source_chunk_id: 'chunk:runtime' }]),
    JSON.stringify(['projection:systems-mbrain']),
    'sha256:before-db',
    'sha256:after-db',
    'sha256:before-md',
    'sha256:after-md',
    'test',
    'session:runtime',
    'job:write',
    'runner:test',
    'applied',
    JSON.stringify({}),
    JSON.stringify({ test: true }),
    NOW,
  ]);

  await engine.db.query(`
    INSERT INTO canonical_projection_targets (
      id, target_type, target_id, locator, source_assertion_ids, projection_hash,
      rendered_markdown, last_rendered_at, last_reconciled_at, status,
      runtime_only, canonical_changed_since_projection, metadata_json,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
  `, [
    'projection:systems-mbrain',
    'system_doc',
    'systems/mbrain',
    'brain/systems/mbrain.md',
    JSON.stringify(['assertion:runtime']),
    'sha256:projection',
    'Runtime profile: Postgres. SUPER_SECRET_CANONICAL',
    NOW,
    NOW,
    'applied',
    false,
    false,
    JSON.stringify({ test: true }),
    NOW,
    NOW,
  ]);

  await engine.db.query(`
    INSERT INTO canonical_projection_mutations (
      id, canonical_write_attempt_id, projection_kind, projection_slug,
      mutation_kind, assertion_ids, assertion_evidence_ids, extracted_claim_ids,
      source_refs, before_markdown_hash, after_markdown_hash, status,
      error_message, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)
  `, [
    'mutation:runtime',
    'write:runtime',
    'system_doc',
    'systems/mbrain',
    'update',
    JSON.stringify(['assertion:runtime']),
    JSON.stringify(['evidence:runtime']),
    JSON.stringify(['claim:runtime']),
    JSON.stringify([{ source_id: 'source:design', source_item_id: 'item:design', source_chunk_id: 'chunk:runtime' }]),
    'sha256:before-md',
    'sha256:after-md',
    'applied',
    null,
    NOW,
  ]);
}

function seedLineageFixture(engine: SQLiteEngine) {
  const database = (engine as any).database;
  database.run(`
    INSERT INTO sources (
      id, kind, display_name, connector_id, locator, consent_state, enabled,
      paused_at, policy_id, metadata_json, created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    'source:design',
    'document',
    'Runtime design',
    'connector:docs',
    'docs/superpowers/specs/phase-12.md',
    'granted',
    1,
    null,
    null,
    JSON.stringify({ phase: 12 }),
    NOW,
    NOW,
    null,
  ]);

  database.run(`
    INSERT INTO source_items (
      id, source_id, external_id, origin_event, locator, title, source_created_at,
      source_updated_at, ingested_at, content_hash, metadata_json, raw_copy_mode,
      raw_copy_ref, sensitivity_level, ingest_status, retention_policy_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    'item:design',
    'source:design',
    'phase-12',
    'manual_entry',
    'docs/superpowers/specs/phase-12.md',
    'Phase 12 design',
    NOW,
    NOW,
    NOW,
    'sha256:runtime-item',
    JSON.stringify({ source: 'test' }),
    'stored',
    'raw:design',
    'normal',
    'ready',
    null,
  ]);

  database.run(`
    INSERT INTO source_chunks (
      id, source_item_id, chunk_index, chunk_hash, chunk_text, redacted_text,
      token_count, parser_version, extractor_version, sensitivity_flags,
      prompt_injection_risk, secret_risk, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    'chunk:runtime',
    'item:design',
    0,
    'sha256:runtime-chunk',
    'MBrain supports managed Postgres. SUPER_SECRET',
    'MBrain supports managed Postgres. [REDACTED_SECRET]',
    8,
    'parser:test',
    'extractor:test',
    JSON.stringify(['secret']),
    'none',
    'redacted',
    NOW,
    null,
  ]);

  database.run(`
    INSERT INTO extracted_claims (
      id, source_id, source_item_id, source_chunk_id, extractor_kind,
      extractor_version, runner_job_id, claim_text, claim_type, target_hint,
      property_hint, value_json, confidence, sensitivity_level,
      prompt_injection_flag, secret_flag, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    'claim:runtime',
    'source:design',
    'item:design',
    'chunk:runtime',
    'llm',
    'extractor:test',
    'job:extract',
    'MBrain supports managed Postgres. SUPER_SECRET_CLAIM',
    'architecture_claim',
    'systems/mbrain',
    'runtime.profile',
    JSON.stringify({ runtime: 'postgres', secret: 'SUPER_SECRET_CLAIM_VALUE' }),
    0.94,
    'normal',
    0,
    1,
    'resolved',
    NOW,
  ]);

  database.run(`
    INSERT INTO assertions (
      id, claim_type, target_type, target_id, target_slug, property, value_json,
      normalized_claim, authority_summary, confidence, evidence_count,
      authority_state, lifecycle_state, valid_from, valid_until,
      supersedes_assertion_id, superseded_by_assertion_id, conflict_set_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    'assertion:runtime',
    'architecture_claim',
    'system',
    'systems/mbrain',
    'systems/mbrain',
    'runtime.profile',
    JSON.stringify({ runtime: 'postgres', secret: 'SUPER_SECRET_ASSERTION_VALUE' }),
    'MBrain supports a managed Postgres runtime profile. SUPER_SECRET_ASSERTION',
    JSON.stringify({ support: 1 }),
    0.94,
    1,
    'canonical',
    'active',
    null,
    null,
    null,
    null,
    null,
    NOW,
    NOW,
  ]);

  database.run(`
    INSERT INTO assertion_evidence (
      id, assertion_id, extracted_claim_id, source_id, source_item_id,
      source_chunk_id, session_id, task_event_id, contribution_type,
      evidence_authority, evidence_confidence, valid_from, valid_until,
      revocation_state, forgetting_state, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    'evidence:runtime',
    'assertion:runtime',
    'claim:runtime',
    'source:design',
    'item:design',
    'chunk:runtime',
    'session:runtime',
    'task:runtime',
    'supports',
    'primary_source',
    0.94,
    null,
    null,
    'active',
    'retained',
    NOW,
  ]);

  database.run(`
    INSERT INTO canonical_write_attempts (
      id, policy_decision, policy_explanation, policy_explanation_hash,
      assertion_ids, assertion_evidence_ids, extracted_claim_ids, source_refs,
      target_projection_ids, before_db_hash, after_db_hash, before_markdown_hash,
      after_markdown_hash, actor, session_id, job_id, runner_id, status,
      error_json, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    'write:runtime',
    'auto_canonical',
    'trusted design source SUPER_SECRET_WRITE',
    'sha256:explanation',
    JSON.stringify(['assertion:runtime']),
    JSON.stringify(['evidence:runtime']),
    JSON.stringify(['claim:runtime']),
    JSON.stringify([{ source_id: 'source:design', source_item_id: 'item:design', source_chunk_id: 'chunk:runtime' }]),
    JSON.stringify(['projection:systems-mbrain']),
    'sha256:before-db',
    'sha256:after-db',
    'sha256:before-md',
    'sha256:after-md',
    'test',
    'session:runtime',
    'job:write',
    'runner:test',
    'applied',
    JSON.stringify({}),
    JSON.stringify({ test: true }),
    NOW,
  ]);

  database.run(`
    INSERT INTO canonical_projection_targets (
      id, target_type, target_id, locator, source_assertion_ids, projection_hash,
      rendered_markdown, last_rendered_at, last_reconciled_at, status,
      runtime_only, canonical_changed_since_projection, metadata_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    'projection:systems-mbrain',
    'system_doc',
    'systems/mbrain',
    'brain/systems/mbrain.md',
    JSON.stringify(['assertion:runtime']),
    'sha256:projection',
    'Runtime profile: Postgres. SUPER_SECRET_CANONICAL',
    NOW,
    NOW,
    'applied',
    0,
    0,
    JSON.stringify({ test: true }),
    NOW,
    NOW,
  ]);

  database.run(`
    INSERT INTO canonical_projection_mutations (
      id, canonical_write_attempt_id, projection_kind, projection_slug,
      mutation_kind, assertion_ids, assertion_evidence_ids, extracted_claim_ids,
      source_refs, before_markdown_hash, after_markdown_hash, status,
      error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    'mutation:runtime',
    'write:runtime',
    'system_doc',
    'systems/mbrain',
    'update',
    JSON.stringify(['assertion:runtime']),
    JSON.stringify(['evidence:runtime']),
    JSON.stringify(['claim:runtime']),
    JSON.stringify([{ source_id: 'source:design', source_item_id: 'item:design', source_chunk_id: 'chunk:runtime' }]),
    'sha256:before-md',
    'sha256:after-md',
    'applied',
    null,
    NOW,
  ]);
}
