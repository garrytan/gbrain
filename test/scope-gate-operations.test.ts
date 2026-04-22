import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('scope gate operation is registered with CLI hints', () => {
  const route = operations.find((operation) => operation.name === 'evaluate_scope_gate');
  expect(route?.cliHints?.name).toBe('scope-gate');
});

test('scope gate operation returns allow, deny, and defer disclosures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-scope-gate-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const route = operations.find((operation) => operation.name === 'evaluate_scope_gate');

  if (!route) {
    throw new Error('evaluate_scope_gate operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.createTaskThread({
      id: 'task-1',
      scope: 'personal',
      title: 'Personal planning',
      goal: 'Track routines',
      status: 'active',
      repo_path: null,
      branch_name: null,
      current_summary: 'Personal continuity only',
    });

    const allow = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'task_resume',
      task_id: 'task-1',
    });

    expect((allow as any).resolved_scope).toBe('personal');
    expect((allow as any).policy).toBe('allow');

    const personalAllow = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'personal_profile_lookup',
      query: 'remember my daily routine',
    });

    expect((personalAllow as any).resolved_scope).toBe('personal');
    expect((personalAllow as any).policy).toBe('allow');

    const personalEpisodeAllow = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'personal_episode_lookup',
      query: 'remember my travel recovery routine',
    });

    expect((personalEpisodeAllow as any).resolved_scope).toBe('personal');
    expect((personalEpisodeAllow as any).policy).toBe('allow');

    const deny = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'precision_lookup',
      query: 'remember my daily routine',
    });

    expect((deny as any).resolved_scope).toBe('personal');
    expect((deny as any).policy).toBe('deny');

    const defer = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      intent: 'broad_synthesis',
      query: 'help me remember this',
    });

    expect((defer as any).resolved_scope).toBe('unknown');
    expect((defer as any).policy).toBe('defer');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
