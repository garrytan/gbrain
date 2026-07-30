/**
 * `REPO_ROOT` — the absolute, native-format path to the repository root, for
 * tests that spawn the CLI (`cwd:`) or read repo files.
 *
 * Use this instead of `new URL('..', import.meta.url).pathname`.
 *
 * `URL.pathname` is a *URL* path, not a filesystem path. On Windows it yields
 * `/C:/Users/...` (leading slash, forward slashes, still percent-encoded),
 * which no Win32 API accepts. The two ways that bites a test:
 *
 *   - as `cwd:` to `Bun.spawn`, libuv can't chdir and reports
 *     `ENOENT: no such file or directory, uv_spawn 'bun'`. The `path: "bun"`
 *     in that error is argv[0] echoed back — it is NOT saying the `bun`
 *     binary is missing, which sends you hunting the wrong defect.
 *   - interpolated into a script argument, Bun reports
 *     `Module not found "/C:/.../src/cli.ts"`.
 *
 * `fileURLToPath` performs the drive-letter, separator, and percent-decoding
 * conversion correctly. On POSIX it is an identity transform over the same
 * inputs, so this helper is a no-op there.
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Repo root, absolute and native-format, with no trailing separator. */
export const REPO_ROOT: string = fileURLToPath(new URL('../..', import.meta.url)).replace(
  /[\\/]+$/,
  '',
);

/** Join path segments onto the repo root, native-format. */
export function repoPath(...segments: string[]): string {
  return join(REPO_ROOT, ...segments);
}
