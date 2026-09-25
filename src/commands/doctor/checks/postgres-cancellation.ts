import type { BrainEngine } from '../../../core/engine.ts';
import { hasPostgresCancellationCapability, type PostgresEngine } from '../../../core/postgres-engine.ts';
import type { Check } from '../../doctor.ts';

const MISSING_PATCH_MESSAGE =
  'The postgres driver lacks the pinned cancellation patch (no discard()): signalled queries fail, /health returns 503 and accepted writes can stay queued. ' +
  'Reinstall from a checkout per INSTALL_FOR_AGENTS.md. For a global Bun install, see #5466: apply the patch inside the installed postgres package, ' +
  'or place the patches/*.patch files of the installed commit under ~/.bun/install/global/patches/ before reinstalling.';

type Owner = { discard?: unknown; release?: () => void };

export async function checkPostgresCancellationDriver(engine: BrainEngine, opts: { timeoutMs?: number } = {}): Promise<Check | null> {
  if (engine.kind !== 'postgres') return null;
  const timeoutMs = opts.timeoutMs ?? 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let owner: Owner | undefined;
  try {
    const reserving = (engine as PostgresEngine).sql.reserve() as unknown as Promise<Owner>;
    // A reservation that lands after the deadline is released immediately instead of leaking.
    reserving.then(late => { if (timedOut) late?.release?.(); }, () => {});
    owner = await Promise.race([
      reserving,
      new Promise<undefined>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(undefined); }, timeoutMs); }),
    ]);
    if (!owner) return { name: 'postgres_cancellation_driver', status: 'warn', message: `Could not reserve a Postgres connection within ${timeoutMs} ms to check cancellation support.` };
    if (!hasPostgresCancellationCapability(owner)) return { name: 'postgres_cancellation_driver', status: 'fail', message: MISSING_PATCH_MESSAGE };
    return { name: 'postgres_cancellation_driver', status: 'ok', message: 'Postgres driver supports safe query cancellation.' };
  } catch {
    return { name: 'postgres_cancellation_driver', status: 'warn', message: 'Could not inspect a reserved Postgres connection for cancellation support.' };
  } finally {
    if (timer) clearTimeout(timer);
    owner?.release?.();
  }
}
