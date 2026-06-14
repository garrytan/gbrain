import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  recordCanonicalWriteAudit,
  type CanonicalWriteAuditInput,
} from '../src/core/assertions/canonical-write-audit-store.ts';
import { explainProjectionForEngine } from '../src/core/assertions/assertion-lineage-store.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

interface Harness {
  label: string;
  engine: BrainEngine;
  rows: (table: string) => Promise<Record<string, unknown>[]>;
  cleanup: () => Promise<void>;
}

for (const createHarness of [createSqliteHarness, createPgliteHarness]) {
  test(`${createHarness.name} records governed canonical write audit rows`, async () => {
    const harness = await createHarness();
    try {
      const result = await recordCanonicalWriteAudit(harness.engine, {
        now: '2026-06-14T10:15:00.000Z',
        policy_decision: 'auto_canonical',
        policy_explanation: 'user_direct decision is source-backed and safe for immediate canonical projection',
        status: 'applied',
        projection_status: 'applied',
        assertion_ids: ['assertion:decision-runtime'],
        assertion_evidence_ids: ['assertion-evidence:decision-runtime'],
        extracted_claim_ids: ['extracted-claim:decision-runtime'],
        source_refs: ['Source: User, direct message, 2026-06-14 10:15 KST'],
        target_projection: {
          id: 'projection:project-decisions',
          kind: 'project_decision_timeline',
          slug: 'projects/mbrain/decisions',
          mutation_kind: 'append_decision_timeline',
          before_markdown_hash: 'sha256:before-md',
          after_markdown_hash: 'sha256:after-md',
        },
        before_db_hash: 'sha256:before-db',
        after_db_hash: 'sha256:after-db',
        actor: {
          actor: 'codex',
          session_id: 'session:audit-store',
          job_id: 'job:audit-store',
          runner_id: 'runner:codex',
        },
        metadata_json: { source: 'test' },
      });

      expect(result.write_attempt_id).toMatch(/^canonical-write-attempt:[a-f0-9]{24}$/);
      expect(result.projection_target_ids).toEqual(['projection:project-decisions']);
      expect(result.projection_mutation_ids).toHaveLength(1);

      const writeAttempts = await harness.rows('canonical_write_attempts');
      expect(writeAttempts).toEqual([
        expect.objectContaining({
          id: result.write_attempt_id,
          policy_decision: 'auto_canonical',
          policy_explanation: 'user_direct decision is source-backed and safe for immediate canonical projection',
          policy_explanation_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          before_db_hash: 'sha256:before-db',
          after_db_hash: 'sha256:after-db',
          before_markdown_hash: 'sha256:before-md',
          after_markdown_hash: 'sha256:after-md',
          actor: 'codex',
          session_id: 'session:audit-store',
          job_id: 'job:audit-store',
          runner_id: 'runner:codex',
          status: 'applied',
          created_at: '2026-06-14T10:15:00.000Z',
        }),
      ]);
      expect(jsonArray(writeAttempts[0]!.assertion_ids)).toEqual(['assertion:decision-runtime']);
      expect(jsonArray(writeAttempts[0]!.assertion_evidence_ids)).toEqual(['assertion-evidence:decision-runtime']);
      expect(jsonArray(writeAttempts[0]!.extracted_claim_ids)).toEqual(['extracted-claim:decision-runtime']);
      expect(jsonArray(writeAttempts[0]!.source_refs)).toEqual(['Source: User, direct message, 2026-06-14 10:15 KST']);
      expect(jsonArray(writeAttempts[0]!.target_projection_ids)).toEqual(['projection:project-decisions']);
      expect(jsonObject(writeAttempts[0]!.metadata_json)).toMatchObject({ source: 'test' });

      const projectionTargets = await harness.rows('canonical_projection_targets');
      expect(projectionTargets).toEqual([
        expect.objectContaining({
          id: 'projection:project-decisions',
          target_type: 'project_doc',
          target_id: 'projects/mbrain/decisions',
          locator: 'brain/projects/mbrain/decisions.md',
          projection_hash: 'sha256:after-md',
          rendered_markdown: '',
          last_rendered_at: '2026-06-14T10:15:00.000Z',
          last_reconciled_at: '2026-06-14T10:15:00.000Z',
          status: 'applied',
          canonical_changed_since_projection: false,
          created_at: '2026-06-14T10:15:00.000Z',
          updated_at: '2026-06-14T10:15:00.000Z',
        }),
      ]);
      expect(jsonArray(projectionTargets[0]!.source_assertion_ids)).toEqual(['assertion:decision-runtime']);
      expect(jsonObject(projectionTargets[0]!.metadata_json)).toMatchObject({
        projection_kind: 'project_decision_timeline',
      });

      const projectionMutations = await harness.rows('canonical_projection_mutations');
      expect(projectionMutations).toEqual([
        expect.objectContaining({
          id: result.projection_mutation_ids[0],
          canonical_write_attempt_id: result.write_attempt_id,
          projection_kind: 'project_decision_timeline',
          projection_slug: 'projects/mbrain/decisions',
          mutation_kind: 'append_decision_timeline',
          before_markdown_hash: 'sha256:before-md',
          after_markdown_hash: 'sha256:after-md',
          status: 'applied',
          error_message: null,
          created_at: '2026-06-14T10:15:00.000Z',
        }),
      ]);
      expect(jsonArray(projectionMutations[0]!.assertion_ids)).toEqual(['assertion:decision-runtime']);
      expect(jsonArray(projectionMutations[0]!.assertion_evidence_ids)).toEqual(['assertion-evidence:decision-runtime']);
      expect(jsonArray(projectionMutations[0]!.extracted_claim_ids)).toEqual(['extracted-claim:decision-runtime']);
      expect(jsonArray(projectionMutations[0]!.source_refs)).toEqual(['Source: User, direct message, 2026-06-14 10:15 KST']);

      const lineage = await explainProjectionForEngine(harness.engine, {
        target_type: 'project_doc',
        target_id: 'projects/mbrain/decisions',
      }) as any;
      expect(lineage.canonical_write_attempts.map((attempt: any) => attempt.id)).toEqual([result.write_attempt_id]);
      expect(lineage.projection_targets.map((target: any) => target.id)).toEqual(['projection:project-decisions']);
      expect(lineage.projection_mutations.map((mutation: any) => mutation.id)).toEqual(result.projection_mutation_ids);
    } finally {
      await harness.cleanup();
    }
  });

  test(`${createHarness.name} preserves projection hash when a later failed markdown audit has only a before snapshot`, async () => {
    const harness = await createHarness();
    try {
      await recordCanonicalWriteAudit(harness.engine, appliedAuditInput());
      await recordCanonicalWriteAudit(harness.engine, {
        ...appliedAuditInput({
          status: 'pending_reconcile',
          projection_status: 'failed_markdown',
          assertion_ids: ['assertion:decision-later'],
          assertion_evidence_ids: ['assertion-evidence:decision-later'],
          extracted_claim_ids: ['extracted-claim:decision-later'],
          error: {
            code: 'failed_markdown',
            message: 'snapshot unavailable',
          },
        }),
        target_projection: {
          id: 'projection:project-decisions',
          kind: 'project_decision_timeline',
          slug: 'projects/mbrain/decisions',
          mutation_kind: 'append_decision_timeline',
          before_markdown_hash: 'sha256:human-edit-before-failed-write',
          after_markdown_hash: null,
        },
      });

      const projectionTargets = await harness.rows('canonical_projection_targets');
      expect(projectionTargets).toHaveLength(1);
      expect(projectionTargets[0]).toMatchObject({
        id: 'projection:project-decisions',
        projection_hash: 'sha256:after-md',
        status: 'pending_reconcile',
        canonical_changed_since_projection: true,
      });
      expect(jsonArray(projectionTargets[0]!.source_assertion_ids)).toEqual([
        'assertion:decision-runtime',
        'assertion:decision-later',
      ]);
    } finally {
      await harness.cleanup();
    }
  });
}

