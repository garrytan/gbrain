import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  type AssertionRecord,
  type ExtractedClaim,
} from '../src/core/assertions/assertion-types.ts';
import { resolveExtractedClaim } from '../src/core/assertions/assertion-resolution.ts';
import { explainAssertionForEngine } from '../src/core/assertions/assertion-lineage-store.ts';
import { recordAssertionResolutionAudit } from '../src/core/assertions/assertion-resolution-audit-store.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

const NOW = '2026-06-14T12:00:00.000Z';

interface Harness {
  engine: BrainEngine;
  rows: (table: string) => Promise<Record<string, unknown>[]>;
  cleanup: () => Promise<void>;
}

for (const createHarness of [createSqliteHarness, createPgliteHarness]) {
  test(`${createHarness.name} records created assertion events and lineage`, async () => {
    const harness = await createHarness();
    try {
      const result = resolveExtractedClaim({
        claim: claim({
          id: 'claim:created',
          value_json: { role: 'governed_projection' },
        }),
        now: NOW,
      });
      await insertAssertions(harness.engine, [result.assertion]);

      await recordAssertionResolutionAudit(harness.engine, result);
      await recordAssertionResolutionAudit(harness.engine, result);

      const eventRows = await harness.rows('assertion_events');
      expect(eventRows).toEqual([
        expect.objectContaining({
          id: result.events[0]!.id,
          assertion_id: result.assertion.id,
          event_type: 'created',
          from_authority_state: null,
          to_authority_state: 'canonical',
          from_lifecycle_state: null,
          to_lifecycle_state: 'active',
          reason: 'claim resolved into assertion',
          actor: 'mbrain:assertion_pipeline',
          job_id: 'job:assertion-resolution-audit',
          created_at: NOW,
        }),
      ]);
      expect(jsonArray(eventRows[0]!.source_refs_json)).toEqual([
        'extracted-claim:claim:created',
        'source-chunk:source-chunk:runtime:0',
      ]);
      expect((await harness.rows('assertion_lineage'))).toEqual([
        expect.objectContaining({
          id: result.lineage[0]!.id,
          assertion_id: result.assertion.id,
          extracted_claim_id: 'claim:created',
          source_id: 'source:user-direct',
          source_item_id: 'source-item:runtime',
          source_chunk_id: 'source-chunk:runtime:0',
          session_id: null,
          task_event_id: null,
          created_at: NOW,
        }),
      ]);
      expect(await harness.rows('assertion_links')).toEqual([]);
      expect(await harness.rows('conflict_sets')).toEqual([]);
      expect(await harness.rows('conflict_set_assertions')).toEqual([]);

      const explain = await explainAssertionForEngine(harness.engine, {
        assertion_id: result.assertion.id,
      }) as any;
      expect(explain.recording_status.assertion_events.status).toBe('recorded');
    } finally {
      await harness.cleanup();
    }
  });

  test(`${createHarness.name} records conflict sets and conflict members`, async () => {
    const harness = await createHarness();
    try {
      const existing = assertion({
        id: 'assertion:conflict-existing',
        value_json: { role: 'postgres' },
      });
      const result = resolveExtractedClaim({
        claim: claim({
          id: 'claim:conflict-new',
          value_json: { role: 'markdown' },
        }),
        existing_assertions: [existing],
        now: NOW,
      });
      await insertAssertions(harness.engine, [result.assertion, ...result.updated_assertions]);
      await insertConflictSet(harness.engine, {
        ...result.conflict_sets[0]!,
        status: 'resolved',
        updated_at: '2026-06-14T11:00:00.000Z',
      });

      await recordAssertionResolutionAudit(harness.engine, result);
      await recordAssertionResolutionAudit(harness.engine, result);

      expect(await harness.rows('conflict_sets')).toEqual([
        expect.objectContaining({
          id: result.conflict_sets[0]!.id,
          target_type: 'system',
          target_id: 'systems/mbrain',
          property: 'runtime.semantic_state',
          status: 'open',
          created_at: NOW,
          updated_at: NOW,
        }),
      ]);
      await insertConflictSet(harness.engine, {
        ...result.conflict_sets[0]!,
        status: 'resolved',
        updated_at: '2026-06-14T13:00:00.000Z',
      });
      await recordAssertionResolutionAudit(harness.engine, result);
      expect(await harness.rows('conflict_sets')).toEqual([
        expect.objectContaining({
          id: result.conflict_sets[0]!.id,
          status: 'resolved',
          updated_at: '2026-06-14T13:00:00.000Z',
        }),
      ]);
      const conflictMembers = (await harness.rows('conflict_set_assertions')).map((row) => ({
        conflict_set_id: row.conflict_set_id,
        assertion_id: row.assertion_id,
        role: row.role,
      }));
      expect(conflictMembers).toEqual(result.conflict_set_assertions.map((member) => ({
        conflict_set_id: member.conflict_set_id,
        assertion_id: member.assertion_id,
        role: member.role,
      })).sort(compareConflictMember));

      const explain = await explainAssertionForEngine(harness.engine, {
        assertion_id: result.assertion.id,
      }) as any;
      expect(explain.recording_status.assertion_events.status).toBe('recorded');
      expect(explain.recording_status.conflict_sets.status).toBe('recorded');
    } finally {
      await harness.cleanup();
    }
  });

  test(`${createHarness.name} records supersession links`, async () => {
    const harness = await createHarness();
    try {
      const oldAssertion = assertion({
        id: 'assertion:superseded-old',
        value_json: { role: 'postgres' },
        valid_from: '2026-06-14T09:00:00.000Z',
      });
      const result = resolveExtractedClaim({
        claim: claim({
          id: 'claim:superseding-new',
          value_json: { role: 'postgres_and_sqlite' },
          valid_from: '2026-06-14T10:00:00.000Z',
        }),
        existing_assertions: [oldAssertion],
        now: NOW,
      });
      await insertAssertions(harness.engine, [result.assertion, ...result.updated_assertions]);

      await recordAssertionResolutionAudit(harness.engine, result);
      await recordAssertionResolutionAudit(harness.engine, result);

      expect((await harness.rows('assertion_links')).map((row) => ({
        id: row.id,
        scope_id: row.scope_id,
        policy_version: row.policy_version,
        from_assertion_id: row.from_assertion_id,
        to_assertion_id: row.to_assertion_id,
        link_type: row.link_type,
        created_at: row.created_at,
      }))).toEqual(result.links.map((link) => ({
        id: link.id,
        scope_id: link.scope_id,
        policy_version: link.policy_version,
        from_assertion_id: link.from_assertion_id,
        to_assertion_id: link.to_assertion_id,
        link_type: link.link_type,
        created_at: link.created_at,
      })));
      expect((await harness.rows('assertion_events')).map((row) => row.id)).toEqual(result.events.map((event) => event.id));
    } finally {
      await harness.cleanup();
    }
  });
}

