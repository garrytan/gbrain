import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ExtractedClaim } from '../src/core/assertions/assertion-types.ts';
import { explainAssertionForEngine } from '../src/core/assertions/assertion-lineage-store.ts';
import { resolveExtractedClaimForEngine } from '../src/core/assertions/assertion-resolution-store.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

const NOW = '2026-06-14T12:00:00.000Z';

interface Harness {
  engine: BrainEngine;
  rows: (table: string) => Promise<Record<string, unknown>[]>;
  cleanup: () => Promise<void>;
}

for (const createHarness of [createSqliteHarness, createPgliteHarness]) {
  test(`${createHarness.name} resolves a new claim and records parent plus audit rows`, async () => {
    const harness = await createHarness();
    try {
      const result = await resolveExtractedClaimForEngine(harness.engine, {
        claim: claim({
          id: 'claim:new',
          value_json: { role: 'governed_projection' },
        }),
        now: NOW,
      });

      expect(result.resolution).toBe('created');
      expect(await selectColumns(harness, 'extracted_claims', [
        'id',
        'status',
        'source_chunk_id',
        'created_at',
      ])).toEqual([
        {
          id: 'claim:new',
          status: 'resolved',
          source_chunk_id: 'source-chunk:runtime:0',
          created_at: NOW,
        },
      ]);
      expect(await selectColumns(harness, 'assertions', [
        'id',
        'authority_state',
        'lifecycle_state',
        'evidence_count',
        'target_slug',
      ])).toEqual([
        {
          id: result.assertion.id,
          authority_state: 'canonical',
          lifecycle_state: 'active',
          evidence_count: 1,
          target_slug: 'systems/mbrain',
        },
      ]);
      expect((await harness.rows('assertion_evidence')).map((row) => row.extracted_claim_id)).toEqual(['claim:new']);
      expect((await harness.rows('assertion_events')).map((row) => row.event_type)).toEqual(['created']);
      expect((await harness.rows('assertion_lineage')).map((row) => row.extracted_claim_id)).toEqual(['claim:new']);

      const explain = await explainAssertionForEngine(harness.engine, {
        assertion_id: result.assertion.id,
      }) as any;
      expect(explain.recording_status.assertion_events.status).toBe('recorded');
      expect(explain.recording_status.conflict_sets.status).toBe('not_applicable');
    } finally {
      await harness.cleanup();
    }
  });

  test(`${createHarness.name} resolves conflicting claims and records conflict ledgers`, async () => {
    const harness = await createHarness();
    try {
      const first = await resolveExtractedClaimForEngine(harness.engine, {
        claim: claim({
          id: 'claim:postgres',
          source_chunk_id: 'source-chunk:postgres:0',
          value_json: { role: 'postgres' },
        }),
        now: NOW,
      });
      const conflict = await resolveExtractedClaimForEngine(harness.engine, {
        claim: claim({
          id: 'claim:markdown',
          source_chunk_id: 'source-chunk:markdown:0',
          value_json: { role: 'markdown' },
        }),
        now: '2026-06-14T12:01:00.000Z',
      });

      expect(conflict.resolution).toBe('conflicted');
      expect(await selectColumns(harness, 'assertions', [
        'id',
        'authority_state',
        'conflict_set_id',
      ])).toEqual([
        {
          id: first.assertion.id,
          authority_state: 'conflicted',
          conflict_set_id: conflict.conflict_sets[0]!.id,
        },
        {
          id: conflict.assertion.id,
          authority_state: 'conflicted',
          conflict_set_id: conflict.conflict_sets[0]!.id,
        },
      ]);
      expect(await selectColumns(harness, 'conflict_sets', [
        'id',
        'status',
        'updated_at',
      ])).toEqual([
        {
          id: conflict.conflict_sets[0]!.id,
          status: 'open',
          updated_at: '2026-06-14T12:01:00.000Z',
        },
      ]);
      expect((await harness.rows('conflict_set_assertions')).map((row) => ({
        assertion_id: row.assertion_id,
        role: row.role,
      }))).toEqual([
        { assertion_id: first.assertion.id, role: 'existing' },
        { assertion_id: conflict.assertion.id, role: 'new_claim' },
      ]);

      const explain = await explainAssertionForEngine(harness.engine, {
        assertion_id: conflict.assertion.id,
      }) as any;
      expect(explain.recording_status.conflict_sets.status).toBe('recorded');
    } finally {
      await harness.cleanup();
    }
  });

  test(`${createHarness.name} resolves temporal supersession and records assertion links`, async () => {
    const harness = await createHarness();
    try {
      const old = await resolveExtractedClaimForEngine(harness.engine, {
        claim: claim({
          id: 'claim:old',
          source_chunk_id: 'source-chunk:old:0',
          value_json: { role: 'postgres' },
          valid_from: '2026-06-14T09:00:00.000Z',
        }),
        now: NOW,
      });
      const newer = await resolveExtractedClaimForEngine(harness.engine, {
        claim: claim({
          id: 'claim:newer',
          source_chunk_id: 'source-chunk:newer:0',
          value_json: { role: 'postgres_and_sqlite' },
          valid_from: '2026-06-14T10:00:00.000Z',
        }),
        now: '2026-06-14T12:02:00.000Z',
      });

      expect(newer.resolution).toBe('superseded');
      expect(await selectColumns(harness, 'assertions', [
        'id',
        'lifecycle_state',
        'superseded_by_assertion_id',
        'supersedes_assertion_id',
      ])).toEqual([
        {
          id: old.assertion.id,
          lifecycle_state: 'expired',
          superseded_by_assertion_id: newer.assertion.id,
          supersedes_assertion_id: null,
        },
        {
          id: newer.assertion.id,
          lifecycle_state: 'active',
          superseded_by_assertion_id: null,
          supersedes_assertion_id: old.assertion.id,
        },
      ]);
      expect((await harness.rows('assertion_links')).map((row) => ({
        from_assertion_id: row.from_assertion_id,
        to_assertion_id: row.to_assertion_id,
        link_type: row.link_type,
      }))).toEqual([
        {
          from_assertion_id: newer.assertion.id,
          to_assertion_id: old.assertion.id,
          link_type: 'supersedes',
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  test(`${createHarness.name} does not double-count evidence when replaying the same claim`, async () => {
    const harness = await createHarness();
    try {
      const originalClaim = claim({
        id: 'claim:replayed',
        source_chunk_id: 'source-chunk:replayed:0',
        value_json: { role: 'governed_projection' },
      });

      const first = await resolveExtractedClaimForEngine(harness.engine, {
        claim: originalClaim,
        now: NOW,
      });
      const replay = await resolveExtractedClaimForEngine(harness.engine, {
        claim: originalClaim,
        now: '2026-06-14T12:03:00.000Z',
      });

      expect(replay.resolution).toBe('duplicate');
      expect(await selectColumns(harness, 'assertions', [
        'id',
        'evidence_count',
        'confidence',
      ])).toEqual([
        {
          id: first.assertion.id,
          evidence_count: 1,
          confidence: 0.9,
        },
      ]);
      expect(await selectColumns(harness, 'assertion_evidence', [
        'assertion_id',
        'extracted_claim_id',
      ])).toEqual([
        {
          assertion_id: first.assertion.id,
          extracted_claim_id: 'claim:replayed',
        },
      ]);
      expect((await harness.rows('assertion_events')).map((row) => row.event_type)).toEqual(['created']);
      expect((await harness.rows('assertion_lineage')).map((row) => row.extracted_claim_id)).toEqual(['claim:replayed']);
    } finally {
      await harness.cleanup();
    }
  });

  test(`${createHarness.name} keeps target type inference aligned with pure resolution`, async () => {
    const harness = await createHarness();
    try {
      const task = await resolveExtractedClaimForEngine(harness.engine, {
        claim: claim({
          id: 'claim:task',
          target_hint: 'task:phase-12',
          property_hint: 'status',
          value_json: { state: 'open' },
        }),
        now: NOW,
      });
      const profile = await resolveExtractedClaimForEngine(harness.engine, {
        claim: claim({
          id: 'claim:profile',
          target_hint: 'profile:user',
          property_hint: 'preference',
          value_json: { theme: 'dark' },
        }),
        now: NOW,
      });

      const assertionRows = await selectColumns(harness, 'assertions', [
        'id',
        'target_type',
        'target_id',
        'target_slug',
      ]);
      assertionRows.sort((left, right) => String(left.target_id).localeCompare(String(right.target_id)));
      expect(assertionRows).toEqual([
        {
          id: profile.assertion.id,
          target_type: 'profile',
          target_id: 'profile:user',
          target_slug: null,
        },
        {
          id: task.assertion.id,
          target_type: 'task',
          target_id: 'task:phase-12',
          target_slug: null,
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });
}

test('Postgres resolution takes a target advisory lock before reading existing assertions', async () => {
  const queries: string[] = [];
  const fake = Object.create(PostgresEngine.prototype) as PostgresEngine;
  Object.defineProperty(fake, 'sql', {
    get: () => ({
      unsafe: async (sql: string) => {
        queries.push(sql);
        return [];
      },
    }),
  });
  Object.defineProperty(fake, 'transaction', {
    value: async (fn: (engine: BrainEngine) => Promise<unknown>) => fn(fake),
  });

  await resolveExtractedClaimForEngine(fake, {
    claim: claim({
      id: 'claim:postgres-lock',
      value_json: { role: 'postgres' },
    }),
    now: NOW,
  });

  const lockIndex = queries.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
  const readIndex = queries.findIndex((sql) => sql.includes('FROM assertions'));
  expect(lockIndex).toBeGreaterThanOrEqual(0);
  expect(readIndex).toBeGreaterThan(lockIndex);
});

async function createSqliteHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-assertion-resolution-store-sqlite-'));
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
  await engine.initSchema();
  return {
    engine,
    rows: async (table) => normalizeRows((engine as any).database.query(`SELECT * FROM ${table} ORDER BY ${orderBy(table)}`).all() as Record<string, unknown>[]),
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createPgliteHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-assertion-resolution-store-pglite-'));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dir });
  await engine.initSchema();
  return {
    engine,
    rows: async (table) => normalizeRows((await engine.db.query(`SELECT * FROM ${table} ORDER BY ${orderBy(table)}`)).rows as Record<string, unknown>[]),
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function selectColumns(
  harness: Harness,
  table: string,
  columns: string[],
): Promise<Record<string, unknown>[]> {
  return (await harness.rows(table)).map((row) => Object.fromEntries(
    columns.map((column) => [column, row[column]]),
  ));
}

function claim(overrides: Partial<ExtractedClaim> = {}): ExtractedClaim {
  return {
    id: 'claim:runtime',
    source_id: 'source:user-direct',
    source_item_id: 'source-item:runtime',
    source_chunk_id: 'source-chunk:runtime:0',
    extractor_kind: 'direct_structured',
    extractor_version: 'assertion-extractor-v1',
    runner_job_id: 'job:assertion-resolution-store',
    claim_text: 'MBrain uses governed canonical memory.',
    claim_type: 'architecture_claim',
    target_hint: 'systems/mbrain',
    property_hint: 'runtime.semantic_state',
    value_json: { role: 'canonical' },
    confidence: 0.9,
    sensitivity_level: 'normal',
    prompt_injection_flag: false,
    secret_flag: false,
    status: 'pending_resolution',
    valid_from: null,
    valid_until: null,
    created_at: NOW,
    ...overrides,
  };
}

function orderBy(table: string): string {
  if (table === 'conflict_set_assertions') return 'conflict_set_id ASC, assertion_id ASC';
  if (table === 'assertions') return 'created_at ASC, id ASC';
  return 'id ASC';
}

function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[key] = value instanceof Date ? value.toISOString() : value;
    }
    return normalized;
  });
}
