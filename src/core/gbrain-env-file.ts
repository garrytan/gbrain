/**
 * ~/.gbrain/.env secrets loader (#3893, reimplemented from @y2688's
 * community PR).
 *
 * Bun only auto-loads `.env` from the process cwd, which for a globally
 * installed CLI is arbitrary — and cwd .env files are UNTRUSTED input (the
 * #427 DATABASE_URL-hijack guard in config.ts exists because of them). The
 * gbrain home directory is operator-owned, so `~/.gbrain/.env` is a
 * deliberate place to keep API keys OUT of config.json. loadConfig() calls
 * this before its env-over-file merge; a variable the shell already
 * exported is NEVER overridden, so real env keeps absolute precedence.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { splitDotenvLines } from './env-trust.ts';

// KEY=VALUE with a POSIX-shaped name. `export KEY=...` is deliberately not
// accepted: this is an env FILE, not a shell script (same stance as Bun's
// own .env loader). Line grammar is shared with the cwd-.env guard
// (env-trust.ts): `\n`, `\r\n` AND a bare `\r` terminate a line, a leading
// BOM is stripped, and the RHS is "everything up to the terminator" — never
// `.*$`, which cannot match past a `\r` or U+2028 and would hide the line.
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\r\n]*)$/;

/**
 * Parse `<dir>/.env` and fill process.env with its assignments.
 *
 * `resolveDir` is a thunk (not a precomputed string) so an invalid
 * GBRAIN_HOME — configDir() throws on relative or `..` paths — stays inside
 * this function's catch instead of turning loadConfig into a throw site.
 */
export function loadGbrainEnvFile(resolveDir: () => string): void {
  try {
    const envPath = join(resolveDir(), '.env');
    if (!existsSync(envPath)) return;
    const raw = readFileSync(envPath, 'utf-8');
    for (const rawLine of splitDotenvLines(raw)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(ASSIGNMENT);
      if (!m) continue;
      const key = m[1]!;
      let value = (m[2] ?? '').trim();
      const quoted =
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
      if (quoted) {
        value = value.slice(1, -1);
      } else {
        // Unquoted values may carry a trailing inline comment.
        const hash = value.indexOf(' #');
        if (hash !== -1) value = value.slice(0, hash).trim();
      }
      // Shell-exported env always wins; empty values never land.
      if (value && !(key in process.env)) process.env[key] = value;
    }
  } catch {
    // The file is optional — missing, unreadable, or an invalid home dir
    // must not break config loading.
  }
}