async function createSqliteHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-assertion-resolution-audit-sqlite-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-assertion-resolution-audit-pglite-'));
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

async function insertAssertions(engine: BrainEngine, assertions: AssertionRecord[]): Promise<void> {
  for (const entry of assertions) {
    if ((engine as any).database) {
      (engine as any).database.query(`
        INSERT INTO assertions (
          id, scope_id, policy_version, authority_scope, claim_type, target_type,
          target_id, target_slug, property, value_json, normalized_claim,
          authority_summary, confidence, evidence_count, authority_state,
          lifecycle_state, valid_from, valid_until, supersedes_assertion_id,
          superseded_by_assertion_id, conflict_set_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          authority_state = excluded.authority_state,
          lifecycle_state = excluded.lifecycle_state,
          superseded_by_assertion_id = excluded.superseded_by_assertion_id,
          conflict_set_id = excluded.conflict_set_id,
          updated_at = excluded.updated_at
      `).run(...assertionParams(entry, false));
      continue;
    }
    await (engine as any).db.query(`
      INSERT INTO assertions (
        id, scope_id, policy_version, authority_scope, claim_type, target_type,
        target_id, target_slug, property, value_json, normalized_claim,
        authority_summary, confidence, evidence_count, authority_state,
        lifecycle_state, valid_from, valid_until, supersedes_assertion_id,
        superseded_by_assertion_id, conflict_set_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      ON CONFLICT(id) DO UPDATE SET
        authority_state = excluded.authority_state,
        lifecycle_state = excluded.lifecycle_state,
        superseded_by_assertion_id = excluded.superseded_by_assertion_id,
        conflict_set_id = excluded.conflict_set_id,
        updated_at = excluded.updated_at
    `, assertionParams(entry, true));
  }
}

