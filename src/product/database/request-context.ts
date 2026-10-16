import { AsyncLocalStorage } from 'node:async_hooks';

export interface DatabaseRequestContext {
  taskId: number;
  token: string;
  signal: AbortSignal;
  timeoutMs?: number;
  onTimeout: (error: Error) => void;
}

const requests = new AsyncLocalStorage<DatabaseRequestContext>();

export function databaseRequestContext(): DatabaseRequestContext | undefined { return requests.getStore(); }

export function withDatabaseRequest<T>(context: DatabaseRequestContext, operation: () => T): T {
  return requests.run(context, operation);
}
