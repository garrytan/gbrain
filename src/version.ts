import pkg from '../package.json';
export const VERSION = pkg.version;

/**
 * The git commit this process was started from, or null when the deploy
 * target did not stamp one.
 *
 * The version alone does not identify a running process. One push can produce
 * more than one image of the same version -- a rebuild, a retry, a rollout
 * that replaces containers a few seconds apart -- so a client that reads
 * `version` off /health and caches what it found there cannot tell whether it
 * is still talking to the process it handshook with.
 *
 * Deploy targets each expose their own SHA variable; set GBRAIN_COMMIT from
 * whichever one applies rather than growing a list of vendor names here.
 *
 * Trimmed and emptiness-checked because a platform that creates the key
 * before its value writes an empty string, not an absent variable, and an
 * empty commit reads as "no commit" rather than as a commit named "".
 */
export function resolveCommitSha(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GBRAIN_COMMIT?.trim() || null;
}
