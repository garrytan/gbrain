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
import {
  resolveSourceWithTier,
  SOURCE_TIER_NAMES,
} from '../core/source-resolver.ts';
import {
  loadAllSources,
  parseSourceConfig,
  isSourceFederated,
  type SourceRow as LoadedSourceRow,
} from '../core/sources-load.ts';

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

// v0.40 (D7): shared helpers — re-exported as local names for back-compat
// with existing call sites that import `parseConfig`/`isFederated` by intent.
const parseConfig = parseSourceConfig;
const isFederated = isSourceFederated;

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

  // v0.40 (D7): loadAllSources is the single source of truth for source enum.
  // Pass includeArchived=true to preserve the legacy `runList` behavior of
  // surfacing archived rows (they get the ⚠ marker below).
  const rows: LoadedSourceRow[] = await loadAllSources(engine, { includeArchived: true });

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

// ── Subcommand: set-cr-mode (v0.40.3.0 — D5) ────────────────
//
// `gbrain sources set-cr-mode <id> <none|title|per_chunk_synopsis>`
// writes sources.contextual_retrieval_mode for the per-source override
// resolver. Empty value / "unset" / "default" clears the column (NULL
// falls through to the global mode).
//
// Loud rejection on:
//   - missing id
//   - missing mode
//   - invalid mode (lists valid options)
//   - non-existent source id (lists registered sources via paste-ready hint)
//
// D5 picked the narrow verb over a generic `sources set <key> <value>`
// because per-field validation actually matters (CRMode validation must
// run; future fields may need bespoke prompts). The generic mutator is
// filed as a v0.41+ TODO when 3+ writable fields exist.

