/**
 * gbrain sources — manage multi-source brain configuration (v0.18.0).
 *
 * A source is a logical brain-within-the-DB: wiki, gstack, yc-media, etc.
 * Every page/file/ingest_log row is scoped to a sources(id) row. Slugs
 * are unique per source. See docs/guides/multi-source-brains.md for the
 * full story.
 *
 * Subcommands:
 *   gbrain sources add <id> --path <path> [--name <display>] [--federated|--no-federated]
 *   gbrain sources list [--json]
 *   gbrain sources remove <id> [--yes] [--dry-run] [--keep-storage]
 *   gbrain sources rename <id> <new-name>
 *   gbrain sources default <id>
 *   gbrain sources attach <id>   — write .gbrain-source in CWD
 *   gbrain sources detach        — remove .gbrain-source from CWD
 *   gbrain sources federate <id>   — sources.config.federated = true
 *   gbrain sources unfederate <id> — sources.config.federated = false
 *
 * NOT in scope for Step 6 (deferred per plan):
 *   - import-from-github (needs SSRF + clone integration)
 *   - prune (retention/TTL deferred to v0.18)
 *   - MCP tool-def regen for full source-scoping of all ops (part of Step 2+5)
 */

import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import type { BrainEngine } from '../core/engine.ts';

// ── Validation ──────────────────────────────────────────────

// Shared with source-resolver.ts — canonical shape.
const SOURCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function validateSourceId(id: string): void {
  if (!SOURCE_ID_RE.test(id)) {
    throw new Error(
      `Invalid source id "${id}". Must be 1-32 lowercase alnum chars with optional interior hyphens (e.g. "wiki", "yc-media").`,
    );
  }
}

// ── Types ───────────────────────────────────────────────────

interface SourceRow {
  id: string;
  name: string;
  local_path: string | null;
  last_commit: string | null;
  last_sync_at: Date | null;
  config: Record<string, unknown> | string;
  created_at: Date;
}

interface SourceListEntry {
  id: string;
  name: string;
  local_path: string | null;
  federated: boolean;
  page_count: number;
  last_sync_at: string | null;
}

// ── Helpers ─────────────────────────────────────────────────

function parseConfig(config: unknown): Record<string, unknown> {
  if (typeof config === 'string') {
    try { return JSON.parse(config) as Record<string, unknown>; } catch { return {}; }
  }
  if (typeof config === 'object' && config !== null) return config as Record<string, unknown>;
  return {};
}

function isFederated(config: unknown): boolean {
  const parsed = parseConfig(config);
  return parsed.federated === true;
}

