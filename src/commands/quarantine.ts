import type { BrainEngine } from '../core/engine.ts';
import { QUARANTINE_KEY } from '../core/quarantine.ts';

interface QuarantineRow {
  slug: string;
  source_id: string;
  title: string;
  reason: string | null;
  detail: string | null;
  assessed_at: string | null;
}

function printHelp(): void {
  console.log(`Usage:
  pmbrain quarantine list [--source <id>] [--json]

Lists pages retained in the knowledge base but excluded from retrieval.
To restore a page, fix the source content and import it again.`);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runQuarantine(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printHelp();
    return;
  }

  const command = args[0];
  if (command !== 'list') {
    throw new Error(`Unknown quarantine subcommand: ${command}`);
  }

  const sourceId = flagValue(args, '--source');
  const params: unknown[] = [];
  const sourceClause = sourceId ? 'AND source_id = $1' : '';
  if (sourceId) params.push(sourceId);

  const rows = await engine.executeRaw<QuarantineRow>(
    `SELECT slug, source_id, title,
            frontmatter -> '${QUARANTINE_KEY}' ->> 'reason' AS reason,
            frontmatter -> '${QUARANTINE_KEY}' ->> 'detail' AS detail,
            frontmatter -> '${QUARANTINE_KEY}' ->> 'assessed_at' AS assessed_at
       FROM pages
      WHERE deleted_at IS NULL
        AND frontmatter ? '${QUARANTINE_KEY}'
        ${sourceClause}
      ORDER BY updated_at DESC, source_id, slug`,
    params,
  );

  if (args.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('No quarantined pages.');
    return;
  }

  for (const row of rows) {
    console.log(`${row.source_id}  ${row.slug}  ${row.reason ?? 'unknown'}  ${row.detail ?? ''}`);
  }
  console.log(`\n${rows.length} quarantined page(s).`);
}
