/**
 * gbrain mounts — manage connected gbrains (v0.19.0, PR 0).
 *
 * A "mount" is a SEPARATE gbrain DATABASE connected to your host agent.
 * Your host OpenClaw can mount N team-published brains (YC Media, YC
 * Politics, Garry's List) and route operations to each via `--brain <id>`.
 *
 * Mounts are distinct from v0.18.0 "sources" (repos within ONE brain).
 * Orthogonal axes:
 *   --brain yc-media     → which DATABASE to target
 *   --source meetings    → which repo WITHIN that database
 *
 * Subcommands (PR 0 — direct transport only):
 *   gbrain mounts add <id> --path <path> --engine pglite|postgres [--db-url|--db-path]
 *   gbrain mounts list [--json]
 *   gbrain mounts remove <id>
 *
 * Not yet shipped (PR 1+):
 *   gbrain mounts pin <id> <sha>        — freeze at a tested version (PR 1)
 *   gbrain mounts sync [--id <id>]      — git pull + cache refresh (PR 1)
 *   gbrain mounts enable/disable <id>   — toggle without removing (PR 1)
 *   gbrain mounts add --mcp-url         — HTTP MCP transport + OAuth (PR 2)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import {
  loadMounts,
  validateMountId,
  HOST_BRAIN_ID,
  DuplicateMountPathError,
  type MountEntry,
  type MountsFile,
} from '../core/brain-registry.ts';
import { findRepoRoot } from '../core/repo-root.ts';
import { writeMountsCache, clearMountsCache } from '../core/mounts-cache.ts';
import { GBrainError } from '../core/types.ts';

function getMountsDir(): string { return join(homedir(), '.gbrain'); }
function getMountsPath(): string { return join(getMountsDir(), 'mounts.json'); }

/**
 * Read mounts.json and return the parsed MountsFile, or a fresh empty file
 * shape if the file is absent. Throws on corruption (never returns partial).
 */
function readMountsFile(path: string = getMountsPath()): MountsFile {
  if (!existsSync(path)) return { version: 1, mounts: [] };
  const entries = loadMounts(path);
  return { version: 1, mounts: entries };
}

/** Write mounts.json atomically with 0600 perms (contains no secrets, but
 *  is per-user config alongside config.json which IS secret-bearing).
 *
 *  Unique tmp filename per call (pid + random). Two concurrent `gbrain
 *  mounts add` invocations would otherwise clobber each other's `.tmp` file
 *  and one writer's update would be lost. Unique tmp names make each
 *  writer's atomic rename self-contained — last rename wins (read-modify-
 *  write lost-update is a separate concern that a true file lock would
 *  address, deferred to PR 1 under `gbrain mounts sync --lock`). */
function writeMountsFile(file: MountsFile, path: string = getMountsPath()): void {
  mkdirSync(getMountsDir(), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(tmpPath, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(tmpPath, 0o600); } catch { /* platform dep */ }
  // Atomic rename so readers never see a torn file.
  renameSync(tmpPath, path);
}

// ── Argument parsing helpers ───────────────────────────────────────────

interface AddArgs {
  id: string;
  path: string;
  engine: 'postgres' | 'pglite';
  database_url?: string;
  database_path?: string;
  alias?: string;
}

function parseAddArgs(args: string[]): AddArgs {
  if (args.length === 0) {
    throw new GBrainError(
      'Missing mount id',
      'gbrain mounts add <id> --path <path> [flags]',
      'Provide a kebab-case id as the first argument',
    );
  }
  const id = validateMountId(args[0], 'mount id');
  let path: string | undefined;
  let engine: 'postgres' | 'pglite' | undefined;
  let database_url: string | undefined;
  let database_path: string | undefined;
  let alias: string | undefined;

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const next = (flag: string): string => {
      const v = args[++i];
      if (!v) throw new GBrainError(`Missing value for ${flag}`, '', `Pass a value: ${flag} <value>`);
      return v;
    };
    if (a === '--path') path = next('--path');
    else if (a === '--engine') {
      const v = next('--engine');
      if (v !== 'postgres' && v !== 'pglite') {
        throw new GBrainError(`Invalid engine: "${v}"`, 'Must be "postgres" or "pglite"', 'Pass --engine pglite or --engine postgres');
      }
      engine = v;
    }
    else if (a === '--db-url' || a === '--database-url') database_url = next(a);
    else if (a === '--db-path' || a === '--database-path') database_path = next(a);
    else if (a === '--alias') alias = validateMountId(next('--alias'), '--alias value');
    else throw new GBrainError(`Unknown flag: ${a}`, '', 'See `gbrain mounts add --help`');
  }

  if (!path) {
    throw new GBrainError('Missing --path', 'Every mount needs a local clone path (for skills + handlers)', 'Add --path /absolute/path/to/mount');
  }

  // Engine inference: if user supplied db-url → postgres, if db-path → pglite.
  if (!engine) {
    if (database_url) engine = 'postgres';
    else if (database_path) engine = 'pglite';
    else {
      throw new GBrainError(
        'Missing --engine',
        'Could not infer engine from flags',
        'Pass --engine pglite --db-path <path> OR --engine postgres --db-url <url>',
      );
    }
  }

  if (engine === 'postgres' && !database_url) {
    throw new GBrainError('postgres mount requires --db-url', '', 'Pass --db-url postgresql://...');
  }
  if (engine === 'pglite' && !database_path && !database_url) {
    throw new GBrainError('pglite mount requires --db-path', '', 'Pass --db-path /path/to/mount/.pglite');
  }

  return { id, path: resolve(path), engine, database_url, database_path, alias };
}

