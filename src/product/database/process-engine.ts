import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { BrainEngine, ReservedConnection } from '../../core/engine.ts';
import type { EngineConfig } from '../../core/types.ts';
import { DatabaseAlreadyOwnedError, PgliteOpenError, PgliteProbeError, PgliteLockMetadataError, PglitePermissionError } from '../../core/pglite-errors.ts';
import { databasePriority } from './priority.ts';

type Reply = { id: number; value?: unknown; error?: { name: string; message: string; properties: Record<string, unknown> } };
type Owner = { send: (value: unknown) => void; kill: () => void; exited: Promise<unknown> };

function transferable(value: unknown): unknown {
  if (value instanceof AbortSignal || typeof value === 'function') return undefined;
  if (Array.isArray(value)) return value.map(transferable);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, transferable(child)]));
  return value;
}

export class WorkerPgliteEngine {
  readonly kind = 'pglite';
  private owner: Owner | null = null;
  private sequence = 0;
  private generation = 0;
  private config?: EngineConfig;
  private recovering: Promise<void> | null = null;
  private failure: Error | null = null;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor() { return this.proxy(); }

  private proxy(scope?: number, generation?: number): this {
    return new Proxy(this, { has: (target, property) => ['transaction', 'withReservedConnection', 'getPage', 'db'].includes(String(property)) || Reflect.has(target, property), get: (target, property) => {
      if (['kind', 'connect', 'disconnect', 'interruptAndRecover'].includes(String(property))) {
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      if (['then', '_db', '_sql'].includes(String(property))) return undefined;
      if (property === 'db') return {
        query: (sql: string, params?: unknown[]) => target.rpc('@db.query', [sql, params], scope, generation),
        transaction: async (fn: (db: unknown) => Promise<unknown>) => target.scoped('transaction', async child => fn((child as any).db), scope, generation),
      };
      if (property === 'transaction' || property === 'withReservedConnection') return (fn: (engine: BrainEngine | ReservedConnection) => Promise<unknown>) => target.scoped(String(property), fn, scope, generation);
      return (...args: unknown[]) => target.rpc(String(property), args, scope, generation);
    } });
  }

  private rpc(method: string, args: unknown[], scope?: number, generation?: number, lifecycle = false): Promise<unknown> {
    if (generation !== undefined && generation !== this.generation) return Promise.reject(new Error('数据库执行已中断，旧事务已关闭'));
    if (!lifecycle && this.recovering) return Promise.reject(new Error('数据库正在停止并恢复，请等待恢复完成'));
    if (!this.owner) return Promise.reject(this.failure ?? new Error('PGLite not connected. Call connect() first.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.owner!.send({ id, method, args: args.map(transferable), scope, priority: databasePriority() }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  private async scoped(method: string, fn: (engine: BrainEngine | ReservedConnection) => Promise<unknown>, parent?: number, generation = this.generation): Promise<unknown> {
    const scope = await this.rpc(`@${method}.open`, [], parent, generation) as number;
    try {
      const value = await fn(this.proxy(scope, generation) as unknown as BrainEngine);
      await this.rpc('@scope.close', [true], scope, generation);
      return value;
    } catch (error) {
      await this.rpc('@scope.close', [false], scope, generation).catch(() => {});
      throw error;
    }
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private accept(reply: Reply): void {
    const request = this.pending.get(reply.id);
    this.pending.delete(reply.id);
    if (!reply.error) { request?.resolve(reply.value); return; }
    const { name, message, properties } = reply.error;
    const error = name === 'DatabaseAlreadyOwnedError' ? new DatabaseAlreadyOwnedError({ ...properties, message } as ConstructorParameters<typeof DatabaseAlreadyOwnedError>[0])
      : name === 'PgliteOpenError' ? new PgliteOpenError(message, properties)
      : name === 'PgliteProbeError' ? new PgliteProbeError(message, properties)
      : name === 'PglitePermissionError' ? new PglitePermissionError(message, properties.databasePath as string | null)
      : name === 'PgliteLockMetadataError' ? new PgliteLockMetadataError(String(properties.lockPath), message)
      : new Error(message);
    Object.assign(error, properties, { name });
    request?.reject(error);
  }

  private spawnOwner(recovery = false): void {
    const compiled = /\/(?:~BUN|\$bunfs)\//.test(decodeURIComponent(import.meta.url));
    const path = compiled ? undefined : fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './database-worker.ts' : './database-worker.js', import.meta.url));
    const generation = ++this.generation;
    const env = { ...process.env, PMBRAIN_DB_OWNER: '1',...(recovery?{PMBRAIN_PGLITE_WAL_REPAIR:'off'}:{}) };
    const accept = (reply: unknown) => { if (generation === this.generation) this.accept(reply as Reply); };
    let owner: Owner;
    if (typeof Bun !== 'undefined') {
      const child = Bun.spawn(path ? [process.execPath, path] : [process.execPath], {
        env, ipc: accept, serialization: 'advanced', stdin: 'ignore', stdout: 'ignore', stderr: 'inherit', windowsHide: true,
      });
      owner = { send: value => child.send(value), kill: () => child.kill('SIGKILL'), exited: child.exited };
    } else {
      const child = fork(path!, [], { env, serialization: 'advanced', stdio: ['ignore','ignore','inherit','ipc'], windowsHide: true } as import('node:child_process').ForkOptions & {windowsHide:boolean});
      child.on('message', accept);
      owner = { send: value => { child.send(value as any); }, kill: () => { child.kill('SIGKILL'); }, exited: new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); }) };
    }
    this.owner = owner;
    void owner.exited.then(code => {
      if (this.owner !== owner) return;
      this.owner = null;
      this.failure = new Error(`数据库执行进程已退出（${code}）`);
      this.rejectPending(this.failure);
    });
  }

  async connect(config: EngineConfig): Promise<void> {
    if (this.recovering) await this.recovering;
    this.config = { ...config };
    this.failure = null;
    if (!this.owner) this.spawnOwner();
    await this.rpc('connect', [config], undefined, undefined, true);
  }

  async interruptAndRecover(): Promise<void> {
    if (this.recovering) return this.recovering;
    if (!this.config?.database_path) throw new Error('内存数据库不能中断后恢复，请使用持久数据库');
    const config = this.config;
    this.recovering = (async () => {
      const owner = this.owner;
      this.owner = null;
      ++this.generation;
      this.rejectPending(new Error('数据库执行已中断，未提交事务已取消'));
      if (owner) { owner.kill(); await owner.exited; }
      this.spawnOwner(true);
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        await Promise.race([this.rpc('connect', [config], undefined, undefined, true),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('原生打开数据库未在 30 秒内完成')),30000);})]);
        await this.rpc('executeRaw', ['SELECT 1'], undefined, undefined, true);
      }
      catch (error) {
        const failed = this.owner as Owner|null;
        this.owner = null;
        if (failed) { failed.kill(); await failed.exited; }
        this.failure = new Error(`数据库恢复失败：${error instanceof Error ? error.message : String(error)}`);
        this.rejectPending(this.failure);
        throw this.failure;
      }
      finally {clearTimeout(timer);}
    })().finally(() => { this.recovering = null; });
    return this.recovering;
  }

  async disconnect(): Promise<void> {
    if (this.recovering) await this.recovering.catch(() => {});
    const owner = this.owner;
    if (!owner) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.rpc('disconnect', [], undefined, undefined, true), new Promise<void>(resolve => { timer=setTimeout(resolve, 3000); })]); }
    finally {
      clearTimeout(timer);
      this.owner = null;
      ++this.generation;
      this.rejectPending(new Error('数据库连接已关闭'));
      owner.kill();
      await owner.exited;
    }
  }
}
