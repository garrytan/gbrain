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
import {
  assessDestructiveImpact,
  checkDestructiveConfirmation,
  softDeleteSource,
  restoreSource,
  listArchivedSources,
  purgeExpiredSources,
  formatImpact,
  formatSoftDelete,
  SOFT_DELETE_TTL_HOURS,
} from '../core/destructive-guard.ts';
import {
  addSource as opsAddSource,
  recloneIfMissing,
  SourceOpError,
  type SourceRow as OpsSourceRow,
} from '../core/sources-ops.ts';

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
    console.error(
      'Usage: gbrain sources add <id> [--path <path> | --url <https-url>] ' +
        '[--name <display>] [--federated|--no-federated] [--clone-dir <path>]',
    );
    process.exit(2);
  }

  let localPath: string | null = null;
  let remoteUrl: string | undefined;
  let displayName: string | undefined;
  let federated: boolean | null = null;
  let cloneDir: string | undefined;

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--path') { localPath = args[++i]; continue; }
    if (a === '--url') { remoteUrl = args[++i]; continue; }
    if (a === '--name') { displayName = args[++i]; continue; }
    if (a === '--federated') { federated = true; continue; }
    if (a === '--no-federated') { federated = false; continue; }
    if (a === '--clone-dir') { cloneDir = args[++i]; continue; }
    console.error(`Unknown flag: ${a}`);
    process.exit(2);
  }

  if (remoteUrl && localPath) {
    console.error('Error: --url and --path are mutually exclusive (--url manages its own clone path).');
    process.exit(2);
  }

  // Throw on SourceOpError; cli.ts wraps every command in a try/catch that
  // turns Error into the right exit code. Tests assert throw shape, so we
  // intentionally propagate rather than process.exit here.
  const created: OpsSourceRow = await opsAddSource(engine, {
    id,
    name: displayName,
    localPath,
    remoteUrl,
    federated,
    cloneDir,
  });

  const fed = isFederated(created.config);
  const finalRemoteUrl = (created.config as Record<string, unknown>).remote_url as string | undefined;
  const tail = finalRemoteUrl
    ? ` ← cloned from ${finalRemoteUrl}`
    : created.local_path
      ? ` → ${created.local_path}`
      : '';
  console.log(
    `Created source "${id}"${displayName && displayName !== id ? ` (name: ${displayName})` : ''}${tail}`,
  );
  if (finalRemoteUrl) {
    console.log(`  clone path: ${created.local_path}`);
  }
  console.log(
    `  federated: ${fed}${fed ? ' — appears in cross-source default search' : ' — only searched when explicitly named via --source'}`,
  );
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
    const fedMark = e.federated ? 'federated' : (e as any).archived ? '⚠ archived' : 'isolated';
    const pathStr = e.local_path ?? '(no local path)';
    const sync = e.last_sync_at ? `last sync ${e.last_sync_at}` : 'never synced';
    console.log(`  ${e.id.padEnd(20)}  ${fedMark.padEnd(12)}  ${String(e.page_count).padStart(6)} pages  ${sync}`);
    if (e.local_path) console.log(`  ${' '.repeat(22)}${pathStr}`);
  }
  if (entries.length === 0) console.log('  (no sources registered)');
}

// ── Subcommand: remove ──────────────────────────────────────

async function runRemove(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: gbrain sources remove <id> [--yes] [--confirm-destructive] [--dry-run] [--keep-storage]');
    process.exit(2);
  }
  const yes = args.includes('--yes');
  const dryRun = args.includes('--dry-run');
  const confirmDestructive = args.includes('--confirm-destructive');
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

  // v0.26.5: Impact preview + destructive guard
  const impact = await assessDestructiveImpact(engine, id);
  if (impact) {
    console.log(formatImpact(impact));

    if (dryRun) {
      console.log('(dry-run; no side effects)');
      return;
    }

    const blockMsg = checkDestructiveConfirmation(impact, { yes, confirmDestructive, dryRun });
    if (blockMsg) {
      console.error(blockMsg);
      process.exit(5);
    }
  } else {
    if (dryRun) { console.log('(dry-run; source not found)'); return; }
    if (!yes && !confirmDestructive) {
      console.error('Refusing to remove without --yes or --confirm-destructive.');
      process.exit(5);
    }
  }

  await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [id]);
  const pageCount = impact?.pageCount ?? 0;
  console.log(`Removed source "${id}" (${pageCount} pages + dependent rows cascaded).`);
}

// ── Subcommand: archive (soft-delete) ───────────────────────

async function runArchive(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: gbrain sources archive <id>');
    process.exit(2);
  }

  if (id === 'default') {
    console.error('Error: cannot archive the "default" source.');
    process.exit(3);
  }

  // Show impact preview
  const impact = await assessDestructiveImpact(engine, id);
  if (!impact) {
    console.error(`Source "${id}" not found.`);
    process.exit(4);
  }

  const result = await softDeleteSource(engine, id);
  if (!result) {
    console.error(`Failed to archive source "${id}".`);
    process.exit(4);
  }

  console.log(formatSoftDelete(result));
}

