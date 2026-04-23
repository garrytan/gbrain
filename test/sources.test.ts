/**
 * v0.18.0 Step 6 — sources CLI subcommand tests.
 *
 * Pure unit tests that exercise the subcommand dispatcher via a
 * stub BrainEngine. No DB required — we just confirm the SQL
 * shape, validation, and flag parsing.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { runSources } from '../src/commands/sources.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// ── Stub engine that records queries ───────────────────────

interface RecordedCall {
  sql: string;
  params: unknown[];
}

function makeStub(rowsByPattern: Record<string, unknown[]> = {}): {
  engine: BrainEngine;
  calls: RecordedCall[];
  configSet: Array<{ key: string; value: string }>;
} {
  const calls: RecordedCall[] = [];
  const configSet: Array<{ key: string; value: string }> = [];

  const executeRaw = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    // Match by substring so tests are robust against whitespace.
    for (const [pattern, rows] of Object.entries(rowsByPattern)) {
      if (sql.includes(pattern)) return rows as never;
    }
    return [] as never;
  };

  const setConfig = async (key: string, value: string) => {
    configSet.push({ key, value });
  };

  // Minimal BrainEngine stub — only the methods sources.ts touches.
  const engine = {
    kind: 'pglite' as const,
    executeRaw,
    setConfig,
    // Unused methods throw if called accidentally during these tests.
    getConfig: async () => null,
  } as unknown as BrainEngine;

  return { engine, calls, configSet };
}

// ── add ─────────────────────────────────────────────────────

// Intercept process.exit so unit tests under bun:test don't actually
// exit. Each test that might trigger process.exit() wraps its call in
// `withExitCapture`. We only return when the function under test returns
// or throws; process.exit() is turned into a recoverable throw.
async function withExitCapture(fn: () => Promise<void>): Promise<number | null> {
  const origExit = process.exit;
  let captured: number | null = null;
  process.exit = ((code?: number) => {
    captured = code ?? 0;
    throw new Error('__process_exit__');
  }) as never;
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes('__process_exit__')) throw e;
  } finally {
    process.exit = origExit;
  }
  return captured;
}

describe('sources add', () => {
  test('rejects invalid ids', async () => {
    const { engine } = makeStub();
    const code = await withExitCapture(() => runSources(engine, ['add']));
    expect(code).toBe(2);
  });

  test('rejects uppercase / invalid chars in id', async () => {
    const { engine } = makeStub();
    await expect(runSources(engine, ['add', 'BadId', '--path', '/tmp/x'])).rejects.toThrow(/Invalid source id/);
  });

  test('rejects id longer than 32 chars', async () => {
    const { engine } = makeStub();
    const long = 'a'.repeat(33);
    await expect(runSources(engine, ['add', long, '--path', '/tmp/x'])).rejects.toThrow(/Invalid source id/);
  });

  test('inserts a valid source with defaults (federated unset → isolated)', async () => {
    const { engine, calls } = makeStub({
      'SELECT id, name, local_path, last_commit, last_sync_at, config, created_at': [{
        id: 'gstack',
        name: 'gstack',
        local_path: '/tmp/gstack',
        last_commit: null,
        last_sync_at: null,
        config: '{}',
        created_at: new Date(),
      }],
    });
    await runSources(engine, ['add', 'gstack', '--path', '/tmp/gstack']);
    const insert = calls.find(c => c.sql.includes('INSERT INTO sources'));
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe('gstack');
    expect(insert!.params[1]).toBe('gstack'); // name defaults to id
    expect(insert!.params[2]).toBe('/tmp/gstack');
    expect(insert!.params[3]).toBe('{}'); // federated unset → empty config
  });

  test('--federated sets config.federated = true', async () => {
    const { engine, calls } = makeStub({
      'SELECT id, name, local_path, last_commit, last_sync_at, config, created_at': [{
        id: 'wiki',
        name: 'wiki',
        local_path: '/tmp/wiki',
        last_commit: null,
        last_sync_at: null,
        config: '{"federated":true}',
        created_at: new Date(),
      }],
    });
    await runSources(engine, ['add', 'wiki', '--path', '/tmp/wiki', '--federated']);
    const insert = calls.find(c => c.sql.includes('INSERT INTO sources'));
    expect(insert!.params[3]).toBe('{"federated":true}');
  });

  test('--no-federated sets config.federated = false (isolation opt-in)', async () => {
    const { engine, calls } = makeStub({
      'SELECT id, name, local_path, last_commit, last_sync_at, config, created_at': [{
        id: 'yc-media',
        name: 'yc-media',
        local_path: '/tmp/yc',
        last_commit: null,
        last_sync_at: null,
        config: '{"federated":false}',
        created_at: new Date(),
      }],
    });
    await runSources(engine, ['add', 'yc-media', '--path', '/tmp/yc', '--no-federated']);
    const insert = calls.find(c => c.sql.includes('INSERT INTO sources'));
    expect(insert!.params[3]).toBe('{"federated":false}');
  });

  test('rejects overlapping paths (per eng review finding 4.1)', async () => {
    const { engine } = makeStub({
      'SELECT id, local_path FROM sources WHERE local_path': [
        { id: 'gstack', local_path: '/tmp/gstack' },
      ],
    });
    // New source at /tmp/gstack/plans is inside existing gstack at /tmp/gstack.
    await expect(runSources(engine, ['add', 'plans', '--path', '/tmp/gstack/plans']))
      .rejects.toThrow(/overlaps with existing source "gstack"/);
  });
});

// ── list ────────────────────────────────────────────────────

describe('sources list', () => {
  test('orders default source first, then alphabetical', async () => {
    const { engine, calls } = makeStub({
      'SELECT id, name, local_path, last_commit, last_sync_at, config, created_at': [
        { id: 'default', name: 'default', local_path: null, last_commit: null, last_sync_at: null, config: '{"federated":true}', created_at: new Date() },
      ],
      'COUNT(*)::int AS n FROM pages': [{ n: 0 }],
    });
    await runSources(engine, ['list']);
    const select = calls.find(c => c.sql.includes('ORDER BY (id = \'default\') DESC'));
    expect(select).toBeDefined();
  });
});

// ── remove ──────────────────────────────────────────────────

describe('sources remove', () => {
  test("refuses to remove the 'default' source", async () => {
    const { engine } = makeStub();
    const code = await withExitCapture(() => runSources(engine, ['remove', 'default', '--yes']));
    expect(code).toBe(3);
  });

  test('refuses without --yes', async () => {
    const { engine } = makeStub({
      'SELECT id, name, local_path, last_commit, last_sync_at, config, created_at': [
        { id: 'gstack', name: 'gstack', local_path: '/tmp/g', last_commit: null, last_sync_at: null, config: '{}', created_at: new Date() },
      ],
      'COUNT(*)::int AS n FROM pages': [{ n: 10 }],
    });
    const code = await withExitCapture(() => runSources(engine, ['remove', 'gstack']));
    expect(code).toBe(5);
  });

  test('--dry-run reports but does not DELETE', async () => {
    const { engine, calls } = makeStub({
      'SELECT id, name, local_path, last_commit, last_sync_at, config, created_at': [
        { id: 'gstack', name: 'gstack', local_path: '/tmp/g', last_commit: null, last_sync_at: null, config: '{}', created_at: new Date() },
      ],
      'COUNT(*)::int AS n FROM pages': [{ n: 10 }],
    });
    await runSources(engine, ['remove', 'gstack', '--dry-run']);
    const del = calls.find(c => c.sql.startsWith('DELETE FROM sources'));
    expect(del).toBeUndefined();
  });
});

// ── default ─────────────────────────────────────────────────

describe('sources default', () => {
  test("stores id in config key 'sources.default'", async () => {
    const { engine, configSet } = makeStub({
      'SELECT id, name, local_path, last_commit, last_sync_at, config, created_at': [
        { id: 'gstack', name: 'gstack', local_path: null, last_commit: null, last_sync_at: null, config: '{}', created_at: new Date() },
      ],
    });
    await runSources(engine, ['default', 'gstack']);
    expect(configSet).toEqual([{ key: 'sources.default', value: 'gstack' }]);
  });
});

// ── federate / unfederate ──────────────────────────────────

describe('sources federate / unfederate', () => {
  test('federate sets config.federated = true', async () => {
    const { engine, calls } = makeStub({
      'SELECT id, name, local_path, last_commit, last_sync_at, config, created_at': [
        { id: 'gstack', name: 'gstack', local_path: null, last_commit: null, last_sync_at: null, config: '{}', created_at: new Date() },
      ],
    });
    await runSources(engine, ['federate', 'gstack']);
    const upd = calls.find(c => c.sql.includes('UPDATE sources SET config'));
    expect(upd).toBeDefined();
    expect(JSON.parse(upd!.params[0] as string)).toEqual({ federated: true });
  });

  test('unfederate preserves other config keys', async () => {
    const { engine, calls } = makeStub({
      'SELECT id, name, local_path, last_commit, last_sync_at, config, created_at': [
        { id: 'gstack', name: 'gstack', local_path: null, last_commit: null, last_sync_at: null, config: '{"ttl_days":90,"federated":true}', created_at: new Date() },
      ],
    });
    await runSources(engine, ['unfederate', 'gstack']);
    const upd = calls.find(c => c.sql.includes('UPDATE sources SET config'));
    const parsed = JSON.parse(upd!.params[0] as string);
    // Must preserve ttl_days while flipping federated.
    expect(parsed.ttl_days).toBe(90);
    expect(parsed.federated).toBe(false);
  });
});
