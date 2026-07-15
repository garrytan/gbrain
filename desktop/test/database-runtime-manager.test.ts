import { describe, expect, test } from 'bun:test';
import {
  DatabaseRuntimeManager,
  type CommandResult,
  type DatabaseRuntimeDependencies,
} from '../src/main/database-runtime-manager.js';

interface FakeRuntime {
  manager: DatabaseRuntimeManager;
  commands: string[][];
  launches: string[];
  tcpChecks: Array<[string, number]>;
}

function fakeRuntime(options: {
  tcpReady?: boolean | boolean[];
  command?: (args: string[]) => CommandResult | Promise<CommandResult>;
  dockerDesktop?: string | null;
  dockerStartupAttempts?: number;
  databaseReadinessAttempts?: number;
} = {}): FakeRuntime {
  const commands: string[][] = [];
  const launches: string[] = [];
  const tcpChecks: Array<[string, number]> = [];
  let tcpReadyIndex = 0;
  const dependencies: DatabaseRuntimeDependencies = {
    runCommand: async (_command, args) => {
      commands.push(args);
      return options.command?.(args) ?? { ok: false, stdout: '', stderr: 'not configured' };
    },
    startDetached: async (executable) => { launches.push(executable); },
    isTcpReady: async (host, port) => {
      tcpChecks.push([host, port]);
      if (Array.isArray(options.tcpReady)) {
        const value = options.tcpReady[tcpReadyIndex] ?? options.tcpReady.at(-1) ?? false;
        tcpReadyIndex += 1;
        return value;
      }
      return options.tcpReady ?? false;
    },
    findDockerDesktopExecutable: async () => options.dockerDesktop ?? null,
    sleep: async () => undefined,
  };
  return {
    manager: new DatabaseRuntimeManager({
      ...dependencies,
      dockerStartupAttempts: options.dockerStartupAttempts ?? 2,
      databaseReadinessAttempts: options.databaseReadinessAttempts ?? 2,
    }),
    commands,
    launches,
    tcpChecks,
  };
}

function inspectResult(
  name: string,
  hostPort: string,
  running: boolean,
  hostIp = '127.0.0.1',
): CommandResult {
  return {
    ok: true,
    stdout: JSON.stringify([{
      Name: `/${name}`,
      State: { Running: running },
      HostConfig: {
        PortBindings: {
          '5432/tcp': [{ HostIp: hostIp, HostPort: hostPort }],
        },
      },
    }]),
    stderr: '',
  };
}

