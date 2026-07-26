import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  inspectAdminSupervisorStatus,
  reduceSupervisorWorkerEvents,
  waitForAdminSupervisorReady,
  type AdminSupervisorStatus,
} from '../src/commands/admin-supervisor.ts';
import { resolveSupervisorWorkerInvocation } from '../src/commands/jobs.ts';
import { formatSupervisorStartFailure } from '../src/commands/serve-http.ts';

const supervisorRecord = {
  pid: 4100,
  started_at: '2026-07-26T00:00:00.000Z',
  instance_id: 'instance-1',
  executable: 'bun.exe',
};

describe('Admin Supervisor readiness', () => {
  test('uses the current Bun runtime and source entrypoint in development', () => {
    expect(resolveSupervisorWorkerInvocation(
      undefined,
      ['bun.exe', 'D:\\repo\\src\\cli.ts', 'jobs', 'supervisor'],
      'C:\\runtime\\bun.exe',
    )).toEqual({
      cliPath: 'C:\\runtime\\bun.exe',
      cliArgsPrefix: ['D:\\repo\\src\\cli.ts'],
    });
  });

  test('uses the bundled Bun runtime and sidecar entrypoint after packaging', () => {
    expect(resolveSupervisorWorkerInvocation(
      undefined,
      ['bun.exe', 'D:\\PMBrain\\pmbrain-sidecar.js', 'jobs', 'supervisor'],
      'D:\\PMBrain\\bun.exe',
    )).toEqual({
      cliPath: 'D:\\PMBrain\\bun.exe',
      cliArgsPrefix: ['D:\\PMBrain\\pmbrain-sidecar.js'],
    });
  });

  test('keeps an explicit compiled worker path compatible', () => {
    expect(resolveSupervisorWorkerInvocation('C:\\bin\\gbrain.exe')).toEqual({
      cliPath: 'C:\\bin\\gbrain.exe',
      cliArgsPrefix: [],
    });
  });

  test('tracks the latest live worker event for one Supervisor instance', () => {
    expect(reduceSupervisorWorkerEvents([
      { event: 'started', ts: '2026-07-26T00:00:00Z', supervisor_pid: 4100 },
      { event: 'worker_spawned', ts: '2026-07-26T00:00:01Z', supervisor_pid: 4100, pid: 4200 },
      { event: 'worker_spawned', ts: '2026-07-26T00:00:02Z', supervisor_pid: 9999, pid: 9998 },
    ], 4100)).toEqual({ workerPid: 4200, lastError: null });

    expect(reduceSupervisorWorkerEvents([
      { event: 'worker_spawned', ts: '2026-07-26T00:00:01Z', supervisor_pid: 4100, pid: 4200 },
      { event: 'worker_exited', ts: '2026-07-26T00:00:02Z', supervisor_pid: 4100, code: 1 },
    ], 4100)).toEqual({ workerPid: null, lastError: 'Worker 已退出（exit 1）' });
  });

  test('requires both Supervisor identity and Worker process identity', () => {
    const events = [
      { event: 'worker_spawned' as const, ts: '2026-07-26T00:00:01Z', supervisor_pid: 4100, pid: 4200 },
    ];
    const ready = inspectAdminSupervisorStatus({
      record: supervisorRecord,
      events,
      isSupervisorProcess: () => true,
      isWorkerProcess: pid => pid === 4200,
    });
    expect(ready.running).toBe(true);
    expect(ready.worker_running).toBe(true);
    expect(ready.worker_pid).toBe(4200);

    const wrongWorker = inspectAdminSupervisorStatus({
      record: supervisorRecord,
      events,
      isSupervisorProcess: () => true,
      isWorkerProcess: () => false,
    });
    expect(wrongWorker.running).toBe(true);
    expect(wrongWorker.worker_running).toBe(false);
    expect(wrongWorker.worker_pid).toBeNull();
  });

  test('ignores audit events older than the current Supervisor PID record', () => {
    const status = inspectAdminSupervisorStatus({
      record: supervisorRecord,
      events: [
        { event: 'worker_spawned', ts: '2026-07-25T23:59:59Z', supervisor_pid: 4100, pid: 4200 },
      ],
      isSupervisorProcess: () => true,
      isWorkerProcess: () => true,
    });
    expect(status.worker_running).toBe(false);
    expect(status.worker_pid).toBeNull();
  });

  test('waits until the expected Supervisor and Worker are both ready', async () => {
    let tick = 0;
    const pending: AdminSupervisorStatus = {
      running: true,
      supervisor_pid: 4100,
      worker_running: false,
      worker_pid: null,
      pid_file: 'supervisor.pid',
      mode: 'supervisor',
    };
    const ready: AdminSupervisorStatus = {
      ...pending,
      worker_running: true,
      worker_pid: 4200,
    };

    const result = await waitForAdminSupervisorReady(4100, {
      timeoutMs: 50,
      pollMs: 5,
      now: () => tick,
      sleep: async ms => { tick += ms; },
      inspect: () => tick >= 10 ? ready : pending,
    });
    expect(result.worker_pid).toBe(4200);
  });

  test('returns captured stderr and redacts secrets', () => {
    expect(formatSupervisorStartFailure(
      1,
      '',
      'Could not resolve CLI; token=super-secret-value',
    )).toBe('Supervisor 启动失败（exit 1）：Could not resolve CLI; token=***');
  });

  test('Admin UI has a separate preparing state and checks Worker readiness', () => {
    const source = readFileSync(join(process.cwd(), 'admin/src/pages/Dream.tsx'), 'utf8');
    expect(source).toContain('const [starting, setStarting] = useState(false)');
    expect(source).toContain('const busy = running || starting');
    expect(source).toContain('!supervisor?.worker_running');
    expect(source).toContain('正在准备 Worker…');
  });

  test('keeps the detached Supervisor and Worker console hidden on Windows', () => {
    const jobsSource = readFileSync(join(process.cwd(), 'src/commands/jobs.ts'), 'utf8');
    const workerSource = readFileSync(
      join(process.cwd(), 'src/core/minions/child-worker-supervisor.ts'),
      'utf8',
    );
    expect(jobsSource).toMatch(
      /spawn\(process\.execPath,[\s\S]*?detached:\s*true,[\s\S]*?windowsHide:\s*true,/,
    );
    expect(workerSource).toMatch(
      /child = spawn\(spawnCmd, spawnArgs,[\s\S]*?windowsHide:\s*true,/,
    );
  });
});
