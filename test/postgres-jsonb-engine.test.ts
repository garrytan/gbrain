import { expect, test } from 'bun:test';
import { runMigrations } from '../src/core/migrate.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl) {
  test('postgres stores page frontmatter, raw data, and note manifest JSON columns as structured JSON', async () => {
    const engine = new PostgresEngine();
    const slug = `systems/postgres-jsonb-${crypto.randomUUID()}`;
    const scopeId = `workspace:jsonb:${crypto.randomUUID()}`;
    let pageId: number | null = null;

    await engine.connect({ engine: 'postgres', database_url: databaseUrl });
    await engine.initSchema();

    try {
      const page = await engine.putPage(slug, {
        type: 'system',
        title: 'Postgres JSONB Regression',
        compiled_truth: 'Tracks whether JSONB columns stay structured.',
        timeline: '',
        frontmatter: {
          status: 'active',
          tags: ['jsonb', 'postgres'],
        },
      });
      pageId = page.id;

      await engine.putRawData(slug, 'jsonb-regression', {
        observed_at: '2026-04-24T12:00:00.000Z',
        issues: ['stringified-jsonb'],
      });

      await engine.upsertNoteManifestEntry({
        scope_id: scopeId,
        page_id: page.id,
        slug,
        path: `${slug}.md`,
        page_type: 'system',
        title: 'Postgres JSONB Regression',
        frontmatter: { owner: 'tests' },
        aliases: ['PG JSONB'],
        tags: ['jsonb', 'manifest'],
        outgoing_wikilinks: ['concepts/jsonb'],
        outgoing_urls: ['https://example.com/jsonb'],
        source_refs: ['User, direct message, 2026-04-24 12:00 PM KST'],
        heading_index: [{ slug: 'overview', text: 'Overview', depth: 1, line_start: 1 }],
        content_hash: 'hash-jsonb-regression',
        extractor_version: 'test-v1',
      });

      const pageKinds = await engine.sql`
        SELECT jsonb_typeof(frontmatter) AS frontmatter_kind
        FROM pages
        WHERE slug = ${slug}
      `;
      expect(pageKinds[0]?.frontmatter_kind).toBe('object');

      const rawKinds = await engine.sql`
        SELECT jsonb_typeof(rd.data) AS data_kind
        FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id
        WHERE p.slug = ${slug}
          AND rd.source = 'jsonb-regression'
      `;
      expect(rawKinds[0]?.data_kind).toBe('object');

      const manifestKinds = await engine.sql`
        SELECT
          jsonb_typeof(frontmatter) AS frontmatter_kind,
          jsonb_typeof(aliases) AS aliases_kind,
          jsonb_typeof(tags) AS tags_kind,
          jsonb_typeof(outgoing_wikilinks) AS wikilinks_kind,
          jsonb_typeof(outgoing_urls) AS urls_kind,
          jsonb_typeof(source_refs) AS source_refs_kind,
          jsonb_typeof(heading_index) AS heading_index_kind
        FROM note_manifest_entries
        WHERE scope_id = ${scopeId}
          AND slug = ${slug}
      `;

      expect(manifestKinds[0]?.frontmatter_kind).toBe('object');
      expect(manifestKinds[0]?.aliases_kind).toBe('array');
      expect(manifestKinds[0]?.tags_kind).toBe('array');
      expect(manifestKinds[0]?.wikilinks_kind).toBe('array');
      expect(manifestKinds[0]?.urls_kind).toBe('array');
      expect(manifestKinds[0]?.source_refs_kind).toBe('array');
      expect(manifestKinds[0]?.heading_index_kind).toBe('array');
    } finally {
      if (pageId != null) {
        await engine.sql`DELETE FROM note_manifest_entries WHERE scope_id = ${scopeId} AND page_id = ${pageId}`;
      }
      await engine.sql`
        DELETE FROM raw_data
        WHERE page_id IN (SELECT id FROM pages WHERE slug = ${slug})
      `;
      await engine.deletePage(slug).catch(() => undefined);
      await engine.disconnect();
    }
  });

  test('postgres stores task-memory and retrieval-trace JSON columns as structured JSON', async () => {
    const engine = new PostgresEngine();
    const taskId = `task-${crypto.randomUUID()}`;

    await engine.connect({ engine: 'postgres', database_url: databaseUrl });
    await engine.initSchema();

    try {
      await engine.createTaskThread({
        id: taskId,
        scope: 'work',
        title: 'JSONB Task Memory',
        goal: 'Verify JSONB task storage',
        status: 'active',
        repo_path: '/repo',
        branch_name: 'postgres-jsonb-correctness',
        current_summary: 'Need structured JSONB writes',
      });

      await engine.upsertTaskWorkingSet({
        task_id: taskId,
        active_paths: ['src/core/postgres-engine.ts'],
        active_symbols: ['PostgresEngine'],
        blockers: ['jsonb writes are stringified'],
        open_questions: ['which columns still use JSON.stringify'],
        next_steps: ['replace stringified bindings'],
        verification_notes: ['write a regression test first'],
      });

      await engine.recordTaskAttempt({
        id: `attempt-${taskId}`,
        task_id: taskId,
        summary: 'Observed JSONB typed as string.',
        outcome: 'failed',
        applicability_context: { engine: 'postgres' },
        evidence: ['jsonb_typeof(route) = string'],
      });

      await engine.recordTaskDecision({
        id: `decision-${taskId}`,
        task_id: taskId,
        summary: 'Use sql.json for all JSONB writes.',
        rationale: 'postgres.js should encode structured JSON directly.',
        consequences: ['all JSONB columns stay queryable'],
        validity_context: { scope: 'engine-layer' },
      });

      await engine.putRetrievalTrace({
        id: `trace-${taskId}`,
        task_id: taskId,
        scope: 'work',
        route: ['task_thread', 'working_set'],
        source_refs: [`task-thread:${taskId}`],
        verification: ['intent:task_resume'],
        outcome: 'task_resume route selected',
      });

      const workingSetKinds = await engine.sql`
        SELECT
          jsonb_typeof(active_paths) AS active_paths_kind,
          jsonb_typeof(active_symbols) AS active_symbols_kind,
          jsonb_typeof(blockers) AS blockers_kind,
          jsonb_typeof(open_questions) AS open_questions_kind,
          jsonb_typeof(next_steps) AS next_steps_kind,
          jsonb_typeof(verification_notes) AS verification_notes_kind
        FROM task_working_sets
        WHERE task_id = ${taskId}
      `;

      expect(workingSetKinds[0]?.active_paths_kind).toBe('array');
      expect(workingSetKinds[0]?.active_symbols_kind).toBe('array');
      expect(workingSetKinds[0]?.blockers_kind).toBe('array');
      expect(workingSetKinds[0]?.open_questions_kind).toBe('array');
      expect(workingSetKinds[0]?.next_steps_kind).toBe('array');
      expect(workingSetKinds[0]?.verification_notes_kind).toBe('array');

      const attemptKinds = await engine.sql`
        SELECT
          jsonb_typeof(applicability_context) AS applicability_context_kind,
          jsonb_typeof(evidence) AS evidence_kind
        FROM task_attempts
        WHERE id = ${`attempt-${taskId}`}
      `;
      expect(attemptKinds[0]?.applicability_context_kind).toBe('object');
      expect(attemptKinds[0]?.evidence_kind).toBe('array');

      const decisionKinds = await engine.sql`
        SELECT
          jsonb_typeof(consequences) AS consequences_kind,
          jsonb_typeof(validity_context) AS validity_context_kind
        FROM task_decisions
        WHERE id = ${`decision-${taskId}`}
      `;
      expect(decisionKinds[0]?.consequences_kind).toBe('array');
      expect(decisionKinds[0]?.validity_context_kind).toBe('object');

      const traceKinds = await engine.sql`
        SELECT
          jsonb_typeof(route) AS route_kind,
          jsonb_typeof(source_refs) AS source_refs_kind,
          jsonb_typeof(verification) AS verification_kind
        FROM retrieval_traces
        WHERE id = ${`trace-${taskId}`}
      `;
      expect(traceKinds[0]?.route_kind).toBe('array');
      expect(traceKinds[0]?.source_refs_kind).toBe('array');
      expect(traceKinds[0]?.verification_kind).toBe('array');
    } finally {
      await engine.sql`DELETE FROM retrieval_traces WHERE task_id = ${taskId}`;
      await engine.sql`DELETE FROM task_decisions WHERE task_id = ${taskId}`;
      await engine.sql`DELETE FROM task_attempts WHERE task_id = ${taskId}`;
      await engine.sql`DELETE FROM task_working_sets WHERE task_id = ${taskId}`;
      await engine.sql`DELETE FROM task_threads WHERE id = ${taskId}`;
      await engine.disconnect();
    }
  });

  test('postgres stores context map and context atlas JSON columns as structured JSON', async () => {
    const engine = new PostgresEngine();
    const scopeId = `workspace:${crypto.randomUUID()}`;
    const mapId = `context-map:${crypto.randomUUID()}`;
    const atlasId = `context-atlas:${crypto.randomUUID()}`;

    await engine.connect({ engine: 'postgres', database_url: databaseUrl });
    await engine.initSchema();

    try {
      await engine.upsertContextMapEntry({
        id: mapId,
        scope_id: scopeId,
        kind: 'workspace',
        title: 'JSONB Context Map',
        build_mode: 'structural',
        status: 'ready',
        source_set_hash: 'jsonb-hash',
        extractor_version: 'jsonb-test-v1',
        node_count: 2,
        edge_count: 1,
        community_count: 0,
        graph_json: {
          nodes: [{ node_id: 'page:systems/mbrain', node_kind: 'page' }],
          edges: [],
        },
      });

      await engine.upsertContextAtlasEntry({
        id: atlasId,
        map_id: mapId,
        scope_id: scopeId,
        kind: 'workspace',
        title: 'JSONB Atlas',
        freshness: 'fresh',
        entrypoints: ['page:systems/mbrain'],
        budget_hint: 4,
      });

      const mapKinds = await engine.sql`
        SELECT jsonb_typeof(graph_json) AS graph_kind
        FROM context_map_entries
        WHERE id = ${mapId}
      `;
      expect(mapKinds[0]?.graph_kind).toBe('object');

      const atlasKinds = await engine.sql`
        SELECT jsonb_typeof(entrypoints) AS entrypoints_kind
        FROM context_atlas_entries
        WHERE id = ${atlasId}
      `;
      expect(atlasKinds[0]?.entrypoints_kind).toBe('array');
    } finally {
      await engine.deleteContextAtlasEntry(atlasId).catch(() => undefined);
      await engine.deleteContextMapEntry(mapId).catch(() => undefined);
      await engine.disconnect();
    }
  });

  test('postgres migrations repair legacy JSONB scalar strings before JSONB operators run', async () => {
    const engine = new PostgresEngine();
    const candidateId = `candidate-${crypto.randomUUID()}`;

    await engine.connect({ engine: 'postgres', database_url: databaseUrl });
    await engine.initSchema();

    try {
      await engine.sql`
        INSERT INTO memory_candidate_entries (
          id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
          extraction_kind, confidence_score, importance_score, recurrence_score,
          sensitivity, status, target_object_type, target_object_id
        ) VALUES (
          ${candidateId},
          'workspace:legacy-jsonb',
          'fact',
          'Legacy source_refs were stored as a JSONB scalar string.',
          to_jsonb(${JSON.stringify(['legacy:source'])}::text),
          'agent',
          'extracted',
          0.9,
          0.8,
          0.7,
          'work',
          'staged_for_review',
          'curated_note',
          'systems/legacy-jsonb'
        )
      `;

      const before = await engine.sql`
        SELECT jsonb_typeof(source_refs) AS source_refs_kind
        FROM memory_candidate_entries
        WHERE id = ${candidateId}
      `;
      expect(before[0]?.source_refs_kind).toBe('string');

      await engine.setConfig('version', '21');
      await runMigrations(engine);

      const after = await engine.sql`
        SELECT jsonb_typeof(source_refs) AS source_refs_kind
        FROM memory_candidate_entries
        WHERE id = ${candidateId}
      `;
      expect(after[0]?.source_refs_kind).toBe('array');

      const promoted = await engine.promoteMemoryCandidateEntry(candidateId);
      expect(promoted?.status).toBe('promoted');
    } finally {
      await engine.sql`DELETE FROM memory_candidate_entries WHERE id = ${candidateId}`;
      await engine.disconnect();
    }
  });
} else {
  test.skip('postgres JSONB regression coverage skipped: DATABASE_URL is not configured', () => {});
}
