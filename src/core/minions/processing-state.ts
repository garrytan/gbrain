import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gbrainPath } from '../config.ts';
import { classifyAutopilotLockHolder, type AutopilotLockProbeDeps } from '../autopilot-lock.ts';
import { autopilotLockPath } from '../autopilot-paths.ts';
import { redactUrlsInText } from '../url-redact.ts';
import type { LocalConfigurationReasonCode } from './configuration-error.ts';

export type ProcessingOwnerKind = 'supervisor' | 'autopilot';
export type ProcessingState = 'starting' | 'ready' | 'configuration_blocked';
export type WorkerStartupStage = 'database_readiness' | 'child_readiness' | 'worker_startup';
export type ProcessingStage = WorkerStartupStage | 'startup_readiness' | 'ready' | 'startup_timeout' | 'retry_backoff' | 'configuration_blocked' | 'stopped';
export interface ProcessingRuntimeIdentity {
  executable: string;
  version: string;
  protocol_version?: number;
}
export interface WorkerProcessingUpdate {
  state: ProcessingState;
  stage?: WorkerStartupStage;
  reason_code?: LocalConfigurationReasonCode | null;
  worker_identity?: ProcessingRuntimeIdentity;
  child_identity?: ProcessingRuntimeIdentity;
}
export interface OwnerProcessingStatus {
  processing_ready: boolean;
  processing_state: ProcessingState;
  processing_stage: ProcessingStage;
  retry_at: string | null;
  reason_code: LocalConfigurationReasonCode | null;
  blocked_since: string | null;
  owner_pid: number;
  runtime_id: string;
  worker_pid: number | null;
  worker_identity: ProcessingRuntimeIdentity | null;
  child_identity: ProcessingRuntimeIdentity | null;
}

function startupStage(value: unknown): WorkerStartupStage | null {
  return value === 'database_readiness' || value === 'child_readiness' || value === 'worker_startup' ? value : null;
}

function processingStage(value: unknown): ProcessingStage {
  return startupStage(value) ?? (value === 'ready' || value === 'startup_timeout' || value === 'retry_backoff' || value === 'configuration_blocked' || value === 'stopped' ? value : 'startup_readiness');
}

function reasonCode(value: unknown): LocalConfigurationReasonCode | null {
  return value === 'postgres_cancellation_unavailable' || value === 'child_executable_invalid' || value === 'child_protocol_incompatible' ? value : null;
}

function identity(value: unknown): ProcessingRuntimeIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.executable !== 'string' || v.executable.length > 4096 || typeof v.version !== 'string' || !/^[\w.+-]{1,100}$/.test(v.version)) return null;
  return {
    executable: redactUrlsInText(v.executable).replace(/[\r\n\x00-\x1f]/g, ''),
    version: v.version,
    ...(Number.isSafeInteger(v.protocol_version) ? { protocol_version: v.protocol_version as number } : {}),
  };
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (statSync(path).size > 16_384) return null;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function writeJson(path: string, value: unknown, createParent = true): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    if (createParent) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch {}
  }
}

function ownerPath(kind: ProcessingOwnerKind, key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return join(gbrainPath(), 'runtime', `${kind}-${hash}.json`);
}