async function runSetCrMode(engine: BrainEngine, args: string[]): Promise<void> {
  const { isCRMode, CR_MODES } = await import('../core/types.ts');
  const id = args[0];
  const mode = args[1];

  if (!id || !mode) {
    console.error('Usage: gbrain sources set-cr-mode <id> <none|title|per_chunk_synopsis>');
    console.error('  Pass "unset" or "default" to clear the override (NULL falls through).');
    process.exit(2);
  }

  // Clear path: empty / "unset" / "default" → NULL.
  const clearing = mode === 'unset' || mode === 'default' || mode === '';
  if (!clearing && !isCRMode(mode)) {
    console.error(`Error: invalid CR mode "${mode}".`);
    console.error(`Valid options: ${CR_MODES.join(' | ')}`);
    console.error(`  Or pass "unset" / "default" to clear the override.`);
    process.exit(2);
  }

  // Loud-rejection on missing source. Closes the idempotent-pebble Failure
  // Modes "critical gap": pre-v0.40.3.0 there was no surface that wrote to
  // sources.contextual_retrieval_mode, so the silent-no-op via SQL UPDATE
  // matching 0 rows was the failure mode the gap warning called out.
  const exists = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (exists.length === 0) {
    console.error(`Error: source "${id}" not found.`);
    console.error(`  Run 'gbrain sources list' to see registered sources.`);
    process.exit(4);
  }

  const newValue = clearing ? null : mode;
  await engine.executeRaw(
    `UPDATE sources SET contextual_retrieval_mode = $1 WHERE id = $2`,
    [newValue, id],
  );
  if (clearing) {
    console.log(`Cleared contextual_retrieval_mode for source "${id}" (NULL falls through to global mode).`);
  } else {
    console.log(`Set source "${id}" contextual_retrieval_mode = ${mode}.`);
  }
}

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

  // v0.40 D19: auto-submit embed-backfill when coverage < 100%. Federation
  // flip is a moment when the user explicitly opted into seeing this source
  // in default search; un-embedded chunks would hide content from the very
  // moment they wanted visibility. Best-effort — submission failure does NOT
  // fail the flip.
  try {
    const { isFederatedV2Enabled } = await import('../core/feature-flags.ts');
    if (!(await isFederatedV2Enabled(engine))) return;

    const { loadAllSources } = await import('../core/sources-load.ts');
    const { computeAllSourceMetrics } = await import('../core/source-health.ts');
    const sources = await loadAllSources(engine, { includeArchived: false });
    const metrics = await computeAllSourceMetrics(engine, sources);
    const m = metrics.find((x) => x.source_id === id);
    if (!m || m.total_chunks === 0 || m.embed_coverage_pct >= 100) return;

    const { submitEmbedBackfill } = await import('../core/embed-backfill-submit.ts');
    const sub = await submitEmbedBackfill(engine, id, { reason: 'federation_flip' });
    if (sub.status === 'submitted') {
      const missing = m.total_chunks - m.embedded_chunks;
      console.log(`  → embed-backfill job ${sub.jobId} queued for missing ${missing} chunks.`);
    } else if (sub.status === 'cooldown') {
      console.log(`  → embed-backfill skipped (cooldown). Manually trigger with: gbrain jobs submit embed-backfill --params '{"sourceId":"${id}"}'`);
    } else if (sub.status === 'spend_capped') {
      console.log(`  → embed-backfill skipped (24h spend cap $${sub.spendCapUsd} reached for this source).`);
    }
  } catch (err) {
    // Federation flip already succeeded; embed-backfill is a follow-up nicety.
    console.error(`  → embed-backfill submission failed (flip succeeded): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── v0.40 sources status (D12) ──────────────────────────────
async function runStatus(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const { loadAllSources } = await import('../core/sources-load.ts');
  const { computeAllSourceMetrics } = await import('../core/source-health.ts');
  const sources = await loadAllSources(engine, { includeArchived: false });
  if (sources.length === 0) {
    if (json) {
      console.log(JSON.stringify({ schema_version: 1, sources: [] }, null, 2));
    } else {
      console.log('No sources registered. Use `gbrain sources add <id> --path <path>` first.');
    }
    return;
  }
  const metrics = await computeAllSourceMetrics(engine, sources);

  if (json) {
    console.log(JSON.stringify({ schema_version: 1, sources: metrics }, null, 2));
    return;
  }

  // Human-readable table: SOURCE | LAG | EMBED | FAILS | QUEUE | PAGES | LAST SYNC
  console.log('SOURCES — health');
  console.log('────────────────');
  console.log(
    `  ${'SOURCE'.padEnd(20)}  ${'LAG'.padEnd(8)}  ${'EMBED'.padEnd(7)}  ${'FAILS'.padEnd(6)}  ${'QUEUE'.padEnd(6)}  ${'PAGES'.padStart(8)}  LAST SYNC`,
  );
  for (const m of metrics) {
    const lag = m.lag_seconds === null
      ? 'never'
      : formatLag(m.lag_seconds);
    const embed = `${m.embed_coverage_pct.toFixed(0)}%`;
    const fails = String(m.failed_jobs_24h);
    const queue = String(m.queue_depth);
    const pages = m.total_pages.toLocaleString();
    const sync = m.last_sync_at ? new Date(m.last_sync_at).toISOString().slice(0, 19).replace('T', ' ') : 'never';
    console.log(`  ${m.source_id.padEnd(20)}  ${lag.padEnd(8)}  ${embed.padEnd(7)}  ${fails.padEnd(6)}  ${queue.padEnd(6)}  ${pages.padStart(8)}  ${sync}`);
  }
  console.log('');
  for (const m of metrics) {
    const warns: string[] = [];
    if (!m.local_path) warns.push('no local_path');
    if (m.lag_seconds === null) warns.push(`never synced — run \`gbrain sync --source ${m.source_id}\``);
    if (m.embed_coverage_pct < 95 && m.total_chunks > 100) {
      warns.push(`${(100 - m.embed_coverage_pct).toFixed(1)}% un-embedded — run \`gbrain embed --stale --source ${m.source_id}\``);
    }
    if (m.failed_jobs_24h >= 3) {
      warns.push(`${m.failed_jobs_24h} failures in 24h — check \`gbrain jobs list --status failed\``);
    }
    if (warns.length > 0) {
      console.log(`  ⚠ ${m.source_id}: ${warns.join('; ')}`);
    }
  }
}

