import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError, operations } from '../src/core/operations.ts';
import { createBrainLoopAuditOperations } from '../src/core/operations-brain-loop-audit.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('brain-loop audit operations can be built from a dedicated domain module', () => {
  const built = createBrainLoopAuditOperations({ OperationError });

  expect(built.map((operation) => operation.name)).toEqual([
    'audit_brain_loop',
    'get_memory_strength_report',
  ]);
});

test('audit_brain_loop operation is registered with CLI hints', () => {
  const audit = operations.find((operation) => operation.name === 'audit_brain_loop');

  expect(audit?.cliHints?.name).toBe('audit-brain-loop');
  expect(audit?.params.scope?.enum).toEqual(['work', 'personal', 'mixed', 'unknown']);
});

test('audit_brain_loop supports dry-run parameter parsing', async () => {
  const audit = operations.find((operation) => operation.name === 'audit_brain_loop');

  if (!audit) {
    throw new Error('audit_brain_loop operation is missing');
  }

  const result = await audit.handler({
    engine: {} as any,
    config: {} as any,
    logger: console,
    dryRun: true,
  }, {
    since: '24h',
    until: new Date(Date.now() + 1000).toISOString(),
    scope: 'work',
    limit: 100,
    json: true,
  });

  expect((result as any).dry_run).toBe(true);
  expect((result as any).action).toBe('audit_brain_loop');
  expect((result as any).scope).toBe('work');
  expect((result as any).limit).toBe(100);
});

test('audit_brain_loop rejects invalid scope and limit params', async () => {
  const audit = operations.find((operation) => operation.name === 'audit_brain_loop');

  if (!audit) {
    throw new Error('audit_brain_loop operation is missing');
  }

  await expect(audit.handler({
    engine: {} as any,
    config: {} as any,
    logger: console,
    dryRun: true,
  }, {
    scope: 'public',
  })).rejects.toThrow('scope must be one of');

  await expect(audit.handler({
    engine: {} as any,
    config: {} as any,
    logger: console,
    dryRun: true,
  }, {
    limit: -1,
  })).rejects.toThrow('limit must be a positive number');
});

test('audit_brain_loop rejects inverted window params as invalid_params', async () => {
  const audit = operations.find((operation) => operation.name === 'audit_brain_loop');

  if (!audit) {
    throw new Error('audit_brain_loop operation is missing');
  }

  await expect(audit.handler({
    engine: {} as any,
    config: {} as any,
    logger: console,
    dryRun: true,
  }, {
    since: '2026-04-24T11:00:00.000Z',
    until: '2026-04-24T10:00:00.000Z',
  })).rejects.toThrow('since must be before until');
});

test('audit_brain_loop operation returns an audit report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-brain-loop-audit-op-'));
  const engine = new SQLiteEngine();
  const audit = operations.find((operation) => operation.name === 'audit_brain_loop');

  if (!audit) {
    throw new Error('audit_brain_loop operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    await engine.putRetrievalTrace({
      id: 'trace-op-audit',
      task_id: null,
      scope: 'unknown',
      route: [],
      source_refs: [],
      verification: ['intent:precision_lookup'],
      selected_intent: 'precision_lookup',
      outcome: 'precision_lookup route unavailable',
    });

    const result = await audit.handler({
      engine: engine as unknown as BrainEngine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      since: '24h',
      until: new Date(Date.now() + 1000).toISOString(),
    });

    expect((result as any).total_traces).toBe(1);
    expect((result as any).by_selected_intent.precision_lookup).toBe(1);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get_memory_strength_report is registered read-only with CLI hints', () => {
  const strength = operations.find((operation) => operation.name === 'get_memory_strength_report');

  expect(strength?.mutating).toBe(false);
  expect(strength?.cliHints?.name).toBe('memory-strength-report');
});

test('get_memory_strength_report supports dry-run parameter parsing', async () => {
  const strength = operations.find((operation) => operation.name === 'get_memory_strength_report');

  if (!strength) {
    throw new Error('get_memory_strength_report operation is missing');
  }

  const result = await strength.handler({
    engine: {} as any,
    config: {} as any,
    logger: console,
    dryRun: true,
  }, {
    window_days: 14,
    limit: 5,
    now: '2026-07-06T00:00:00.000Z',
  });

  expect((result as any).dry_run).toBe(true);
  expect((result as any).action).toBe('get_memory_strength_report');
  expect((result as any).window_days).toBe(14);
  expect((result as any).limit).toBe(5);
});

test('get_memory_strength_report rejects invalid params', async () => {
  const strength = operations.find((operation) => operation.name === 'get_memory_strength_report');

  if (!strength) {
    throw new Error('get_memory_strength_report operation is missing');
  }

  const context = {
    engine: {} as any,
    config: {} as any,
    logger: console,
    dryRun: true,
  };

  await expect(strength.handler(context, { window_days: -1 })).rejects.toThrow('window_days must be a positive number');
  await expect(strength.handler(context, { limit: 0 })).rejects.toThrow('limit must be a positive number');
  await expect(strength.handler(context, { now: 'not-a-date' })).rejects.toThrow('now must be a valid ISO timestamp');
});

test('get_memory_strength_report returns a strength report from a real engine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-strength-op-'));
  const engine = new SQLiteEngine();
  const strength = operations.find((operation) => operation.name === 'get_memory_strength_report');

  if (!strength) {
    throw new Error('get_memory_strength_report operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    await engine.putPage('systems/alpha', {
      type: 'system',
      title: 'Alpha System',
      compiled_truth: 'Alpha compiled truth.',
    });
    await engine.putPage('ideas/delta', {
      type: 'concept',
      title: 'Delta Idea',
      compiled_truth: 'Delta compiled truth.',
    });
    await engine.putRetrievalTrace({
      id: 'trace-strength-op',
      task_id: null,
      scope: 'work',
      route: ['read_context'],
      source_refs: ['page:workspace:default:systems/alpha'],
      verification: ['answer_ready:ready'],
      outcome: 'read_context returned canonical evidence',
    });

    const result = await strength.handler({
      engine: engine as unknown as BrainEngine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      now: new Date(Date.now() + 60_000).toISOString(),
    }) as any;

    expect(result.formula).toContain('confirmed_reads');
    expect(result.totals.pages_with_activity).toBe(1);
    expect(result.top_strength[0]?.slug).toBe('systems/alpha');
    expect(result.never_used.map((entry: any) => entry.slug)).toEqual(['ideas/delta']);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
