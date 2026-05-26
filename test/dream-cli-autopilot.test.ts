import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const repoRootUrl = new URL('..', import.meta.url).href;
const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');

describe('dream CLI and autopilot integration', () => {
  test('top-level help exposes dream command', () => {
    expect(cliSource).toContain('dream [--apply|--dry-run]');
  });

  test('dream CLI and autopilot dream command call the same phase runner input contract', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runner = async (input: Record<string, unknown>) => {
      calls.push(input);
      return {
        status: 'ok',
        mode: input.dry_run === false ? 'apply' : 'dry_run',
        scope_id: input.scope_id,
        phases: [],
      };
    };
    const { runDream } = await importFreshDreamCommand();
    const { runAutopilot } = await importFreshAutopilotCommand();

    await captureConsole(() => runDream(stubEngine(), [
      '--scope-id', 'workspace:default',
      '--now', '2026-05-21T10:00:00.000Z',
      '--dry-run',
    ], { runner }));
    await captureConsole(() => runAutopilot([
      'dream',
      '--scope-id', 'workspace:default',
      '--now', '2026-05-21T10:00:00.000Z',
      '--dry-run',
    ], { engine: stubEngine(), dreamRunner: runner }));

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
        scope_id: 'workspace:default',
        now: '2026-05-21T10:00:00.000Z',
        dry_run: true,
        write_candidates: false,
        trigger: 'cli',
    });
    expect(calls[1]).toMatchObject({
        scope_id: 'workspace:default',
        now: '2026-05-21T10:00:00.000Z',
        dry_run: true,
        write_candidates: false,
        trigger: 'autopilot',
    });
    expect(calls[1]).toHaveProperty('allow_local_runner', false);
    expect(calls[1]).toHaveProperty('allow_llm', false);
  });

  test('dry-run flag wins if apply and dry-run are both provided', async () => {
    const { parseDreamArgs } = await importFreshDreamCommand();

    expect(parseDreamArgs(['--apply', '--dry-run'], 'cli')).toMatchObject({
      dry_run: true,
      write_candidates: false,
    });
    expect(parseDreamArgs(['--write-candidates'], 'cli')).toMatchObject({
      dry_run: true,
      write_candidates: false,
    });
  });

  test('dream CLI runs lifecycle forgetting review on the SQLite local runtime', async () => {
    await withSQLiteEngine(async (engine) => {
      const { runDream } = await importFreshDreamCommand();
      const { stdout } = await captureConsole(() => runDream(engine, [
        '--scope-id', 'workspace:default',
        '--now', '2026-05-21T10:00:00.000Z',
        '--dry-run',
      ]));
      const result = JSON.parse(stdout);
      const forgetting = result.phases.find((phase: any) => phase.family === 'forgetting_review');

      expect(forgetting).toMatchObject({
        status: 'ok',
        skip_reason: null,
        counts: {
          purge_candidates: 0,
          restore_windows: 0,
        },
      });
    });
  });

  test('autopilot dream runs lifecycle forgetting review on the SQLite local runtime', async () => {
    await withSQLiteEngine(async (engine) => {
      const { runAutopilot } = await importFreshAutopilotCommand();
      const { stdout } = await captureConsole(() => runAutopilot([
        'dream',
        '--scope-id', 'workspace:default',
        '--now', '2026-05-21T10:00:00.000Z',
        '--dry-run',
      ], { engine }));
      const result = JSON.parse(stdout);
      const forgetting = result.phases.find((phase: any) => phase.family === 'forgetting_review');

      expect(forgetting).toMatchObject({
        status: 'ok',
        skip_reason: null,
        counts: {
          purge_candidates: 0,
          restore_windows: 0,
        },
      });
    });
  });
});

async function importFreshDreamCommand() {
  return import(`${repoRootUrl}src/commands/dream.ts?test=${Date.now()}-${Math.random()}`);
}

async function importFreshAutopilotCommand() {
  return import(`${repoRootUrl}src/commands/autopilot.ts?test=${Date.now()}-${Math.random()}`);
}

function stubEngine() {
  return {
    initSchema: async () => {},
    disconnect: async () => {},
  } as any;
}

async function withSQLiteEngine(run: (engine: SQLiteEngine) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-dream-lifecycle-'));
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    await run(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function captureConsole(run: () => Promise<void> | void): Promise<{ stdout: string; stderr: string }> {
  const originalLog = console.log;
  const originalError = console.error;
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  };
  try {
    await run();
    return {
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}
