import { parentPort } from 'node:worker_threads';
import { PGLiteEngine } from '../../core/pglite-engine.ts';
import type { BrainEngine, ReservedConnection } from '../../core/engine.ts';
import { configureGateway } from '../../core/ai/gateway.ts';
import { buildGatewayConfig } from '../../core/ai/gateway-config.ts';
import { loadConfig } from '../../core/config.ts';
import { withPgliteSavepoints } from './savepoints.ts';
import { leaseRenewal } from './lease-renewal.ts';

function respond(payload: { id: number; value?: unknown; error?: { name: string; message: string; properties: Record<string, unknown> } }): void {
  try { if (parentPort) parentPort.postMessage(payload); else process.send!(payload); }
  catch (error) { console.error('[database] 回复数据库调用失败:', error instanceof Error ? error.message : error); }
}

const engine = new PGLiteEngine();
let sequence = 0;
const scopes = new Map<number, { engine: BrainEngine | ReservedConnection; finish: (commit: boolean) => void; done: Promise<unknown> }>();
let openRootScope: number | undefined;
const renewalsWhileOpen = new Map<string, any[]>();
let replayAfterReply: (() => Promise<void>) | undefined;

async function perform(message: { method: string; args: any[]; scope?: number }): Promise<unknown> {
  const { method, args, scope } = message;
  if (method === '@scope.close') {
    const current = scopes.get(scope!);
    if (!current) throw new Error('数据库事务已关闭');
    const commit = args[0] === true;
    const rootClose = scope === openRootScope;
    current.finish(commit);
    try { return await current.done; }
    finally {
      scopes.delete(scope!);
      if (!commit && !rootClose && openRootScope !== undefined && renewalsWhileOpen.size) {
        const root = scopes.get(openRootScope)?.engine;
        const renewals=[...renewalsWhileOpen.values()];
        if (root) {
          replayAfterReply = async () => {
            for(const [sql,params] of renewals){
              try { await root.executeRaw(sql, params); }
              catch (error) { console.error('[database] 保存点回滚后续期锁失败:', error instanceof Error ? error.message : error); }
            }
          };
        }
      }
      if (rootClose && renewalsWhileOpen.size) {
        const renewals=[...renewalsWhileOpen.values()];
        renewalsWhileOpen.clear();
        if (openRootScope === scope) openRootScope = undefined;
        replayAfterReply = async () => {
          for(const [sql,params] of renewals){
            try { await engine.executeRaw(sql, params); }
            catch (error) { console.error('[database] 事务结束后续期锁失败:', error instanceof Error ? error.message : error); }
          }
        };
      }
    }
  }
  const current = scope === undefined ? engine : scopes.get(scope)?.engine;
  if (!current) throw new Error('数据库事务已关闭');
  if (method === '@transaction.open' || method === '@withReservedConnection.open') {
    const id = ++sequence;
    let resolveReady!: (id: number) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<number>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let finish!: (commit: boolean) => void;
    const gate = new Promise<boolean>(resolve => { finish = resolve; });
    const callback = async (connection: BrainEngine | ReservedConnection) => {
      await Promise.resolve();
      const scoped = method === '@transaction.open' ? withPgliteSavepoints(connection as BrainEngine) : connection;
      scopes.set(id, { engine: scoped, finish, done });
      resolveReady(id);
      if (!await gate) throw new Error('数据库事务已回滚');
    };
    const owner = current as BrainEngine;
    const done = method === '@transaction.open' ? owner.transaction(callback) : owner.withReservedConnection(callback);
    void done.catch(rejectReady);
    return ready;
  }
  if (method === 'connect') {
    const config = loadConfig();
    configureGateway(config ? buildGatewayConfig(config) : { env: {} });
  }
  if (method === '@db.query') return (current as PGLiteEngine).db.query(args[0], args[1]);
  const call = (current as unknown as Record<string, unknown>)[method];
  if (typeof call !== 'function' || method.startsWith('_') || method === 'constructor') throw new Error(`不支持的数据库调用：${method}`);
  return call.apply(current, args);
}

type Request = { id: number; method: string; args: any[]; scope?: number; priority?: number };
const waiting: Request[] = [];
let busy = false;
let chain: Promise<void> = Promise.resolve();

function isLockRenewal(message: Request): boolean {
  return leaseRenewal(message.method, message.args) !== undefined;
}

function enqueue(work: () => Promise<void>): void {
  chain = chain.then(work, work).then(() => undefined, () => undefined);
}

async function waitForConnection(): Promise<void> {
  for (;;) {
    const current = chain;
    await current;
    if (current === chain) return;
  }
}

async function reply(message: Request): Promise<void> {
  try {
    const delivered = isLockRenewal(message) && message.scope !== undefined && !scopes.has(message.scope)
      ? { ...message, scope: undefined }
      : message;
    const value = await perform(delivered);
    respond({ id: message.id, value });
    if (message.scope === undefined && message.method.endsWith('.open')) {
      const scopeId = value as number;
      const settled = scopes.get(scopeId)?.done;
      openRootScope = scopeId;
      renewalsWhileOpen.clear();
      await settled?.catch(() => undefined);
      await waitForConnection();
      if (openRootScope === scopeId) openRootScope = undefined;
    }
  } catch (error: any) {
    const properties = Object.fromEntries(Object.entries(error instanceof Error ? error : {}).filter(([, value]) => typeof value !== 'function'));
    const failure = { name: error?.name ?? 'Error', message: error instanceof Error ? error.message : String(error), properties };
    const replay = replayAfterReply;
    replayAfterReply = undefined;
    if (replay) await replay();
    await new Promise((resolve) => setTimeout(resolve, 0));
    respond({ id: message.id, error: failure });
    return;
  }
  const replay = replayAfterReply;
  replayAfterReply = undefined;
  if (replay) await replay();
}

function drain(): void {
  if (busy || !waiting.length) return;
  busy = true;
  let next = 0;
  for (let index = 1; index < waiting.length; index++) {
    if ((waiting[index].priority ?? 0) < (waiting[next].priority ?? 0)) next = index;
  }
  const [message] = waiting.splice(next, 1);
  void reply(message).finally(() => { busy = false; setImmediate(drain); });
}

const receive = (message: Request) => {
  if (message.scope !== undefined) { enqueue(() => reply(message)); return; }
  if (isLockRenewal(message) && openRootScope !== undefined && scopes.has(openRootScope)) {
    renewalsWhileOpen.set(leaseRenewal(message.method, message.args)!.key, message.args);
    const scope = openRootScope;
    enqueue(() => reply({ ...message, scope }));
    return;
  }
  waiting.push(message);
  setImmediate(drain);
};
if (parentPort) parentPort.on('message', receive);
else {
  process.on('message', receive);
  process.on('disconnect', () => process.exit(0));
}
