import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';

test('retrieval route selector operation is registered with CLI hints', () => {
  const route = operations.find((operation) => operation.name === 'select_retrieval_route');
  expect(route?.cliHints?.name).toBe('retrieval-route');
});

test('retrieval route selector operation dispatches task and precision intents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-route-selector-op-'));
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
      title: 'Phase 3 selector',
      goal: 'Unify route dispatch',
      status: 'active',
      repo_path: '/repo',
      branch_name: 'phase2-note-manifest',
      current_summary: 'Need one selector surface',
    });

    const taskResult = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'task_resume',
      task_id: 'task-1',
    });

    expect((taskResult as any).selected_intent).toBe('task_resume');
    expect((taskResult as any).route?.route_kind).toBe('task_resume');

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
      '[Source: User, direct message, 2026-04-22 12:30 PM KST]',
    ].join('\n'), { path: 'systems/mbrain.md' });

    const exact = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'precision_lookup',
      slug: 'systems/mbrain',
    });

    expect((exact as any).selected_intent).toBe('precision_lookup');
    expect((exact as any).route?.route_kind).toBe('precision_lookup');

    const byPath = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'precision_lookup',
      path: 'systems/mbrain.md',
    });

    expect((byPath as any).selected_intent).toBe('precision_lookup');
    expect((byPath as any).selection_reason).toBe('direct_path_match');

    const bySectionPath = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'precision_lookup',
      path: 'systems/mbrain.md#overview/runtime',
    });

    expect((bySectionPath as any).selected_intent).toBe('precision_lookup');
    expect((bySectionPath as any).selection_reason).toBe('direct_section_path_match');
    expect((bySectionPath as any).route?.payload?.target_kind).toBe('section');

    const bySourceRef = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'precision_lookup',
      source_ref: 'User, direct message, 2026-04-22 12:30 PM KST',
    });

    expect((bySourceRef as any).selected_intent).toBe('precision_lookup');
    expect((bySourceRef as any).selection_reason).toBe('direct_source_ref_section_match');
    expect((bySourceRef as any).route?.payload?.target_kind).toBe('section');

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
    await buildStructuralContextMapEntry(engine);

    const ambiguous = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'precision_lookup',
      source_ref: 'User, direct message, 2026-04-22 12:31 PM KST',
    });

    expect((ambiguous as any).selected_intent).toBe('precision_lookup');
    expect((ambiguous as any).selection_reason).toBe('ambiguous_source_ref_match');
    expect((ambiguous as any).candidate_count).toBe(2);
    expect((ambiguous as any).route).toBeNull();

    const scopedDeny = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'precision_lookup',
      requested_scope: 'personal',
      query: 'remember my daily routine',
      slug: 'systems/mbrain',
    });

    expect((scopedDeny as any).selected_intent).toBe('precision_lookup');
    expect((scopedDeny as any).selection_reason).toBe('unsupported_scope_intent');
    expect((scopedDeny as any).route).toBeNull();
    expect((scopedDeny as any).scope_gate?.resolved_scope).toBe('personal');
    expect((scopedDeny as any).scope_gate?.policy).toBe('deny');

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
      subject: 'daily routine',
      query: 'remember my daily routine',
    });

    expect((personal as any).selected_intent).toBe('personal_profile_lookup');
    expect((personal as any).selection_reason).toBe('direct_subject_match');
    expect((personal as any).scope_gate?.resolved_scope).toBe('personal');
    expect((personal as any).scope_gate?.policy).toBe('allow');
    expect((personal as any).route?.route_kind).toBe('personal_profile_lookup');

    await engine.createPersonalEpisodeEntry({
      id: 'episode-2',
      scope_id: 'personal:default',
      title: 'Morning reset',
      start_time: new Date('2026-04-22T06:30:00.000Z'),
      end_time: new Date('2026-04-22T07:00:00.000Z'),
      source_kind: 'note',
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
      episode_title: 'Morning reset',
      query: 'remember my travel recovery routine',
    });

    expect((episode as any).selected_intent).toBe('personal_episode_lookup');
    expect((episode as any).selection_reason).toBe('direct_title_match');
    expect((episode as any).scope_gate?.resolved_scope).toBe('personal');
    expect((episode as any).scope_gate?.policy).toBe('allow');
    expect((episode as any).route?.route_kind).toBe('personal_episode_lookup');

    await engine.createTaskThread({
      id: 'task-mixed',
      scope: 'mixed',
      title: 'Connect routines to project planning',
      goal: 'Bridge work and personal context explicitly',
      status: 'active',
      repo_path: '/repo',
      branch_name: 'phase2-note-manifest',
      current_summary: 'Need explicit mixed retrieval only',
    });

    const mixed = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'mixed_scope_bridge',
      task_id: 'task-mixed',
      persist_trace: true,
      requested_scope: 'mixed',
      personal_route_kind: 'profile',
      query: 'mbrain',
      subject: 'daily routine',
    });

    expect((mixed as any).selected_intent).toBe('mixed_scope_bridge');
    expect((mixed as any).selection_reason).toBe('direct_mixed_scope_bridge');
    expect((mixed as any).scope_gate?.resolved_scope).toBe('mixed');
    expect((mixed as any).scope_gate?.policy).toBe('allow');
    expect((mixed as any).route?.route_kind).toBe('mixed_scope_bridge');
    expect((mixed as any).route?.payload?.personal_route_kind).toBe('profile');
    expect((mixed as any).trace?.task_id).toBe('task-mixed');

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

    const mixedEpisode = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'mixed_scope_bridge',
      task_id: 'task-mixed',
      persist_trace: true,
      requested_scope: 'mixed',
      personal_route_kind: 'episode',
      query: 'mbrain',
      episode_title: 'Morning reset',
      episode_source_kind: 'note',
    });

    expect((mixedEpisode as any).selected_intent).toBe('mixed_scope_bridge');
    expect((mixedEpisode as any).selection_reason).toBe('direct_mixed_scope_bridge');
    expect((mixedEpisode as any).route?.payload?.personal_route_kind).toBe('episode');
    expect((mixedEpisode as any).trace?.source_refs).toContain('personal-episode:episode-2');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
