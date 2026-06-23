import type { BrainEngine } from '../core/engine.ts';
import {
  createGoogleDriveClient,
  extractDriveId,
  printDriveSummary,
  resolveGoogleDriveAccessToken,
  scanDriveFolder,
  writeDriveScan,
  type DriveListClient,
} from '../core/google-drive-collector.ts';

interface DriveArgs {
  subcmd: 'ingest' | 'help';
  folder?: string;
  dryRun: boolean;
  write: boolean;
  json: boolean;
  source?: string;
  maxDepth: number;
  maxFiles: number;
}

interface DriveDeps {
  client?: DriveListClient;
  scan?: typeof scanDriveFolder;
  writeScan?: typeof writeDriveScan;
  printSummary?: typeof printDriveSummary;
  token?: string;
}

const HELP = `Usage: gbrain drive ingest --folder <url-or-id> [options]

Narrow Google Drive collector for shared Seascape-style folders. Defaults to
dry-run and prints a keep/skip summary before any write.

Options:
  --folder ID|URL        Shared Drive folder id or URL
  --write                Write kept pages into GBrain after printing summary
  --dry-run              Print summary only (default)
  --source ID            Write under a specific GBrain source
  --max-depth N          Folder recursion depth (default: 4)
  --max-files N          Maximum Drive items to scan (default: 500)
  --json                 JSON output
  --help                 Show this help

Auth:
  Set GBRAIN_GOOGLE_DRIVE_ACCESS_TOKEN with a Drive read token.

Filter:
  Keeps document-like owner, agreement, meeting, receipt, readback, and
  property-operations material. Skips photos, images, zips, shortcuts, and
  generic files without high-signal title/path terms.
`;

export async function runDrive(engine: BrainEngine | null, args: string[], deps: DriveDeps = {}): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.subcmd === 'help') {
    console.log(HELP);
    return;
  }
  if (!parsed.folder) throw new Error('gbrain drive ingest requires --folder <url-or-id>');

  const folderId = extractDriveId(parsed.folder);
  const token = deps.token ?? (deps.client ? 'test-token' : resolveGoogleDriveAccessToken());
  const client = deps.client ?? createGoogleDriveClient({ accessToken: token });
  const scan = deps.scan ?? scanDriveFolder;
  const writeScan = deps.writeScan ?? writeDriveScan;
  const printSummary = deps.printSummary ?? printDriveSummary;

  const summary = await scan(client, folderId, {
    maxDepth: parsed.maxDepth,
    maxFiles: parsed.maxFiles,
  });

  printSummary(summary, parsed.json && !parsed.write);
  if (!parsed.write || parsed.dryRun) return;
  if (!engine) throw new Error('gbrain drive ingest --write requires a local engine');

  const result = await writeScan(engine, client, summary, { sourceId: parsed.source });
  if (parsed.json) {
    console.log(JSON.stringify({ dry_run_summary: summary, write: result }, null, 2));
    return;
  }
  console.log(`written: ${result.written}`);
  for (const slug of result.slugs) console.log(`  ${slug}`);
}

function parseArgs(args: string[]): DriveArgs {
  const out: DriveArgs = {
    subcmd: (args[0] as DriveArgs['subcmd']) ?? 'help',
    dryRun: true,
    write: false,
    json: false,
    maxDepth: 4,
    maxFiles: 500,
  };
  if (out.subcmd !== 'ingest') out.subcmd = 'help';
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === '--help' || a === '-h') out.subcmd = 'help';
    else if (a === '--json') out.json = true;
    else if (a === '--write') { out.write = true; out.dryRun = false; }
    else if (a === '--dry-run') { out.dryRun = true; out.write = false; }
    else if (a === '--folder' && next) { out.folder = next; i++; }
    else if (a === '--source' && next) { out.source = next; i++; }
    else if (a === '--max-depth' && next) { out.maxDepth = positiveInt(next, '--max-depth'); i++; }
    else if (a === '--max-files' && next) { out.maxFiles = positiveInt(next, '--max-files'); i++; }
  }
  return out;
}

function positiveInt(value: string, flag: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}

export const __testing = {
  parseArgs,
};
