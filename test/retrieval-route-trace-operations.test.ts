import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';

test('retrieval route operation persists a trace when requested', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-route-trace-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const route = operations.find((operation) => operation.name === 'select_retrieval_route');

  if (!route) {
    throw new Error('select_retrieval_route operation is missing');
  }

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
      '',
      '## Runtime',
      'Owns exact retrieval routing.',
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

    const result = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'broad_synthesis',
      task_id: 'task-1',
      query: 'mbrain',
      persist_trace: true,
    });

    expect((result as any).selected_intent).toBe('broad_synthesis');
    expect((result as any).trace?.task_id).toBe('task-1');
    expect((result as any).trace?.outcome).toBe('broad_synthesis route selected');

    const precision = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'precision_lookup',
      task_id: 'task-1',
      path: 'systems/mbrain.md#overview/runtime',
      persist_trace: true,
    });

    expect((precision as any).selected_intent).toBe('precision_lookup');
    expect((precision as any).selection_reason).toBe('direct_section_path_match');
    expect((precision as any).trace?.source_refs).toContain('section:systems/mbrain#overview/runtime');
    expect((precision as any).trace?.outcome).toBe('precision_lookup route selected');

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
      '[Source: User, direct message, 2026-04-22 12:31 PM KST]',
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
      '[Source: User, direct message, 2026-04-22 12:31 PM KST]',
    ].join('\n'), { path: 'systems/brain-cache.md' });

    const ambiguous = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'precision_lookup',
      task_id: 'task-1',
      source_ref: 'User, direct message, 2026-04-22 12:31 PM KST',
      persist_trace: true,
    });

    expect((ambiguous as any).selection_reason).toBe('ambiguous_source_ref_match');
    expect((ambiguous as any).route).toBeNull();
    expect((ambiguous as any).trace?.route).toEqual([]);
    expect((ambiguous as any).trace?.verification).toContain('selection_reason:ambiguous_source_ref_match');
    expect((ambiguous as any).trace?.outcome).toBe('precision_lookup route unavailable');

    const scopedDeny = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'precision_lookup',
      task_id: 'task-1',
      requested_scope: 'personal',
      query: 'remember my daily routine',
      slug: 'systems/mbrain',
      persist_trace: true,
    });

    expect((scopedDeny as any).selection_reason).toBe('unsupported_scope_intent');
    expect((scopedDeny as any).route).toBeNull();
    expect((scopedDeny as any).scope_gate?.resolved_scope).toBe('personal');
    expect((scopedDeny as any).trace?.verification).toContain('scope_gate:deny');
    expect((scopedDeny as any).trace?.verification).toContain('scope_gate_reason:unsupported_scope_intent');

    await engine.createTaskThread({
      id: 'task-2',
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

    const personal = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'personal_profile_lookup',
      task_id: 'task-2',
      subject: 'daily routine',
      query: 'remember my daily routine',
      persist_trace: true,
    });

    expect((personal as any).selection_reason).toBe('direct_subject_match');
    expect((personal as any).scope_gate?.resolved_scope).toBe('personal');
    expect((personal as any).trace?.verification).toContain('intent:personal_profile_lookup');
    expect((personal as any).trace?.verification).toContain('scope_gate:allow');
    expect((personal as any).trace?.source_refs).toContain('profile-memory:profile-1');

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

    const episode = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'personal_episode_lookup',
      task_id: 'task-2',
      episode_title: 'Morning reset',
      query: 'remember my travel recovery routine',
      persist_trace: true,
    });

    expect((episode as any).selection_reason).toBe('direct_title_match');
    expect((episode as any).scope_gate?.resolved_scope).toBe('personal');
    expect((episode as any).trace?.verification).toContain('intent:personal_episode_lookup');
    expect((episode as any).trace?.verification).toContain('scope_gate:allow');
    expect((episode as any).trace?.source_refs).toContain('personal-episode:episode-1');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retrieval route operation persists a task-less trace when requested', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-route-trace-op-taskless-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const route = operations.find((operation) => operation.name === 'select_retrieval_route');

  if (!route) {
    throw new Error('select_retrieval_route operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await importFromContent(engine, 'systems/mbrain', [
      '---',
      'type: system',
      'title: MBrain',
      '---',
      '# Overview',
      'Coordinates durable retrieval traces.',
      '[Source: User, direct message, 2026-04-26 09:10 AM KST]',
    ].join('\n'), { path: 'systems/mbrain.md' });

    const deferred = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'precision_lookup',
      slug: 'systems/mbrain',
      persist_trace: true,
    });

    expect((deferred as any).selected_intent).toBe('precision_lookup');
    expect((deferred as any).route).toBeNull();
    expect((deferred as any).trace?.task_id).toBeNull();
    expect((deferred as any).trace?.scope).toBe('unknown');
    expect((deferred as any).trace?.scope_gate_policy).toBe('defer');
    expect((deferred as any).trace?.scope_gate_reason).toBe('insufficient_signal');
    expect((deferred as any).trace?.outcome).toBe('precision_lookup route unavailable');

    const selected = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'precision_lookup',
      requested_scope: 'work',
      slug: 'systems/mbrain',
      persist_trace: true,
    });

    expect((selected as any).selected_intent).toBe('precision_lookup');
    expect((selected as any).trace?.task_id).toBeNull();
    expect((selected as any).trace?.source_refs).toContain('page:systems/mbrain');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
