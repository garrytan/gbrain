import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const repoRootUrl = new URL('..', import.meta.url).href;
const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');

describe('dream CLI and autopilot integration', () => {
  test('top-level help exposes dream command', () => {
    expect(cliSource).toContain('dream [--apply|--dry-run]');
    expect(cliSource).toContain('--apply-auto-promote');
    expect(cliSource).toContain('--allow-canonical-page-writes');
  });

  test('dream help exposes split permission flags', async () => {
    const { runDream } = await importFreshDreamCommand();
    const { runAutopilot } = await importFreshAutopilotCommand();

    const dreamHelp = await captureConsole(() => runDream(stubEngine(), ['--help']));
    const autopilotDreamHelp = await captureConsole(() => runAutopilot(['dream', '--help']));

    expect(dreamHelp.stdout).toContain('--apply-auto-promote');
    expect(dreamHelp.stdout).toContain('--allow-canonical-page-writes');
    expect(dreamHelp.stdout).toContain('--governed-recompile');
    expect(autopilotDreamHelp.stdout).toContain('--apply-auto-promote');
    expect(autopilotDreamHelp.stdout).toContain('--allow-canonical-page-writes');
    expect(autopilotDreamHelp.stdout).toContain('--governed-recompile');
  });

  test('dream CLI and autopilot dream command call the same phase runner input contract', async () => {
    await withTempConfigDir({
      engine: 'sqlite',
      database_path: 'brain.db',
      autopilot: { allow_llm: false, allow_local_runner: false },
    }, async () => {
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
        apply_auto_promote: false,
        allow_canonical_page_writes: false,
        trigger: 'cli',
      });
      expect(calls[1]).toMatchObject({
        scope_id: 'workspace:default',
        now: '2026-05-21T10:00:00.000Z',
        dry_run: true,
        write_candidates: false,
        apply_auto_promote: false,
        allow_canonical_page_writes: false,
        trigger: 'autopilot',
      });
      expect(calls[1]).toHaveProperty('allow_local_runner', false);
      expect(calls[1]).toHaveProperty('allow_llm', false);
    });
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

  test('dream parser accepts governed recompile override flags', async () => {
    const { parseDreamArgs } = await importFreshDreamCommand();

    expect(parseDreamArgs(['--governed-recompile'], 'cli')).toMatchObject({
      governed_recompile_enabled: true,
    });
    expect(parseDreamArgs(['--no-governed-recompile'], 'cli')).toMatchObject({
      governed_recompile_enabled: false,
    });
  });

  test('dream parser rejects non-ISO now input', async () => {
    const { parseDreamArgs } = await importFreshDreamCommand();

    expect(() => parseDreamArgs([
      '--now',
      "2026-05-21T10:00:00.000Z'; DROP TABLE memory_jobs; --",
    ], 'cli')).toThrow('--now must be a valid ISO datetime string');
  });

  test('dream permission flags are split beyond apply', async () => {
    const { parseDreamArgs } = await importFreshDreamCommand();

    expect(parseDreamArgs(['--apply'], 'cli')).toMatchObject({
      dry_run: false,
      write_candidates: true,
      apply_auto_promote: false,
      allow_canonical_page_writes: false,
    });

    expect(parseDreamArgs([
      '--apply',
      '--apply-auto-promote',
      '--allow-canonical-page-writes',
      '--max-runner-calls', '3',
      '--time-budget-ms', '5000',
      '--max-candidates-per-cycle', '8',
    ], 'cli')).toMatchObject({
      dry_run: false,
      write_candidates: true,
      apply_auto_promote: true,
      allow_canonical_page_writes: true,
      max_runner_calls: 3,
      time_budget_ms: 5000,
      max_candidates_per_cycle: 8,
    });
  });

  test('dream CLI loads maintenance governed recompile defaults from config', async () => {
    await withTempConfigDir({
      engine: 'sqlite',
      database_path: 'brain.db',
      maintenance: {
        governed_recompile_enabled: true,
        phase_timeout_ms: 12_345,
      },
    }, async () => {
      const calls: Array<Record<string, unknown>> = [];
      const runner = async (input: Record<string, unknown>) => {
        calls.push(input);
        return { status: 'ok', phases: [] };
      };
      const { runDream } = await importFreshDreamCommand();

      await captureConsole(() => runDream(stubEngine(), [
        '--scope-id', 'workspace:default',
        '--now', '2026-05-21T10:00:00.000Z',
        '--dry-run',
      ], { runner }));

      expect(calls[0]).toMatchObject({
        governed_recompile_enabled: true,
        phase_timeout_ms: 12_345,
      });
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

  test('dream CLI governed recompile phase uses the built-in compile-debt patch runner', async () => {
    await withSQLiteEngine(async (engine) => {
      await engine.putPage('systems/compile-debt-dream', {
        type: 'system',
        title: 'Compile Debt Dream',
        compiled_truth: 'Original compiled truth. [Source: User, direct message, 2026-07-03 09:00 KST]',
        timeline: '',
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await engine.putPage('systems/compile-debt-dream', {
        type: 'system',
        title: 'Compile Debt Dream',
        compiled_truth: 'Original compiled truth. [Source: User, direct message, 2026-07-03 09:00 KST]',
        timeline: '- **2026-07-03** | Dream-cycle compile debt. [Source: User, direct message, 2026-07-03 10:00 KST]',
      });
      const { runDream } = await importFreshDreamCommand();
      const { stdout } = await captureConsole(() => runDream(engine, [
        '--scope-id', 'workspace:default',
        '--now', '2026-07-04T00:00:00.000Z',
        '--dry-run',
        '--governed-recompile',
      ]));
      const result = JSON.parse(stdout);
      const recompile = result.phases.find((phase: any) => phase.family === 'recompile');

      expect(recompile).toMatchObject({
        status: 'warn',
        skip_reason: null,
        counts: {
          pages_with_compile_debt: 1,
          proposed_patch_candidates: 1,
        },
        canonical_mutations: 0,
        llm_or_runner_used: true,
      });
      expect(recompile.source_ids).toContain('systems/compile-debt-dream');
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

  test('dream CLI apply mode uses the built-in replay canary before phase work', async () => {
    await withSQLiteEngine(async (engine) => {
      const { runDream } = await importFreshDreamCommand();
      const { stdout } = await captureConsole(() => runDream(engine, [
        '--scope-id', 'workspace:default',
        '--now', '2026-06-06T00:00:00.000Z',
        '--apply',
      ]));
      const result = JSON.parse(stdout);

      expect(result.status).not.toBe('failed');
      expect(result.guardrails.replay_canary).toMatchObject({
        status: 'passed',
        required: true,
      });
      expect(result.guardrails.replay_canary.reason_codes).toContain('proof_agent_memory_passed');
      expect(result.phases.length).toBeGreaterThan(0);
    });
  });

  test('autopilot dream apply mode uses the built-in replay canary before phase work', async () => {
    await withSQLiteEngine(async (engine) => {
      const { runAutopilot } = await importFreshAutopilotCommand();
      const { stdout } = await captureConsole(() => runAutopilot([
        'dream',
        '--scope-id', 'workspace:default',
        '--now', '2026-06-06T00:00:00.000Z',
        '--apply',
      ], { engine }));
      const result = JSON.parse(stdout);

      expect(result.status).not.toBe('failed');
      expect(result.guardrails.replay_canary).toMatchObject({
        status: 'passed',
        required: true,
      });
      expect(result.guardrails.replay_canary.reason_codes).toContain('proof_agent_memory_passed');
      expect(result.phases.length).toBeGreaterThan(0);
    });
  });

  test('autopilot run-once apply cycle uses the built-in replay canary before phase work', async () => {
    await withSQLiteEngine(async (engine, paths) => {
      const originalConfigDir = process.env.MBRAIN_CONFIG_DIR;
      const originalConfigPath = process.env.MBRAIN_CONFIG_PATH;
      const originalCwd = process.cwd();
      const launchdCwd = mkdtempSync(join(tmpdir(), 'mbrain-launchd-cwd-'));
      process.env.MBRAIN_CONFIG_DIR = paths.configDir;
      delete process.env.MBRAIN_CONFIG_PATH;
      try {
        mkdirSync(paths.configDir, { recursive: true });
        writeFileSync(join(paths.configDir, 'config.json'), JSON.stringify({
          engine: 'sqlite',
          database_path: paths.databasePath,
          autopilot: {
            enabled: true,
            mode: 'manual',
            allow_llm: false,
            allow_local_runner: false,
          },
        }, null, 2));

        const { runAutopilot } = await importFreshAutopilotCommand();
        process.chdir(launchdCwd);
        const { stdout } = await captureConsole(() => runAutopilot([
          'run-once',
        ], { engine }));
        process.chdir(originalCwd);
        const result = JSON.parse(stdout);

        expect(result.status).not.toBe('failed');
        expect(result.dream_result.guardrails.replay_canary).toMatchObject({
          status: 'passed',
          required: true,
        });
        expect(result.dream_result.guardrails.replay_canary.reason_codes).toContain('proof_agent_memory_passed');
        expect(result.dream_result.phases.length).toBeGreaterThan(0);
        const dailyReportPhase = result.dream_result.phases.find((phase: any) => phase.family === 'daily_report');
        expect(dailyReportPhase).toMatchObject({
          counts: { saved_reports: 1 },
        });
        const reportPath = dailyReportPhase.source_ids[0];
        expect(reportPath.startsWith(paths.rootDir)).toBe(true);
        expect(existsSync(reportPath)).toBe(true);
        expect(existsSync(join(launchdCwd, 'reports'))).toBe(false);
      } finally {
        process.chdir(originalCwd);
        if (originalConfigDir === undefined) delete process.env.MBRAIN_CONFIG_DIR;
        else process.env.MBRAIN_CONFIG_DIR = originalConfigDir;
        if (originalConfigPath === undefined) delete process.env.MBRAIN_CONFIG_PATH;
        else process.env.MBRAIN_CONFIG_PATH = originalConfigPath;
        rmSync(launchdCwd, { recursive: true, force: true });
      }
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

async function withSQLiteEngine(
  run: (engine: SQLiteEngine, paths: { rootDir: string; configDir: string; databasePath: string }) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-dream-lifecycle-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await run(engine, {
      rootDir: dir,
      configDir: join(dir, '.mbrain'),
      databasePath,
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempConfigDir(config: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-dream-config-'));
  const configDir = join(dir, '.mbrain');
  const originalConfigDir = process.env.MBRAIN_CONFIG_DIR;
  const originalConfigPath = process.env.MBRAIN_CONFIG_PATH;
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(config, null, 2));
    process.env.MBRAIN_CONFIG_DIR = configDir;
    delete process.env.MBRAIN_CONFIG_PATH;
    await run();
  } finally {
    if (originalConfigDir === undefined) delete process.env.MBRAIN_CONFIG_DIR;
    else process.env.MBRAIN_CONFIG_DIR = originalConfigDir;
    if (originalConfigPath === undefined) delete process.env.MBRAIN_CONFIG_PATH;
    else process.env.MBRAIN_CONFIG_PATH = originalConfigPath;
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
