import type { BrainEngine } from '../core/engine.ts';
import {
  chooseSharePointDrive,
  getOneDrive,
  getSharePointSite,
  GraphDriveError,
  listSharePointDrives,
  registerGraphDriveSource,
  resolveGraphToken,
  syncGraphDriveSource,
  type GraphDrive,
} from '../core/microsoft-graph-drive.ts';

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseFederated(args: string[]): boolean | undefined {
  if (hasFlag(args, '--federated')) return true;
  if (hasFlag(args, '--no-federated')) return false;
  return undefined;
}

function parseLimit(args: string[]): number | undefined {
  const raw = flagValue(args, '--limit');
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new GraphDriveError('--limit must be a positive number.', 'invalid_limit');
  }
  return Math.floor(n);
}

function printDrive(drive: GraphDrive): void {
  console.log(`${drive.id}\t${drive.name ?? '(unnamed)'}\t${drive.driveType ?? '?'}\t${drive.webUrl ?? ''}`);
}

async function runAddOneDrive(engine: BrainEngine, args: string[]): Promise<void> {
  const sourceId = args[0];
  if (!sourceId) {
    console.error('Usage: gbrain microsoft-drives add-onedrive <source-id> [--drive-id <id>] [--name <display>] [--federated|--no-federated]');
    process.exit(2);
  }
  const token = resolveGraphToken();
  const drive = await getOneDrive(token, flagValue(args, '--drive-id'));
  const config = await registerGraphDriveSource(engine, {
    sourceId,
    name: flagValue(args, '--name') ?? drive.name ?? sourceId,
    provider: 'onedrive',
    drive,
    federated: parseFederated(args),
  });
  console.log(`Registered OneDrive source "${sourceId}" (${config.drive_name ?? config.drive_id}).`);
  console.log('Sync it with: gbrain microsoft-drives sync ' + sourceId);
}

async function resolveSharePointSelection(args: string[]): Promise<{
  site: Awaited<ReturnType<typeof getSharePointSite>>;
  drive: GraphDrive;
}> {
  const token = resolveGraphToken();
  const site = await getSharePointSite(token, {
    siteId: flagValue(args, '--site-id'),
    siteUrl: flagValue(args, '--site-url'),
  });
  const drives = await listSharePointDrives(token, site.id);
  const drive = chooseSharePointDrive(drives, {
    driveId: flagValue(args, '--drive-id'),
    driveName: flagValue(args, '--drive-name'),
  });
  return { site, drive };
}

async function runAddSharePoint(engine: BrainEngine, args: string[]): Promise<void> {
  const sourceId = args[0];
  if (!sourceId) {
    console.error('Usage: gbrain microsoft-drives add-sharepoint <source-id> (--site-url <url>|--site-id <id>) [--drive-id <id>|--drive-name <name>] [--name <display>] [--federated|--no-federated]');
    process.exit(2);
  }
  const { site, drive } = await resolveSharePointSelection(args);
  const config = await registerGraphDriveSource(engine, {
    sourceId,
    name: flagValue(args, '--name') ?? `${site.displayName ?? site.name ?? 'SharePoint'} / ${drive.name ?? 'Documents'}`,
    provider: 'sharepoint',
    drive,
    site,
    federated: parseFederated(args),
  });
  console.log(`Registered SharePoint source "${sourceId}" (${config.site_name ?? config.site_id} / ${config.drive_name ?? config.drive_id}).`);
  console.log('Sync it with: gbrain microsoft-drives sync ' + sourceId);
}

async function runListSharePointDrives(args: string[]): Promise<void> {
  const token = resolveGraphToken();
  const site = await getSharePointSite(token, {
    siteId: flagValue(args, '--site-id'),
    siteUrl: flagValue(args, '--site-url'),
  });
  const drives = await listSharePointDrives(token, site.id);
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify({ site, drives }, null, 2));
    return;
  }
  console.log(`Drives for ${site.displayName ?? site.name ?? site.id}`);
  for (const drive of drives) printDrive(drive);
}

async function runSync(engine: BrainEngine, args: string[]): Promise<void> {
  const sourceId = args[0];
  if (!sourceId) {
    console.error('Usage: gbrain microsoft-drives sync <source-id> [--limit N] [--no-embed|--embed] [--dry-run] [--reset-delta] [--json]');
    process.exit(2);
  }
  const noEmbed = hasFlag(args, '--no-embed') || !hasFlag(args, '--embed');
  const result = await syncGraphDriveSource(engine, {
    sourceId,
    token: resolveGraphToken(),
    noEmbed,
    dryRun: hasFlag(args, '--dry-run'),
    resetDelta: hasFlag(args, '--reset-delta'),
    limit: parseLimit(args),
  });
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `Microsoft drive sync ${result.status}: imported=${result.imported} metadata_only=${result.metadata_only} ` +
    `deleted=${result.deleted} folders=${result.skipped_folders} errors=${result.errors}`,
  );
  if (result.next_link_saved) {
    console.log('  Saved a continuation cursor; rerun the same sync command to continue.');
  } else if (result.delta_complete) {
    console.log('  Delta cursor saved.');
  }
  if (noEmbed && (result.imported > 0 || result.metadata_only > 0)) {
    console.log('  Embeddings deferred. Run: gbrain embed --stale');
  }
}

export async function runMicrosoftDrives(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  try {
    switch (sub) {
      case 'add-onedrive':
        return runAddOneDrive(engine, rest);
      case 'add-sharepoint':
        return runAddSharePoint(engine, rest);
      case 'list-sharepoint-drives':
        return runListSharePointDrives(rest);
      case 'sync':
        return runSync(engine, rest);
      case undefined:
      case '--help':
      case '-h':
        printMicrosoftDrivesHelp();
        return;
      default:
        console.error(`Unknown microsoft-drives subcommand: ${sub}`);
        printMicrosoftDrivesHelp();
        process.exit(2);
    }
  } catch (err) {
    if (err instanceof GraphDriveError) {
      console.error(`Error [${err.code}]: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

export function printMicrosoftDrivesHelp(): void {
  console.log(`gbrain microsoft-drives - OneDrive and SharePoint document-library sources

Environment:
  MICROSOFT_GRAPH_TOKEN             Microsoft Graph bearer token.
                                    MS_GRAPH_TOKEN and GRAPH_ACCESS_TOKEN also work.

Subcommands:
  add-onedrive <source-id> [--drive-id <id>] [--name <display>]
                                    Register a OneDrive source.

  add-sharepoint <source-id> (--site-url <url>|--site-id <id>)
      [--drive-id <id>|--drive-name <name>] [--name <display>]
                                    Register a SharePoint document library.

  list-sharepoint-drives (--site-url <url>|--site-id <id>) [--json]
                                    Show document libraries for a site.

  sync <source-id> [--limit N] [--no-embed|--embed] [--dry-run] [--reset-delta] [--json]
                                    Delta-sync files into the source.

Notes:
  Initial sync defaults to --no-embed so large drives do not surprise-spend.
  Run 'gbrain embed --stale' after import, or pass --embed for inline embedding.
`);
}
