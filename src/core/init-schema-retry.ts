import type { BrainEngine } from './engine.ts';
import {
  isLockTimeoutError,
  isRetryableConnError,
  isStatementTimeoutError,
} from './retry-matcher.ts';

export interface InitSchemaRetryOpts {
  maxAttempts?: number;
  backoffMs?: number;
  /** #5227: a short bounded backoff for a lock the other session will release in a moment (default 2 s). */
  lockBackoffMs?: number;
  log?: (line: string) => void;
  _hooks?: {
    initSchema?: () => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
  };
}

export interface InitSchemaRetryResult {
  attempts: number;
}

function isMigrationRetryExhausted(err: unknown): boolean {
  return err instanceof Error && err.name === 'MigrationRetryExhausted';
}

/** #5227: the typed `schema_lock_blocked` refusal, or a raw SQLSTATE 55P03 from a lock_timeout. */
function isSchemaLockBlocked(err: unknown): boolean {
  return (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'schema_lock_blocked') || isLockTimeoutError(err);
}

function isRetryableInitSchemaError(err: unknown): boolean {
  if (isMigrationRetryExhausted(err)) return false;
  return isStatementTimeoutError(err) || isRetryableConnError(err) || isSchemaLockBlocked(err);
}

function retryReason(err: unknown): string {
  if (isSchemaLockBlocked(err)) return 'a lock another session holds (schema_lock_blocked)';
  if (isStatementTimeoutError(err)) return 'statement_timeout';
  if (isRetryableConnError(err)) return 'transient connection error';
  return 'retryable schema error';
}

/**
 * Retry the full idempotent initSchema pass for pooler-level cold-start flakes.
 *
 * Individual migration statements already have their own retry envelope inside
 * runMigrations(); this wrapper only catches failures outside that envelope
 * (for example the embedded schema replay before pending migrations run).
 */
export async function runInitSchemaWithRetry(
  engine: Pick<BrainEngine, 'initSchema'>,
  opts: InitSchemaRetryOpts = {},
): Promise<InitSchemaRetryResult> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const backoffMs = opts.backoffMs ?? 15_000;
  const initSchema = opts._hooks?.initSchema ?? (() => engine.initSchema());
  const sleep = opts._hooks?.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await initSchema();
      return { attempts: attempt };
    } catch (err) {
      if (!isRetryableInitSchemaError(err) || attempt === maxAttempts) {
        throw err;
      }

      const wait = isSchemaLockBlocked(err) ? (opts.lockBackoffMs ?? 2_000) : backoffMs;
      log(`  [init retry ${attempt}/${maxAttempts}] schema setup hit ${retryReason(err)}; retrying in ${wait}ms`);
      await sleep(wait);
    }
  }

  throw new Error('initSchema retry loop exhausted unexpectedly');
}