export function writeWorkerProcessingStatus(update: WorkerProcessingUpdate, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = env.GBRAIN_WORKER_STATUS_PATH;
  const token = env.GBRAIN_WORKER_STATUS_TOKEN;
  if (!path || !token) return false;
  try {
    const envelopePath = join(dirname(path), 'owner.json');
    const envelope = readJson(envelopePath);
    const activeGeneration = () => {
      const current = readJson(envelopePath);
      if (!envelope || envelope.kind !== 'gbrain-worker-channel-v1' || envelope.token !== token ||
          !Number.isSafeInteger(envelope.owner_pid) || Number(envelope.owner_pid) <= 0 ||
          typeof envelope.runtime_id !== 'string' || typeof envelope.owner_status_path !== 'string' ||
          current?.kind !== envelope.kind || current.token !== token || current.owner_pid !== envelope.owner_pid ||
          current.runtime_id !== envelope.runtime_id || current.owner_status_path !== envelope.owner_status_path) return false;
      const owner = readJson(envelope.owner_status_path);
      if (!owner || owner.owner_pid !== envelope.owner_pid || owner.runtime_id !== envelope.runtime_id ||
          owner.worker_channel_token !== token ||
          (owner.processing_stage !== 'startup_readiness' && owner.processing_stage !== 'ready' && !startupStage(owner.processing_stage))) return false;
      try { process.kill(envelope.owner_pid as number, 0); } catch { return false; }
      return true;
    };
    if (!activeGeneration()) return false;
    const previous = readJson(path);
    if (!previous || previous.token !== token || previous.owner_pid !== envelope!.owner_pid || previous.runtime_id !== envelope!.runtime_id ||
        (previous.worker_pid !== null && previous.worker_pid !== process.pid)) return false;
    const sameWorker = previous.worker_pid === process.pid;
    writeJson(path, {
      owner_pid: envelope!.owner_pid, runtime_id: envelope!.runtime_id,
      token, worker_pid: process.pid, state: update.state, stage: startupStage(update.stage),
      reason_code: reasonCode(update.reason_code),
      worker_identity: identity(update.worker_identity) ?? (sameWorker ? identity(previous?.worker_identity) : null),
      child_identity: identity(update.child_identity) ?? (sameWorker ? identity(previous?.child_identity) : null),
    }, false);
    const published = readJson(path);
    return activeGeneration() && published?.token === token && published.worker_pid === process.pid &&
      published.owner_pid === envelope!.owner_pid && published.runtime_id === envelope!.runtime_id;
  } catch { return false; }
}

export function readOwnerProcessingStatus(kind: ProcessingOwnerKind, key: string, pid?: number): OwnerProcessingStatus | null {
  const v = readJson(ownerPath(kind, key));
  if (!v || !Number.isSafeInteger(v.owner_pid) || Number(v.owner_pid) <= 0 || (pid !== undefined && v.owner_pid !== pid) || typeof v.runtime_id !== 'string') return null;
  try { process.kill(v.owner_pid as number, 0); } catch { return null; }
  if (v.processing_state !== 'starting' && v.processing_state !== 'ready' && v.processing_state !== 'configuration_blocked') return null;
  return {
    processing_ready: v.processing_state === 'ready',
    processing_state: v.processing_state,
    processing_stage: processingStage(v.processing_stage),
    retry_at: typeof v.retry_at === 'string' && Number.isFinite(Date.parse(v.retry_at)) ? v.retry_at : null,
    reason_code: reasonCode(v.reason_code),
    blocked_since: typeof v.blocked_since === 'string' ? v.blocked_since : null,
    owner_pid: v.owner_pid as number,
    runtime_id: v.runtime_id,
    worker_pid: Number.isSafeInteger(v.worker_pid) ? v.worker_pid as number : null,
    worker_identity: identity(v.worker_identity),
    child_identity: identity(v.child_identity),
  };
}

export function readAutopilotProcessingStatus(deps: AutopilotLockProbeDeps = {}): OwnerProcessingStatus | null {
  let lockPid: number;
  try { lockPid = Number.parseInt(readFileSync(autopilotLockPath(), 'utf-8').trim(), 10); } catch { return null; }
  const holder = classifyAutopilotLockHolder(lockPid, process.pid, deps).state;
  return holder === 'alive-foreign' || holder === 'dead' ? null : readOwnerProcessingStatus('autopilot', 'default', lockPid);
}

export class OwnerProcessingState {
  private readonly path: string;
  private childPath: string | null = null;
  private childToken: string | null = null;
  private status: OwnerProcessingStatus = {
    processing_ready: false, processing_state: 'starting', processing_stage: 'startup_readiness', retry_at: null, reason_code: null,
    blocked_since: null, owner_pid: process.pid, runtime_id: randomUUID(),
    worker_pid: null, worker_identity: null, child_identity: null,
  };

  constructor(kind: ProcessingOwnerKind, key: string) {
    this.path = ownerPath(kind, key);
    this.publish();
  }

  get snapshot(): OwnerProcessingStatus {
    this.observeWorker();
    return { ...this.status };
  }

  get blocked(): boolean { return this.snapshot.processing_state === 'configuration_blocked'; }