async function fetchSource(engine: BrainEngine, id: string): Promise<SourceRow | null> {
  const rows = await engine.executeRaw<SourceRow>(
    `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at
       FROM sources WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function countPages(engine: BrainEngine, sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
    [sourceId],
  );
  return rows[0]?.n ?? 0;
}

// ── Subcommand: add ─────────────────────────────────────────

async function runAdd(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: gbrain sources add <id> --path <path> [--name <display>] [--federated|--no-federated]');
    process.exit(2);
  }
  validateSourceId(id);

  let localPath: string | null = null;
  let displayName = id;
  let federated: boolean | null = null; // null = default (false for new, opt-in via --federated)

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--path') { localPath = args[++i]; continue; }
    if (a === '--name') { displayName = args[++i]; continue; }
    if (a === '--federated') { federated = true; continue; }
    if (a === '--no-federated') { federated = false; continue; }
    console.error(`Unknown flag: ${a}`);
    process.exit(2);
  }

  // Overlapping path guard: reject if new path is inside or contains an
  // existing source's local_path (per eng review §4 finding 4.1).
  // Throwing (vs process.exit) keeps this testable via the standard
  // CLI error-handling wrapper in src/cli.ts.
  if (localPath) {
    const others = await engine.executeRaw<{ id: string; local_path: string }>(
      `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL AND id != $1`,
      [id],
    );
    for (const other of others) {
      const a = localPath;
      const b = other.local_path;
      if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')) {
        throw new Error(
          `path "${a}" overlaps with existing source "${other.id}" at "${b}". ` +
          `Overlapping sources are not allowed — same files would ingest twice under different source_ids.`,
        );
      }
    }
  }

  const config = federated === null ? {} : { federated };
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id, displayName, localPath, JSON.stringify(config)],
  );

  const created = await fetchSource(engine, id);
  if (!created) {
    console.error(`Failed to create source "${id}" (conflict with existing id?)`);
    process.exit(4);
  }
  const fed = isFederated(created.config);
  console.log(`Created source "${id}"${displayName !== id ? ` (name: ${displayName})` : ''}${localPath ? ` → ${localPath}` : ''}`);
  console.log(`  federated: ${fed}${fed ? ' — appears in cross-source default search' : ' — only searched when explicitly named via --source'}`);
}

// ── Subcommand: list ────────────────────────────────────────

async function runList(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');

  const rows = await engine.executeRaw<SourceRow>(
    `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at
       FROM sources ORDER BY (id = 'default') DESC, id`,
  );

  const entries: SourceListEntry[] = [];
  for (const r of rows) {
    const pageCount = await countPages(engine, r.id);
    entries.push({
      id: r.id,
      name: r.name,
      local_path: r.local_path,
      federated: isFederated(r.config),
      page_count: pageCount,
      last_sync_at: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
    });
  }

  if (json) {
    console.log(JSON.stringify({ sources: entries }, null, 2));
    return;
  }

  // Human-readable table.
  console.log('SOURCES');
  console.log('───────');
  for (const e of entries) {
    const fedMark = e.federated ? 'federated' : 'isolated';
    const pathStr = e.local_path ?? '(no local path)';
    const sync = e.last_sync_at ? `last sync ${e.last_sync_at}` : 'never synced';
    console.log(`  ${e.id.padEnd(20)}  ${fedMark.padEnd(10)}  ${String(e.page_count).padStart(6)} pages  ${sync}`);
    if (e.local_path) console.log(`  ${' '.repeat(22)}${pathStr}`);
  }
  if (entries.length === 0) console.log('  (no sources registered)');
}

// ── Subcommand: remove ──────────────────────────────────────

async function runRemove(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: gbrain sources remove <id> [--yes] [--dry-run] [--keep-storage]');
    process.exit(2);
  }
  const yes = args.includes('--yes');
  const dryRun = args.includes('--dry-run');
  // NOTE: --keep-storage is accepted for forward compatibility but has no
  // effect until Step 7 wires in explicit storage object deletion.
  const _keepStorage = args.includes('--keep-storage');
  void _keepStorage;

  if (id === 'default') {
    console.error('Error: cannot remove the "default" source (it backs the pre-v0.17 brain).');
    process.exit(3);
  }

  const src = await fetchSource(engine, id);
  if (!src) {
    console.error(`Source "${id}" not found.`);
    process.exit(4);
  }

  const pageCount = await countPages(engine, id);
  console.log(`Source "${id}" → ${pageCount} pages will be deleted (cascade).`);

  if (dryRun) {
    console.log(`(dry-run; no side effects)`);
    return;
  }

  if (!yes) {
    console.error(`Refusing to remove without --yes. Pass --yes to confirm.`);
    process.exit(5);
  }

  await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [id]);
  console.log(`Removed source "${id}" (${pageCount} pages + dependent rows cascaded).`);
}

// ── Subcommand: rename ──────────────────────────────────────

async function runRename(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  const newName = args[1];
  if (!id || !newName) {
    console.error('Usage: gbrain sources rename <id> <new-display-name>');
    process.exit(2);
  }
  const src = await fetchSource(engine, id);
  if (!src) {
    console.error(`Source "${id}" not found.`);
    process.exit(4);
  }
  await engine.executeRaw(`UPDATE sources SET name = $1 WHERE id = $2`, [newName, id]);
  console.log(`Renamed source "${id}" display: ${src.name} → ${newName} (id is immutable).`);
}

// ── Subcommand: default ─────────────────────────────────────

async function runDefault(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: gbrain sources default <id>');
    process.exit(2);
  }
  const src = await fetchSource(engine, id);
  if (!src) {
    console.error(`Source "${id}" not found.`);
    process.exit(4);
  }
  // Stored in the config table (not sources.config, because it's a brain-
  // level preference not a per-source setting).
  await engine.setConfig('sources.default', id);
  console.log(`Default source set to "${id}".`);
}

// ── Subcommand: attach / detach (CWD dotfile) ──────────────

function runAttach(args: string[]): void {
  const id = args[0];
  if (!id) {
    console.error('Usage: gbrain sources attach <id>');
    process.exit(2);
  }
  validateSourceId(id);
  const dotfile = join(process.cwd(), '.gbrain-source');
  writeFileSync(dotfile, id + '\n', 'utf8');
  console.log(`Attached ${process.cwd()} to source "${id}" via .gbrain-source.`);
  console.log(`Commands run from this directory (or any subdirectory) will default to this source.`);
}

function runDetach(): void {
  const dotfile = join(process.cwd(), '.gbrain-source');
  if (!existsSync(dotfile)) {
    console.log(`No .gbrain-source file in ${process.cwd()}.`);
    return;
  }
  unlinkSync(dotfile);
  console.log(`Detached ${process.cwd()} (removed .gbrain-source).`);
}

// ── Subcommand: federate / unfederate ───────────────────────

async function runFederate(engine: BrainEngine, args: string[], value: boolean): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error(`Usage: gbrain sources ${value ? 'federate' : 'unfederate'} <id>`);
    process.exit(2);
  }
  const src = await fetchSource(engine, id);
  if (!src) {
    console.error(`Source "${id}" not found.`);
    process.exit(4);
  }
  const config = parseConfig(src.config);
  config.federated = value;
  await engine.executeRaw(
    `UPDATE sources SET config = $1::jsonb WHERE id = $2`,
    [JSON.stringify(config), id],
  );
  console.log(`Source "${id}" is now ${value ? 'federated (appears in cross-source default search)' : 'isolated (only searched when explicitly named)'}.`);
}

// ── Dispatcher ──────────────────────────────────────────────

export async function runSources(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'add':        return runAdd(engine, rest);
    case 'list':       return runList(engine, rest);
    case 'remove':     return runRemove(engine, rest);
    case 'rename':     return runRename(engine, rest);
    case 'default':    return runDefault(engine, rest);
    case 'attach':     runAttach(rest); return;
    case 'detach':     runDetach(); return;
    case 'federate':   return runFederate(engine, rest, true);
    case 'unfederate': return runFederate(engine, rest, false);
    case undefined:
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      console.error(`Unknown sources subcommand: ${sub}`);
      printHelp();
      process.exit(2);
  }
}

function printHelp(): void {
  console.log(`gbrain sources — manage multi-source brain configuration (v0.18.0)

Subcommands:
  add <id> --path <p> [--name <n>] [--federated|--no-federated]
                                    Register a new source.
  list [--json]                     List registered sources with page counts.
  remove <id> [--yes] [--dry-run]   Cascade-delete a source and its pages.
  rename <id> <new-name>            Rename display name (id is immutable).
  default <id>                      Set the brain-level default source.
  attach <id>                       Write .gbrain-source in CWD (like kubectl context).
  detach                            Remove .gbrain-source from CWD.
  federate <id>                     Make source appear in cross-source default search.
  unfederate <id>                   Isolate source from default search.

Source id: [a-z0-9-]{1,32}. Immutable citation key.
`);
}
