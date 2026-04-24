import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';
import { selectRetrievalRoute } from '../src/core/services/retrieval-route-selector-service.ts';

test('retrieval route selector persists a task-scoped trace for successful broad synthesis', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-route-trace-success-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.createTaskThread({
      id: 'task-1',
      scope: 'work',
      title: 'Traceable selector',
      goal: 'Persist retrieval traces',
      status: 'active',
      repo_path: '/repo',
      branch_name: 'phase2-note-manifest',
      current_summary: 'Need durable explainability',
    });

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      '---',
      '# Overview',
      'See [[concepts/note-manifest]].',
    ].join('\n'), { path: 'systems/mbrain.md' });
    await importFromContent(engine, 'concepts/note-manifest', [
      '---',
      'type: concept',
      'title: Note Manifest',
      '---',
      '# Purpose',
      'Indexes [[systems/mbrain]].',
    ].join('\n'), { path: 'concepts/note-manifest.md' });
    await buildStructuralContextMapEntry(engine);

    const result = await selectRetrievalRoute(engine, {
      intent: 'broad_synthesis',
      task_id: 'task-1',
      query: 'mbrain',
      persist_trace: true,
    });

    expect(result.selected_intent).toBe('broad_synthesis');
    expect(result.trace?.task_id).toBe('task-1');
    expect(result.trace?.scope).toBe('work');
    expect(result.trace?.route).toEqual([
      'curated_notes',
      'context_map_report',
      'context_map_query',
      'context_map_explain',
      'canonical_follow_through',
    ]);
    expect(result.trace?.source_refs).toContain('page:systems/mbrain');
    expect(result.trace?.derived_consulted).toEqual([
      (result.route?.payload as { map_id?: string } | undefined)?.map_id,
    ]);
    expect(result.trace?.verification).toContain('intent:broad_synthesis');
    expect(result.trace?.verification).toContain('selection_reason:selected_fresh_match');
    expect(result.trace?.selected_intent).toBe('broad_synthesis');
    expect(result.trace?.write_outcome).toBe('no_durable_write');
    expect(result.trace?.scope_gate_policy).toBeNull();
    expect(result.trace?.scope_gate_reason).toBeNull();
    expect(result.trace?.outcome).toBe('broad_synthesis route selected');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retrieval route selector persists a degraded task-scoped trace for no-match precision lookup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-route-trace-miss-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.createTaskThread({
      id: 'task-1',
      scope: 'work',
      title: 'Traceable selector',
      goal: 'Persist retrieval traces',
      status: 'active',
      repo_path: '/repo',
      branch_name: 'phase2-note-manifest',
      current_summary: 'Need durable explainability',
    });

    const result = await selectRetrievalRoute(engine, {
      intent: 'precision_lookup',
      task_id: 'task-1',
      slug: 'systems/unknown',
      persist_trace: true,
    });

    expect(result.selected_intent).toBe('precision_lookup');
    expect(result.selection_reason).toBe('no_match');
    expect(result.route).toBeNull();
    expect(result.trace?.task_id).toBe('task-1');
    expect(result.trace?.route).toEqual([]);
    expect(result.trace?.source_refs).toEqual([]);
    expect(result.trace?.verification).toContain('intent:precision_lookup');
    expect(result.trace?.verification).toContain('selection_reason:no_match');
    expect(result.trace?.outcome).toBe('precision_lookup route unavailable');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retrieval route selector persists a section-scoped trace for anchored precision lookup paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-route-trace-section-path-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.createTaskThread({
      id: 'task-1',
      scope: 'work',
      title: 'Traceable selector',
      goal: 'Persist retrieval traces',
      status: 'active',
      repo_path: '/repo',
      branch_name: 'phase2-note-manifest',
      current_summary: 'Need durable explainability',
    });

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      '---',
      '# Overview',
      'Coordinates structural extraction.',
      '',
      '## Runtime',
      'Owns exact retrieval routing.',
    ].join('\n'), { path: 'systems/mbrain.md' });

    const result = await selectRetrievalRoute(engine, {
      intent: 'precision_lookup',
      task_id: 'task-1',
      path: 'systems/mbrain.md#overview/runtime',
      persist_trace: true,
    });

    expect(result.selected_intent).toBe('precision_lookup');
    expect(result.selection_reason).toBe('direct_section_path_match');
    expect(result.trace?.task_id).toBe('task-1');
    expect(result.trace?.route).toEqual([
      'direct_canonical_artifact',
      'minimal_supporting_reads',
    ]);
    expect(result.trace?.source_refs).toContain('section:systems/mbrain#overview/runtime');
    expect(result.trace?.source_refs).toContain('page:systems/mbrain');
    expect(result.trace?.verification).toContain('selection_reason:direct_section_path_match');
    expect(result.trace?.outcome).toBe('precision_lookup route selected');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retrieval route selector persists a degraded trace for ambiguous source-ref precision lookup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-route-trace-source-ref-ambiguous-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.createTaskThread({
      id: 'task-1',
      scope: 'work',
      title: 'Traceable selector',
      goal: 'Persist retrieval traces',
      status: 'active',
      repo_path: '/repo',
      branch_name: 'phase2-note-manifest',
      current_summary: 'Need durable explainability',
    });

    const sharedSourceRef = 'User, direct message, 2026-04-22 12:31 PM KST';

    await importFromContent(engine, 'systems/brain-graph', [
      '---',
      'type: system',
      'title: Brain Graph',
      '---',
      '# Overview',
      'Maps knowledge structures.',
      '',
      '## Runtime',
      'Owns graph traversal.',
      `[Source: ${sharedSourceRef}]`,
    ].join('\n'), { path: 'systems/brain-graph.md' });
    await importFromContent(engine, 'systems/brain-cache', [
      '---',
      'type: system',
      'title: Brain Cache',
      '---',
      '# Overview',
      'Caches memory snapshots.',
      '',
      '## Runtime',
      'Owns cache invalidation.',
      `[Source: ${sharedSourceRef}]`,
    ].join('\n'), { path: 'systems/brain-cache.md' });

    const result = await selectRetrievalRoute(engine, {
      intent: 'precision_lookup',
      task_id: 'task-1',
      source_ref: sharedSourceRef,
      persist_trace: true,
    });

    expect(result.selected_intent).toBe('precision_lookup');
    expect(result.selection_reason).toBe('ambiguous_source_ref_match');
    expect(result.route).toBeNull();
    expect(result.trace?.task_id).toBe('task-1');
    expect(result.trace?.route).toEqual([]);
    expect(result.trace?.source_refs).toEqual([]);
    expect(result.trace?.verification).toContain('selection_reason:ambiguous_source_ref_match');
    expect(result.trace?.outcome).toBe('precision_lookup route unavailable');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retrieval route selector persists scope-gate evidence when explicit scope denies a route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-route-trace-scope-gate-deny-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.createTaskThread({
      id: 'task-1',
      scope: 'work',
      title: 'Traceable selector',
      goal: 'Persist retrieval traces',
      status: 'active',
      repo_path: '/repo',
      branch_name: 'phase2-note-manifest',
      current_summary: 'Need durable explainability',
    });

    const result = await selectRetrievalRoute(engine, {
      intent: 'precision_lookup',
      task_id: 'task-1',
      requested_scope: 'personal',
      query: 'remember my daily routine',
      slug: 'systems/mbrain',
      persist_trace: true,
    });

    expect(result.selected_intent).toBe('precision_lookup');
    expect(result.selection_reason).toBe('unsupported_scope_intent');
    expect(result.route).toBeNull();
    expect(result.scope_gate?.resolved_scope).toBe('personal');
    expect(result.scope_gate?.policy).toBe('deny');
    expect(result.trace?.scope).toBe('personal');
    expect(result.trace?.verification).toContain('scope_gate:deny');
    expect(result.trace?.verification).toContain('scope_gate_reason:unsupported_scope_intent');
    expect(result.trace?.scope_gate_policy).toBe('deny');
    expect(result.trace?.scope_gate_reason).toBe('unsupported_scope_intent');
    expect(result.trace?.selected_intent).toBe('precision_lookup');
    expect(result.trace?.write_outcome).toBe('no_durable_write');
    expect(result.trace?.outcome).toBe('precision_lookup route unavailable');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retrieval route selector persists a personal-profile trace when personal lookup is allowed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-route-trace-personal-profile-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.createTaskThread({
      id: 'task-1',
      scope: 'personal',
      title: 'Personal memory trace',
      goal: 'Persist personal retrieval traces',
      status: 'active',
      repo_path: null,
      branch_name: null,
      current_summary: 'Need durable personal explainability',
    });

    await engine.upsertProfileMemoryEntry({
      id: 'profile-1',
      scope_id: 'personal:default',
      profile_type: 'routine',
      subject: 'daily routine',
      content: 'Wake at 7 AM, review priorities, then write.',
      source_refs: ['User, direct message, 2026-04-22 9:05 AM KST'],
      sensitivity: 'personal',
      export_status: 'private_only',
      last_confirmed_at: new Date('2026-04-22T00:05:00.000Z'),
      superseded_by: null,
    });

    const result = await selectRetrievalRoute(engine, {
      intent: 'personal_profile_lookup',
      task_id: 'task-1',
      subject: 'daily routine',
      query: 'remember my daily routine',
      persist_trace: true,
    } as any);

    expect(result.selected_intent).toBe('personal_profile_lookup');
    expect(result.selection_reason).toBe('direct_subject_match');
    expect(result.scope_gate?.resolved_scope).toBe('personal');
    expect(result.trace?.task_id).toBe('task-1');
    expect(result.trace?.route).toEqual([
      'profile_memory_record',
      'minimal_personal_supporting_reads',
    ]);
    expect(result.trace?.source_refs).toContain('profile-memory:profile-1');
    expect(result.trace?.verification).toContain('intent:personal_profile_lookup');
    expect(result.trace?.verification).toContain('scope_gate:allow');
    expect(result.trace?.outcome).toBe('personal_profile_lookup route selected');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retrieval route selector persists a personal-episode trace when episode lookup is allowed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-route-trace-personal-episode-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.createTaskThread({
      id: 'task-2',
      scope: 'personal',
      title: 'Personal episode trace',
      goal: 'Persist personal episode retrieval traces',
      status: 'active',
      repo_path: null,
      branch_name: null,
      current_summary: 'Need durable personal episode explainability',
    });

    await engine.createPersonalEpisodeEntry({
      id: 'episode-1',
      scope_id: 'personal:default',
      title: 'Morning reset',
      start_time: new Date('2026-04-22T06:30:00.000Z'),
      end_time: new Date('2026-04-22T07:00:00.000Z'),
      source_kind: 'chat',
      summary: 'Re-established the daily routine after travel.',
      source_refs: ['User, direct message, 2026-04-22 9:05 AM KST'],
      candidate_ids: ['profile-1'],
    });

    const result = await selectRetrievalRoute(engine, {
      intent: 'personal_episode_lookup',
      task_id: 'task-2',
      episode_title: 'Morning reset',
      query: 'remember my travel recovery routine',
      persist_trace: true,
    } as any);

    expect(result.selected_intent).toBe('personal_episode_lookup');
    expect(result.selection_reason).toBe('direct_title_match');
    expect(result.scope_gate?.resolved_scope).toBe('personal');
    expect(result.trace?.task_id).toBe('task-2');
    expect(result.trace?.route).toEqual([
      'personal_episode_record',
      'minimal_personal_supporting_reads',
    ]);
    expect(result.trace?.source_refs).toContain('personal-episode:episode-1');
    expect(result.trace?.verification).toContain('intent:personal_episode_lookup');
    expect(result.trace?.verification).toContain('scope_gate:allow');
    expect(result.trace?.outcome).toBe('personal_episode_lookup route selected');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
