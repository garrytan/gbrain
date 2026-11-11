/**
 * Where the skill resolver keeps its files: `<home>/skill-index/`, where
 * home is the gbrain config directory (GBRAIN_HOME/.gbrain, else
 * ~/.gbrain; the same rule as configDir() in src/core/config.ts, repeated
 * here so the resolver stays a leaf). Every path is derived from a validated
 * catalog name and asserted to sit under the skill-index root.
 *
 *   skill-index/<catalog>/index.bin     the index (term dictionary + postings)
 *   skill-index/<catalog>/receipt.json  the build receipt (written last)
 *   skill-index/<catalog>/source.json   the --from-json snapshot
 *   skill-index/<catalog>/fingerprint.json  stat fingerprint of a --dir source
 *   skill-index/<catalog>/lock          the build lease
 *   skill-index/<catalog>/stale.stamp   a resolve saw a stale index
 *   skill-index/<catalog>/stat-check    last turn-path stat check
 *   skill-index/<catalog>/build.log     last failed build
 *   skill-index/sessions/<key>.json     per-session dedupe and budget state
 *   skill-index/logs/                   scrubbed traces of unexpected failures
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { ResolverError } from './errors.ts';

export const CATALOG_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The catalog setup claude-code builds from Claude Code's enabled plugins. */
export const CLAUDE_PLUGINS_CATALOG = 'claude-code-plugins';
const RESERVED = new Set(['sessions', 'logs']);

/** The gbrain config directory (configDir() in src/core/config.ts). */
export function resolverHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GBRAIN_HOME;
  if (override && override.trim()) {
    const trimmed = override.trim();
    if (!isAbsolute(trimmed)) throw new Error(`GBRAIN_HOME must be an absolute path; got: ${trimmed}`);
    if (trimmed.split(/[\\/]/).includes('..')) throw new Error(`GBRAIN_HOME must not contain '..' segments; got: ${trimmed}`);
    return join(trimmed, '.gbrain');
  }
  return join(homedir(), '.gbrain');
}

export function skillIndexRoot(home: string): string {
  return join(home, 'skill-index');
}

export function validCatalogName(name: unknown): name is string {
  return typeof name === 'string' && CATALOG_NAME_RE.test(name) && !RESERVED.has(name);
}

export function assertCatalogName(name: unknown): string {
  if (validCatalogName(name)) return name;
  throw new ResolverError('skill_catalog_unknown',
    `Catalog names are 1-64 characters of a-z, 0-9, _ and -, starting with a letter or digit (and not "sessions" or "logs").`,
    { suggestion: 'Pass --catalog with a name such as claude-user or openclaw-main.', argv: ['gbrain', 'skills', 'index', 'status', '--json'] });
}

export function catalogDir(home: string, name: string): string {
  const root = skillIndexRoot(home);
  const dir = resolve(root, assertCatalogName(name));
  if (!dir.startsWith(root + sep)) throw new ResolverError('skill_catalog_unknown', 'The catalog path resolves outside the skill-index directory.', { suggestion: 'Use a plain catalog name.' });
  return dir;
}

export const catalogFile = (home: string, name: string, file: 'index.bin' | 'receipt.json' | 'source.json' | 'fingerprint.json' | 'lock' | 'stale.stamp' | 'stat-check' | 'build.log') => join(catalogDir(home, name), file);
export const sessionsDir = (home: string) => join(skillIndexRoot(home), 'sessions');
export const logsDir = (home: string) => join(skillIndexRoot(home), 'logs');
