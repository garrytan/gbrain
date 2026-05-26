import { describe, expect, test } from 'bun:test';
import { buildDoctorReport } from '../src/core/services/doctor-service.ts';
import {
  createSystemOfRecordReconcilerService,
  summarizeSystemOfRecordHealth,
  type ProjectionTargetRecord,
} from '../src/core/services/system-of-record-reconciler-service.ts';
import {
  parseMarkdownProjection,
  projectionContentHash,
  renderMarkdownProjection,
} from '../src/core/reconciler/markdown-contracts.ts';
import { SCHEMA_SQL } from '../src/core/schema-embedded.ts';

const now = '2026-05-22T00:00:00.000Z';

describe('system of record reconciler service', () => {
  test('schema declares the Phase 10 projection target registry', () => {
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS canonical_projection_targets');
    expect(SCHEMA_SQL).toContain("target_type TEXT NOT NULL CHECK (target_type IN ('markdown_page', 'page_timeline', 'profile_memory', 'personal_episode', 'task_resume', 'project_doc', 'system_doc', 'source_summary', 'daily_report'))");
    expect(SCHEMA_SQL).toContain("status TEXT NOT NULL CHECK (status IN ('applied', 'pending_reconcile', 'reconciled', 'failed', 'conflict'))");
  });

  test('check detects projection hash drift while excluding runtime-only state', async () => {
    const canonical = projectionMarkdown('Canonical projection.', 'systems/mbrain', 'system_doc');
    const edited = projectionMarkdown('Human edited projection.', 'systems/mbrain', 'system_doc');
    const harness = createHarness([
      projectionTarget({
        id: 'projection:systems/mbrain',
        target_type: 'system_doc',
        target_id: 'systems/mbrain',
        locator: 'systems/mbrain.md',
        rendered_markdown: canonical,
        projection_hash: projectionHash(canonical),
      }),
      projectionTarget({
        id: 'projection:runtime/job-1',
        target_type: 'task_resume',
        target_id: 'task:job-1',
        locator: 'runtime/task-job-1.md',
        runtime_only: true,
        rendered_markdown: projectionMarkdown('Runtime-only state.', 'task:job-1', 'task_resume'),
      }),
    ], {
      'systems/mbrain.md': edited,
      'runtime/task-job-1.md': projectionMarkdown('Runtime drift that should not matter.', 'task:job-1', 'task_resume'),
    });

    const result = await harness.service.run({ mode: 'check' });

    expect(result.items).toEqual([expect.objectContaining({
      target_id: 'systems/mbrain',
      status: 'pending_reconcile',
      reason: 'projection_drift',
    })]);
    expect(result.excluded_runtime_only).toEqual(['projection:runtime/job-1']);
  });

  test('check accepts byte-stable contract projections without full-file hash drift', async () => {
    const canonical = projectionMarkdown('Canonical projection.', 'systems/mbrain', 'system_doc');
    const harness = createHarness([
      projectionTarget({
        id: 'projection:systems/mbrain',
        target_type: 'system_doc',
        target_id: 'systems/mbrain',
        locator: 'systems/mbrain.md',
        rendered_markdown: canonical,
        projection_hash: projectionHash(canonical),
      }),
    ], { 'systems/mbrain.md': canonical });

    const result = await harness.service.run({ mode: 'check' });

    expect(projectionContentHash(canonical)).not.toBe(projectionHash(canonical));
    expect(result.items).toEqual([expect.objectContaining({
      target_id: 'systems/mbrain',
      status: 'ok',
    })]);
  });

  test('repair_markdown restores a missing projection from freshly rendered canonical assertions', async () => {
    const staleCached = projectionMarkdown('Stale cached content.', 'projects/apollo', 'project_doc');
    const canonical = projectionMarkdown('Canonical repair content.', 'projects/apollo', 'project_doc');
    const harness = createHarness([
      projectionTarget({
        id: 'projection:projects/apollo',
        target_type: 'project_doc',
        target_id: 'projects/apollo',
        locator: 'projects/apollo.md',
        rendered_markdown: staleCached,
        projection_hash: projectionHash(staleCached),
      }),
    ], {}, { 'projection:projects/apollo': canonical });

    const result = await harness.service.run({
      mode: 'repair_markdown',
      target_id: 'projects/apollo',
    });

    expect(harness.markdown['projects/apollo.md']).toBe(canonical);
    expect(harness.targets[0]?.projection_hash).toBe(projectionHash(canonical));
    expect(result.items[0]).toMatchObject({
      target_id: 'projects/apollo',
      status: 'reconciled',
      action: 'repair_markdown',
    });
    expect(harness.events[0]).toMatchObject({
      operation: 'system_of_record_reconcile',
      result: 'applied',
      metadata: expect.objectContaining({ mode: 'repair_markdown' }),
    });
  });

  test('repair_markdown quarantines when canonical and Markdown changed since the last projection', async () => {
    const lastProjection = projectionMarkdown('Last reconciled content.', 'systems/mbrain', 'system_doc');
    const humanEdited = projectionMarkdown('Human changed Markdown too.', 'systems/mbrain', 'system_doc');
    const newlyRendered = projectionMarkdown('DB changed canonical rendering.', 'systems/mbrain', 'system_doc');
    const harness = createHarness([
      projectionTarget({
        id: 'projection:systems/mbrain',
        target_type: 'system_doc',
        target_id: 'systems/mbrain',
        locator: 'systems/mbrain.md',
        rendered_markdown: newlyRendered,
        projection_hash: projectionHash(lastProjection),
        canonical_changed_since_projection: true,
      }),
    ], { 'systems/mbrain.md': humanEdited }, { 'projection:systems/mbrain': newlyRendered });

    const result = await harness.service.run({
      mode: 'repair_markdown',
      target_id: 'systems/mbrain',
    });

    expect(harness.markdown['systems/mbrain.md']).toBe(humanEdited);
    expect(harness.targets[0]?.status).toBe('conflict');
    expect(result.items[0]).toMatchObject({
      status: 'conflict',
      reason: 'db_and_markdown_changed',
      action: 'repair_markdown',
    });
  });

  test('repair_markdown does not overwrite Markdown-only human edits', async () => {
    const lastProjection = projectionMarkdown('Last reconciled content.', 'systems/mbrain', 'system_doc');
    const humanEdited = projectionMarkdown('Human changed Markdown only.', 'systems/mbrain', 'system_doc');
    const harness = createHarness([
      projectionTarget({
        id: 'projection:systems/mbrain',
        target_type: 'system_doc',
        target_id: 'systems/mbrain',
        locator: 'systems/mbrain.md',
        rendered_markdown: lastProjection,
        projection_hash: projectionHash(lastProjection),
        canonical_changed_since_projection: false,
      }),
    ], { 'systems/mbrain.md': humanEdited }, { 'projection:systems/mbrain': lastProjection });

    const result = await harness.service.run({
      mode: 'repair_markdown',
      target_id: 'systems/mbrain',
    });

    expect(harness.markdown['systems/mbrain.md']).toBe(humanEdited);
    expect(harness.targets[0]?.status).toBe('pending_reconcile');
    expect(harness.events).toEqual([]);
    expect(result.items[0]).toMatchObject({
      status: 'pending_reconcile',
      reason: 'projection_drift',
      action: 'repair_markdown',
      semantic_assertion_mutations: 0,
    });
  });

  test('repair_db repairs projection metadata without semantic assertion mutation', async () => {
    const canonical = projectionMarkdown('Old rendered content.', 'systems/mbrain', 'system_doc');
    const edited = projectionMarkdown('Metadata repair only.', 'systems/mbrain', 'system_doc');
    const target = projectionTarget({
      id: 'projection:systems/mbrain',
      target_type: 'system_doc',
      target_id: 'systems/mbrain',
      locator: 'systems/mbrain.md',
      rendered_markdown: canonical,
      projection_hash: projectionHash(canonical),
      source_assertion_ids: ['assertion:existing'],
    });
    const harness = createHarness([target], { 'systems/mbrain.md': edited });

    const result = await harness.service.run({
      mode: 'repair_db',
      target_id: 'systems/mbrain',
    });

    expect(harness.targets[0]).toMatchObject({
      projection_hash: projectionHash(edited),
      source_assertion_ids: ['assertion:existing'],
      status: 'reconciled',
    });
    expect(result.items[0]).toMatchObject({
      action: 'repair_db',
      semantic_assertion_mutations: 0,
    });
  });

  test('repair_db quarantines when canonical and Markdown changed since the last projection', async () => {
    const lastProjection = projectionMarkdown('Last reconciled content.', 'systems/mbrain', 'system_doc');
    const dbChanged = projectionMarkdown('DB changed canonical rendering.', 'systems/mbrain', 'system_doc');
    const humanEdited = projectionMarkdown('Human changed Markdown too.', 'systems/mbrain', 'system_doc');
    const harness = createHarness([
      projectionTarget({
        id: 'projection:systems/mbrain',
        target_type: 'system_doc',
        target_id: 'systems/mbrain',
        locator: 'systems/mbrain.md',
        rendered_markdown: dbChanged,
        projection_hash: projectionHash(lastProjection),
        canonical_changed_since_projection: true,
      }),
    ], { 'systems/mbrain.md': humanEdited });

    const result = await harness.service.run({
      mode: 'repair_db',
      target_id: 'systems/mbrain',
    });

    expect(harness.markdown['systems/mbrain.md']).toBe(humanEdited);
    expect(harness.targets[0]).toMatchObject({
      status: 'conflict',
      projection_hash: projectionHash(lastProjection),
      rendered_markdown: dbChanged,
    });
    expect(result.items[0]).toMatchObject({
      status: 'conflict',
      reason: 'db_and_markdown_changed',
      action: 'repair_db',
      semantic_assertion_mutations: 0,
    });
    expect(harness.events[0]).toMatchObject({
      operation: 'system_of_record_reconcile',
      result: 'conflict',
      metadata: expect.objectContaining({ mode: 'repair_db' }),
    });
  });

  test('repair_db quarantines invalid or mismatched Markdown when canonical changed too', async () => {
    const lastProjection = projectionMarkdown('Last reconciled content.', 'systems/mbrain', 'system_doc');
    const dbChanged = projectionMarkdown('DB changed canonical rendering.', 'systems/mbrain', 'system_doc');
    const unsafeMarkdownCases = [
      '<!-- no projection fence -->\nHuman changed Markdown into a non-projection file.',
      projectionMarkdown('Wrong file content.', 'systems/other', 'system_doc'),
    ];

    for (const markdown of unsafeMarkdownCases) {
      const harness = createHarness([
        projectionTarget({
          id: 'projection:systems/mbrain',
          target_type: 'system_doc',
          target_id: 'systems/mbrain',
          locator: 'systems/mbrain.md',
          rendered_markdown: dbChanged,
          projection_hash: projectionHash(lastProjection),
          canonical_changed_since_projection: true,
        }),
      ], { 'systems/mbrain.md': markdown });

      const result = await harness.service.run({
        mode: 'repair_db',
        target_id: 'systems/mbrain',
      });

      expect(harness.targets[0]).toMatchObject({
        status: 'conflict',
        projection_hash: projectionHash(lastProjection),
        rendered_markdown: dbChanged,
      });
      expect(result.items[0]).toMatchObject({
        status: 'conflict',
        reason: 'db_and_markdown_changed',
        action: 'repair_db',
        semantic_assertion_mutations: 0,
      });
      expect(harness.events[0]).toMatchObject({
        result: 'conflict',
        metadata: expect.objectContaining({ mode: 'repair_db' }),
      });
    }
  });

  test('repair_db rejects Markdown projections for a different canonical target', async () => {
    const wrongTargetMarkdown = projectionMarkdown('Wrong file content.', 'systems/other', 'system_doc');
    const harness = createHarness([
      projectionTarget({
        id: 'projection:systems/mbrain',
        target_type: 'system_doc',
        target_id: 'systems/mbrain',
        locator: 'systems/mbrain.md',
      }),
    ], { 'systems/mbrain.md': wrongTargetMarkdown });

    const result = await harness.service.run({
      mode: 'repair_db',
      target_id: 'systems/mbrain',
    });

    expect(harness.targets[0]?.status).toBe('failed');
    expect(result.items[0]).toMatchObject({
      status: 'failed',
      reason: 'target_mismatch',
      action: 'repair_db',
      semantic_assertion_mutations: 0,
    });
  });

  test('import_markdown_edit creates source-backed markdown_file ingest instead of mutating assertions directly', async () => {
    const edited = projectionMarkdown('Human-authored semantic edit.', 'systems/mbrain', 'system_doc');
    const harness = createHarness([
      projectionTarget({
        id: 'projection:systems/mbrain',
        target_type: 'system_doc',
        target_id: 'systems/mbrain',
        locator: 'systems/mbrain.md',
        rendered_markdown: projectionMarkdown('Canonical content.', 'systems/mbrain', 'system_doc'),
      }),
    ], { 'systems/mbrain.md': edited });

    const result = await harness.service.run({
      mode: 'import_markdown_edit',
      target_id: 'systems/mbrain',
    });

    expect(result.items[0]).toMatchObject({
      action: 'import_markdown_edit',
      status: 'pending_reconcile',
      reason: 'policy_pipeline_required',
      semantic_assertion_mutations: 0,
    });
    expect(result.raw_ingest_plans).toHaveLength(1);
    expect(result.raw_ingest_plans?.[0]?.item).toMatchObject({
      source_id: 'source:markdown-file',
      external_id: 'systems/mbrain.md',
      origin_event: 'markdown_edit',
      locator: 'systems/mbrain.md',
    });
    expect(result.raw_ingest_plans?.[0]?.chunks[0]?.chunk_text).toBe(edited);
  });

  test('import_markdown_edit returns one raw ingest plan per target', async () => {
    const first = projectionMarkdown('First semantic edit.', 'systems/first', 'system_doc');
    const second = projectionMarkdown('Second semantic edit.', 'systems/second', 'system_doc');
    const harness = createHarness([
      projectionTarget({
        id: 'projection:systems/first',
        target_id: 'systems/first',
        locator: 'systems/first.md',
        rendered_markdown: first,
      }),
      projectionTarget({
        id: 'projection:systems/second',
        target_id: 'systems/second',
        locator: 'systems/second.md',
        rendered_markdown: second,
      }),
    ], {
      'systems/first.md': first,
      'systems/second.md': second,
    });

    const result = await harness.service.run({ mode: 'import_markdown_edit' });

    expect(result.items).toHaveLength(2);
    expect(result.raw_ingest_plans?.map((plan) => plan.item.external_id)).toEqual([
      'systems/first.md',
      'systems/second.md',
    ]);
  });

  test('conflicting DB and Markdown edits are quarantined instead of auto-repaired', async () => {
    const lastProjection = projectionMarkdown('Last reconciled content.', 'systems/mbrain', 'system_doc');
    const harness = createHarness([
      projectionTarget({
        id: 'projection:systems/mbrain',
        target_type: 'system_doc',
        target_id: 'systems/mbrain',
        locator: 'systems/mbrain.md',
        rendered_markdown: projectionMarkdown('DB changed canonical rendering.', 'systems/mbrain', 'system_doc'),
        projection_hash: projectionHash(lastProjection),
        canonical_changed_since_projection: true,
      }),
    ], { 'systems/mbrain.md': projectionMarkdown('Human changed Markdown too.', 'systems/mbrain', 'system_doc') });

    const result = await harness.service.run({
      mode: 'quarantine_conflict',
      target_id: 'systems/mbrain',
    });

    expect(result.items[0]).toMatchObject({
      status: 'conflict',
      reason: 'db_and_markdown_changed',
      action: 'quarantine_conflict',
    });
    expect(harness.targets[0]?.status).toBe('conflict');
  });

  test('doctor reports pending_reconcile and failed projection health', () => {
    const report = buildDoctorReport({
      connectionOk: true,
      stats: {
        page_count: 0,
        chunk_count: 0,
        embedded_count: 0,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      },
      config: null,
      profile: null,
      rawPostgresChecksSupported: false,
      schemaVersion: '43',
      latestVersion: 43,
      health: {
        page_count: 0,
        embed_coverage: 1,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 0,
      },
      systemOfRecord: summarizeSystemOfRecordHealth([
        projectionTarget({ id: 'projection:pending', status: 'pending_reconcile' }),
        projectionTarget({ id: 'projection:failed', status: 'failed' }),
      ]),
    });

    expect(report.checks).toContainEqual({
      name: 'system_of_record',
      status: 'warn',
      message: '1 pending reconcile, 1 failed projection',
    });
  });
});

