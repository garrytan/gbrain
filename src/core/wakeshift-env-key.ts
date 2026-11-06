/**
 * WAKESHIFT_API_KEY leaves process.env as soon as gbrain sees it (the shell's export or ~/.gbrain/.env, which
 * loadGbrainEnvFile fills on every config load), so jobs and other child processes never inherit the app's
 * signing key. The value lives on only in this module. No imports: gbrain-env-file.ts calls it.
 */
export const WAKESHIFT_KEY_ENV = 'WAKESHIFT_API_KEY';

let envKey: string | null = null;

/**
 * Move the key out of process.env into this module. The first value seen wins, so a shell export (taken at the
 * first config load) keeps precedence over a ~/.gbrain/.env value a later load fills; a changed key needs a restart.
 */
export function takeWakeshiftEnvKey(): string | null {
  const value = process.env[WAKESHIFT_KEY_ENV]?.trim();
  if (value && envKey === null) envKey = value;
  delete process.env[WAKESHIFT_KEY_ENV];
  return envKey;
}

/** Test seam: forget a key taken from the environment. */
export function resetWakeshiftEnvKeyForTests(): void { envKey = null; }
