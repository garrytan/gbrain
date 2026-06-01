import type { BrainEngine } from '../core/engine.ts';
import { importFromContent } from '../core/import-file.ts';
import { resolveSourceWithTier } from '../core/source-resolver.ts';
import { validateIngestionEvent, type IngestionEvent, type IngestionSourceContext } from '../core/ingestion/types.ts';
import { IphoneBackupSource, type IphoneBackupStats } from '../core/ingestion/sources/iphone-backup.ts';

export interface ImportIphoneFlags {
  backupDir: string | null;
  sourceId?: string;
  selfName: string;
  dryRun: boolean;
  json: boolean;
  limit?: number;
  maxMessages?: number;
  help: boolean;
}

export interface ImportIphoneResult {
  schema_version: 1;
  source_id: string;
  source_tier: string;
  dry_run: boolean;
  events_emitted: number;
  pages_imported: number;
  pages_skipped: number;
  errors: Array<{ slug: string; error: string }>;
  source_stats: IphoneBackupStats;
  follow_up_commands: string[];
}

const HELP = `Usage: gbrain import-iphone --backup <decrypted-backup-dir> [options]

Local-only iPhone backup importer. Reads an already-decrypted iPhone backup
(Manifest.db + sms.db + AddressBook.sqlitedb), renders conversation/person
markdown pages, and imports them without embeddings.

Options:
  --backup <dir>       Decrypted iPhone backup directory (required)
  --source-id <id>     Brain source_id to import into (defaults through source resolver)
  --self-name <name>   Speaker label for your own messages (default: Me)
  --limit <N>          Import at most N rendered pages
  --max-messages <N>   Read at most N SMS rows (default: 250000)
  --dry-run            Parse and render, but do not import pages
  --json               Emit stable JSON receipt
  -h, --help           Show this help

Email is out of scope: server-side email stores are not present in iPhone backups.

Follow-up after a successful import:
  gbrain extract-conversation-facts --source-id <id>
  gbrain embed --stale
  gbrain query "what did alice-example say about acme-example?"
`;

