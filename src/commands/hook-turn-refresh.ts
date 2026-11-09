/**
 * Mid-session context refresh. Env GBRAIN_CONTEXT_REFRESH_EVERY_TURNS, else
 * file-plane `hooks.context_refresh_every_turns`
 * (`gbrain config set hooks.context_refresh_every_turns 5`):
 *   - unset or 0 (default): the boundary context pack loads once, at
 *     SessionStart, exactly as before.
 *   - N > 0: the user-prompt hook also requests the session's boundary pack on
 *     every Nth human prompt. The serve's per-session since-cursor makes that
 *     pack carry only facts and pages written after the last one, so facts
 *     saved mid-session reach the conversation without a restart.
 *
 * Engine-free: one small counter file per session under the hooks dir. Every
 * failure reads as "not a refresh turn" (fail-open, like the rest of the hook).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GBrainConfig } from '../core/config.ts';
import { resolveGbrainHome } from '../core/gbrain-home.ts';
import { IPC_UNAVAILABLE, requestContextPack } from '../core/context/resolve-ipc.ts';

/**
 * The user-prompt hook's entry point: when this prompt is a refresh turn,
 * start the session's boundary-pack request (keyed like SessionStart's, so the
 * since-cursor returns only what is new) and resolve to its block text. Null
 * when not due; the promise never rejects and resolves undefined on any miss.
 */
export function startTurnRefresh(a: {
  cfg: Pick<GBrainConfig, 'hooks'> | null;
  sessionId: string;
  socketPath: string;
  secret: string;
  sourceId?: string;
  timeoutMs: number;
}): Promise<string | undefined> | null {
  const every = refreshEveryTurns(a.cfg);
  if (every <= 0 || a.sessionId === 'unknown') return null;
  try {
    const dir = join(resolveGbrainHome(), 'integrations', 'hooks', 'turn-refresh');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!countTurnAndCheckRefresh(dir, a.sessionId, every)) return null;
  } catch {
    return null;
  }
  return requestContextPack(a.socketPath, {
    secret: a.secret,
    sessionId: a.sessionId,
    ...(a.sourceId ? { sourceId: a.sourceId } : {}),
    trigger: 'turn-refresh',
  }, { timeoutMs: Math.max(1, a.timeoutMs) })
    .then((r) => (r !== IPC_UNAVAILABLE && !('degraded' in r) && r.ok ? r.block?.text : undefined))
    .catch(() => undefined);
}

/** The refresh interval in human prompts; 0 = start-of-session only. */
export function refreshEveryTurns(
  cfg: Pick<GBrainConfig, 'hooks'> | null,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.GBRAIN_CONTEXT_REFRESH_EVERY_TURNS ?? cfg?.hooks?.context_refresh_every_turns;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Count this human prompt for `sessionId` (already sanitized) and report
 * whether it is a refresh turn (the Nth, 2Nth, ...). `dir` must exist.
 * ponytail: one counter file per session, never pruned (a few bytes each); add GC beside the corpus pruning if it ever matters.
 */
export function countTurnAndCheckRefresh(dir: string, sessionId: string, every: number): boolean {
  if (every <= 0) return false;
  const file = join(dir, `${sessionId}.count`);
  let n = 0;
  try {
    n = Number.parseInt(readFileSync(file, 'utf8'), 10) || 0;
  } catch { /* first prompt of the session */ }
  n += 1;
  try {
    writeFileSync(file, String(n), { mode: 0o600 });
  } catch {
    return false;
  }
  return n % every === 0;
}