function formatLag(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// ── v0.40 sources webhook (D8) ──────────────────────────────
async function runWebhook(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'set':    return runWebhookSet(engine, rest);
    case 'show':   return runWebhookShow(engine, rest);
    case 'rotate': return runWebhookRotate(engine, rest);
    case 'clear':  return runWebhookClear(engine, rest);
    case undefined:
    case '--help':
    case '-h':
      console.log(`Usage: gbrain sources webhook <subcommand> <source-id> [options]

Subcommands:
  set <id>    [--secret VAL] [--github-repo owner/name]   One-time reveal
  show <id>                                                Metadata only
  rotate <id>                                              New secret, reveal
  clear <id>                                               Remove webhook config`);
      return;
    default:
      console.error(`Unknown webhook subcommand: ${sub}`);
      process.exit(2);
  }
}

async function runWebhookSet(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: gbrain sources webhook set <id> [--secret VAL] [--github-repo owner/name]');
    process.exit(2);
  }
  const src = await fetchSource(engine, id);
  if (!src) {
    console.error(`Source "${id}" not found.`);
    process.exit(1);
  }
  const explicitSecret = args.find((a, i) => args[i - 1] === '--secret');
  const githubRepo = args.find((a, i) => args[i - 1] === '--github-repo');
  if (!githubRepo) {
    console.error('--github-repo owner/name is required (e.g. "Garry-s-List/zion-brain")');
    process.exit(2);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(githubRepo)) {
    console.error(`Invalid --github-repo format: "${githubRepo}". Expected "owner/name".`);
    process.exit(2);
  }

  const { randomBytes } = await import('node:crypto');
  const secret = explicitSecret ?? randomBytes(32).toString('hex');
  const cfg = parseConfig(src.config);
  cfg.webhook_secret = secret;
  cfg.github_repo = githubRepo;
  await engine.executeRaw(
    `UPDATE sources SET config = $1::jsonb WHERE id = $2`,
    [JSON.stringify(cfg), id],
  );

  console.log(`Webhook configured for source "${id}":`);
  console.log(`  github_repo:    ${githubRepo}`);
  console.log(`  webhook_secret: ${secret}`);
  console.log('');
  console.log('--- Paste this into GitHub repo settings → Webhooks → Add webhook ---');
  console.log('  Payload URL:  <your gbrain serve --http URL>/webhooks/github');
  console.log('  Content type: application/json');
  console.log(`  Secret:       ${secret}`);
  console.log('  Events:       Just the push event');
  console.log('  Active:       checked');
  console.log('');
  console.log('⚠ This secret is shown ONCE. Save it now; subsequent `gbrain sources webhook show` will NOT display it.');
}

async function runWebhookShow(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: gbrain sources webhook show <id>');
    process.exit(2);
  }
  const src = await fetchSource(engine, id);
  if (!src) {
    console.error(`Source "${id}" not found.`);
    process.exit(1);
  }
  const cfg = parseConfig(src.config);
  const githubRepo = typeof cfg.github_repo === 'string' ? cfg.github_repo : '(not set)';
  const secretSet = typeof cfg.webhook_secret === 'string' && cfg.webhook_secret.length > 0;
  const trackedBranch = typeof cfg.tracked_branch === 'string' ? cfg.tracked_branch : '(auto-detected on next sync, default main)';

  console.log(`Webhook configuration for source "${id}":`);
  console.log(`  github_repo:    ${githubRepo}`);
  console.log(`  webhook_secret: ${secretSet ? '<set — use `webhook rotate` to reveal a new one>' : '(not set)'}`);
  console.log(`  tracked_branch: ${trackedBranch}`);
}

