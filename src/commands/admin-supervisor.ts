import {
  DEFAULT_PID_FILE,
  isExpectedSupervisorProcess,
  isExpectedWorkerProcess,
  readSupervisorPidRecord,
  type SupervisorPidRecord,
} from '../core/minions/supervisor.ts';
import {
  readSupervisorEvents,
} from '../core/minions/handlers/supervisor-audit.ts';
import type { SupervisorEmission } from '../core/minions/supervisor.ts';

export interface AdminSupervisorStatus {
  running: boolean;
  supervisor_pid: number | null;
  worker_running: boolean;
  worker_pid: number | null;
  pid_file: string;
  mode: 'supervisor' | 'none';
  readiness_error?: string;
}

export type SupervisorAuditEvent = SupervisorEmission & {
  supervisor_pid?: number;
  pid?: number;
  error?: string;
  code?: number | string | null;
  signal?: string | null;
  reason?: string;
};

export function reduceSupervisorWorkerEvents(
  events: SupervisorAuditEvent[],
  supervisorPid: number,
): { workerPid: number | null; lastError: string | null } {
  let workerPid: number | null = null;
  let lastError: string | null = null;

  for (const event of events) {
    if (event.supervisor_pid !== supervisorPid) continue;
    if (event.event === 'worker_spawned') {
      workerPid = Number.isInteger(event.pid) && (event.pid ?? 0) > 0 ? event.pid! : null;
      lastError = null;
    } else if (event.event === 'worker_spawn_failed') {
      workerPid = null;
      lastError = event.error ? `Worker 启动失败：${event.error}` : 'Worker 启动失败';
    } else if (event.event === 'worker_exited') {
      workerPid = null;
      const exit = event.signal ? `signal ${event.signal}` : `exit ${event.code ?? 'unknown'}`;
      lastError = `Worker 已退出（${exit}）`;
    } else if (event.event === 'max_crashes_exceeded') {
      workerPid = null;
      lastError = 'Worker 连续崩溃，Supervisor 已停止重试';
    } else if (event.event === 'stopped') {
      workerPid = null;
      lastError = event.reason ? `Supervisor 已停止：${event.reason}` : 'Supervisor 已停止';
    }
  }

  return { workerPid, lastError };
}

export function inspectAdminSupervisorStatus(options: {
  pidFile?: string;
  record?: SupervisorPidRecord | null;
  events?: SupervisorAuditEvent[];
  isSupervisorProcess?: (record: SupervisorPidRecord) => boolean;
  isWorkerProcess?: (pid: number) => boolean;
} = {}): AdminSupervisorStatus {
  const pidFile = options.pidFile ?? DEFAULT_PID_FILE;
  const record = options.record === undefined ? readSupervisorPidRecord(pidFile) : options.record;
  const supervisorRunning = record
    ? (options.isSupervisorProcess ?? isExpectedSupervisorProcess)(record)
    : false;

  if (!record || !supervisorRunning) {
    return {
      running: false,
      supervisor_pid: record?.pid ?? null,
      worker_running: false,
      worker_pid: null,
      pid_file: pidFile,
      mode: 'none',
    };
  }

  const allEvents = options.events ?? readSupervisorEvents({ sinceMs: 24 * 60 * 60 * 1000 }) as SupervisorAuditEvent[];
  const supervisorStartedAt = Date.parse(record.started_at);
  const events = Number.isFinite(supervisorStartedAt)
    ? allEvents.filter(event => {
        const eventAt = Date.parse(event.ts);
        return !Number.isFinite(eventAt) || eventAt >= supervisorStartedAt;
      })
    : allEvents;
  const workerState = reduceSupervisorWorkerEvents(events, record.pid);
  const workerRunning = workerState.workerPid !== null
    && (options.isWorkerProcess ?? (pid => isExpectedWorkerProcess(pid, record.pid)))(workerState.workerPid);

  return {
    running: true,
    supervisor_pid: record.pid,
    worker_running: workerRunning,
    worker_pid: workerRunning ? workerState.workerPid : null,
    pid_file: pidFile,
    mode: 'supervisor',
    ...(!workerRunning && workerState.lastError ? { readiness_error: workerState.lastError } : {}),
  };
}

export async function waitForAdminSupervisorReady(
  expectedSupervisorPid: number,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    inspect?: () => AdminSupervisorStatus;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<AdminSupervisorStatus> {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const pollMs = options.pollMs ?? 250;
  const inspect = options.inspect ?? (() => inspectAdminSupervisorStatus());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const startedAt = now();
  let lastStatus = inspect();

  while (now() - startedAt <= timeoutMs) {
    lastStatus = inspect();
    if (
      lastStatus.supervisor_pid === expectedSupervisorPid
      && lastStatus.running
      && lastStatus.worker_running
      && lastStatus.worker_pid
    ) {
      return lastStatus;
    }
    await sleep(pollMs);
  }

  const detail = lastStatus.supervisor_pid && lastStatus.supervisor_pid !== expectedSupervisorPid
    ? `PID 不匹配，预期 ${expectedSupervisorPid}，实际 ${lastStatus.supervisor_pid}`
    : lastStatus.readiness_error
      ?? (lastStatus.running ? 'Supervisor 已启动，但 Worker 未就绪' : 'Supervisor 进程未保持运行');
  throw new Error(`Supervisor 启动就绪检查失败：${detail}`);
}
