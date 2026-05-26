import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { MBrainConfig } from '../src/core/config.ts';
import { createLifecycleForgettingStoreForEngine } from '../src/core/maintenance/lifecycle-forgetting.ts';
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

describe('assertion retrieval operations', () => {
  test('operation is exposed through MCP and CLI contract', () => {
    const operation = operationsByName.list_retrievable_assertions;

    expect(operation?.cliHints?.name).toBe('assertion-retrieval');
    expect(operation?.params.mode).toMatchObject({ type: 'string' });
    expect(operation?.params.target_slug).toMatchObject({ type: 'string' });
    expect(operation?.params.scope_id).toMatchObject({ type: 'string' });
    expect(operation?.params.limit).toMatchObject({ type: 'number' });
  });

  test('SQLite operation returns active assertions, marks stale verify-first, and hides expired archived purged by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-assertion-retrieval-sqlite-'));
    tempPaths.push(dir);
    const engine = new SQLiteEngine();
    try {
      await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
      await engine.initSchema();
      const ctx = operationContext(engine, {
        engine: 'sqlite',
        database_path: join(dir, 'brain.db'),
        offline: true,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      });

      insertSQLiteAssertion(engine, { id: 'assertion:sqlite-active', property: 'runtime.active', lifecycle_state: 'active' });
      insertSQLiteAssertion(engine, { id: 'assertion:sqlite-stale', property: 'runtime.stale', lifecycle_state: 'stale', claim_type: 'code_claim' });
      insertSQLiteAssertion(engine, { id: 'assertion:sqlite-expired', property: 'runtime.expired', lifecycle_state: 'expired' });
      insertSQLiteAssertion(engine, { id: 'assertion:sqlite-archived', property: 'runtime.archived', lifecycle_state: 'archived' });
      insertSQLiteAssertion(engine, { id: 'assertion:sqlite-purged', property: 'runtime.purged', lifecycle_state: 'purged' });
      const lifecycleStore = createLifecycleForgettingStoreForEngine(engine);
      await lifecycleStore.createForgettingEvent({
        scope_id: 'workspace:default',
        entity_type: 'assertion',
        entity_id: 'assertion:sqlite-purged',
        event_type: 'lifecycle_archived_to_purged',
        from_lifecycle_state: 'archived',
        to_lifecycle_state: 'purged',
        reason: 'test purge audit decoration',
        source_refs_json: ['test/assertion-operations.test.ts'],
        actor: 'test',
        created_at: NOW,
      });
      await lifecycleStore.createMemoryTombstone({
        scope_id: 'workspace:default',
        entity_type: 'assertion',
        entity_id: 'assertion:sqlite-purged',
        reason: 'test purge audit decoration',
        content_hash: 'sha256:sqlite-purged',
        metadata_json: { test: true },
        created_at: NOW,
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
        { id: 'assertion:sqlite-active', activation: 'answer_ground', reason_codes: ['canonical_active'] },
        { id: 'assertion:sqlite-stale', activation: 'verify_first', reason_codes: ['canonical_stale', 'code_claim'] },
      ]);
      expect(audit.map((entry) => entry.assertion.id)).toEqual([
        'assertion:sqlite-active',
        'assertion:sqlite-stale',
        'assertion:sqlite-expired',
        'assertion:sqlite-archived',
        'assertion:sqlite-purged',
      ]);
      expect(audit.find((entry) => entry.assertion.id === 'assertion:sqlite-purged')).toMatchObject({
        activation: 'audit_only',
        content_visible: false,
        lifecycle_events: [
          {
            event_type: 'lifecycle_archived_to_purged',
            from_lifecycle_state: 'archived',
            to_lifecycle_state: 'purged',
            reason: 'test purge audit decoration',
            created_at: NOW,
          },
        ],
        tombstone: {
          reason: 'test purge audit decoration',
          content_hash: 'sha256:sqlite-purged',
          created_at: NOW,
        },
        assertion: {
          normalized_claim: '[purged assertion content removed]',
          value_json: {},
        },
      });

      const empty = await operationsByName.list_retrievable_assertions.handler(ctx, {
        target_slug: 'systems/mbrain',
        limit: 0,
      }) as any[];
      expect(empty).toEqual([]);
    } finally {
      await engine.disconnect();
    }
  });

  test('PGLite operation uses the same lifecycle retrieval contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-assertion-retrieval-pglite-'));
    tempPaths.push(dir);
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ engine: 'pglite', database_path: dir });
      await engine.initSchema();
      const ctx = operationContext(engine, {
        engine: 'pglite',
        database_path: dir,
        offline: true,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      });

      await insertPGLiteAssertion(engine, { id: 'assertion:pglite-active', property: 'runtime.active', lifecycle_state: 'active' });
      await insertPGLiteAssertion(engine, { id: 'assertion:pglite-expired', property: 'runtime.expired', lifecycle_state: 'expired' });

      const defaults = await operationsByName.list_retrievable_assertions.handler(ctx, {
        target_slug: 'systems/mbrain',
      }) as any[];
      const audit = await operationsByName.list_retrievable_assertions.handler(ctx, {
        target_slug: 'systems/mbrain',
        mode: 'audit',
      }) as any[];

      expect(defaults.map((entry) => entry.assertion.id)).toEqual(['assertion:pglite-active']);
      expect(audit.map((entry) => entry.assertion.id)).toEqual(['assertion:pglite-active', 'assertion:pglite-expired']);
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

function insertSQLiteAssertion(
  engine: SQLiteEngine,
  input: {
    id: string;
    property: string;
    lifecycle_state: 'active' | 'stale' | 'expired' | 'archived' | 'purged';
    claim_type?: string;
  },
) {
  const database = (engine as any).database;
  database.run(`
    INSERT INTO assertions (
      id, claim_type, target_type, target_id, target_slug, property, value_json,
      normalized_claim, authority_summary, confidence, evidence_count,
      authority_state, lifecycle_state, valid_from, valid_until,
      supersedes_assertion_id, superseded_by_assertion_id, conflict_set_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, assertionParams(input));
}

async function insertPGLiteAssertion(
  engine: PGLiteEngine,
  input: {
    id: string;
    property: string;
    lifecycle_state: 'active' | 'stale' | 'expired' | 'archived' | 'purged';
    claim_type?: string;
  },
) {
  await engine.db.query(`
    INSERT INTO assertions (
      id, claim_type, target_type, target_id, target_slug, property, value_json,
      normalized_claim, authority_summary, confidence, evidence_count,
      authority_state, lifecycle_state, valid_from, valid_until,
      supersedes_assertion_id, superseded_by_assertion_id, conflict_set_id,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
  `, assertionParams(input));
}

function assertionParams(input: {
  id: string;
  property: string;
  lifecycle_state: 'active' | 'stale' | 'expired' | 'archived' | 'purged';
  claim_type?: string;
}) {
  return [
    input.id,
    input.claim_type ?? 'architecture_claim',
    'system',
    'systems/mbrain',
    'systems/mbrain',
    input.property,
    JSON.stringify({ status: input.lifecycle_state }),
    `${input.property} = ${input.lifecycle_state}`,
    JSON.stringify({ support: 1 }),
    0.9,
    1,
    'canonical',
    input.lifecycle_state,
    null,
    null,
    null,
    null,
    null,
    NOW,
    NOW,
  ];
}