function assertionParams(entry: AssertionRecord, _pg: boolean): unknown[] {
  return [
    entry.id,
    entry.scope_id,
    entry.policy_version,
    entry.authority_scope,
    entry.claim_type,
    entry.target_type,
    entry.target_id,
    entry.target_slug,
    entry.property,
    JSON.stringify(entry.value_json),
    entry.normalized_claim,
    JSON.stringify(entry.authority_summary),
    entry.confidence,
    entry.evidence_count,
    entry.authority_state,
    entry.lifecycle_state,
    entry.valid_from,
    entry.valid_until,
    entry.supersedes_assertion_id,
    entry.superseded_by_assertion_id,
    entry.conflict_set_id,
    entry.created_at,
    entry.updated_at,
  ];
}

function claim(overrides: Partial<ExtractedClaim> = {}): ExtractedClaim {
  return {
    id: 'claim:runtime',
    source_id: 'source:user-direct',
    source_item_id: 'source-item:runtime',
    source_chunk_id: 'source-chunk:runtime:0',
    extractor_kind: 'direct_structured',
    extractor_version: 'assertion-extractor-v1',
    runner_job_id: 'job:assertion-resolution-audit',
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

function assertion(overrides: Partial<AssertionRecord> = {}): AssertionRecord {
  return {
    id: 'assertion:runtime',
    scope_id: 'workspace:default',
    policy_version: 'policy:v1',
    authority_scope: 'work',
    claim_type: 'architecture_claim',
    target_type: 'system',
    target_id: 'systems/mbrain',
    target_slug: 'systems/mbrain',
    property: 'runtime.semantic_state',
    value_json: { role: 'canonical' },
    normalized_claim: 'architecture_claim:systems/mbrain:runtime.semantic_state:{"role":"canonical"}',
    authority_summary: { source_claim: 1 },
    confidence: 0.9,
    evidence_count: 1,
    authority_state: 'canonical',
    lifecycle_state: 'active',
    valid_from: null,
    valid_until: null,
    supersedes_assertion_id: null,
    superseded_by_assertion_id: null,
    conflict_set_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

async function insertConflictSet(
  engine: BrainEngine,
  conflictSet: {
    id: string;
    target_type: string;
    target_id: string;
    property: string;
    status: string;
    created_at: string;
    updated_at: string;
  },
): Promise<void> {
  if ((engine as any).database) {
    (engine as any).database.query(`
      INSERT INTO conflict_sets (id, target_type, target_id, property, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      conflictSet.id,
      conflictSet.target_type,
      conflictSet.target_id,
      conflictSet.property,
      conflictSet.status,
      conflictSet.created_at,
      conflictSet.updated_at,
    );
    return;
  }
  await (engine as any).db.query(`
    INSERT INTO conflict_sets (id, target_type, target_id, property, status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      updated_at = excluded.updated_at
  `, [
    conflictSet.id,
    conflictSet.target_type,
    conflictSet.target_id,
    conflictSet.property,
    conflictSet.status,
    conflictSet.created_at,
    conflictSet.updated_at,
  ]);
}

function orderBy(table: string): string {
  if (table === 'conflict_set_assertions') return 'conflict_set_id ASC, assertion_id ASC';
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

function compareConflictMember(
  left: { assertion_id: unknown },
  right: { assertion_id: unknown },
): number {
  return String(left.assertion_id).localeCompare(String(right.assertion_id));
}

function jsonArray(value: unknown): unknown[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}
