import type { BrainEngine } from '../../../core/engine.ts';
import type { PostgresEngine } from '../../../core/postgres-engine.ts';
import { hasPostgresCancellationCapability, postgresCancellationUnavailable, reserveWithCancellation } from '../../../core/postgres-engine/cancellation.ts';
import type { Check } from '../../doctor.ts';

export async function checkPostgresCancellationDriver(
  engine: BrainEngine,
  opts: { timeoutMs?: number } = {},
): Promise<Check | null> {
  if (engine.kind !== 'postgres') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5_000);
  let owner: { release(): void } | undefined;
  try {
    owner = await reserveWithCancellation(options => (engine as PostgresEngine).sql.reserve(options), controller.signal);
    if (!hasPostgresCancellationCapability(owner)) {
      const error = postgresCancellationUnavailable();
      return {
        name: 'postgres_cancellation_driver',
        status: 'fail',
        message: error.message,
        details: { reason_code: error.reasonCode },
      };
    }
    return {
      name: 'postgres_cancellation_driver',
      status: 'ok',
      message: 'Postgres driver supports safe query cancellation.',
    };
  } catch {
    return {
      name: 'postgres_cancellation_driver',
      status: 'warn',
      message: 'Could not inspect a reserved Postgres connection within the readiness budget. Check database connectivity and retry; a timeout does not prove a driver fault.',
    };
  } finally {
    clearTimeout(timer);
    owner?.release();
  }
}
