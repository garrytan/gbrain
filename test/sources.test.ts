/**
 * v0.18.0 Step 6 — sources CLI subcommand tests.
 *
 * Pure unit tests that exercise the subcommand dispatcher via a
 * stub BrainEngine. No DB required — we just confirm the SQL
 * shape, validation, and flag parsing.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { runSources } from '../src/commands/sources.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { countSourcePages, deleteSourceRecord, readSourceDeleteImpact } from '../src/core/engine-sql/sources.ts';
import { renderFragment, type SqlFragment } from '../src/core/engine-sql/fragment.ts';
import { withTypedSourceReads } from './helpers/typed-source-reads.ts';

// ── Stub engine that records queries ───────────────────────

interface RecordedCall {
  sql: string;
  params: unknown[];
}

function makeStub(rowsByPattern: Record<string, unknown[]> = {}, opts: { appearsOnInsert?: boolean } = {}): {
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
    if (sql.includes('FROM persistence_brain')) return [{ enabled: false }] as never; // #6482: the strict mode reader needs one well-formed unmanaged row.
    return [] as never;
  };

  // The executor the typed members run on: a fragment renders to the text and params executeRaw records.
  const recording = { executeRaw, run: async (fragment: SqlFragment) => {
    const { text, params } = renderFragment(fragment);
    const rows = (await executeRaw(text, params)) as unknown[];
    return { rows, affectedRows: rows.length };
  } };

  const setConfig = async (key: string, value: string) => {
    configSet.push({ key, value });
  };

  // Minimal BrainEngine stub — only the methods sources.ts touches.
  // The typed source reads answer from the same fake rows. With `appearsOnInsert` (the `add` tests) getSource sees a
  // row only once the INSERT ran (the pre-flight collision check finds nothing, the re-read after the insert finds
  // it), as on a real brain; otherwise the seeded rows already exist.
  const DETAIL = 'SELECT id, name, local_path, last_commit, last_sync_at, config, created_at';
  const inserted = () => new Set(calls.filter(c => c.sql.includes('INSERT INTO sources')).map(c => c.params[0]));
  const detailRows = () => (rowsByPattern[DETAIL] ?? []) as Array<{ id: string }>;
  const getSource = async (id: string) => {
    if (opts.appearsOnInsert === true && !inserted().has(id)) return null;
    return detailRows().find(r => r.id === id) ?? null;
  };
  // listSourceRecords answers in the member's order (default first, then by id); the rows carry no archived flag.
  const listSourceRecords = async () => {
    const rows = [...detailRows()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return [...rows.filter(r => r.id === 'default'), ...rows.filter(r => r.id !== 'default')].map(r => ({ archived: false, ...r }));
  };
  const listLocalPathSources = async () =>
    ((rowsByPattern['SELECT id, local_path FROM sources WHERE local_path'] ?? []) as Array<{ id: string; local_path: string }>)
      .map(r => ({ id: r.id, local_path: r.local_path, archived: false }));
  // countSourcePages runs the real engine-sql member over the recording executeRaw, so the tests see its SQL.
  // insertSource records its typed row as one INSERT call (config as JSON text), the shape the add tests read.
  const insertSource = async (row: { id: string; name: string; local_path: string | null; config: Record<string, unknown> }) => {
    calls.push({ sql: 'INSERT INTO sources (id, name, local_path, config)', params: [row.id, row.name, row.local_path, JSON.stringify(row.config)] });
  };
  const engine = withTypedSourceReads({
    kind: 'pglite' as const,
    executeRaw,
    countSourcePages: (sourceId: string, o?: { includeDeleted?: boolean }) => countSourcePages({ executeRaw } as never, sourceId, o),
    // The delete preview and the delete run the real engine-sql members over the recording executeRaw too.
    readSourceDeleteImpact: (sourceId: string) => readSourceDeleteImpact(recording as never, sourceId),
    deleteSourceRecord: (sourceId: string, o?: { expiredArchiveOnly?: boolean }) => deleteSourceRecord(recording as never, sourceId, o),
    listOauthClients: async () => [],
    insertSource,
    getSource,
    listSourceRecords,
    listLocalPathSources,
    // `sources federate` holds the row and replaces the whole config through typed members; the stub records the
    // replacement as one UPDATE call (config as JSON text), the shape the federate tests read.
    lockSourceRow: async (id: string) => detailRows().find(r => r.id === id) ?? null,
    replaceSourceConfig: async (id: string, config: Record<string, unknown>) => {
      calls.push({ sql: 'UPDATE sources SET config', params: [JSON.stringify(config), id] });
      return true;
    },
    renameSource: async (id: string, name: string) => {
      calls.push({ sql: 'UPDATE sources SET name', params: [name, id] });
      return true;
    },
    // The federation warning's exposed-pages read: this brain has no remote-written page.
    readFederationExposedPages: async () => [],
    listAccessTokens: async () => [],
    // The strict mode reader is a typed method; it answers from the same fake rows as executeRaw.
    readManagedModeRows: () => executeRaw('SELECT enabled FROM persistence_brain WHERE singleton=1'),
    setConfig,
    // brainServes reads the enabled access members; this brain has none (it serves one person).
    listActiveAccessMembers: async () => [],
    // The audience check reads client usage through a typed method; no clients means a personal brain.
    readClientOpUsage: async () => [],
    // The scope-source check reads source configs through a typed method; no source here is a scope source.
    readScopeSourceConfigs: async () => [],
    // `sources unfederate` names the member keys still reading the source through a typed method; this brain has none.
    listKeysReadingSource: async () => [],
    transaction: async (fn: (tx: BrainEngine) => Promise<unknown>) => fn(engine),
    // Unused methods throw if called accidentally during these tests.
    getConfig: async () => null,
  } as unknown as BrainEngine);

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

  test('inserts a valid source with defaults (a single-user brain federates it, GST-2732)', async () => {
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
    }, { appearsOnInsert: true });
    await runSources(engine, ['add', 'gstack', '--path', '/tmp/gstack']);
    const insert = calls.find(c => c.sql.includes('INSERT INTO sources'));
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe('gstack');
    expect(insert!.params[1]).toBe('gstack'); // name defaults to id
    expect(insert!.params[2]).toBe('/tmp/gstack');
    // A shared brain keeps the old unset default: test/sources-add-default-search.test.ts.
    expect(insert!.params[3]).toBe('{"federated":true}');
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
    }, { appearsOnInsert: true });
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
    }, { appearsOnInsert: true });
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

// ── add — #2707 git-repo validation (CLI wiring) ───────────────
//
// Uses a REAL on-disk temp dir (unlike the fake-path tests above) so the
// core addSource git check actually runs; the stub engine still fakes the
// DB round-trip. Confirms --force parses through to opsAddSource.

describe('sources add — #2707 --force flag wiring', () => {
  let plainDir: string;

  beforeEach(() => {
    plainDir = mkdtempSync(join(tmpdir(), 'gbrain-sources-cli-2707-'));
    // GST-2732: a folder outside any repository registers as plain; the refusal is for a repository with nothing committed.
    execFileSync('git', ['-C', plainDir, 'init', '-q']);
  });
  afterEach(() => {
    rmSync(plainDir, { recursive: true, force: true });
  });

  test('rejects a git repository with nothing committed by default', async () => {
    const { engine } = makeStub();
    await expect(runSources(engine, ['add', 'cli-plain', '--path', plainDir]))
      .rejects.toThrow(/not a git repository/);
  });

  test('--force registers the same directory anyway', async () => {
    const { engine, calls } = makeStub({
      'SELECT id, name, local_path, last_commit, last_sync_at, config, created_at': [{
        id: 'cli-forced',
        name: 'cli-forced',
        local_path: plainDir,
        last_commit: null,
        last_sync_at: null,
        config: '{}',
        created_at: new Date(),
      }],
    }, { appearsOnInsert: true });
    await runSources(engine, ['add', 'cli-forced', '--path', plainDir, '--force']);
    const insert = calls.find(c => c.sql.includes('INSERT INTO sources'));
    expect(insert).toBeDefined();
    expect(insert!.params[2]).toBe(plainDir);
  });
});

// ── list ────────────────────────────────────────────────────

describe('sources list', () => {
  test('orders default source first, then alphabetical', async () => {
    // The order comes from listSourceRecords (pinned by the engine parity suite); list keeps it as given.
    const { engine } = makeStub({
      'SELECT id, name, local_path, last_commit, last_sync_at, config, created_at': [
        { id: 'zeta', name: 'zeta', local_path: null, last_commit: null, last_sync_at: null, config: '{}', created_at: new Date() },
        { id: 'alpha', name: 'alpha', local_path: null, last_commit: null, last_sync_at: null, config: '{}', created_at: new Date() },
        { id: 'default', name: 'default', local_path: null, last_commit: null, last_sync_at: null, config: '{"federated":true}', created_at: new Date() },
      ],
      'COUNT(*)::int AS n FROM pages': [{ n: 0 }],
    });
    const lines: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    try {
      await runSources(engine, ['list', '--json']);
    } finally {
      logSpy.mockRestore();
    }
    expect((JSON.parse(lines.join('\n')).sources as Array<{ id: string }>).map(s => s.id)).toEqual(['default', 'alpha', 'zeta']);
  });

  test('counts only visible pages', async () => {
    const { engine, calls } = makeStub({
      'SELECT id, name, local_path, last_commit, last_sync_at, config, created_at': [
        { id: 'default', name: 'default', local_path: null, last_commit: null, last_sync_at: null, config: '{"federated":true}', created_at: new Date() },
      ],
      'COUNT(*)::int AS n FROM pages': [{ n: 1 }],
    });

    const asked: unknown[] = [];
    const countSourcePages = engine.countSourcePages.bind(engine);
    (engine as { countSourcePages: unknown }).countSourcePages = (id: string, opts?: { includeDeleted?: boolean }) => {
      asked.push({ id, opts });
      return countSourcePages(id, opts);
    };
    const lines: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    try {
      await runSources(engine, ['list']);
    } finally {
      logSpy.mockRestore();
    }

    // The count comes from the typed page count for this one source, live pages only (no includeDeleted).
    expect(asked).toEqual([{ id: 'default', opts: undefined }]);
    expect(calls.find(c => c.sql.includes('COUNT(*)::int AS n FROM pages'))?.sql).toContain('deleted_at IS NULL');
    // The rows come from the typed source listing, so no list statement reaches executeRaw.
    expect(calls.some(c => c.sql.includes('ORDER BY (id = \'default\') DESC'))).toBe(false);
    expect(lines.find(l => l.includes('default'))).toContain('1');
  });

  test('distinguishes explicit false / absent key / explicit true in the human-readable label', async () => {
    const { engine } = makeStub({
      'SELECT id, name, local_path, last_commit, last_sync_at, config, created_at': [
        { id: 'wiki', name: 'wiki', local_path: '/tmp/wiki', last_commit: null, last_sync_at: null, config: '{"federated":true}', created_at: new Date() },
        { id: 'yc-media', name: 'yc-media', local_path: '/tmp/yc', last_commit: null, last_sync_at: null, config: '{"federated":false}', created_at: new Date() },
        { id: 'gstack', name: 'gstack', local_path: '/tmp/gstack', last_commit: null, last_sync_at: null, config: '{}', created_at: new Date() },
      ],
      'COUNT(*)::int AS n FROM pages': [{ n: 0 }],
    });
    const lines: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    try {
      await runSources(engine, ['list']);
    } finally {
      logSpy.mockRestore();
    }
    const wikiLine = lines.find(l => l.includes('wiki'))!;
    const ycLine = lines.find(l => l.includes('yc-media'))!;
    const gstackLine = lines.find(l => l.includes('gstack'))!;
    // Explicit `federated: true` — unchanged.
    expect(wikiLine).toContain('federated');
    // Explicit `federated: false` (`sources unfederate`) — fully isolated.
    expect(ycLine).toContain('isolated');
    // Absent key (bare `sources add`, config={}) is NOT the same as explicit
    // false: it doesn't appear in others' federated reads, but its own
    // unqualified reads still widen outward (#1434/#2561/#2928). The label
    // must say something other than "isolated", which overstates it.
    expect(gstackLine).not.toContain('isolated');
    expect(gstackLine).toContain('unset');
  });
});

// ── remove ──────────────────────────────────────────────────

describe('sources remove', () => {
  test("refuses to remove the 'default' source", async () => {
    const { engine } = makeStub();
    const code = await withExitCapture(() => runSources(engine, ['remove', 'default', '--yes']));
    expect(code).toBe(2); // agent contract v1 A3: invalid input exits 2 (3 is confirmation_required)
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
