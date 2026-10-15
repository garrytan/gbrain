/**
 * `gbrain cloud` — opt-in HydraDB cloud memory for this brain.
 *
 *   gbrain cloud connect [--database <name>] [--key -] [--no-push]
 *   gbrain cloud status [--json]
 *   gbrain cloud push [--full]
 *   gbrain cloud primary on|off
 *   gbrain cloud disconnect [--purge-cloud]
 *
 * `connect` is the only way in: it shows the disclosure, takes consent, stores
 * the key in the credential vault and runs the first mirror. Everything after
 * is automatic: every page write is pushed (hydradb-mirror.ts scheduleCloudPush),
 * the `cloud_mirror` cycle phase catches up, and search ranks through HydraDB
 * (search/hydra-primary.ts).
 * Disconnecting leaves the local brain exactly as it was; it never depended
 * on the cloud.
 */

import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { shellQuote } from '../core/agent-output.ts';
import { agentBlock } from '../core/agent-markers.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { isConfigTruthy } from '../core/config.ts';
import { isInteractive, promptLineStderr, promptYesNo } from '../core/interaction.ts';
import { createProgress } from '../core/progress.ts';
import { readStdinPayload } from '../core/stdin-read.ts';
import {
  DEFAULT_HYDRADB_DATABASE, HYDRADB_API_KEY_ENV, HYDRADB_CONFIG, HydraDBError,
  apiKeyPrefix, hydraRequest, resolveHydraConnection, saveHydraApiKey, type HydraConnection,
  HYDRADB_BASE_URL, HYDRADB_BASE_URL_ENV, hydraBaseUrl, hydraQueryMode,
} from '../core/hydradb.ts';
import { mirrorBrain } from '../core/hydradb-mirror.ts';

const READY_WAIT_MS = 120_000;
const READY_POLL_MS = 3_000;

function printHelp(): void {
  console.log([
    'gbrain cloud — make HydraDB this brain\'s storage and search backend (opt-in)',
    '',
    'Copies every page, past and future, to a HydraDB database and answers query,',
    'search and recall from it. Off until you connect; this brain keeps a full local',
    'copy and searches it whenever HydraDB is off or unreachable.',
    '',
    'Subcommands:',
    '  connect               Show what is shared, ask, store the API key, mirror the brain.',
    '                          --database <name>  HydraDB database (default: gbrain)',
    '                          --api-url <url>    HydraDB endpoint (default: production)',
    '                          --mode fast|thinking  Retrieval mode (default: fast)',
    `                          --key -            read the API key from stdin (else ${HYDRADB_API_KEY_ENV} or a prompt)`,
    '                          --no-push          connect without the first mirror',
    '  status [--json]       Connection, recall and mirror state (never prints the key).',
    '  push [--full]         Mirror changes now (--full re-sends every page).',
    '  mode fast|thinking     Set cloud retrieval mode (default: fast). Thinking may take longer.',
    '  primary on|off        Search through HydraDB (on) or this brain alone (off; pages keep syncing).',
    '  disconnect            Stop using the cloud. --purge-cloud also deletes the HydraDB database.',
    '',
    'API keys: https://dashboard.hydradb.com',
  ].join('\n'));
}

function disclosure(database: string, baseUrl = HYDRADB_BASE_URL): string {
  return [
    `[gbrain] Connect this brain to HydraDB cloud memory (database "${database}")?`,
    '[gbrain]',
    `[gbrain]  - Every page, now and on each write, is copied to ${new URL(baseUrl).host}: the text gbrain gives`,
    '[gbrain]    an embedding provider, with detected secrets (keys, tokens) redacted. Private pages,',
    '[gbrain]    private fact rows, embed-skipped and quarantined pages stay here.',
    '[gbrain]  - HydraDB becomes the search backend: query, search and recall rank with HydraDB; this',
    '[gbrain]    brain is searched only when HydraDB is unreachable. While on, private pages are not',
    '[gbrain]    searchable, and a page written seconds ago may not be found yet.',
    '[gbrain]  - The API key is kept in ~/.gbrain/credentials.json (0600).',
    '[gbrain]',
    '[gbrain] Off switches: gbrain cloud primary off   (search locally, keep syncing)',
    '[gbrain]               gbrain cloud disconnect    (stop; --purge-cloud deletes the cloud copy)',
  ].join('\n');
}

