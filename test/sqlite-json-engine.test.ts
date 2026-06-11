/**
 * SQLite JSON-column regression coverage — the SQLite sibling of
 * test/postgres-jsonb-engine.test.ts and test/pglite-jsonb-engine.test.ts.
 *
 * SQLite stores JSON payloads in TEXT columns serialized once via
 * JSON.stringify. The regression class this guards against is double
 * serialization: a doubly-stringified array/object parses as a JSON *string*
 * scalar, so json_type() flips from 'array'/'object' to 'text' while every
 * read path that JSON.parses once silently returns a string instead of the
 * structure. Verification reads through an independent bun:sqlite connection
 * so engine-internal parsing cannot mask a corrupted column.
 */

import { Database } from 'bun:sqlite';
import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

interface SqliteHarness {
  engine: SQLiteEngine;
  databasePath: string;
  cleanup: () => Promise<void>;
}

async function createHarness(prefix: string): Promise<SqliteHarness> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-sqlite-json-${prefix}-`));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();

  return {
    engine,
    databasePath,
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function readJsonKinds(
  databasePath: string,
  query: string,
  params: (string | number)[],
): Record<string, unknown> | undefined {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db.query(query).get(...params) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

test('sqlite stores page frontmatter, raw data, and note manifest JSON columns as structured JSON text', async () => {
  const harness = await createHarness('pages');
  const slug = `systems/sqlite-json-${crypto.randomUUID()}`;
  const scopeId = `workspace:json:${crypto.randomUUID()}`;

  try {
    const page = await harness.engine.putPage(slug, {
      type: 'system',
      title: 'SQLite JSON Regression',
      compiled_truth: 'Tracks whether JSON text columns stay structured.',
      timeline: '',
      frontmatter: {
        status: 'active',
        tags: ['json', 'sqlite'],
      },
    });

    await harness.engine.putRawData(slug, 'json-regression', {
      observed_at: '2026-06-11T12:00:00.000Z',
      issues: ['stringified-json'],
    });

    await harness.engine.upsertNoteManifestEntry({
      scope_id: scopeId,
      page_id: page.id,
      slug,
      path: `${slug}.md`,
      page_type: 'system',
      title: 'SQLite JSON Regression',
      frontmatter: { owner: 'tests' },
      aliases: ['SQLite JSON'],
      tags: ['json', 'manifest'],
      outgoing_wikilinks: ['concepts/json'],
      outgoing_urls: ['https://example.com/json'],
      source_refs: ['User, direct message, 2026-06-11 12:00 PM KST'],
      heading_index: [{ slug: 'overview', text: 'Overview', depth: 1, line_start: 1 }],
      content_hash: 'hash-json-regression',
      extractor_version: 'test-v1',
    });

    const pageKinds = readJsonKinds(
      harness.databasePath,
      'SELECT json_type(frontmatter) AS frontmatter_kind FROM pages WHERE slug = ?',
      [slug],
    );
    expect(pageKinds?.frontmatter_kind).toBe('object');

    const rawKinds = readJsonKinds(
      harness.databasePath,
      `SELECT json_type(rd.data) AS data_kind
       FROM raw_data rd
       JOIN pages p ON p.id = rd.page_id
       WHERE p.slug = ? AND rd.source = 'json-regression'`,
      [slug],
    );
    expect(rawKinds?.data_kind).toBe('object');

    const manifestKinds = readJsonKinds(
      harness.databasePath,
      `SELECT
         json_type(frontmatter) AS frontmatter_kind,
         json_type(aliases) AS aliases_kind,
         json_type(tags) AS tags_kind,
         json_type(outgoing_wikilinks) AS wikilinks_kind,
         json_type(outgoing_urls) AS urls_kind,
         json_type(source_refs) AS source_refs_kind,
         json_type(heading_index) AS heading_index_kind
       FROM note_manifest_entries
       WHERE scope_id = ? AND slug = ?`,
      [scopeId, slug],
    );

    expect(manifestKinds?.frontmatter_kind).toBe('object');
    expect(manifestKinds?.aliases_kind).toBe('array');
    expect(manifestKinds?.tags_kind).toBe('array');
    expect(manifestKinds?.wikilinks_kind).toBe('array');
    expect(manifestKinds?.urls_kind).toBe('array');
    expect(manifestKinds?.source_refs_kind).toBe('array');
    expect(manifestKinds?.heading_index_kind).toBe('array');
  } finally {
    await harness.cleanup();
  }
});

test('sqlite stores task-memory and retrieval-trace JSON columns as structured JSON text', async () => {
  const harness = await createHarness('tasks');
  const taskId = `task-${crypto.randomUUID()}`;

  try {
    await harness.engine.createTaskThread({
      id: taskId,
      scope: 'work',
      title: 'JSON Task Memory',
      goal: 'Verify JSON task storage',
      status: 'active',
      repo_path: '/repo',
      branch_name: 'sqlite-json-correctness',
      current_summary: 'Need structured JSON writes',
    });

    await harness.engine.upsertTaskWorkingSet({
      task_id: taskId,
      active_paths: ['src/core/sqlite-engine.ts'],
      active_symbols: ['SQLiteEngine'],
      blockers: ['json writes are double-stringified'],
      open_questions: ['which columns still double-encode'],
      next_steps: ['keep single JSON.stringify per column'],
      verification_notes: ['write a regression test first'],
    });

    await harness.engine.recordTaskAttempt({
      id: `attempt-${taskId}`,
      task_id: taskId,
      summary: 'Observed JSON typed as text.',
      outcome: 'failed',
      applicability_context: { engine: 'sqlite' },
      evidence: ['json_type(route) = text'],
    });

    await harness.engine.recordTaskDecision({
      id: `decision-${taskId}`,
      task_id: taskId,
      summary: 'Keep JSON writes single-encoded.',
      rationale: 'TEXT JSON columns must stay queryable via json_type().',
      consequences: ['all JSON columns stay structured'],
      validity_context: { scope: 'engine-layer' },
    });

    await harness.engine.putRetrievalTrace({
      id: `trace-${taskId}`,
      task_id: taskId,
      scope: 'work',
      route: ['task_thread', 'working_set'],
      source_refs: [`task-thread:${taskId}`],
      verification: ['intent:task_resume'],
      outcome: 'task_resume route selected',
    });

    const workingSetKinds = readJsonKinds(
      harness.databasePath,
      `SELECT
         json_type(active_paths) AS active_paths_kind,
         json_type(active_symbols) AS active_symbols_kind,
         json_type(blockers) AS blockers_kind,
         json_type(open_questions) AS open_questions_kind,
         json_type(next_steps) AS next_steps_kind,
         json_type(verification_notes) AS verification_notes_kind
       FROM task_working_sets
       WHERE task_id = ?`,
      [taskId],
    );

    expect(workingSetKinds?.active_paths_kind).toBe('array');
    expect(workingSetKinds?.active_symbols_kind).toBe('array');
    expect(workingSetKinds?.blockers_kind).toBe('array');
    expect(workingSetKinds?.open_questions_kind).toBe('array');
    expect(workingSetKinds?.next_steps_kind).toBe('array');
    expect(workingSetKinds?.verification_notes_kind).toBe('array');

    const attemptKinds = readJsonKinds(
      harness.databasePath,
      `SELECT
         json_type(applicability_context) AS applicability_context_kind,
         json_type(evidence) AS evidence_kind
       FROM task_attempts
       WHERE id = ?`,
      [`attempt-${taskId}`],
    );
    expect(attemptKinds?.applicability_context_kind).toBe('object');
    expect(attemptKinds?.evidence_kind).toBe('array');

    const decisionKinds = readJsonKinds(
      harness.databasePath,
      `SELECT
         json_type(consequences) AS consequences_kind,
         json_type(validity_context) AS validity_context_kind
       FROM task_decisions
       WHERE id = ?`,
      [`decision-${taskId}`],
    );
    expect(decisionKinds?.consequences_kind).toBe('array');
    expect(decisionKinds?.validity_context_kind).toBe('object');

    const traceKinds = readJsonKinds(
      harness.databasePath,
      `SELECT
         json_type(route) AS route_kind,
         json_type(source_refs) AS source_refs_kind,
         json_type(verification) AS verification_kind
       FROM retrieval_traces
       WHERE id = ?`,
      [`trace-${taskId}`],
    );
    expect(traceKinds?.route_kind).toBe('array');
    expect(traceKinds?.source_refs_kind).toBe('array');
    expect(traceKinds?.verification_kind).toBe('array');
  } finally {
    await harness.cleanup();
  }
});

test('sqlite stores context map and context atlas JSON columns as structured JSON text', async () => {
  const harness = await createHarness('maps');
  const scopeId = `workspace:${crypto.randomUUID()}`;
  const mapId = `context-map:${crypto.randomUUID()}`;
  const atlasId = `context-atlas:${crypto.randomUUID()}`;

  try {
    await harness.engine.upsertContextMapEntry({
      id: mapId,
      scope_id: scopeId,
      kind: 'workspace',
      title: 'JSON Context Map',
      build_mode: 'structural',
      status: 'ready',
      source_set_hash: 'json-hash',
      extractor_version: 'json-test-v1',
      node_count: 2,
      edge_count: 1,
      community_count: 0,
      graph_json: {
        nodes: [{ node_id: 'page:systems/mbrain', node_kind: 'page' }],
        edges: [],
      },
    });

    await harness.engine.upsertContextAtlasEntry({
      id: atlasId,
      map_id: mapId,
      scope_id: scopeId,
      kind: 'workspace',
      title: 'JSON Atlas',
      freshness: 'fresh',
      entrypoints: ['page:systems/mbrain'],
      budget_hint: 4,
    });

    const mapKinds = readJsonKinds(
      harness.databasePath,
      'SELECT json_type(graph_json) AS graph_kind FROM context_map_entries WHERE id = ?',
      [mapId],
    );
    expect(mapKinds?.graph_kind).toBe('object');

    const atlasKinds = readJsonKinds(
      harness.databasePath,
      'SELECT json_type(entrypoints) AS entrypoints_kind FROM context_atlas_entries WHERE id = ?',
      [atlasId],
    );
    expect(atlasKinds?.entrypoints_kind).toBe('array');
  } finally {
    await harness.cleanup();
  }
});

test('sqlite stores memory candidate source_refs as a structured JSON array', async () => {
  const harness = await createHarness('candidates');
  const candidateId = `candidate-${crypto.randomUUID()}`;

  try {
    await harness.engine.createMemoryCandidateEntry({
      id: candidateId,
      scope_id: 'workspace:json-candidates',
      candidate_type: 'fact',
      proposed_content: 'SQLite candidate source_refs stay structured.',
      source_refs: ['User, direct message, 2026-06-11 12:00 PM KST'],
      generated_by: 'manual',
      extraction_kind: 'manual',
      confidence_score: 0.9,
      importance_score: 0.7,
      recurrence_score: 0.1,
      sensitivity: 'work',
      status: 'captured',
      target_object_type: 'curated_note',
      target_object_id: 'systems/sqlite-json',
      reviewed_at: null,
      review_reason: null,
    });

    const kinds = readJsonKinds(
      harness.databasePath,
      'SELECT json_type(source_refs) AS source_refs_kind FROM memory_candidate_entries WHERE id = ?',
      [candidateId],
    );
    expect(kinds?.source_refs_kind).toBe('array');
  } finally {
    await harness.cleanup();
  }
});