async function runWebhookRotate(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: gbrain sources webhook rotate <id>');
    process.exit(2);
  }
  const src = await fetchSource(engine, id);
  if (!src) {
    console.error(`Source "${id}" not found.`);
    process.exit(1);
  }
  const { randomBytes } = await import('node:crypto');
  const secret = randomBytes(32).toString('hex');
  const cfg = parseConfig(src.config);
  cfg.webhook_secret = secret;
  await engine.executeRaw(
    `UPDATE sources SET config = $1::jsonb WHERE id = $2`,
    [JSON.stringify(cfg), id],
  );
  console.log(`New webhook secret for source "${id}":`);
  console.log(`  ${secret}`);
  console.log('');
  console.log('⚠ Update the GitHub webhook config to use this new secret. The old one is invalidated immediately.');
}

async function runWebhookClear(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: gbrain sources webhook clear <id>');
    process.exit(2);
  }
  const src = await fetchSource(engine, id);
  if (!src) {
    console.error(`Source "${id}" not found.`);
    process.exit(1);
  }
  const cfg = parseConfig(src.config);
  delete cfg.webhook_secret;
  delete cfg.github_repo;
  await engine.executeRaw(
    `UPDATE sources SET config = $1::jsonb WHERE id = $2`,
    [JSON.stringify(cfg), id],
  );
  console.log(`Webhook configuration cleared for source "${id}".`);
}