/** The key from `--key -`, the environment, or a terminal prompt; null with the reason printed. */
async function readApiKey(args: string[]): Promise<{ key: string; fromEnv: boolean } | null> {
  if (args.includes('--key')) {
    const read = await readStdinPayload("printf '%s' \"$HYDRA_DB_API_KEY\" | gbrain cloud connect --key -");
    if (read.ok && read.text.trim()) return { key: read.text.trim(), fromEnv: false };
    console.error(read.ok ? 'No API key on stdin; nothing was written.' : read.message);
    return null;
  }
  const fromEnv = process.env[HYDRADB_API_KEY_ENV];
  if (fromEnv) return { key: fromEnv, fromEnv: true };
  const typed = (await promptLineStderr('HydraDB API key (https://dashboard.hydradb.com): '))?.trim();
  if (typed) return { key: typed, fromEnv: false };
  console.error('No API key given; nothing was written.');
  return null;
}

/** Create the database (an existing one is reused, so a second device joins it) and wait until it takes writes. */
async function ensureDatabase(conn: HydraConnection): Promise<boolean> {
  try {
    await hydraRequest(conn, 'POST', '/databases', { json: { database: conn.database } });
  } catch (e) {
    if (!(e instanceof HydraDBError && e.status === 409)) throw e;
  }
  const deadline = Date.now() + READY_WAIT_MS;
  for (;;) {
    const status = await hydraRequest<{ infra?: { ready_for_ingestion?: boolean } }>(conn, 'GET', '/databases/status', { query: { database: conn.database } })
      .catch(() => null);
    if (status?.infra?.ready_for_ingestion) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
}

async function push(engine: BrainEngine, conn: HydraConnection, full: boolean): Promise<void> {
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  const r = await mirrorBrain(engine, conn, { full, progress });
  console.log(`Mirrored ${r.upserted} page(s) to HydraDB "${conn.database}", removed ${r.removed}` +
    (r.skipped ? `, skipped ${r.skipped} with an identity too long for HydraDB metadata.` : '.'));
}

async function connect(engine: BrainEngine, args: string[]): Promise<void> {
  const modeFlag = args.find(a => a === '--mode' || a.startsWith('--mode='));
  const mode = modeFlag?.includes('=') ? modeFlag.slice(7) : modeFlag ? args[args.indexOf(modeFlag) + 1] : 'fast';
  if (mode !== 'fast' && mode !== 'thinking') { console.error('Use --mode fast|thinking'); setCliExitVerdict(1); return; }
  const dbFlag = args.indexOf('--database');
  const database = (dbFlag >= 0 ? args[dbFlag + 1] : undefined) ?? DEFAULT_HYDRADB_DATABASE;
  const urlFlag = args.indexOf('--api-url');
  const baseUrl = hydraBaseUrl(urlFlag >= 0 ? args[urlFlag + 1] : process.env[HYDRADB_BASE_URL_ENV]);
  console.log(disclosure(database, baseUrl));
  if (!args.includes('--yes')) {
    if (!isInteractive()) {
      console.error('[cloud] non-interactive session: refusing to send this brain to a cloud service without explicit consent. Nothing was written.');
      console.error(agentBlock({
        ask: 'Ask the user to run this in a terminal and answer its prompt.',
        why: 'Connecting mirrors this brain\'s pages to HydraDB, off this machine; only the user can agree to that.',
        consent: 'egress',
        actor: 'user',
        next: 'tell_user_to_run',
        if_yes: shellQuote(['gbrain', 'cloud', 'connect']),
        if_no: 'Nothing was written; the brain keeps working locally.',
      }));
      setCliExitVerdict(1);
      return;
    }
    if (!await promptYesNo('[gbrain] Connect to HydraDB? [y/N] ')) {
      console.log('Declined. Nothing was written.');
      return;
    }
  }
  const apiKey = await readApiKey(args);
  if (!apiKey) {
    setCliExitVerdict(1);
    return;
  }
  const conn: HydraConnection = { database, apiKey: apiKey.key, baseUrl };
  let ready: boolean;
  try {
    ready = await ensureDatabase(conn);
  } catch (e) {
    console.error(`✗ HydraDB rejected the connection: ${(e as Error).message}. Nothing was written.`);
    setCliExitVerdict(1);
    return;
  }
  if (!apiKey.fromEnv) await engine.setConfig(HYDRADB_CONFIG.credentialId, await saveHydraApiKey(apiKey.key));
  await engine.setConfig(HYDRADB_CONFIG.database, database);
  await engine.setConfig(HYDRADB_CONFIG.baseUrl, baseUrl);
  await engine.setConfig(HYDRADB_CONFIG.primary, 'true');
  await engine.setConfig(HYDRADB_CONFIG.mode, mode);
  console.log(`✓ Connected to HydraDB database "${database}" (key ${apiKeyPrefix(apiKey.key)}…).`);
  if (!ready) {
    console.log('HydraDB is still provisioning the database; the next autopilot cycle (or `gbrain cloud push`) mirrors the brain.');
    return;
  }
  if (!args.includes('--no-push')) await push(engine, conn, true);
}

async function status(engine: BrainEngine, args: string[]): Promise<void> {
  const database = await engine.getConfig(HYDRADB_CONFIG.database);
  const conn = await resolveHydraConnection(engine);
  const cursor = await engine.getConfig(HYDRADB_CONFIG.pagesCursor);
  const row = {
    connected: !!database,
    database,
    api_url: await engine.getConfig(HYDRADB_CONFIG.baseUrl) ?? HYDRADB_BASE_URL,
    key: conn ? `${apiKeyPrefix(conn.apiKey)}…` : null,
    key_source: conn ? (process.env[HYDRADB_API_KEY_ENV] ? 'env' : 'vault') : null,
    mode: hydraQueryMode(await engine.getConfig(HYDRADB_CONFIG.mode)),
    primary: isConfigTruthy(await engine.getConfig(HYDRADB_CONFIG.primary)),
    last_push_at: await engine.getConfig(HYDRADB_CONFIG.lastPushAt),
    mirrored_through: cursor ? (JSON.parse(cursor) as { updatedAt: string }).updatedAt : null,
  };
  if (args.includes('--json')) {
    console.log(JSON.stringify(row, null, 2));
    return;
  }
  if (!row.connected) {
    console.log('Cloud memory is off. Turn it on: gbrain cloud connect');
    return;
  }
  console.log(`HydraDB mode: ${row.mode}`);
  console.log(`HydraDB database "${row.database}"  key: ${row.key ?? `missing (set ${HYDRADB_API_KEY_ENV} or re-run gbrain cloud connect)`}  search: ${row.primary ? 'HydraDB' : 'local'}`);
  console.log(`  last push: ${row.last_push_at ?? 'never'}  mirrored through: ${row.mirrored_through ?? 'nothing yet'}`);
}

async function requireConnection(engine: BrainEngine): Promise<HydraConnection | null> {
  const conn = await resolveHydraConnection(engine);
  if (!conn) {
    console.error('Cloud memory is off or its key is missing. Run: gbrain cloud connect');
    setCliExitVerdict(1);
  }
  return conn;
}

async function disconnect(engine: BrainEngine, args: string[]): Promise<void> {
  const conn = await resolveHydraConnection(engine);
  if (args.includes('--purge-cloud')) {
    if (!conn) {
      console.error('No HydraDB key to delete the cloud copy with; nothing was changed. Set the key, then retry.');
      setCliExitVerdict(1);
      return;
    }
    if (!args.includes('--yes') && !(isInteractive() && await promptYesNo(`[gbrain] Permanently delete HydraDB database "${conn.database}" and everything in it? [y/N] `))) {
      console.log('Kept the cloud copy. Nothing was changed.');
      return;
    }
    await hydraRequest(conn, 'DELETE', '/databases', { query: { database: conn.database } });
    console.log(`Deleted HydraDB database "${conn.database}".`);
  }
  // Vault entries are shared by brains on this machine; clear only this brain's reference.
  for (const key of Object.values(HYDRADB_CONFIG)) await engine.unsetConfig(key);
  console.log('Cloud memory is off. This brain is unchanged and keeps working locally.');
}

export async function runCloud(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    return;
  }
  const rest = args.slice(1);
  switch (sub) {
    case 'connect':
      return connect(engine, rest);
    case 'status':
      return status(engine, rest);
    case 'push': {
      const conn = await requireConnection(engine);
      if (conn) await push(engine, conn, rest.includes('--full'));
      return;
    }
    case 'mode': {
      const mode = rest[0];
      if (mode !== 'fast' && mode !== 'thinking') { console.error('Usage: gbrain cloud mode fast|thinking'); setCliExitVerdict(1); return; }
      if (!await requireConnection(engine)) return;
      await engine.setConfig(HYDRADB_CONFIG.mode, mode);
      console.log(`HydraDB search mode: ${mode}.`);
      return;
    }
    case 'primary': {
      const mode = rest[0];
      if (mode !== 'on' && mode !== 'off') {
        console.error('Usage: gbrain cloud primary on|off');
        setCliExitVerdict(1);
        return;
      }
      if (!await requireConnection(engine)) return;
      await engine.setConfig(HYDRADB_CONFIG.primary, mode === 'on' ? 'true' : 'false');
      console.log(mode === 'on' ? 'Search now ranks through HydraDB.' : 'Search uses this brain alone; pages keep syncing to HydraDB.');
      return;
    }
    case 'disconnect':
      return disconnect(engine, rest);
    default:
      console.error(`Unknown cloud subcommand: ${sub}`);
      printHelp();
      setCliExitVerdict(1);
  }
}
