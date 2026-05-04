/**
 * gbrain pages — page-level operator commands. v0.26.5+.
 *
 * The first subcommand: `pages purge-deleted [--older-than HOURS] [--dry-run]`.
 * Manual escape hatch alongside the autopilot purge phase. Hard-deletes pages
 * whose `deleted_at` is older than the cutoff; cascades to content_chunks,
 * page_links, chunk_relations via existing FKs.
 */
import type { BrainEngine } from '../core/engine.ts';

const SOFT_DELETE_TTL_HOURS_DEFAULT = 72;

function parseOlderThanHours(args: string[]): number {
  const idx = args.indexOf('--older-than');
  if (idx === -1 || idx === args.length - 1) return SOFT_DELETE_TTL_HOURS_DEFAULT;
  const raw = args[idx + 1];
  // Accept bare numbers (hours) or `<N>h` / `<N>d`. Reject anything ambiguous.
  const trimmed = raw.trim();
  const dayMatch = trimmed.match(/^(\d+)d$/);
  if (dayMatch) return Math.max(0, parseInt(dayMatch[1], 10) * 24);
  const hourMatch = trimmed.match(/^(\d+)h?$/);
  if (hourMatch) return Math.max(0, parseInt(hourMatch[1], 10));
  console.error(`Invalid --older-than value: "${raw}". Expected hours (e.g. 72 or 72h) or days (e.g. 3d).`);
  process.exit(2);
}

async function runPurgeDeleted(engine: BrainEngine, args: string[]): Promise<void> {
  const olderThanHours = parseOlderThanHours(args);
  const dryRun = args.includes('--dry-run');
  const json = args.includes('--json');

  if (dryRun) {
    // Use listPages with includeDeleted to enumerate the recoverable set, then
    // count how many would be purged given the cutoff. Stays read-only.
    const candidates = await engine.listPages({ includeDeleted: true, limit: 10000 });
    const cutoff = Date.now() - olderThanHours * 60 * 60 * 1000;
    const wouldPurge = candidates.filter(
      (p) => p.deleted_at && p.deleted_at instanceof Date && p.deleted_at.getTime() < cutoff,
    );
    if (json) {
      console.log(JSON.stringify({ dry_run: true, older_than_hours: olderThanHours, count: wouldPurge.length, slugs: wouldPurge.map((p) => p.slug) }, null, 2));
      return;
    }
    console.log(`(dry-run) Would purge ${wouldPurge.length} page(s) soft-deleted more than ${olderThanHours}h ago.`);
    for (const p of wouldPurge) console.log(`  ${p.slug}  deleted_at=${p.deleted_at?.toISOString()}`);
    return;
  }

  const result = await engine.purgeDeletedPages(olderThanHours);
  if (json) {
    console.log(JSON.stringify({ older_than_hours: olderThanHours, count: result.count, slugs: result.slugs }, null, 2));
    return;
  }
  if (result.count === 0) {
    console.log(`No pages to purge (older than ${olderThanHours}h).`);
  } else {
    console.log(`Purged ${result.count} page(s) (older than ${olderThanHours}h):`);
    for (const slug of result.slugs) console.log(`  ${slug}`);
  }
}

function printHelp(): void {
  console.log(`gbrain pages — page-level operator commands (v0.26.5)

Subcommands:
  purge-deleted [--older-than HOURS|Nd] [--dry-run] [--json]
                                    Hard-delete soft-deleted pages older than the cutoff
                                    (default 72h). Cascades to chunks/links/edges.
                                    Mirror of the autopilot purge phase.

Notes:
  Soft-delete a page via the MCP \`delete_page\` op. Restore via \`restore_page\`.
  This command is the manual operator escape hatch — the autopilot cycle's
  purge phase already calls the same library function on every run.
`);
}

export async function runPages(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'purge-deleted': return runPurgeDeleted(engine, rest);
    case undefined:
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printHelp();
      process.exit(2);
  }
}