// ── v0.40 sources tracked-branch (D20) ──────────────────────
async function runTrackedBranch(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: gbrain sources tracked-branch <id> [--set <branch>] [--detect]');
    process.exit(2);
  }
  const src = await fetchSource(engine, id);
  if (!src) {
    console.error(`Source "${id}" not found.`);
    process.exit(1);
  }
  const setArg = args.find((a, i) => args[i - 1] === '--set');
  const detect = args.includes('--detect');
  const cfg = parseConfig(src.config);

  if (setArg) {
    cfg.tracked_branch = setArg;
    await engine.executeRaw(
      `UPDATE sources SET config = $1::jsonb WHERE id = $2`,
      [JSON.stringify(cfg), id],
    );
    console.log(`Tracked branch for source "${id}" set to "${setArg}".`);
    return;
  }
  if (detect) {
    if (!src.local_path) {
      console.error(`Source "${id}" has no local_path; cannot auto-detect branch.`);
      process.exit(1);
    }
    try {
      const { execFileSync } = await import('node:child_process');
      const branch = execFileSync('git', ['-C', src.local_path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
      cfg.tracked_branch = branch;
      await engine.executeRaw(
        `UPDATE sources SET config = $1::jsonb WHERE id = $2`,
        [JSON.stringify(cfg), id],
      );
      console.log(`Detected branch "${branch}" for source "${id}"; persisted to config.tracked_branch.`);
    } catch (e) {
      console.error(`git rev-parse failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    return;
  }

  // Read mode: just print
  const tracked = typeof cfg.tracked_branch === 'string' ? cfg.tracked_branch : '(unset — defaults to main)';
  console.log(`Source "${id}" tracked_branch: ${tracked}`);
}

// ── `sources current` (v0.37.7.0) ──────────────────────────
//
// Verify which source the CLI would target before running a
// destructive op. Walks the same 6-tier chain as `resolveSourceId()`
// and reports both the winning source id AND the tier label
// ("flag" / "env" / "dotfile" / "local_path" / "brain_default" /
// "seed_default"). Optional `--source <id>` shows what an explicit
// flag WOULD resolve to without actually running anything.

async function runCurrent(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  let explicit: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && i + 1 < args.length) {
      explicit = args[++i] || null;
    }
  }

  let result: Awaited<ReturnType<typeof resolveSourceWithTier>>;
  try {
    result = await resolveSourceWithTier(engine, explicit, process.cwd());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (json) {
      console.log(JSON.stringify({ error: msg }, null, 2));
    } else {
      console.error(`Error resolving source: ${msg}`);
    }
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify({
      source_id: result.source_id,
      tier: result.tier,
      detail: result.detail ?? null,
      resolver_chain: SOURCE_TIER_NAMES,
    }, null, 2));
    return;
  }

  console.log(`source: ${result.source_id}`);
  console.log(`  tier: ${result.tier}${result.detail ? ` (${result.detail})` : ''}`);
}

/**
 * v0.41 — `gbrain sources audit <id>` dry-run scan.
 *
 * Walks the source's `local_path` on disk, runs `assessContentSanity`
 * per `.md` file, and reports:
 *   - file count + size distribution (p50 / p99 / max)
 *   - would-hard-blocks (junk-pattern matches; new ingests would refuse)
 *   - would-soft-blocks (oversize-only; new ingests would set embed_skip)
 *   - junk-pattern hit counts grouped by pattern name
 *
 * Read-only: NO DB writes, NO file mutations. Intended for operators to
 * inspect a source repo BEFORE syncing (catches junk early) or AFTER
 * the new gate ships (audit existing inventory against the new rules
 * without touching state).
 *
 * Uses `pruneDir` from sync.ts so node_modules / .git / .obsidian are
 * skipped at descent — same walker semantics as the actual sync path.
 */
async function runAudit(engine: BrainEngine, args: string[]): Promise<void> {
  const sourceId = args.find((a) => !a.startsWith('--'));
  const json = args.includes('--json');
  const includeWarns = args.includes('--include-warns');

  if (!sourceId) {
    console.error('Usage: gbrain sources audit <source-id> [--json] [--include-warns]');
    process.exit(2);
  }

  const { fetchSource } = await import('../core/sources-load.ts');
  const src = await fetchSource(engine, sourceId);
  if (!src) {
    console.error(`Source not found: ${sourceId} (run \`gbrain sources list\` to see registered sources)`);
    process.exit(1);
  }
  if (!src.local_path) {
    console.error(`Source ${sourceId} has no local_path — cannot audit on disk`);
    process.exit(1);
  }

  // Lazy-load FS + walker bits so the command stays import-cheap when
  // not invoked (every subcommand pays the import cost on dispatch).
  const { readFileSync, readdirSync, lstatSync, existsSync: _exists } =
    await import('fs');
  const { join: pathJoin } = await import('path');
  const { pruneDir } = await import('../core/sync.ts');
  const { assessContentSanity } = await import('../core/content-sanity.ts');
  const { loadOperatorLiterals } = await import('../core/content-sanity-literals.ts');
  const { parseMarkdown } = await import('../core/markdown.ts');

  if (!_exists(src.local_path)) {
    console.error(`local_path does not exist on disk: ${src.local_path}`);
    process.exit(1);
  }

  // Walk recursively. Mirror gbrain sync's descent rules so the file set
  // we audit matches the file set that would actually be ingested.
  const files: string[] = [];
  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // permission denied; skip silently
    }
    for (const entry of entries) {
      const full = pathJoin(dir, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (pruneDir(entry, dir)) continue;
        walk(full);
      } else if (entry.endsWith('.md')) {
        files.push(full);
      }
    }
  }
  walk(src.local_path);

  const literals = loadOperatorLiterals();
  const sizes: number[] = [];
  const wouldHardBlock: Array<{ file: string; matched: string[]; bytes: number }> = [];
  const wouldSoftBlock: Array<{ file: string; bytes: number }> = [];
  const wouldWarn: Array<{ file: string; bytes: number }> = [];
  const patternHits: Record<string, number> = {};
  // v0.41.11.0 — facts-backfill estimator (E4). Walks the same files
  // already loaded for sanity scanning; counts eligible pages by
  // frontmatter.type and estimates per-page segment count from body
  // bytes. Estimated per-segment Sonnet cost is a rough heuristic
  // (~2000 in + 500 out tokens at $3/MTok in + $15/MTok out ≈ $0.013).
  const FACTS_BACKFILL_ALLOWED = ['conversation', 'meeting', 'slack', 'email'];
  const FACTS_BACKFILL_CHARS_PER_SEGMENT = 6500; // matches SEGMENT_TEXT_CHAR_LIMIT
  const FACTS_BACKFILL_USD_PER_SEGMENT = 0.013;
  let factsBackfillPages = 0;
  let factsBackfillSegments = 0;

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = parseMarkdown(content, file);
    } catch {
      continue; // malformed page; not our concern in audit
    }
    const sanity = assessContentSanity({
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline ?? '',
      title: parsed.title,
      extra_literals: literals,
    });
    sizes.push(sanity.bytes);
    if (sanity.shouldHardBlock) {
      const matched = [...sanity.junk_pattern_matches, ...sanity.literal_substring_matches];
      for (const name of matched) {
        patternHits[name] = (patternHits[name] ?? 0) + 1;
      }
      wouldHardBlock.push({ file, matched, bytes: sanity.bytes });
    } else if (sanity.shouldSkipEmbed) {
      wouldSoftBlock.push({ file, bytes: sanity.bytes });
    } else if (sanity.reasons.includes('oversize_warn')) {
      wouldWarn.push({ file, bytes: sanity.bytes });
    }
    // Facts-backfill estimator: counts pages matching allowed types.
    const fmType = (parsed.frontmatter?.type as string | undefined) ?? null;
    if (fmType && FACTS_BACKFILL_ALLOWED.includes(fmType)) {
      factsBackfillPages++;
      const totalBytes = sanity.bytes;
      const segmentsEstimate = Math.max(
        1,
        Math.ceil(totalBytes / FACTS_BACKFILL_CHARS_PER_SEGMENT),
      );
      factsBackfillSegments += segmentsEstimate;
    }
  }

  const factsBackfillEstimate = {
    pages: factsBackfillPages,
    est_segments: factsBackfillSegments,
    est_cost_usd: Number((factsBackfillSegments * FACTS_BACKFILL_USD_PER_SEGMENT).toFixed(2)),
    types: FACTS_BACKFILL_ALLOWED,
  };

  // Size distribution stats.
  sizes.sort((a, b) => a - b);
  const p = (q: number) =>
    sizes.length === 0 ? 0 : sizes[Math.min(sizes.length - 1, Math.floor(q * sizes.length))];

  if (json) {
    console.log(JSON.stringify({
      schema_version: 1,
      source_id: sourceId,
      local_path: src.local_path,
      total_files: files.length,
      distribution: { p50: p(0.5), p99: p(0.99), max: sizes[sizes.length - 1] ?? 0 },
      hard_block_count: wouldHardBlock.length,
      soft_block_count: wouldSoftBlock.length,
      warn_count: wouldWarn.length,
      pattern_hits: patternHits,
      facts_backfill_estimate: factsBackfillEstimate,
      hard_blocks: wouldHardBlock.slice(0, 20),
      soft_blocks: wouldSoftBlock.slice(0, 20),
      ...(includeWarns ? { warns: wouldWarn.slice(0, 20) } : {}),
    }, null, 2));
    return;
  }

  console.log(`Source: ${sourceId} (${src.local_path})`);
  console.log(`Files scanned: ${files.length} markdown files`);
  if (sizes.length > 0) {
    console.log(`Size distribution: p50=${p(0.5)} bytes, p99=${p(0.99)} bytes, max=${sizes[sizes.length - 1]} bytes`);
  }
  console.log(`Would-hard-block: ${wouldHardBlock.length}`);
  console.log(`Would-soft-block: ${wouldSoftBlock.length}`);
  if (includeWarns) {
    console.log(`Would-warn: ${wouldWarn.length}`);
  }
  if (Object.keys(patternHits).length > 0) {
    const sorted = Object.entries(patternHits).sort((a, b) => b[1] - a[1]);
    console.log(`Junk-pattern hits: ${sorted.map(([n, c]) => `${n} ×${c}`).join(', ')}`);
  }
  if (factsBackfillEstimate.pages > 0) {
    console.log(
      `Facts backfill estimate: ${factsBackfillEstimate.pages} eligible page(s), ` +
      `~${factsBackfillEstimate.est_segments} segments, ~$${factsBackfillEstimate.est_cost_usd}. ` +
      `Run: gbrain extract-conversation-facts --source-id ${sourceId} --max-cost-usd ${Math.max(factsBackfillEstimate.est_cost_usd, 1)}`,
    );
  }
  if (wouldHardBlock.length > 0) {
    console.log('\nTop hard-blocks:');
    for (const h of wouldHardBlock.slice(0, 10)) {
      console.log(`  ${h.file} [${h.matched.join(', ')}] (${h.bytes}b)`);
    }
  }
  if (wouldSoftBlock.length > 0) {
    console.log('\nTop soft-blocks (would write but skip embedding):');
    for (const s of wouldSoftBlock.slice(0, 10)) {
      console.log(`  ${s.file} (${s.bytes}b)`);
    }
  }
}