// ── Subcommand: restore ─────────────────────────────────────

async function runRestore(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  const noFederate = args.includes('--no-federate');
  if (!id) {
    console.error('Usage: gbrain sources restore <id> [--no-federate]');
    process.exit(2);
  }

  const restored = await restoreSource(engine, id, !noFederate);
  if (!restored) {
    console.error(`Source "${id}" not found or not archived.`);
    process.exit(4);
  }

  console.log(`Source "${id}" restored. ${noFederate ? 'Not re-federated.' : 'Re-federated.'}`);
  console.log(`All pages, chunks, and embeddings are intact.`);

  // T4 (eng-review): if the source has a remote_url AND its clone dir was
  // autopurged (e.g. operator rm -rf'd $GBRAIN_HOME/clones/), re-clone
  // before declaring restore success. Without this, restore returns green
  // but the source is unsyncable until a later sync path discovers the gap.
  try {
    const recloned = await recloneIfMissing(engine, id);
    if (recloned) {
      console.log(`  re-cloned from remote_url (clone dir was missing).`);
    }
  } catch (e) {
    if (e instanceof SourceOpError) {
      console.error(`  WARN: could not re-clone: ${e.message}`);
      console.error(`  The DB row is restored but the on-disk clone is missing.`);
      console.error(`  Try \`gbrain sync --source ${id}\` to recover, or remove + re-add.`);
    } else {
      throw e;
    }
  }
}

// ── Subcommand: purge ───────────────────────────────────────

async function runPurge(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  const confirmDestructive = args.includes('--confirm-destructive');

  if (id) {
    // Purge a specific source (must be archived)
    const impact = await assessDestructiveImpact(engine, id);
    if (!impact) {
      console.error(`Source "${id}" not found.`);
      process.exit(4);
    }

    console.log(formatImpact(impact));

    if (!confirmDestructive) {
      console.error(`Pass --confirm-destructive to permanently delete source "${id}".`);
      process.exit(5);
    }

    await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [id]);
    console.log(`Permanently deleted source "${id}" (${impact.pageCount} pages cascaded).`);
    return;
  }

  // No id: purge all expired archives
  const purged = await purgeExpiredSources(engine);
  if (purged.length === 0) {
    console.log('No expired archives to purge.');
  } else {
    console.log(`Purged ${purged.length} expired archive(s): ${purged.join(', ')}`);
  }
}

// ── Subcommand: archived ────────────────────────────────────

async function runListArchived(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const archived = await listArchivedSources(engine);

  if (json) {
    console.log(JSON.stringify({ archived }, null, 2));
    return;
  }

  if (archived.length === 0) {
    console.log('No archived sources.');
    return;
  }

  console.log('ARCHIVED SOURCES (soft-deleted)');
  console.log('───────────────────────────────');
  for (const a of archived) {
    const hours = Math.max(0, Math.round((a.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60)));
    console.log(`  ${a.id.padEnd(20)}  ${String(a.pageCount).padStart(6)} pages  expires in ${hours}h  (restore: gbrain sources restore ${a.id})`);
  }
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
    case 'archive':    return runArchive(engine, rest);
    case 'restore':    return runRestore(engine, rest);
    case 'purge':      return runPurge(engine, rest);
    case 'archived':   return runListArchived(engine, rest);
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
  console.log(`gbrain sources — manage multi-source brain configuration (v0.26.5)

Subcommands:
  add <id> --path <p> [--name <n>] [--federated|--no-federated]
                                    Register a new source.
  list [--json]                     List registered sources with page counts.
  remove <id> [--confirm-destructive] [--dry-run]
                                    Permanently delete a source and all its data.
                                    Shows impact preview. Requires --confirm-destructive
                                    when the source has data (pages/chunks/embeddings).
  archive <id>                      Soft-delete: hide from search, preserve data for ${SOFT_DELETE_TTL_HOURS}h.
  restore <id> [--no-federate]      Un-archive a soft-deleted source.
  archived [--json]                 List soft-deleted sources and their expiry.
  purge [<id>] [--confirm-destructive]
                                    Permanently delete archived sources.
                                    Without <id>: purge all expired archives.
                                    With <id>: force-purge (requires --confirm-destructive).
  rename <id> <new-name>            Rename display name (id is immutable).
  default <id>                      Set the brain-level default source.
  attach <id>                       Write .gbrain-source in CWD (like kubectl context).
  detach                            Remove .gbrain-source from CWD.
  federate <id>                     Make source appear in cross-source default search.
  unfederate <id>                   Isolate source from default search.

Source id: [a-z0-9-]{1,32}. Immutable citation key.

Destructive operations (remove, purge) show an impact preview before acting.
Pass --dry-run to preview without side effects.
Use 'archive' instead of 'remove' for a safe ${SOFT_DELETE_TTL_HOURS}h grace period.
`);
}