// ── Subcommand: add ─────────────────────────────────────────────────────

async function runAdd(args: string[]): Promise<void> {
  const parsed = parseAddArgs(args);

  // Mount path must exist on disk — otherwise skill/handler loading will
  // fail later with a less-actionable error.
  if (!existsSync(parsed.path)) {
    throw new GBrainError(
      `Mount path does not exist: ${parsed.path}`,
      'The local clone directory must exist before registering a mount',
      `Clone the repo first (git clone <repo> ${parsed.path}) then re-run`,
    );
  }

  const file = readMountsFile();

  // Duplicate id check.
  if (file.mounts.some(m => m.id === parsed.id)) {
    throw new GBrainError(
      `Mount id already exists: "${parsed.id}"`,
      `Use 'gbrain mounts list' to see registered mounts`,
      `Remove the existing mount first: gbrain mounts remove ${parsed.id}`,
    );
  }

  // Duplicate path check (load-bearing — skills/handlers/attestation/git
  // sync all key off path, so two mounts at the same path silently collide).
  const existingAtPath = file.mounts.find(m => resolve(m.path) === parsed.path);
  if (existingAtPath) {
    throw new DuplicateMountPathError(parsed.path, existingAtPath.id, parsed.id);
  }

  // Soft warning: same database_url/database_path under different id. A
  // team can legitimately mount the same remote brain under two aliases,
  // so this is NOT a hard block (Codex finding #9 correction).
  const urlDupe = file.mounts.find(m =>
    (parsed.database_url && m.database_url === parsed.database_url) ||
    (parsed.database_path && m.database_path === parsed.database_path),
  );
  if (urlDupe) {
    process.stderr.write(
      `WARN: mount "${parsed.id}" shares database with "${urlDupe.id}". ` +
      `This is usually a mistake but is allowed for intentional aliasing.\n`,
    );
  }

  const entry: MountEntry = {
    id: parsed.id,
    alias: parsed.alias,
    path: parsed.path,
    engine: parsed.engine,
    database_url: parsed.database_url,
    database_path: parsed.database_path,
    enabled: true,
  };
  file.mounts.push(entry);
  writeMountsFile(file);

  process.stdout.write(
    `Mount "${parsed.id}" added → ${parsed.path}\n` +
    `  engine: ${parsed.engine}\n` +
    `  ${parsed.database_url ? `db_url: ${redactUrl(parsed.database_url)}` : `db_path: ${parsed.database_path}`}\n`,
  );

  // Publish aggregated resolver + manifest to ~/.gbrain/mounts-cache/. This
  // is the runtime ownership seam — host agents read the aggregated file
  // instead of the checked-in skills/RESOLVER.md. When the current process
  // isn't inside a gbrain repo, skip (a later mounts invocation from a
  // repo-rooted cwd will publish the cache).
  refreshMountsCache();
}

// ── Subcommand: list ────────────────────────────────────────────────────

function runList(args: string[]): void {
  const jsonMode = args.includes('--json');
  const file = readMountsFile();

  if (jsonMode) {
    // Redact raw db_url in json output (mounts.json is per-user 0600, but
    // stdout can be piped into logs). database_path is fine (it's a local
    // path, not a secret).
    const redacted = file.mounts.map(m => ({
      ...m,
      database_url: m.database_url ? redactUrl(m.database_url) : undefined,
    }));
    process.stdout.write(JSON.stringify({ version: file.version, mounts: redacted }, null, 2) + '\n');
    return;
  }

  if (file.mounts.length === 0) {
    process.stdout.write(
      'No mounts registered.\n\n' +
      `Add a mount with:\n` +
      `  gbrain mounts add <id> --path <path> --engine pglite --db-path <path>\n`,
    );
    return;
  }

  process.stdout.write(`MOUNTS (${file.mounts.length})\n`);
  process.stdout.write('─'.repeat(60) + '\n');
  for (const m of file.mounts) {
    const status = m.enabled === false ? '(disabled)' : '';
    process.stdout.write(`  ${m.id.padEnd(20)} ${m.engine.padEnd(10)} ${status}\n`);
    process.stdout.write(`    path:    ${m.path}\n`);
    if (m.database_url) {
      process.stdout.write(`    db_url:  ${redactUrl(m.database_url)}\n`);
    } else if (m.database_path) {
      process.stdout.write(`    db_path: ${m.database_path}\n`);
    }
    if (m.alias) process.stdout.write(`    alias:   ${m.alias}\n`);
  }
}

