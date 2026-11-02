/**
 * session-cwd.ts — the session directory for a gbrain process the hook
 * launcher started (#8424, #8426). The launcher
 * (src/core/setup/hook-launcher.ts) records the harness session's directory
 * in GBRAIN_HOOK_CWD and starts gbrain from its own directory, so Bun never
 * reads the session's bunfig.toml or .env. `gbrain hook` and `gbrain serve`
 * capture it at start; every read that means "the user's working directory"
 * (.gbrain-source, .gbrain-mount, the upload root, the skills dir) defaults
 * to sessionCwd(), which is process.cwd() for every other command. Nothing
 * here changes the process's working directory: a gbrain child started from
 * the session directory would load its bunfig.toml again.
 */
import { realpathSync } from 'node:fs';

export const HOOK_CWD_ENV = 'GBRAIN_HOOK_CWD';

let capturedSessionCwd: string | null = null;

/**
 * Take the session directory the launcher recorded and drop it from the
 * environment, so no child inherits a stale value. Resolved like
 * process.cwd() (sh keeps a symlinked $PWD), so project matching against
 * setup's realpath'd directories still holds.
 */
export function captureHookSessionCwd(): void {
  const recorded = process.env[HOOK_CWD_ENV];
  delete process.env[HOOK_CWD_ENV];
  if (!recorded || !recorded.startsWith('/')) { capturedSessionCwd = null; return; }
  try { capturedSessionCwd = realpathSync(recorded); } catch { capturedSessionCwd = recorded; }
}

/** The session directory: what the launcher recorded, else this process's directory. */
export function hookSessionCwd(): string {
  return capturedSessionCwd ?? process.cwd();
}
