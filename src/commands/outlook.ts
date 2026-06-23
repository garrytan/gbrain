import type { BrainEngine } from '../core/engine.ts';
import {
  fetchOutlookScanInput,
  loadOutlookToken,
  outlookTokenPath,
  printScanSummary,
  runDeviceCodeLogin,
  scanOutlook,
  writeOutlookScan,
} from '../core/outlook-collector.ts';

interface OutlookArgs {
  subcmd: 'login' | 'scan' | 'help';
  clientId?: string;
  tenantId?: string;
  dryRun: boolean;
  write: boolean;
  json: boolean;
  days: number;
  limit: number;
  knownDomains: string[];
  selfDomains: string[];
  source?: string;
}

interface OutlookDeps {
  login?: typeof runDeviceCodeLogin;
  loadToken?: typeof loadOutlookToken;
  fetchInput?: typeof fetchOutlookScanInput;
  scan?: typeof scanOutlook;
  writeScan?: typeof writeOutlookScan;
  printSummary?: typeof printScanSummary;
  tokenPath?: typeof outlookTokenPath;
}

const HELP = `Usage: gbrain outlook <login|scan> [options]

Local Outlook collector for high-signal mail, calendar, and contacts.

Commands:
  outlook login          First Microsoft consent login. Stores a local token.
  outlook scan           Strict inbox/calendar/contact scan. Defaults to dry-run.

Options:
  --client-id ID         Microsoft app client id
  --tenant-id ID         Microsoft tenant id
  --days N               Mail/calendar lookback window (default: 14)
  --limit N              Max inbox messages to inspect (default: 500)
  --known-domain D       Keep this business domain. Repeatable.
  --self-domain D        Your mailbox/company domain. Repeatable.
  --write                Write high-signal pages into GBrain
  --dry-run              Print counts only (default)
  --source ID            Write under a specific GBrain source
  --json                 JSON output
  --help                 Show this help

Dry-run prints:
  kept: N
  skipped spam/newsletters: N
  people detected: N
  threads worth saving: N

Client and tenant ids can also come from GBRAIN_OUTLOOK_CLIENT_ID /
GBRAIN_OUTLOOK_TENANT_ID or ~/.gbrain/config.json outlook.client_id /
outlook.tenant_id.
`;

export async function runOutlook(engine: BrainEngine | null, args: string[], deps: OutlookDeps = {}): Promise<void> {
  const parsed = parseArgs(args);
  const login = deps.login ?? runDeviceCodeLogin;
  const loadToken = deps.loadToken ?? loadOutlookToken;
  const fetchInput = deps.fetchInput ?? fetchOutlookScanInput;
  const scan = deps.scan ?? scanOutlook;
  const writeScan = deps.writeScan ?? writeOutlookScan;
  const printSummary = deps.printSummary ?? printScanSummary;
  const tokenPath = deps.tokenPath ?? outlookTokenPath;
  if (parsed.subcmd === 'help') {
    console.log(HELP);
    return;
  }

  if (parsed.subcmd === 'login') {
    const token = await login({
      clientId: parsed.clientId,
      tenantId: parsed.tenantId,
      out: parsed.json
        ? { log: (msg: string) => process.stderr.write(`${msg}\n`) }
        : console,
    });
    if (parsed.json) {
      console.log(JSON.stringify({
        token_path: tokenPath(),
        expires_at: new Date(token.expires_at).toISOString(),
        scopes: token.scope,
      }, null, 2));
    } else {
      console.log(`Outlook login saved: ${tokenPath()}`);
      console.log(`Token expires: ${new Date(token.expires_at).toISOString()}`);
    }
    return;
  }

  const token = await loadToken({
    clientId: parsed.clientId,
    tenantId: parsed.tenantId,
  });
  const input = await fetchInput(token.access_token, {
    days: parsed.days,
    limit: parsed.limit,
  });
  const summary = scan({
    ...input,
    knownDomains: parsed.knownDomains,
    selfDomains: parsed.selfDomains.length > 0 ? parsed.selfDomains : input.selfDomains,
  });

  if (!parsed.write || parsed.dryRun) {
    printSummary(summary, parsed.json);
    return;
  }
  if (!engine) throw new Error('gbrain outlook scan --write requires a local engine');
  const result = await writeScan(engine, summary, { sourceId: parsed.source });
  if (parsed.json) {
    console.log(JSON.stringify({ ...summary, write: result }, null, 2));
    return;
  }
  printSummary(summary, false);
  console.log(`written: ${result.written}`);
  for (const slug of result.slugs) console.log(`  ${slug}`);
}

function parseArgs(args: string[]): OutlookArgs {
  const out: OutlookArgs = {
    subcmd: (args[0] as OutlookArgs['subcmd']) ?? 'help',
    dryRun: true,
    write: false,
    json: false,
    days: 14,
    limit: 500,
    knownDomains: [],
    selfDomains: [],
  };
  if (out.subcmd !== 'login' && out.subcmd !== 'scan') out.subcmd = 'help';
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === '--help' || a === '-h') out.subcmd = 'help';
    else if (a === '--json') out.json = true;
    else if (a === '--write') { out.write = true; out.dryRun = false; }
    else if (a === '--dry-run') { out.dryRun = true; out.write = false; }
    else if (a === '--client-id' && next) { out.clientId = next; i++; }
    else if (a === '--tenant-id' && next) { out.tenantId = next; i++; }
    else if (a === '--days' && next) { out.days = positiveInt(next, '--days'); i++; }
    else if (a === '--limit' && next) { out.limit = positiveInt(next, '--limit'); i++; }
    else if (a === '--known-domain' && next) { out.knownDomains.push(next); i++; }
    else if (a === '--self-domain' && next) { out.selfDomains.push(next); i++; }
    else if (a === '--source' && next) { out.source = next; i++; }
  }
  return out;
}

function positiveInt(value: string, flag: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}