function projectionMarkdown(
  body: string,
  target_id = 'systems/default',
  target_type: ProjectionTargetRecord['target_type'] = 'system_doc',
): string {
  return renderMarkdownProjection({
    target_id,
    target_type,
    frontmatter: { type: 'system' },
    compiled_truth: body,
    timeline: '- **2026-05-20** | Source-backed timeline.',
  });
}

function projectionHash(markdown: string): string {
  return parseMarkdownProjection(markdown).projection_hash;
}

function projectionTarget(overrides: Partial<ProjectionTargetRecord> = {}): ProjectionTargetRecord {
  const target_id = overrides.target_id ?? 'systems/default';
  const target_type = overrides.target_type ?? 'system_doc';
  const rendered = overrides.rendered_markdown ?? projectionMarkdown('Canonical projection.', target_id, target_type);
  return {
    id: 'projection:default',
    target_type,
    target_id,
    locator: 'systems/default.md',
    source_assertion_ids: [],
    projection_hash: projectionHash(rendered),
    rendered_markdown: rendered,
    last_rendered_at: '2026-05-20T00:00:00.000Z',
    last_reconciled_at: '2026-05-20T00:00:00.000Z',
    status: 'applied',
    runtime_only: false,
    canonical_changed_since_projection: false,
    ...overrides,
  };
}

function createHarness(
  initialTargets: ProjectionTargetRecord[],
  initialMarkdown: Record<string, string>,
  canonicalRenders: Record<string, string> = {},
) {
  const targets = initialTargets.map((target) => ({ ...target }));
  const markdownFiles = { ...initialMarkdown };
  const events: Record<string, unknown>[] = [];
  const service = createSystemOfRecordReconcilerService({
    now: () => now,
    listProjectionTargets: async () => targets,
    updateProjectionTarget: async (updated) => {
      const index = targets.findIndex((target) => target.id === updated.id);
      if (index >= 0) targets[index] = { ...targets[index], ...updated };
    },
    readMarkdown: async (locator) => markdownFiles[locator] ?? null,
    writeMarkdown: async (locator, content) => {
      markdownFiles[locator] = content;
    },
    renderCanonicalProjection: async (target) => canonicalRenders[target.id] ?? target.rendered_markdown,
    recordMutationEvent: async (event) => {
      events.push(event);
    },
  });

  return { service, targets, markdown: markdownFiles, events };
}