async function createSqliteHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-canonical-audit-sqlite-'));
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
  await engine.initSchema();
  return {
    label: 'sqlite',
    engine,
    rows: async (table) => normalizeRows((engine as any).database.query(`SELECT * FROM ${table} ORDER BY id ASC`).all() as Record<string, unknown>[]),
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createPgliteHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-canonical-audit-pglite-'));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dir });
  await engine.initSchema();
  return {
    label: 'pglite',
    engine,
    rows: async (table) => normalizeRows((await engine.db.query(`SELECT * FROM ${table} ORDER BY id ASC`)).rows as Record<string, unknown>[]),
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value instanceof Date) {
        normalized[key] = value.toISOString();
      } else if ((key === 'runtime_only' || key === 'canonical_changed_since_projection') && typeof value === 'number') {
        normalized[key] = value !== 0;
      } else {
        normalized[key] = value;
      }
    }
    return normalized;
  });
}

function jsonArray(value: unknown): unknown[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function appliedAuditInput(overrides: Partial<CanonicalWriteAuditInput> = {}): CanonicalWriteAuditInput {
  return {
    now: '2026-06-14T10:15:00.000Z',
    policy_decision: 'auto_canonical',
    policy_explanation: 'user_direct decision is source-backed and safe for immediate canonical projection',
    status: 'applied',
    projection_status: 'applied',
    assertion_ids: ['assertion:decision-runtime'],
    assertion_evidence_ids: ['assertion-evidence:decision-runtime'],
    extracted_claim_ids: ['extracted-claim:decision-runtime'],
    source_refs: ['Source: User, direct message, 2026-06-14 10:15 KST'],
    target_projection: {
      id: 'projection:project-decisions',
      kind: 'project_decision_timeline',
      slug: 'projects/mbrain/decisions',
      mutation_kind: 'append_decision_timeline',
      before_markdown_hash: 'sha256:before-md',
      after_markdown_hash: 'sha256:after-md',
    },
    before_db_hash: 'sha256:before-db',
    after_db_hash: 'sha256:after-db',
    actor: {
      actor: 'codex',
      session_id: 'session:audit-store',
      job_id: 'job:audit-store',
      runner_id: 'runner:codex',
    },
    metadata_json: { source: 'test' },
    ...overrides,
  };
}