// ── Subcommand: remove ──────────────────────────────────────────────────

function runRemove(args: string[]): void {
  if (args.length === 0) {
    throw new GBrainError(
      'Missing mount id',
      'gbrain mounts remove <id>',
      `Run 'gbrain mounts list' to see registered mounts`,
    );
  }
  const id = args[0];
  if (id === HOST_BRAIN_ID) {
    throw new GBrainError(
      `Cannot remove host brain`,
      `"host" is not a mount — it is the default brain from ~/.gbrain/config.json`,
      `Use 'gbrain init' to reconfigure the host brain`,
    );
  }

  const file = readMountsFile();
  const before = file.mounts.length;
  file.mounts = file.mounts.filter(m => m.id !== id);
  if (file.mounts.length === before) {
    throw new GBrainError(
      `Mount "${id}" not found`,
      `No mount with id "${id}" is registered`,
      `Run 'gbrain mounts list' to see registered mounts`,
    );
  }

  writeMountsFile(file);
  process.stdout.write(`Mount "${id}" removed from mounts.json\n`);

  // If removing the last mount, clear the cache entirely; otherwise
  // rewrite with the remaining mounts so the aggregated resolver doesn't
  // reference stale entries.
  if (file.mounts.length === 0) {
    try { clearMountsCache(); } catch { /* best effort */ }
  } else {
    refreshMountsCache();
  }
}

/**
 * Recompute + publish ~/.gbrain/mounts-cache/{RESOLVER.md,manifest.json}.
 * Looks for the host skills dir via findRepoRoot(cwd). When not in a gbrain
 * repo, skips with a stderr note — next mounts invocation from a
 * repo-rooted cwd will publish. Failures are non-fatal: the mounts.json
 * write already succeeded; a stale cache is recoverable via `gbrain mounts
 * list` (PR 1 will add `gbrain mounts sync --cache` for explicit refresh).
 */
function refreshMountsCache(): void {
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    process.stderr.write(
      'NOTE: mounts-cache not refreshed (not inside a gbrain repo). ' +
      'Run `gbrain mounts add|remove` from within a repo to publish ' +
      'the aggregated resolver for host agents.\n',
    );
    return;
  }
  const hostSkillsDir = join(repoRoot, 'skills');
  if (!existsSync(hostSkillsDir)) {
    process.stderr.write(
      `NOTE: mounts-cache not refreshed (${hostSkillsDir} does not exist).\n`,
    );
    return;
  }
  try {
    const file = readMountsFile();
    const { resolverPath } = writeMountsCache(hostSkillsDir, file.mounts);
    process.stderr.write(`  cache: ${resolverPath}\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`WARN: failed to refresh mounts-cache: ${msg}\n`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Strip password from a postgres:// url for safe display. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://'));
    if (u.password) u.password = '***';
    return u.toString().replace(/^http:\/\//, 'postgres://');
  } catch {
    // Opaque URL (e.g. file:// for pglite). Return as-is.
    return url;
  }
}

// ── Dispatcher ──────────────────────────────────────────────────────────

export async function runMounts(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return;
  }
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'add':
      await runAdd(rest);
      return;
    case 'list':
    case 'ls':
      runList(rest);
      return;
    case 'remove':
    case 'rm':
      runRemove(rest);
      return;
    default:
      throw new GBrainError(
        `Unknown subcommand: gbrain mounts ${sub}`,
        `Supported: add, list, remove`,
        `Run 'gbrain mounts --help' for usage`,
      );
  }
}

function printHelp(): void {
  process.stdout.write(`gbrain mounts — manage connected gbrains (PR 0: direct transport only)

USAGE
  gbrain mounts add <id> --path <path> --engine pglite|postgres [--db-url|--db-path]
  gbrain mounts list [--json]
  gbrain mounts remove <id>

EXAMPLES
  # Mount a team-published yc-media gbrain (PGLite)
  git clone https://github.com/yc-team/yc-media-gbrain ~/gbrains/yc-media
  gbrain mounts add yc-media --path ~/gbrains/yc-media --engine pglite \\
    --db-path ~/gbrains/yc-media/.pglite

  # List registered mounts
  gbrain mounts list

  # Remove a mount
  gbrain mounts remove yc-media

NOT YET IMPLEMENTED (coming in PR 1/2)
  gbrain mounts pin <id> <sha>          — freeze a mount at a tested version
  gbrain mounts sync [--id <id>]        — git pull + refresh attestation
  gbrain mounts enable|disable <id>     — toggle without removing
  gbrain mounts add --mcp-url <url>     — HTTP MCP transport + OAuth
`);
}

/** Exposed for tests. */
export const __testing = {
  parseAddArgs,
  redactUrl,
  readMountsFile,
  writeMountsFile,
  getMountsPath,
};