describe('desktop database runtime manager', () => {
  test('PGLite never probes TCP or Docker', async () => {
    const runtime = fakeRuntime();

    const result = await runtime.manager.ensureReady({ engine: 'pglite' });

    expect(result).toEqual({ kind: 'pglite', managedByDocker: false });
    expect(runtime.tcpChecks).toEqual([]);
    expect(runtime.commands).toEqual([]);
    expect(runtime.launches).toEqual([]);
  });

  test('remote Postgres is treated as externally managed without probing Docker', async () => {
    const runtime = fakeRuntime();

    const result = await runtime.manager.ensureReady({
      engine: 'postgres',
      databaseUrl: 'postgresql://pmbrain:secret@10.10.8.20:5432/pmbrain',
    });

    expect(result).toEqual({ kind: 'external-postgres', managedByDocker: false });
    expect(runtime.tcpChecks).toEqual([]);
    expect(runtime.commands).toEqual([]);
  });

  test('reachable local Postgres is used before Docker is consulted', async () => {
    const runtime = fakeRuntime({ tcpReady: true });

    const result = await runtime.manager.ensureReady({
      engine: 'postgres',
      databaseUrl: 'postgresql://pmbrain:secret@127.0.0.1:5433/pmbrain',
    });

    expect(result).toEqual({ kind: 'local-postgres', managedByDocker: false });
    expect(runtime.tcpChecks).toEqual([['127.0.0.1', 5433]]);
    expect(runtime.commands).toEqual([]);
  });

  test('starts Docker Desktop hidden, then starts the configured stopped container', async () => {
    let dockerInfoCalls = 0;
    const runtime = fakeRuntime({
      tcpReady: [false, true],
      dockerDesktop: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
      command: (args) => {
        if (args[0] === 'info') {
          dockerInfoCalls += 1;
          return dockerInfoCalls === 1
            ? { ok: false, stdout: '', stderr: 'engine down' }
            : { ok: true, stdout: 'ready', stderr: '' };
        }
        if (args[0] === 'inspect' && args[1] === 'company-brain-db') {
          return inspectResult('company-brain-db', '5433', false);
        }
        if (args[0] === 'start') return { ok: true, stdout: 'company-brain-db', stderr: '' };
        if (args[0] === 'exec') return { ok: true, stdout: 'accepting connections', stderr: '' };
        return { ok: false, stdout: '', stderr: 'not found' };
      },
    });

    const result = await runtime.manager.ensureReady({
      engine: 'postgres',
      databaseUrl: 'postgresql://pmbrain:secret@localhost:5433/pmbrain',
      configuredContainerName: 'company-brain-db',
    });

    expect(result).toEqual({
      kind: 'docker-postgres',
      managedByDocker: true,
      containerName: 'company-brain-db',
      containerStarted: true,
    });
    expect(runtime.launches).toEqual(['C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe']);
    expect(runtime.commands).toContainEqual(['start', 'company-brain-db']);
    expect(runtime.commands.some((args) => args[0] === 'exec' && args.includes('pg_isready'))).toBe(true);
  });

  test('falls back from configured and legacy names to a container matching the URL port', async () => {
    const runtime = fakeRuntime({
      tcpReady: [false, true],
      command: (args) => {
        if (args[0] === 'info') return { ok: true, stdout: 'ready', stderr: '' };
        if (args[0] === 'inspect' && ['old-name', 'gbrain-pg', 'pmbrain-postgres'].includes(args[1]!)) {
          return { ok: false, stdout: '', stderr: 'not found' };
        }
        if (args[0] === 'container' && args[1] === 'ls') {
          return { ok: true, stdout: 'unrelated\npmbrain-db-1\n', stderr: '' };
        }
        if (args[0] === 'inspect' && args[1] === 'unrelated') return inspectResult('unrelated', '5544', true);
        if (args[0] === 'inspect' && args[1] === 'pmbrain-db-1') return inspectResult('pmbrain-db-1', '5433', true);
        if (args[0] === 'exec') return { ok: true, stdout: 'accepting connections', stderr: '' };
        return { ok: false, stdout: '', stderr: 'unexpected' };
      },
    });

    const result = await runtime.manager.ensureReady({
      engine: 'postgres',
      databaseUrl: 'postgresql://pmbrain:secret@127.0.0.1:5433/pmbrain',
      configuredContainerName: 'old-name',
    });

    expect(result.containerName).toBe('pmbrain-db-1');
    expect(result.containerStarted).toBe(false);
    expect(runtime.commands).not.toContainEqual(['start', 'pmbrain-db-1']);
    expect(runtime.commands.map((args) => args.slice(0, 2))).toEqual(expect.arrayContaining([
      ['inspect', 'old-name'],
      ['inspect', 'gbrain-pg'],
      ['inspect', 'pmbrain-postgres'],
      ['container', 'ls'],
    ]));
  });

  test('does not create a replacement when no existing container matches', async () => {
    const runtime = fakeRuntime({
      command: (args) => {
        if (args[0] === 'info') return { ok: true, stdout: 'ready', stderr: '' };
        if (args[0] === 'container') return { ok: true, stdout: 'other-db\n', stderr: '' };
        if (args[0] === 'inspect' && args[1] === 'other-db') return inspectResult('other-db', '5440', false);
        return { ok: false, stdout: '', stderr: 'not found' };
      },
    });

    await expect(runtime.manager.ensureReady({
      engine: 'postgres',
      databaseUrl: 'postgresql://pmbrain:secret@127.0.0.1:5433/pmbrain',
    })).rejects.toThrow('没有找到映射到本机端口 5433 的现有 Postgres 容器');

    const forbidden = new Set(['create', 'run', 'rm', 'stop', 'restart']);
    expect(runtime.commands.some((args) => forbidden.has(args[0]!))).toBe(false);
  });

  test('ignores a matching port bound only to a different host address', async () => {
    const runtime = fakeRuntime({
      command: (args) => {
        if (args[0] === 'info') return { ok: true, stdout: 'ready', stderr: '' };
        if (args[0] === 'inspect' && args[1] === 'company-brain-db') {
          return inspectResult('company-brain-db', '5433', true, '192.168.112.1');
        }
        if (args[0] === 'container') return { ok: true, stdout: '', stderr: '' };
        return { ok: false, stdout: '', stderr: 'not found' };
      },
    });

    await expect(runtime.manager.ensureReady({
      engine: 'postgres',
      databaseUrl: 'postgresql://pmbrain:secret@127.0.0.1:5433/pmbrain',
      configuredContainerName: 'company-brain-db',
    })).rejects.toThrow('没有找到映射到本机端口 5433 的现有 Postgres 容器');
  });

  test('retries the configured database host and port after pg_isready succeeds', async () => {
    const runtime = fakeRuntime({
      tcpReady: [false, false, true],
      command: (args) => {
        if (args[0] === 'info') return { ok: true, stdout: 'ready', stderr: '' };
        if (args[0] === 'inspect' && args[1] === 'gbrain-pg') {
          return inspectResult('gbrain-pg', '5433', true, '0.0.0.0');
        }
        if (args[0] === 'exec') return { ok: true, stdout: 'accepting connections', stderr: '' };
        return { ok: false, stdout: '', stderr: 'not found' };
      },
    });

    const result = await runtime.manager.ensureReady({
      engine: 'postgres',
      databaseUrl: 'postgresql://pmbrain:secret@127.0.0.1:5433/pmbrain',
    });

    expect(result.kind).toBe('docker-postgres');
    expect(runtime.tcpChecks).toEqual([
      ['127.0.0.1', 5433],
      ['127.0.0.1', 5433],
      ['127.0.0.1', 5433],
    ]);
  });

  test('reports configured host and port when container Postgres is ready but TCP stays unavailable', async () => {
    const runtime = fakeRuntime({
      command: (args) => {
        if (args[0] === 'info') return { ok: true, stdout: 'ready', stderr: '' };
        if (args[0] === 'inspect' && args[1] === 'gbrain-pg') {
          return inspectResult('gbrain-pg', '5433', true, '127.0.0.1');
        }
        if (args[0] === 'exec') return { ok: true, stdout: 'accepting connections', stderr: '' };
        return { ok: false, stdout: '', stderr: 'not found' };
      },
    });

    await expect(runtime.manager.ensureReady({
      engine: 'postgres',
      databaseUrl: 'postgresql://pmbrain:secret@127.0.0.1:5433/pmbrain',
    })).rejects.toThrow('数据库地址 127.0.0.1:5433 仍无法连接');

    expect(runtime.tcpChecks).toHaveLength(3);
  });

  test('reports an actionable error when Docker Desktop cannot be found', async () => {
    const runtime = fakeRuntime({
      command: (args) => args[0] === 'info'
        ? { ok: false, stdout: '', stderr: 'engine down' }
        : { ok: false, stdout: '', stderr: 'not found' },
    });

    await expect(runtime.manager.ensureReady({
      engine: 'postgres',
      databaseUrl: 'postgresql://pmbrain:secret@127.0.0.1:5433/pmbrain',
    })).rejects.toThrow('未找到 Docker Desktop');
  });

  test('default detached launcher turns an asynchronous spawn error into a preparation error', async () => {
    const manager = new DatabaseRuntimeManager({
      runCommand: async (_command, args) => args[0] === 'info'
        ? { ok: false, stdout: '', stderr: 'engine down' }
        : { ok: false, stdout: '', stderr: 'not found' },
      isTcpReady: async () => false,
      findDockerDesktopExecutable: () => `${process.cwd()}\\__pmbrain_missing_docker_desktop__.exe`,
      sleep: async () => undefined,
      dockerStartupAttempts: 1,
      databaseReadinessAttempts: 1,
    });

    await expect(manager.ensureReady({
      engine: 'postgres',
      databaseUrl: 'postgresql://pmbrain:secret@127.0.0.1:5433/pmbrain',
    })).rejects.toThrow('无法启动 Docker Desktop');
  });

  test('reports pg_isready failure without replacing or rebuilding the container', async () => {
    const runtime = fakeRuntime({
      command: (args) => {
        if (args[0] === 'info') return { ok: true, stdout: 'ready', stderr: '' };
        if (args[0] === 'inspect' && args[1] === 'gbrain-pg') return inspectResult('gbrain-pg', '5433', true);
        if (args[0] === 'exec') return { ok: false, stdout: '', stderr: 'rejecting connections' };
        return { ok: false, stdout: '', stderr: 'not found' };
      },
    });

    await expect(runtime.manager.ensureReady({
      engine: 'postgres',
      databaseUrl: 'postgresql://pmbrain:secret@127.0.0.1:5433/pmbrain',
    })).rejects.toThrow('容器 gbrain-pg 已运行，但 Postgres 未能就绪');

    expect(runtime.commands.some((args) => ['create', 'run', 'rm', 'stop'].includes(args[0]!))).toBe(false);
  });
});
