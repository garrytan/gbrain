/** Retry advice for the two observational PostgreSQL status commands, never for a write. */
import { GBrainError } from '../core/types.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { RemoteMcpError } from '../core/remote-mcp-error.ts';
import { getCode, getMessage, isConnectionCode } from '../core/retry-matcher.ts';
import type { BrainEngine } from '../core/engine.ts';

export function postgresStatusReadError(error: unknown, engineKind: BrainEngine['kind'] | null): unknown {
  switch (engineKind) {
    case 'postgres': break;
    case 'pglite': case null: return error;
    default: { const unreachable: never = engineKind; return unreachable; }
  }
  if (error instanceof OperationError || error instanceof RemoteMcpError) return error;
  const cause = error instanceof GBrainError && error.cause !== undefined ? error.cause : error;
  const code = getCode(cause);
  const socket = cause as { syscall?: unknown; address?: unknown; path?: unknown } | null;
  const missingSocket = code === 'ENOENT' && socket?.syscall === 'connect'
    && (/\/\.s\.PGSQL\.\d+$/.test(String(socket.address ?? socket.path ?? ''))
      || /^connect ENOENT \/.*\/\.s\.PGSQL\.\d+$/.test(getMessage(cause)));
  if (!missingSocket && !isConnectionCode(code)
    && !['ECONNREFUSED', '57P01', '57P02', '57P03', '08000', '08001', '08003', '08006'].includes(code ?? '')) return error;
  return opError('database_error', 'PostgreSQL was unavailable while reading status.',
    'Once the database is ready, retry the same read-only status command with the same brain and source or queue. If it persists, run `gbrain engine status --probe` for that brain.',
    { retryable: true, reason: missingSocket ? 'socket_missing' : 'connection_unavailable',
      fix: { argv: ['gbrain', 'engine', 'status', '--probe'], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Diagnoses the selected brain connection without retrying a mutation.' } });
}
