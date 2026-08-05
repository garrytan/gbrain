/**
 * End-to-end PGLite contract for persistent source sync strategy resolution.
 *
 * The policy is resolved inside the per-source sync lock and then drives the
 * real full-sync classifier/importer. These tests prove observable outcomes,
 * not just option plumbing.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatSyncResultJson,
  performSync,
  runSync,
  syncOneSource,
} from '../src/commands/sync.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { runCycle } from '../src/core/cycle.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let repoPath: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-sync-strategy-'));
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
  mkdirSync(join(repoPath, 'notes'));
  mkdirSync(join(repoPath, 'src'));
  writeFileSync(
    join(repoPath, 'notes', 'guide.md'),
    '---\ntype: note\ntitle: Guide\n---\n\nPersistent strategy fixture.\n',
  );
  writeFileSync(
    join(repoPath, 'src', 'widget.ts'),
    "export function widget(): string { return 'ready'; }\n",
  );
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'strategy fixture'], {
    cwd: repoPath,
    stdio: 'pipe',
  });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(repoPath, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function insertSource(strategy: unknown): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ($1, $2, $3, $4::jsonb)`,
    ['fixture', 'Fixture', repoPath, JSON.stringify({ strategy })],
  );
}

async function runNamed(override?: 'markdown' | 'code' | 'auto') {
  return performSync(engine, {
    repoPath,
    sourceId: 'fixture',
    strategy: override,
    full: true,
    noPull: true,
    noEmbed: true,
    noExtract: true,
  });
}

async function importedPaths(sourceId = 'fixture'): Promise<string[]> {
  const rows = await engine.executeRaw<{ source_path: string | null }>(
    `SELECT source_path
       FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL
      ORDER BY source_path`,
    [sourceId],
  );
  return rows.flatMap((row) => (row.source_path ? [row.source_path] : []));
}

async function expectCodeOnly(sourceId = 'fixture'): Promise<void> {
  expect(
    await engine.getPage('src-widget-ts', { sourceId }),
  ).not.toBeNull();
  expect(await importedPaths(sourceId)).toEqual([]);
}

async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const logSpy = spyOn(console, 'log').mockImplementation(
    (...values: unknown[]) => logs.push(values.join(' ')),
  );
  try {
    await fn();
  } finally {
    logSpy.mockRestore();
  }
  return logs;
}

describe('performSync source strategy precedence', () => {
  test('stored auto imports both markdown and code', async () => {
    await insertSource('auto');
    const result = await runNamed();
    expect(result.status).toBe('first_sync');
    expect(result.added).toBe(2);
    expect(result.syncStrategy).toBe('auto');
    expect(result.syncStrategyOrigin).toBe('stored');
    expect(await importedPaths()).toEqual(['notes/guide.md']);
    expect(
      await engine.getPage('src-widget-ts', { sourceId: 'fixture' }),
    ).not.toBeNull();
  }, 60_000);

  test('explicit invocation override wins but does not persist', async () => {
    await insertSource('auto');
    const result = await runNamed('code');
    expect(result.added).toBe(1);
    expect(result.syncStrategy).toBe('code');
    expect(result.syncStrategyOrigin).toBe('override');
    expect(await importedPaths()).toEqual([]);
    expect(
      await engine.getPage('src-widget-ts', { sourceId: 'fixture' }),
    ).not.toBeNull();

    const rows = await engine.executeRaw<{ config: Record<string, unknown> }>(
      `SELECT config FROM sources WHERE id = 'fixture'`,
    );
    expect(rows[0].config).toMatchObject({ strategy: 'auto' });
  }, 60_000);

  test('invalid stored strategy falls back to markdown with explicit provenance', async () => {
    await insertSource('everything');
    const errors: string[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation(
      (...values: unknown[]) => {
        errors.push(values.join(' '));
      },
    );
    try {
      const result = await runNamed();
      expect(result.added).toBe(1);
      expect(result.syncStrategy).toBe('markdown');
      expect(result.syncStrategyOrigin).toBe('invalid_fallback');
      expect(await importedPaths()).toEqual(['notes/guide.md']);
    } finally {
      errorSpy.mockRestore();
    }
    expect(errors.join('\n')).toContain(
      'gbrain sources set-sync-strategy fixture markdown',
    );
  }, 60_000);

  test('missing named source fails before filesystem sync work', async () => {
    await expect(
      performSync(engine, {
        repoPath: join(repoPath, 'does-not-exist'),
        sourceId: 'missing',
        full: true,
        noPull: true,
        noEmbed: true,
        noExtract: true,
      }),
    ).rejects.toThrow(/Source "missing" not found/);
  });

  test('legacy no-source call remains markdown/default', async () => {
    const result = await performSync(engine, {
      repoPath,
      full: true,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(result.added).toBe(1);
    expect(result.syncStrategy).toBe('markdown');
    expect(result.syncStrategyOrigin).toBe('default');
  }, 60_000);

  test('single-source JSON exposes the effective policy and provenance', async () => {
    await insertSource('auto');
    const result = await runNamed('code');
    expect(formatSyncResultJson(result)).toMatchObject({
      schema_version: 1,
      sync_strategy: 'code',
      sync_strategy_origin: 'override',
      added: 1,
    });
  }, 60_000);

  test('syncOneSource ignores stale caller config and resolves the locked source row', async () => {
    await insertSource('code');
    const { result } = await syncOneSource(
      engine,
      {
        id: 'fixture',
        name: 'Fixture',
        local_path: repoPath,
        // Deliberately stale snapshot: source-row authority must win.
        config: { strategy: 'markdown' },
      },
      {
        dryRun: false,
        full: true,
        noPull: true,
        noEmbed: true,
        noExtract: true,
        skipFailed: false,
        retryFailed: false,
        concurrency: 1,
      },
    );
    expect(result.syncStrategy).toBe('code');
    expect(result.syncStrategyOrigin).toBe('stored');
    expect(result.added).toBe(1);
    expect(
      await engine.getPage('src-widget-ts', { sourceId: 'fixture' }),
    ).not.toBeNull();
    expect(await importedPaths()).toEqual([]);
  }, 60_000);

  test('the explicit skipLock branch still resolves the named source policy', async () => {
    await insertSource('code');
    const result = await performSync(engine, {
      repoPath,
      sourceId: 'fixture',
      skipLock: true,
      full: true,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(result.syncStrategy).toBe('code');
    expect(result.syncStrategyOrigin).toBe('stored');
    await expectCodeOnly();
  }, 60_000);
});

describe('stored strategy parity across direct and scheduled callers', () => {
  test('sync --all reports stored provenance and imports the stored file set', async () => {
    await insertSource('code');
    const logs = await captureLogs(() => runSync(engine, [
      '--all',
      '--serial',
      '--full',
      '--no-pull',
      '--no-embed',
      '--no-extract',
      '--json',
    ]));
    const envelope = JSON.parse(logs.at(-1) ?? '{}') as {
      schema_version: number;
      sources: Array<Record<string, unknown>>;
    };
    expect(envelope.schema_version).toBe(1);
    expect(envelope.sources.find((source) => source.source_id === 'fixture'))
      .toMatchObject({
        status: 'ok',
        sync_strategy: 'code',
        sync_strategy_origin: 'stored',
      });
    await expectCodeOnly();
  }, 60_000);

  test('sync --retry-failed resolves stored policy and does not persist an override', async () => {
    await insertSource('code');
    await runSync(engine, [
      '--source', 'fixture',
      '--repo', repoPath,
      '--retry-failed',
      '--full',
      '--no-pull',
      '--no-embed',
      '--no-extract',
    ]);
    await expectCodeOnly();
    const rows = await engine.executeRaw<{ config: Record<string, unknown> }>(
      `SELECT config FROM sources WHERE id = 'fixture'`,
    );
    expect(rows[0].config).toMatchObject({ strategy: 'code' });
  }, 60_000);

  test('watch pins its invocation override for the process without persisting it', async () => {
    await insertSource('markdown');
    const nativeSetTimeout = globalThis.setTimeout;
    const stopAfterFirstPoll = new Error('stop-watch-after-first-poll');
    const watchDelayMs = 123_456_000;
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation((
      (handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        if (delay === watchDelayMs) throw stopAfterFirstPoll;
        return nativeSetTimeout(handler, delay, ...args);
      }
    ) as typeof setTimeout);
    const errors: string[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation(
      (...values: unknown[]) => errors.push(values.join(' ')),
    );
    try {
      await expect(runSync(engine, [
        '--source', 'fixture',
        '--repo', repoPath,
        '--watch',
        '--interval', String(watchDelayMs / 1000),
        '--strategy', 'code',
        '--no-pull',
        '--no-embed',
        '--no-extract',
      ])).rejects.toThrow(stopAfterFirstPoll.message);
    } finally {
      errorSpy.mockRestore();
      timeoutSpy.mockRestore();
    }

    await expectCodeOnly();
    const rows = await engine.executeRaw<{ config: Record<string, unknown> }>(
      `SELECT config FROM sources WHERE id = 'fixture'`,
    );
    expect(rows[0].config).toMatchObject({ strategy: 'markdown' });
    expect(errors.join('\n')).toContain(
      '--strategy code pins this watch process; source setting unchanged',
    );
  }, 60_000);

  test('the Minion sync handler produces the stored code outcome', async () => {
    await insertSource('code');
    const worker = new MinionWorker(engine, { concurrency: 1 });
    await registerBuiltinHandlers(worker, engine, { quiet: true });
    const handler = (worker as unknown as {
      handlers: Map<string, (job: any) => Promise<any>>;
    }).handlers.get('sync');
    if (!handler) throw new Error('sync handler not registered');

    const result = await handler({
      id: 1,
      name: 'sync',
      data: {
        sourceId: 'fixture',
        repoPath,
        noPull: true,
        noEmbed: true,
        noExtract: true,
        auto_embed_backfill: false,
      },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      syncStrategy: 'code',
      syncStrategyOrigin: 'stored',
    });
    await expectCodeOnly();
  }, 60_000);

  test('the cycle sync phase produces the stored code outcome', async () => {
    await insertSource('code');
    const report = await runCycle(engine, {
      brainDir: repoPath,
      sourceId: 'fixture',
      phases: ['sync'],
      pull: false,
    });
    expect(report.status).not.toBe('failed');
    await expectCodeOnly();
  }, 60_000);

  test('the autopilot-cycle handler produces the stored code outcome', async () => {
    await insertSource('code');
    const worker = new MinionWorker(engine, { concurrency: 1 });
    await registerBuiltinHandlers(worker, engine, { quiet: true });
    const handler = (worker as unknown as {
      handlers: Map<string, (job: any) => Promise<any>>;
    }).handlers.get('autopilot-cycle');
    if (!handler) throw new Error('autopilot-cycle handler not registered');

    const result = await handler({
      id: 2,
      name: 'autopilot-cycle',
      data: {
        source_id: 'fixture',
        repoPath,
        phases: ['sync'],
        pull: false,
      },
      signal: new AbortController().signal,
    });
    expect(result.status).not.toBe('failed');
    await expectCodeOnly();
  }, 60_000);

  test('the local sync_brain operation produces the stored code outcome', async () => {
    await insertSource('code');
    const op = operationsByName.sync_brain;
    if (!op) throw new Error('sync_brain operation not registered');
    const result = await op.handler({
      engine,
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: 'fixture',
    } as unknown as OperationContext, {
      no_embed: true,
      no_pull: true,
    });
    expect(result).toMatchObject({
      syncStrategy: 'code',
      syncStrategyOrigin: 'stored',
    });
    await expectCodeOnly();
  }, 60_000);
});
