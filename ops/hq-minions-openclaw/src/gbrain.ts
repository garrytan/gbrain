import type { AppConfig } from './config.ts';
import { OperatorError } from './errors.ts';

export type BrainEngineLike = {
  connect(config: Record<string, unknown>): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
  executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  getConfig?(key: string): Promise<string | null>;
};

export type MinionQueueLike = {
  add(name: string, data?: Record<string, unknown>, opts?: Record<string, unknown>, trusted?: Record<string, unknown>): Promise<Record<string, unknown>>;
  getJob(id: number): Promise<Record<string, unknown> | null>;
  getJobs(opts?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  cancelJob(id: number): Promise<Record<string, unknown> | null>;
  retryJob(id: number): Promise<Record<string, unknown> | null>;
  pauseJob(id: number): Promise<Record<string, unknown> | null>;
  resumeJob(id: number): Promise<Record<string, unknown> | null>;
  sendMessage(jobId: number, payload: unknown, sender: string): Promise<Record<string, unknown> | null>;
  addAttachment(jobId: number, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  listAttachments(jobId: number): Promise<Record<string, unknown>[]>;
  getStats(opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
};

export type MinionWorkerLike = {
  register(name: string, handler: (ctx: unknown) => unknown): void;
  start(): Promise<void>;
  stop?(): void;
};

async function importEngineFactory(): Promise<{ createEngine: (config: Record<string, unknown>) => Promise<BrainEngineLike> }> {
  try {
    return await import('gbrain/engine-factory') as never;
  } catch {
    return await import('../../../src/core/engine-factory.ts') as never;
  }
}

async function importMinions(): Promise<{
  MinionQueue: new (engine: BrainEngineLike, opts?: Record<string, unknown>) => MinionQueueLike;
  MinionWorker: new (engine: BrainEngineLike, opts?: Record<string, unknown>) => MinionWorkerLike;
}> {
  try {
    return await import('gbrain/minions') as never;
  } catch {
    return await import('../../../src/core/minions/index.ts') as never;
  }
}

export async function openEngine(config: AppConfig, poolSize = 5): Promise<BrainEngineLike> {
  const { createEngine } = await importEngineFactory();
  const engine = await createEngine({
    engine: 'postgres',
    database_url: config.databaseUrl
  });
  await engine.connect({
    engine: 'postgres',
    database_url: config.databaseUrl,
    poolSize
  });
  return engine;
}

export async function createQueue(config: AppConfig): Promise<{ engine: BrainEngineLike; queue: MinionQueueLike }> {
  const engine = await openEngine(config);
  const { MinionQueue } = await importMinions();
  const queue = new MinionQueue(engine, {
    maxAttachmentBytes: config.maxAttachmentBytes
  });
  return { engine, queue };
}

export async function createWorker(config: AppConfig): Promise<{ engine: BrainEngineLike; worker: MinionWorkerLike }> {
  const engine = await openEngine(config, Math.max(config.concurrency + 2, 5));
  const { MinionWorker } = await importMinions();
  const worker = new MinionWorker(engine, {
    queue: config.queue,
    concurrency: config.concurrency,
    pollInterval: config.pollIntervalMs,
    maxAttachmentBytes: config.maxAttachmentBytes
  });
  return { engine, worker };
}

export function requireJobId(raw: string | undefined): number {
  if (!raw) throw new OperatorError('missing_job_id', 'Missing job id.');
  if (!/^\d+$/.test(raw)) throw new OperatorError('invalid_job_id', 'Job id must be an integer.');
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new OperatorError('invalid_job_id', 'Job id must be a positive safe integer.');
  return id;
}
