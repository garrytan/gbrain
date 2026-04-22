import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { evaluateScopeGate } from '../src/core/services/scope-gate-service.ts';

test('scope gate allows explicit work scope for broad synthesis', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-scope-gate-work-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await evaluateScopeGate(engine, {
      intent: 'broad_synthesis',
      requested_scope: 'work',
      query: 'summarize the architecture docs',
    });

    expect(result.resolved_scope).toBe('work');
    expect(result.policy).toBe('allow');
    expect(result.decision_reason).toBe('explicit_scope');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope gate resumes personal tasks using the task scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-scope-gate-task-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

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

    const result = await evaluateScopeGate(engine, {
      intent: 'task_resume',
      task_id: 'task-1',
    });

    expect(result.resolved_scope).toBe('personal');
    expect(result.policy).toBe('allow');
    expect(result.decision_reason).toBe('task_scope');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope gate denies personal scope for the current work-only precision route stack', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-scope-gate-personal-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await evaluateScopeGate(engine, {
      intent: 'precision_lookup',
      query: 'remember my daily routine',
    });

    expect(result.resolved_scope).toBe('personal');
    expect(result.policy).toBe('deny');
    expect(result.decision_reason).toBe('unsupported_scope_intent');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope gate defers when signals are insufficient to safely choose a scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-scope-gate-unknown-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await evaluateScopeGate(engine, {
      intent: 'broad_synthesis',
      query: 'help me remember this',
    });

    expect(result.resolved_scope).toBe('unknown');
    expect(result.policy).toBe('defer');
    expect(result.decision_reason).toBe('insufficient_signal');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope gate allows explicit mixed scope for mixed-scope bridge intent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-scope-gate-mixed-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await evaluateScopeGate(engine, {
      intent: 'mixed_scope_bridge',
      requested_scope: 'mixed',
      query: 'connect my routines to project planning',
      subject: 'daily routine',
    } as any);

    expect(result.resolved_scope).toBe('mixed');
    expect(result.policy).toBe('allow');
    expect(result.decision_reason).toBe('explicit_scope');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope gate denies non-mixed scope for mixed-scope bridge intent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-scope-gate-mixed-deny-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await evaluateScopeGate(engine, {
      intent: 'mixed_scope_bridge',
      requested_scope: 'work',
      query: 'connect my routines to project planning',
      subject: 'daily routine',
    } as any);

    expect(result.resolved_scope).toBe('work');
    expect(result.policy).toBe('deny');
    expect(result.decision_reason).toBe('unsupported_scope_intent');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope gate defers mixed-scope bridge when scope is unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-scope-gate-mixed-defer-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await evaluateScopeGate(engine, {
      intent: 'mixed_scope_bridge',
      query: 'connect this to that',
      subject: 'reference entry',
    } as any);

    expect(result.resolved_scope).toBe('unknown');
    expect(result.policy).toBe('defer');
    expect(result.decision_reason).toBe('insufficient_signal');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope gate allows personal profile lookup when personal scope is explicit or obvious', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-scope-gate-personal-lookup-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const explicit = await evaluateScopeGate(engine, {
      intent: 'personal_profile_lookup',
      requested_scope: 'personal',
      subject: 'daily routine',
      query: 'remember my daily routine',
    } as any);

    expect(explicit.resolved_scope).toBe('personal');
    expect(explicit.policy).toBe('allow');
    expect(explicit.decision_reason).toBe('explicit_scope');

    const inferred = await evaluateScopeGate(engine, {
      intent: 'personal_profile_lookup',
      query: 'remember my daily routine',
    } as any);

    expect(inferred.resolved_scope).toBe('personal');
    expect(inferred.policy).toBe('allow');
    expect(inferred.decision_reason).toBe('personal_signal');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope gate allows personal episode lookup when personal scope is explicit or obvious', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-scope-gate-personal-episode-lookup-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const explicit = await evaluateScopeGate(engine, {
      intent: 'personal_episode_lookup',
      requested_scope: 'personal',
      title: 'Morning reset',
      query: 'remember my travel recovery routine',
    } as any);

    expect(explicit.resolved_scope).toBe('personal');
    expect(explicit.policy).toBe('allow');
    expect(explicit.decision_reason).toBe('explicit_scope');

    const inferred = await evaluateScopeGate(engine, {
      intent: 'personal_episode_lookup',
      query: 'remember my travel recovery routine',
    } as any);

    expect(inferred.resolved_scope).toBe('personal');
    expect(inferred.policy).toBe('allow');
    expect(inferred.decision_reason).toBe('personal_signal');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
