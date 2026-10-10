/**
 * gbrain pages — page-level operator commands. v0.26.5+.
 *
 * The first subcommand: `pages purge-deleted [--older-than HOURS|Nh|Nd] [--dry-run] [--json] [--yes]`.
 * Manual escape hatch alongside the autopilot purge phase. Hard-deletes pages
 * whose `deleted_at` is older than the cutoff; cascades to content_chunks,
 * page_links, chunk_relations via existing FKs.
 */
import type { BrainEngine } from '../core/engine.ts';
import { purgeConsentRequest, purgeDeletedPagesCoordinated } from '../core/persistence/purge-deleted.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { consentGate } from '../core/consent-cli.ts';
import { strictArgsRefusal } from '../cli/strict-args.ts';
import { PAGES_SUBCOMMANDS, ROUTERS, subcommandHelpRequested } from '../cli/subcommands.ts';

const SOFT_DELETE_TTL_HOURS_DEFAULT = 72;

export { PAGES_SUBCOMMANDS as SUBCOMMANDS } from '../cli/subcommands.ts';

export interface PurgeArgs { olderThanHours: number; dryRun: boolean; json: boolean }

/**
 * Strict `purge-deleted` arguments (#6114): exactly `--dry-run`, `--json`,
 * `--yes` (read by the consent gate) and one `--older-than <HOURS|Nh|Nd>` (also `--older-than=N`).
 * Anything else throws `invalid_params` before the engine is touched; cli.ts
 * refuses the same tokens earlier through the same table.
 */
export function parsePurgeArgs(args: readonly string[]): PurgeArgs {
  const refusal = strictArgsRefusal('pages', ['purge-deleted', ...args]);
  if (refusal) throw refusal;
  let olderThanHours = SOFT_DELETE_TTL_HOURS_DEFAULT;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const raw = a === '--older-than' ? args[++i]! : a.startsWith('--older-than=') ? a.slice('--older-than='.length) : null;
    if (raw === null) continue;
    const n = parseInt(raw, 10);
    olderThanHours = raw.endsWith('d') ? n * 24 : n;
  }
  return { olderThanHours, dryRun: args.includes('--dry-run'), json: args.includes('--json') };
}

async function runPurgeDeleted(engine: BrainEngine, args: string[]): Promise<void> {
  const { olderThanHours, dryRun, json } = parsePurgeArgs(args);

  if (dryRun) {
    // Same engine method, same WHERE predicate, same DB now() clock as the
    // real purge — only the verb differs (SELECT, stays read-only). The old
    // listPages enumeration capped at 10000 rows (live pages included), so
    // brains past the cap under-reported the purge set.
    const preview = await engine.purgeDeletedPages(olderThanHours, { dryRun: true });
    if (json) {
      console.log(JSON.stringify({ dry_run: true, older_than_hours: olderThanHours, count: preview.count, slugs: preview.slugs }, null, 2));
      return;
    }
    console.log(`(dry-run) Would purge ${preview.count} page(s) soft-deleted more than ${olderThanHours}h ago.`);
    for (const p of preview.pages ?? []) console.log(`  ${p.slug}  deleted_at=${p.deleted_at.toISOString()}`);
    return;
  }

  // D6: a hard purge is irreversible and brain-wide, so the CLI asks first
  // (a TTY prompt, `--yes`, or exit 3 with the consent payload). The
  // autopilot purge phase calls the library directly and is unaffected.
  const preview = await engine.purgeDeletedPages(olderThanHours, { dryRun: true });
  if (preview.count === 0) {
    if (json) console.log(JSON.stringify({ older_than_hours: olderThanHours, count: 0, slugs: [] }, null, 2));
    else console.log(`No pages to purge (older than ${olderThanHours}h).`);
    return;
  }
  const authorized = await consentGate(purgeConsentRequest(preview.count, olderThanHours, json, args), { json });
  if (!authorized) return;

  const result = await purgeDeletedPagesCoordinated(engine, olderThanHours);
  if (json) {
    console.log(JSON.stringify({ older_than_hours: olderThanHours, count: result.count, slugs: result.slugs,
      ...(result.blocked.length ? { blocked: result.blocked } : {}) }, null, 2));
    if (result.error) setCliExitVerdict(1);
    return;
  }
  for (const b of result.blocked) console.error(`Not purged: ${b.source_id}/${b.slug}: ${b.reason}`);
  if (result.error) setCliExitVerdict(1);
  if (result.count === 0) {
    console.log(`No pages to purge (older than ${olderThanHours}h).`);
  } else {
    console.log(`Purged ${result.count} page(s) (older than ${olderThanHours}h):`);
    for (const slug of result.slugs) console.log(`  ${slug}`);
  }
}

export function printUsage(): void {
  console.log(`gbrain pages — page-level operator commands (v0.26.5)

Subcommands:
  purges list [--source <id>] [--json]
                                    List page purge tombstones (slug, hash, request, time).
  unpurge <slug> [--source <id>] [--json]
                                    Clear a page's purge tombstones so its old content can be
                                    imported again. Restores nothing.
  purge-deleted [--older-than HOURS|Nh|Nd] [--dry-run] [--json] [--yes]
                                    Hard-delete soft-deleted pages older than the cutoff
                                    (default 72h) in every source of the brain (per-source
                                    purge is not supported). Cascades to chunks/links/edges.
                                    Asks first: a TTY prompt, --yes, or exit 3 with the
                                    consent payload. Preview with --dry-run --json.
                                    Mirror of the autopilot purge phase.

Notes:
  Soft-delete a page via \`gbrain delete <slug> --force\`; restore via \`gbrain restore <slug> --force\`
  (the delete_page / restore_page ops, equally reachable over MCP). Deleting also removes
  the page's markdown file from the source working tree; restoring re-creates it.
  This command is the manual operator escape hatch — the autopilot cycle's
  purge phase already calls the same library function on every run.
`);
}

export async function runPages(engine: BrainEngine, args: string[]): Promise<void> {
  if (subcommandHelpRequested(args, ROUTERS.pages)) { printUsage(); return; }
  const sub = args[0] as (typeof PAGES_SUBCOMMANDS)[number] | undefined;
  switch (sub) {
    case 'purge-deleted': return runPurgeDeleted(engine, args.slice(1));
    case 'purges': case 'unpurge': return (await import('./pages-purges.ts')).runPagePurges(engine, sub, args.slice(1));
    case undefined:
      printUsage();
      return;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printUsage();
      process.exit(2);
  }
}
