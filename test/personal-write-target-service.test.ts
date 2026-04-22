import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { selectPersonalWriteTarget } from '../src/core/services/personal-write-target-service.ts';

test('personal write target service allows profile-memory writes when personal scope is explicit or obvious', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-write-target-profile-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await selectPersonalWriteTarget(engine, {
      target_kind: 'profile_memory',
      subject: 'daily routine',
      query: 'remember my daily routine',
    });

    expect(result.selection_reason).toBe('direct_personal_write_target');
    expect(result.scope_gate.resolved_scope).toBe('personal');
    expect(result.scope_gate.policy).toBe('allow');
    expect(result.route?.route_kind).toBe('personal_write_target');
    expect(result.route?.target_kind).toBe('profile_memory');
    expect(result.route?.scope_id).toBe('personal:default');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('personal write target service allows personal-episode writes when personal scope is explicit or obvious', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-write-target-episode-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await selectPersonalWriteTarget(engine, {
      target_kind: 'personal_episode',
      title: 'Morning reset',
      query: 'remember my travel recovery routine',
    });

    expect(result.selection_reason).toBe('direct_personal_write_target');
    expect(result.scope_gate.resolved_scope).toBe('personal');
    expect(result.scope_gate.policy).toBe('allow');
    expect(result.route?.route_kind).toBe('personal_write_target');
    expect(result.route?.target_kind).toBe('personal_episode');
    expect(result.route?.scope_id).toBe('personal:default');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('personal write target service denies work-scoped requests from writing into personal stores', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-write-target-deny-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await selectPersonalWriteTarget(engine, {
      target_kind: 'profile_memory',
      subject: 'architecture preference',
      query: 'summarize the architecture docs',
      requested_scope: 'work',
    });

    expect(result.selection_reason).toBe('unsupported_scope_intent');
    expect(result.scope_gate.resolved_scope).toBe('work');
    expect(result.scope_gate.policy).toBe('deny');
    expect(result.route).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('personal write target service defers when scope is not safe enough to infer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-write-target-defer-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await selectPersonalWriteTarget(engine, {
      target_kind: 'profile_memory',
      subject: 'reference entry',
      query: 'help me remember this',
    });

    expect(result.selection_reason).toBe('insufficient_signal');
    expect(result.scope_gate.resolved_scope).toBe('unknown');
    expect(result.scope_gate.policy).toBe('defer');
    expect(result.route).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
