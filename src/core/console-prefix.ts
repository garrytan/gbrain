/**
 * v0.40.3.0 — per-source console line-prefixing via AsyncLocalStorage.
 *
 * Under `gbrain sync --all --parallel > 1`, multiple per-source syncs run
 * concurrently. Without prefixing, every `console.log` from `performSync`
 * (git pull lines, embed progress, drift gates, ~30+ call sites total)
 * interleaves on the terminal — operators can't tell which source emitted
 * which line. kubectl `--prefix` and docker-compose solve the same problem
 * with `[<id>] ` prefixes that ride along with each line.
 *
 * Usage:
 *   await withSourcePrefix(src.id, () => performSync(engine, opts));
 *   // Inside performSync (and its callees), call slog() / serr() instead
 *   // of console.log() / console.error(). When invoked under a wrap, the
 *   // prefix is automatically prepended to each emitted line. Outside the
 *   // wrap (single-source sync, doctor, anywhere else), slog/serr are
 *   // identical to console.log/console.error — back-compat preserved.
 *
 * Multi-line strings: each newline-separated segment gets its own prefix,
 * so a `serr('phase started\\n  details: x')` under prefix `[foo]` emits:
 *   [foo] phase started
 *   [foo]   details: x
 *
 * Why source.id and not source.name:
 *   `sources add --name` accepts arbitrary text — operators (or attackers)
 *   could embed newlines or control characters that break grep filtering
 *   and impersonate other sources' lines. `source.id` is slug-validated by
 *   the existing sources schema (lowercase alphanumeric + dash) and safe to
 *   prefix raw. The per-source banner (one-shot at start of each source)
 *   can still display `source.name` for human readability.
 *
 * Why AsyncLocalStorage:
 *   Propagates through every `await` boundary without manual threading.
 *   `withSourcePrefix(id, () => performSync(...))` covers performSync AND
 *   every async function it calls (runImport, runEmbedCore, parallel-worker
 *   subphases) as long as those functions use slog/serr. Nested wraps
 *   restore the outer prefix on exit.
 *
 * Coverage in v0.40.3.0 (see CLAUDE.md for the canonical list):
 *   - src/commands/sync.ts (performSync + in-file callees)
 *   - src/commands/embed.ts (runEmbedCore + helpers)
 *   - src/core/progress.ts (heartbeat / progress writer)
 *
 * Anything outside those modules that writes directly to stdout/stderr will
 * NOT get the prefix. If you find a delegate-module line that escapes the
 * prefix under parallel sync, it's a missed migration target — file an
 * issue (per D12 → A full-lake; honest about scope).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const __prefixStore = new AsyncLocalStorage<string>();

/**
 * Run `fn` with an active per-source prefix `id`. Within the closure,
 * `slog` and `serr` will prepend `[id] ` to every line they emit. The
 * prefix is automatically propagated through `await` boundaries.
 *
 * Nested wraps replace the active prefix for the inner closure and
 * restore the outer prefix when the inner returns/throws.
 *
 * `id` should be a slug-validated source identifier (NOT a free-form
 * display name) — see module docstring for the security rationale.
 */
export function withSourcePrefix<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return __prefixStore.run(id, fn);
}

/**
 * Read the currently-active per-source prefix. Returns null when called
 * outside a `withSourcePrefix` scope. Test seam; production code should
 * use `slog` / `serr` instead of reading the prefix directly.
 */
export function getSourcePrefix(): string | null {
  return __prefixStore.getStore() ?? null;
}

/**
 * Prefix-aware replacement for `console.log`. When called inside a
 * `withSourcePrefix(id, ...)` scope, prepends `[id] ` to every line of
 * the formatted output. Outside the scope, behaves exactly like
 * `console.log` (writes to stdout).
 */
export function slog(...args: unknown[]): void {
  const prefix = getSourcePrefix();
  if (prefix === null) {
    // Back-compat fast path: bare console.log semantics.
    // eslint-disable-next-line no-console
    console.log(...args);
    return;
  }
  process.stdout.write(prefixLines(formatArgs(args), prefix) + '\n');
}

/**
 * Prefix-aware replacement for `console.error`. Same prefix semantics as
 * `slog`, but writes to stderr. Use for warnings, errors, and any output
 * that should NOT pollute `--json` stdout.
 */
export function serr(...args: unknown[]): void {
  const prefix = getSourcePrefix();
  if (prefix === null) {
    // eslint-disable-next-line no-console
    console.error(...args);
    return;
  }
  process.stderr.write(prefixLines(formatArgs(args), prefix) + '\n');
}

/**
 * Format an args list the way `console.log` would, but as a single string.
 * Strings stay raw; everything else goes through JSON.stringify with a
 * fallback to String() for non-serializable values. Multi-arg invocations
 * join with spaces (matches console.log's default delimiter).
 */
function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

/**
 * Prepend `[prefix] ` to every line of `text`. Preserves empty trailing
 * lines (so a trailing newline in input stays a trailing newline in
 * output — the caller's `+ '\\n'` adds the final separator). Embedded
 * newlines inside the string each get their own prefix.
 *
 * Examples (prefix = 'foo'):
 *   ''              → '[foo] '
 *   'a'             → '[foo] a'
 *   'a\\nb'         → '[foo] a\\n[foo] b'
 *   'a\\nb\\n'      → '[foo] a\\n[foo] b\\n[foo] '
 */
function prefixLines(text: string, prefix: string): string {
  const tag = `[${prefix}] `;
  return text.split('\n').map((line) => tag + line).join('\n');
}