  prepareChild(): NodeJS.ProcessEnv {
    if (this.blocked) throw new Error('Processing is configuration-blocked; restart the owner after repair.');
    this.removeChildFile();
    this.childToken = randomUUID();
    this.childPath = join(`${this.path}.${this.status.runtime_id}.${this.childToken}.worker`, 'status.json');
    this.status.processing_ready = false;
    this.status.processing_state = 'starting';
    this.status.processing_stage = 'startup_readiness';
    this.status.retry_at = null;
    this.status.worker_pid = null;
    this.status.worker_identity = null;
    this.status.child_identity = null;
    this.publish();
    mkdirSync(dirname(this.childPath), { mode: 0o700 });
    writeJson(join(dirname(this.childPath), 'owner.json'), {
      kind: 'gbrain-worker-channel-v1', token: this.childToken,
      owner_pid: this.status.owner_pid, runtime_id: this.status.runtime_id, owner_status_path: this.path,
    }, false);
    writeJson(this.childPath, {
      token: this.childToken, owner_pid: this.status.owner_pid, runtime_id: this.status.runtime_id,
      worker_pid: null, state: 'starting', stage: null,
    }, false);
    return { GBRAIN_WORKER_STATUS_PATH: this.childPath, GBRAIN_WORKER_STATUS_TOKEN: this.childToken };
  }

  block(reason: LocalConfigurationReasonCode | null = null): void {
    if (this.status.processing_state === 'configuration_blocked') return;
    this.status.processing_state = 'configuration_blocked';
    this.status.processing_stage = 'configuration_blocked';
    this.status.retry_at = null;
    this.status.processing_ready = false;
    this.status.reason_code = reason;
    this.status.blocked_since = new Date().toISOString();
    this.publish();
  }

  workerExited(): void {
    this.observeWorker();
    if (!this.blocked) {
      this.status.processing_ready = false;
      this.status.processing_state = 'starting';
      this.status.processing_stage = 'startup_readiness';
      this.status.retry_at = null;
    }
    this.removeChildFile();
    this.publish();
  }

  waiting(stage: 'startup_timeout' | 'retry_backoff' | 'stopped', retryAt: number | null = null): boolean {
    if (this.blocked || (stage === 'startup_timeout' && this.status.processing_ready)) return false;
    if (stage === 'startup_timeout') this.removeChildFile();
    this.status.processing_ready = false;
    this.status.processing_state = 'starting';
    this.status.processing_stage = stage;
    this.status.retry_at = retryAt === null ? null : new Date(retryAt).toISOString();
    this.publish();
    return true;
  }

  close(): void {
    this.removeChildFile();
    if (readJson(this.path)?.runtime_id === this.status.runtime_id) {
      try { unlinkSync(this.path); } catch {}
    }
  }

  private observeWorker(): void {
    if (!this.childPath || this.status.processing_state === 'configuration_blocked') return;
    const v = readJson(this.childPath);
    if (!v || v.token !== this.childToken || v.owner_pid !== this.status.owner_pid || v.runtime_id !== this.status.runtime_id ||
        !Number.isSafeInteger(v.worker_pid) || Number(v.worker_pid) <= 0) return;
    if (v.state !== 'ready' && v.state !== 'configuration_blocked' && v.state !== 'starting') return;
    this.status.worker_pid = v.worker_pid as number;
    this.status.worker_identity = identity(v.worker_identity) ?? this.status.worker_identity;
    this.status.child_identity = identity(v.child_identity) ?? this.status.child_identity;
    if (v.state === 'configuration_blocked') {
      this.block(reasonCode(v.reason_code));
    } else if (v.state === 'ready' && !this.status.processing_ready && this.status.processing_stage !== 'startup_timeout') {
      this.status.processing_state = 'ready';
      this.status.processing_stage = 'ready';
      this.status.retry_at = null;
      this.status.processing_ready = true;
      this.publish();
    } else if (v.state === 'starting' && !this.status.processing_ready && this.status.processing_stage !== 'startup_timeout') {
      const stage = startupStage(v.stage) ?? 'startup_readiness';
      if (this.status.processing_stage !== stage) {
        this.status.processing_stage = stage;
        this.publish();
      }
    }
  }

  private removeChildFile(): void {
    if (this.childPath) {
      try { rmSync(dirname(this.childPath), { recursive: true, force: true }); } catch {}
    }
    this.childPath = null;
    this.childToken = null;
  }

  private publish(): void {
    try { writeJson(this.path, { ...this.status, worker_channel_token: this.childToken }); } catch {}
  }
}
