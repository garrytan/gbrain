import { AsyncLocalStorage } from 'node:async_hooks';

export type DatabasePriority = 0 | 1 | 2 | 3;
const priority = new AsyncLocalStorage<DatabasePriority>();

export function databasePriority(): DatabasePriority { return priority.getStore() ?? 0; }

export function withDatabasePriority<T>(value: DatabasePriority, operation: () => T): T {
  return priority.run(value, operation);
}
