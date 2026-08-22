import type { BrainEngine } from './engine.ts';
import {
  isRetryableConnError,
  isStatementTimeoutError,
} from './retry-matcher.ts';

export interface InitSchemaRetryOpts {
  maxAttempts?: number;
  backoffMs?: number;
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

function isRetryableInitSchemaError(err: unknown): boolean {
  if (isMigrationRetryExhausted(err)) return false;
  return isStatementTimeoutError(err) || isRetryableConnError(err);
}

function retryReason(err: unknown): string {
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

      log(`  [init retry ${attempt}/${maxAttempts}] schema setup hit ${retryReason(err)}; retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
    }
  }

  throw new Error('initSchema retry loop exhausted unexpectedly');
}