// ── Dispatcher ──────────────────────────────────────────────

// v0.40.6.0: my duplicate `runStatus` (line ~895 pre-resolution) was
// removed during the v0.40.5 merge. Master's source-health.ts-backed
// runStatus at line ~582 is a strict superset (adds lag / embed coverage
// / failed-job count / queue depth columns). The `buildSyncStatusReport`
// + `printSyncStatusReport` exports from src/commands/sync.ts remain
// available as a library API for callers who want the v0.40.6.0-specific
// shape (used by test/e2e/sync-status-pglite.test.ts as the IRON RULE
// regression).

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
    case 'current':    return runCurrent(engine, rest);
    // v0.40.5.0 Federated Sync v2 (master) + v0.40.6.0 status dashboard
    // The status function lives at the line-582 declaration (master's
    // source-health.ts-backed version). My duplicate runStatus (line ~895
    // in the post-merge file, the buildSyncStatusReport-backed one) is
    // removed below since master's federation_health metrics dashboard is
    // a superset.
    case 'status':     return runStatus(engine, rest);
    case 'webhook':    return runWebhook(engine, rest);
    case 'tracked-branch': return runTrackedBranch(engine, rest);
    // v0.40.3.0 contextual retrieval (from master)
    case 'set-cr-mode': return runSetCrMode(engine, rest);
    case 'audit':      return runAudit(engine, rest);
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
  status [--json]                   v0.40.3.0 — read-only per-source dashboard:
                                    last sync, staleness, page count,
                                    embedding coverage, unacked failures.
                                    --json emits {schema_version:1, ...} on
                                    stdout for monitoring pipelines.
  archived [--json]                 List soft-deleted sources and their expiry.
  purge [<id>] [--confirm-destructive]
                                    Permanently delete archived sources.
                                    Without <id>: purge all expired archives.
                                    With <id>: force-purge (requires --confirm-destructive).
  rename <id> <new-name>            Rename display name (id is immutable).
  default <id>                      Set the brain-level default source.
  attach <id>                       Write .gbrain-source in CWD (like kubectl context).
  detach                            Remove .gbrain-source from CWD.
  current [--source <id>] [--json]  Echo the resolved source id + which tier
                                    won (flag/env/dotfile/local_path/
                                    brain_default/seed_default). Run this
                                    before destructive ops to verify you're
                                    targeting the brain you think you are.
  federate <id>                     Make source appear in cross-source default search.
  unfederate <id>                   Isolate source from default search.
  set-cr-mode <id> <none|title|per_chunk_synopsis>
                                    Per-source contextual retrieval mode
                                    override (v0.40.3.0). Pass "unset" or
                                    "default" to clear (NULL falls through
                                    to the global search.mode bundle).

Source id: [a-z0-9-]{1,32}. Immutable citation key.

Destructive operations (remove, purge) show an impact preview before acting.
Pass --dry-run to preview without side effects.
Use 'archive' instead of 'remove' for a safe ${SOFT_DELETE_TTL_HOURS}h grace period.
`);
}
