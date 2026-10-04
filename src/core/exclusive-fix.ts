/**
 * A7 lock ownership for exclusive fixes, split out of readiness.ts so the CLI
 * error path (fatal seam, doctor's connection check) can wrap a fix without
 * loading readiness's provider/recipe graph. readiness.ts re-exports it.
 */
import type { Action } from './agent-output.ts';
import type { LockOwner } from './readiness.ts';

/** CLI commands that route themselves through a live owner (`runDelegatedCliOperation` and the persistence delegates). */
const OWNER_DELEGATED_COMMANDS: ReadonlySet<string> = new Set(['reindex-code', 'sync']);

/**
 * Wrap an exclusive fix for the current lock owner. No owner, or a command
 * that delegates to the owner → unchanged. Otherwise a two-step plan: step one
 * (actor `user`) stops the owning serve, `then` the original command.
 */
export function exclusiveFix(action: Action, lockOwner: LockOwner | null): Action {
  if (!action.requires_exclusive || !lockOwner) return action;
  if (action.argv?.[0] === 'gbrain' && OWNER_DELEGATED_COMMANDS.has(action.argv[1] ?? '')) return action;
  const who = lockOwner.transport === 'http'
    ? `the shared \`gbrain serve --http\` (PID ${lockOwner.pid})`
    : `the stdio \`gbrain serve\` an agent session started (PID ${lockOwner.pid})`;
  const restart = lockOwner.transport === 'http'
    ? 'Start `gbrain serve --http` again afterwards.'
    : 'Reopen the agent session afterwards so it restarts its gbrain server.';
  return {
    argv: ['kill', String(lockOwner.pid)],
    consent: [],
    actor: 'user',
    why: `${who} holds this brain's single-writer lock and the next command needs it exclusively. Stop that server first (quit the session or run this), then run the next step. ${restart}`,
    user_message: `This needs gbrain's database to itself. Please stop ${who}, then I'll run the next step. ${restart}`,
    requires_exclusive: false,
    then: action,
  };
}

/**
 * The owner named by a live-serve lock refusal (`LiveServeLockError` carries
 * the holder's pid and transport), or null for any other error.
 */
export function liveServeOwner(e: unknown): LockOwner | null {
  const busy = e as { code?: unknown; reason?: unknown; ownerPid?: unknown; ownerTransport?: unknown } | null;
  if (busy?.code !== 'pglite_busy' || busy.reason !== 'live_serve' || typeof busy.ownerPid !== 'number') return null;
  return { pid: busy.ownerPid, transport: busy.ownerTransport === 'http' ? 'http' : 'stdio', is_self: busy.ownerPid === process.pid };
}