export function parseImportIphoneFlags(args: string[]): ImportIphoneFlags {
  const flags: ImportIphoneFlags = {
    backupDir: null,
    selfName: 'Me',
    dryRun: false,
    json: false,
    help: args.includes('--help') || args.includes('-h'),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--backup':
        flags.backupDir = requireValue(args, ++i, '--backup');
        break;
      case '--source-id':
        flags.sourceId = requireValue(args, ++i, '--source-id');
        break;
      case '--self-name':
        flags.selfName = requireValue(args, ++i, '--self-name');
        break;
      case '--limit': {
        const raw = requireValue(args, ++i, '--limit');
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error(`--limit must be a positive integer; got ${raw}`);
        }
        flags.limit = parsed;
        break;
      }
      case '--max-messages': {
        const raw = requireValue(args, ++i, '--max-messages');
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error(`--max-messages must be a positive integer; got ${raw}`);
        }
        flags.maxMessages = parsed;
        break;
      }
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--help':
      case '-h':
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown import-iphone flag: ${arg}`);
        throw new Error(`Unexpected import-iphone argument: ${arg}`);
    }
  }

  return flags;
}

export async function runImportIphone(
  engine: BrainEngine | null,
  args: string[],
): Promise<ImportIphoneResult | null> {
  let flags: ImportIphoneFlags;
  try {
    flags = parseImportIphoneFlags(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('Run `gbrain import-iphone --help` for usage.');
    process.exit(2);
  }

  if (flags.help) {
    console.log(HELP);
    return null;
  }
  if (!engine) {
    throw new Error('gbrain import-iphone requires a configured local brain');
  }
  if (!flags.backupDir) {
    console.error('Missing required --backup <decrypted-backup-dir>.');
    console.error('Run `gbrain import-iphone --help` for usage.');
    process.exit(2);
  }

  const resolved = await resolveSourceWithTier(engine, flags.sourceId ?? null);
  if (!flags.sourceId && resolved.tier === 'seed_default') {
    console.error('Refusing to import iPhone data into implicit seed source "default".');
    console.error('Pass --source-id <id> so this sensitive local import goes to the intended brain source.');
    process.exit(2);
  }
  const result = await runImportIphoneCore(engine, {
    backupDir: flags.backupDir,
    sourceId: resolved.source_id,
    sourceTier: resolved.tier,
    selfName: flags.selfName,
    dryRun: flags.dryRun,
    limit: flags.limit,
    maxMessages: flags.maxMessages,
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReceipt(result);
  }
  if (result.errors.length > 0) process.exitCode = 1;
  return result;
}

export async function runImportIphoneCore(
  engine: BrainEngine,
  opts: {
    backupDir: string;
    sourceId: string;
    sourceTier?: string;
    selfName?: string;
    dryRun?: boolean;
    limit?: number;
    maxMessages?: number;
  },
): Promise<ImportIphoneResult> {
  const events: IngestionEvent[] = [];
  const source = new IphoneBackupSource({
    backupDir: opts.backupDir,
    selfName: opts.selfName,
    dryRun: opts.dryRun,
    limit: opts.limit,
    maxMessages: opts.maxMessages,
  });

  const ctx: IngestionSourceContext = {
    emit(event) {
      const err = validateIngestionEvent(event);
      if (err) {
        events.push({
          ...event,
          metadata: {
            ...(event.metadata ?? {}),
            _validation_error: `${err.field}: ${err.reason}`,
          },
        });
        return;
      }
      events.push(event);
    },
    engine,
    logger: {
      info: (msg: string) => process.stderr.write(msg + '\n'),
      warn: (msg: string) => process.stderr.write(msg + '\n'),
      error: (msg: string) => process.stderr.write(msg + '\n'),
    },
    abortSignal: new AbortController().signal,
    config: {},
  };

  await source.start(ctx);
  await source.stop();

  let pagesImported = 0;
  let pagesSkipped = 0;
  const errors: Array<{ slug: string; error: string }> = [];
  if (source.stats.missingStores > 0) {
    errors.push({
      slug: '(source)',
      error: `${source.stats.missingStores} expected iPhone backup store(s) were missing; see iphone-backup failure audit`,
    });
  }
  if (source.stats.failures > 0) {
    errors.push({
      slug: '(source)',
      error: `${source.stats.failures} iPhone backup store(s) failed to parse; see iphone-backup failure audit`,
    });
  }
  if (source.stats.messagesCapped > 0) {
    errors.push({
      slug: '(source)',
      error: `${source.stats.messagesCapped} SMS read cap(s) were hit; rerun with --max-messages to widen intentionally`,
    });
  }

  if (!opts.dryRun) {
    for (const event of events) {
      const slug = typeof event.metadata?.slug === 'string' ? event.metadata.slug : '';
      const validationError = event.metadata?._validation_error;
      if (!slug) {
        errors.push({ slug: '(missing)', error: 'IngestionEvent metadata.slug is required' });
        continue;
      }
      if (typeof validationError === 'string') {
        errors.push({ slug, error: validationError });
        continue;
      }
      try {
        const existing = await engine.getPage(slug, { sourceId: opts.sourceId });
        const ownedByIphone = existing?.source_kind === 'iphone-backup';
        if (existing && !ownedByIphone) {
          pagesSkipped++;
          errors.push({
            slug,
            error: 'Refusing to overwrite existing non-iPhone page. Merge fields manually or remove/rename the existing page.',
          });
          continue;
        }
        const imported = await importFromContent(engine, slug, event.content, {
          noEmbed: true,
          sourceId: opts.sourceId,
          source_kind: event.source_kind,
          source_uri: event.source_uri,
          ingested_via: 'iphone-backup',
        });
        if (imported.status === 'imported') pagesImported++;
        else pagesSkipped++;
        if (imported.error) errors.push({ slug, error: imported.error });
      } catch (err) {
        errors.push({ slug, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return {
    schema_version: 1,
    source_id: opts.sourceId,
    source_tier: opts.sourceTier ?? 'unknown',
    dry_run: opts.dryRun === true,
    events_emitted: events.length,
    pages_imported: pagesImported,
    pages_skipped: pagesSkipped,
    errors,
    source_stats: source.stats,
    follow_up_commands: [
      `gbrain extract-conversation-facts --source-id ${opts.sourceId}`,
      'gbrain embed --stale',
      'gbrain query "what did alice-example say about acme-example?"',
    ],
  };
}

function printReceipt(result: ImportIphoneResult): void {
  const action = result.dry_run ? 'Would import' : 'Imported';
  console.log(`${action} iPhone backup pages into source '${result.source_id}' (${result.source_tier}).`);
  if (result.dry_run) {
    console.log(`Pages: ${result.source_stats.emitted} would import, ${result.errors.length} error(s).`);
  } else {
    console.log(`Pages: ${result.pages_imported} imported, ${result.pages_skipped} skipped, ${result.errors.length} error(s).`);
  }
  console.log(`Rendered: ${result.source_stats.people} person page(s), ${result.source_stats.conversations} conversation page(s).`);
  console.log('');
  console.log('Next steps:');
  for (const cmd of result.follow_up_commands) console.log(`  ${cmd}`);
}

function requireValue(args: string[], idx: number, flag: string): string {
  const value = args[idx];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
