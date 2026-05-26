import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRootUrl = new URL('..', import.meta.url).href;
const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');

describe('autopilot CLI surface', () => {
  test('top-level help exposes autopilot command family', () => {
    expect(cliSource).toContain('autopilot');
    expect(cliSource).toContain('enable');
    expect(cliSource).toContain('disable');
    expect(cliSource).toContain('start');
    expect(cliSource).toContain('stop');
    expect(cliSource).toContain('status');
    expect(cliSource).toContain('install');
    expect(cliSource).toContain('uninstall');
    expect(cliSource).toContain('logs');
    expect(cliSource).toContain('config');
    expect(cliSource).toContain('run-once');
  });

  test('command help covers enable disable start stop status install uninstall logs config run-once', async () => {
    const { runAutopilot } = await import('../src/commands/autopilot.ts');
    const { stdout } = await captureConsole(() => runAutopilot(['--help']));

    for (const command of [
      'enable',
      'disable',
      'start',
      'stop',
      'status',
      'install',
      'uninstall',
      'logs',
      'config',
      'run-once',
    ]) {
      expect(stdout).toContain(command);
    }
  });

  test('enable forwards mode schedule and start-now to the service', async () => {
    const calls = await withFakeAutopilotService(async (service) => {
      const { runAutopilot } = await importFreshCommand();
      await runAutopilot(['enable', '--mode', 'cron', '--schedule', '*/15 * * * *', '--start-now'], { service });
    });

    expect(calls).toContainEqual({
      method: 'enable',
      input: expect.objectContaining({
        mode: 'cron',
        schedule: '*/15 * * * *',
        start_now: true,
      }),
    });
  });

  test('status prints active cycle lock and last cycle result', async () => {
    const calls = await withFakeAutopilotService(async (service) => {
      const { runAutopilot } = await importFreshCommand();
      const { stdout } = await captureConsole(() => runAutopilot(['status'], { service }));

      expect(stdout).toContain('active cycle');
      expect(stdout).toContain('autopilot-cycle:2026-05-20T12:00Z');
      expect(stdout).toContain('completed');
    });

    expect(calls).toContainEqual({ method: 'status', input: {} });
  });

  test('disable start stop install uninstall logs config and run-once dispatch to service methods', async () => {
    const calls = await withFakeAutopilotService(async (service) => {
      const { runAutopilot } = await importFreshCommand();

      await runAutopilot(['disable'], { service });
      await runAutopilot(['start'], { service });
      await runAutopilot(['stop'], { service });
      await runAutopilot(['install', '--profile', 'launchd'], { service });
      await runAutopilot(['uninstall', '--profile', 'launchd'], { service });
      await runAutopilot(['logs', '--lines', '20'], { service });
      await runAutopilot(['config', '--json'], { service });
      await runAutopilot(['run-once'], { service });
    });

    expect(calls.map(call => call.method)).toEqual([
      'disable',
      'start',
      'stop',
      'install',
      'uninstall',
      'logs',
      'config',
      'runOnce',
    ]);
    expect(calls).toContainEqual({
      method: 'install',
      input: expect.objectContaining({ profile: 'launchd' }),
    });
    expect(calls).toContainEqual({
      method: 'logs',
      input: expect.objectContaining({ lines: 20 }),
    });
  });

  test('run-once and daemon tick share the same service primitive', async () => {
    const calls = await withFakeAutopilotService(async (service) => {
      const { runAutopilot } = await importFreshCommand();
      await runAutopilot(['run-once'], { service });
      await runAutopilot(['_daemon-tick'], { service });
    });

    expect(calls).toContainEqual({
      method: 'runOnce',
      input: expect.objectContaining({ requested_by: 'cli' }),
    });
    expect(calls).toContainEqual({
      method: 'tick',
      input: expect.objectContaining({ trigger: 'daemon' }),
    });
  });

  test('enable persists only file-backed config and does not capture env-only secrets', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mbrain-autopilot-config-'));
    const previousConfigDir = process.env.MBRAIN_CONFIG_DIR;
    const previousConfigPath = process.env.MBRAIN_CONFIG_PATH;
    const previousDbUrl = process.env.DATABASE_URL;
    const previousOpenAi = process.env.OPENAI_API_KEY;
    try {
      process.env.MBRAIN_CONFIG_DIR = configDir;
      delete process.env.MBRAIN_CONFIG_PATH;
      process.env.DATABASE_URL = 'postgresql://env-user:env-secret@db.example.com:5432/mbrain';
      process.env.OPENAI_API_KEY = 'sk-env-secret';
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        engine: 'sqlite',
        database_path: '/tmp/brain.db',
        offline: true,
        embedding_provider: 'local',
        query_rewrite_provider: 'heuristic',
      }, null, 2));

      const { runAutopilot } = await importFreshCommand();
      await captureConsole(() => runAutopilot(['enable', '--mode', 'manual']));

      const saved = readFileSync(join(configDir, 'config.json'), 'utf-8');
      expect(saved).toContain('"autopilot"');
      expect(saved).toContain('"mode": "manual"');
      expect(saved).not.toContain('env-secret');
      expect(saved).not.toContain('sk-env-secret');
    } finally {
      if (previousConfigDir === undefined) delete process.env.MBRAIN_CONFIG_DIR;
      else process.env.MBRAIN_CONFIG_DIR = previousConfigDir;
      if (previousConfigPath === undefined) delete process.env.MBRAIN_CONFIG_PATH;
      else process.env.MBRAIN_CONFIG_PATH = previousConfigPath;
      if (previousDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDbUrl;
      if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAi;
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('--config honors the exact config filename advertised by install profiles', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mbrain-autopilot-custom-config-'));
    const customConfigPath = join(configDir, 'custom-mbrain.json');
    const defaultConfigPath = join(configDir, 'config.json');
    const previousConfigDir = process.env.MBRAIN_CONFIG_DIR;
    const previousConfigPath = process.env.MBRAIN_CONFIG_PATH;
    try {
      delete process.env.MBRAIN_CONFIG_DIR;
      delete process.env.MBRAIN_CONFIG_PATH;
      writeFileSync(customConfigPath, JSON.stringify({
        engine: 'sqlite',
        database_path: '/tmp/brain.db',
        offline: true,
        embedding_provider: 'local',
        query_rewrite_provider: 'heuristic',
      }, null, 2));

      const { runAutopilot } = await importFreshCommand();
      await captureConsole(() => runAutopilot(['enable', '--mode', 'manual', '--config', customConfigPath]));

      const saved = readFileSync(customConfigPath, 'utf-8');
      expect(saved).toContain('"autopilot"');
      expect(saved).toContain('"mode": "manual"');
      expect(existsSync(defaultConfigPath)).toBe(false);
    } finally {
      if (previousConfigDir === undefined) delete process.env.MBRAIN_CONFIG_DIR;
      else process.env.MBRAIN_CONFIG_DIR = previousConfigDir;
      if (previousConfigPath === undefined) delete process.env.MBRAIN_CONFIG_PATH;
      else process.env.MBRAIN_CONFIG_PATH = previousConfigPath;
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

async function importFreshCommand() {
  return import(`${repoRootUrl}src/commands/autopilot.ts?test=${Date.now()}-${Math.random()}`);
}

async function withFakeAutopilotService(run: (service: any) => Promise<void>) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const service = {
    enable: async (input: Record<string, unknown>) => {
      calls.push({ method: 'enable', input });
      return { enabled: true };
    },
    disable: async (input: Record<string, unknown> = {}) => {
      calls.push({ method: 'disable', input });
      return { enabled: false };
    },
    start: async (input: Record<string, unknown> = {}) => {
      calls.push({ method: 'start', input });
      return { running: true };
    },
    stop: async (input: Record<string, unknown> = {}) => {
      calls.push({ method: 'stop', input });
      return { running: false };
    },
    status: async (input: Record<string, unknown> = {}) => {
      calls.push({ method: 'status', input });
      return {
        scheduler_installed: true,
        daemon_running: true,
        active_cycle_lock: { cycle_name: 'autopilot_cycle', holder_kind: 'daemon' },
        last_cycle_result: {
          idempotency_key: 'autopilot-cycle:2026-05-20T12:00Z',
          status: 'completed',
        },
        warnings: [],
      };
    },
    install: async (input: Record<string, unknown>) => {
      calls.push({ method: 'install', input });
      return { installed: true, profile: input.profile };
    },
    uninstall: async (input: Record<string, unknown>) => {
      calls.push({ method: 'uninstall', input });
      return { installed: false, profile: input.profile };
    },
    logs: async (input: Record<string, unknown>) => {
      calls.push({ method: 'logs', input });
      return { lines: ['autopilot log line'] };
    },
    config: async (input: Record<string, unknown> = {}) => {
      calls.push({ method: 'config', input });
      return { enabled: true, mode: 'cron' };
    },
    runOnce: async (input: Record<string, unknown>) => {
      calls.push({ method: 'runOnce', input });
      return { status: 'submitted' };
    },
    tick: async (input: Record<string, unknown>) => {
      calls.push({ method: 'tick', input });
      return { status: 'submitted' };
    },
  };

  await run(service);
  return calls;
}

async function captureConsole(run: () => Promise<void> | void) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  };

  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  return { stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}
