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
import { posix, win32 } from 'node:path';
import { msysToNativePath } from './path-confine.ts';

export const HOOK_CWD_ENV = 'GBRAIN_HOOK_CWD';

let capturedSessionCwd: string | null = null;

/**
 * Take the session directory the launcher recorded and drop it from the
 * environment, so no child inherits a stale value. Resolved like
 * process.cwd() (sh keeps a symlinked $PWD), so project matching against
 * setup's realpath'd directories still holds. On Windows the launcher runs
 * under Git Bash, whose $PWD is /c/..., so that form is mapped back to C:\...
 */
export function captureHookSessionCwd(platform: NodeJS.Platform = process.platform): void {
  const recorded = msysToNativePath(process.env[HOOK_CWD_ENV] ?? '', platform);
  delete process.env[HOOK_CWD_ENV];
  if (!recorded || !(platform === 'win32' ? win32 : posix).isAbsolute(recorded)) { capturedSessionCwd = null; return; }
  try { capturedSessionCwd = realpathSync(recorded); } catch { capturedSessionCwd = recorded; }
}

/** The session directory: what the launcher recorded, else this process's directory. */
export function hookSessionCwd(): string {
  return capturedSessionCwd ?? process.cwd();
}
