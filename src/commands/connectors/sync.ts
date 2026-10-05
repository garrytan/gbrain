/**
 * commands/connectors/sync.ts — `gbrain connectors sync <provider>|--all [flags]`.
 *
 * Inline by default (PGLite-safe: it's the same runConnectorSync the handler
 * wraps). `--background` submits the `connector-sync` minion job on Postgres;
 * on PGLite (no worker daemon) it falls back to inline with a note.
 */

import type { BrainEngine } from '../../core/engine.ts';
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import { createProgress } from '../../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../../core/cli-options.ts';
import { runConnectorSync } from '../../core/connectors/sync.ts';
import type { ConnectorSyncResult } from '../../core/connectors/sync.ts';
import { connectorProviderNames, isConnectorProviderName } from '../../core/connectors/registry.ts';
import { loadCredential } from '../../core/connectors/credentials.ts';
import { sourceIdKey } from '../../core/connectors/config-keys.ts';
import type { ConnectorProviderName } from '../../core/connectors/types.ts';
import { flagValueError, intFlagValue } from '../../cli/flag-values.ts';
import { usageError } from '../../cli/cli-error.ts';

interface SyncFlags {
  full: boolean;
  dryRun: boolean;
  limit?: number;
  windowDays?: number;
  source?: string;
  embed: boolean;
  background: boolean;
  json: boolean;
  all: boolean;
}

function parseFlags(args: string[]): { provider: string; providerIndex: number; flags: SyncFlags } {
  const flags: SyncFlags = { full: false, dryRun: false, embed: false, background: false, json: false, all: false };
  let provider = '';
  let providerIndex = -1;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') flags.all = true;
    else if (a === '--full') flags.full = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--embed') flags.embed = true;
    else if (a === '--background') flags.background = true;
    else if (a === '--json') flags.json = true;
    // #5930 (D4): decimals, zero limits and unsafe integers are usage errors (exit 2), not Number() coercions.
    else if (a === '--limit') flags.limit = intFlagValue(args[++i], '--limit', { min: 1, example: 50 });
    else if (a === '--window-days') flags.windowDays = intFlagValue(args[++i], '--window-days', { min: 0, example: 30 });
    else if (a === '--source') flags.source = args[++i];
    else if (!a.startsWith('-')) { provider = a; providerIndex = i; }
  }
  return { provider, providerIndex, flags };
}

const SYNC_USAGE = 'gbrain connectors sync <chatgpt|claude>|--all [--full] [--dry-run] [--limit N] [--window-days N] [--source id] [--embed] [--background] [--json]';

/** Agent contract v1: usage errors are `invalid_params` (exit 2, one `--json` envelope) naming the usage and the fix. */
function syncUsageError(message: string, fix: { argv: string[]; inputs: Array<{ name: string; how: string }> }) {
  return usageError(message, `Usage: ${SYNC_USAGE}`, {
    why: 'gbrain connectors sync needs one provider (or --all) and a value after every value flag.',
    fix: { ...fix, consent: [], actor: 'agent', why: 'A corrected command line runs the sync.', requires_exclusive: false },
  });
}

export async function runConnectorSyncCmd(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: ${SYNC_USAGE}`);
    return;
  }
  const badSource = args.findIndex((arg, i) => arg === '--source' && (!args[i + 1] || args[i + 1].startsWith('-')));
  if (badSource !== -1) {
    const argv = ['gbrain', 'connectors', 'sync', ...args.slice(0, badSource + 1), '<SOURCE_ID>', ...args.slice(badSource + 1)];
    throw syncUsageError(flagValueError('--source', args[badSource + 1], 'a source id', 'default').message, {
      argv, inputs: [{ name: 'SOURCE_ID', how: 'The id of the source the imported conversations belong to (gbrain sources list), or drop --source to use the configured connector source.' }],
    });
  }

  const { provider, providerIndex, flags } = parseFlags(args);

  // Resolve the target provider set.
  let providers: ConnectorProviderName[];
  if (flags.all) {
    // Only providers that have a credential (env or file) are worth syncing.
    providers = connectorProviderNames().filter((p) => loadCredential(p) !== null);
    if (providers.length === 0) {
      console.error('No connector credentials found. Run `gbrain connectors auth <provider>` first.');
      setCliExitVerdict(1);
      return;
    }
  } else if (isConnectorProviderName(provider)) {
    providers = [provider];
  } else {
    const names = connectorProviderNames();
    throw syncUsageError(provider ? `Unknown connector provider '${provider}'; expected ${names.join(', ')} or --all.` : `Name a connector provider (${names.join(', ')}) or pass --all.`, {
      argv: ['gbrain', 'connectors', 'sync', '<PROVIDER>', ...args.filter((_, i) => i !== providerIndex)],
      inputs: [{ name: 'PROVIDER', how: `One of ${names.join(', ')}, or --all for every provider with a credential (gbrain connectors providers lists them).` }],
    });
  }

  const sourceId = flags.source ?? (await engine.getConfig(sourceIdKey())) ?? 'default';
  const results: ConnectorSyncResult[] = [];

  for (const p of providers) {
    if (flags.background && !flags.dryRun) {
      const submitted = await submitBackground(engine, p, sourceId, flags);
      if (submitted) continue; // job queued (Postgres); else fell through to inline
    }
    const reporter = createProgress(cliOptsToProgressOptions(getCliOptions()));
    reporter.start(`connector.sync.${p}`);
    try {
      const r = await runConnectorSync(engine, {
        provider: p,
        sourceId,
        full: flags.full,
        dryRun: flags.dryRun,
        limit: flags.limit,
        windowDays: flags.windowDays,
        embed: flags.embed,
        onProgress: (pr) => reporter.heartbeat(`${pr.phase}: listed ${pr.listed}, fetched ${pr.fetched}, imported ${pr.imported}`),
      });
      results.push(r);
      reporter.finish();
      if (!flags.json) printResult(r);
    } catch (e) {
      reporter.finish();
      console.error(`connector sync ${p} failed: ${e instanceof Error ? e.message : String(e)}`);
      setCliExitVerdict(1);
    }
  }

  if (flags.json) console.log(JSON.stringify({ results }, null, 2));
}

async function submitBackground(
  engine: BrainEngine,
  provider: ConnectorProviderName,
  sourceId: string,
  flags: SyncFlags,
): Promise<boolean> {
  if (engine.kind !== 'postgres') {
    console.error(`(${provider}) --background needs Postgres (PGLite has no worker daemon); running inline.`);
    return false;
  }
  const { MinionQueue } = await import('../../core/minions/queue.ts');
  const queue = new MinionQueue(engine);
  const slot = new Date().toISOString().slice(0, 13); // hour bucket
  const job = await queue.add(
    'connector-sync',
    { provider, sourceId, full: flags.full, limit: flags.limit },
    { idempotency_key: `connector-sync:${provider}:${slot}`, max_attempts: 2 },
  );
  console.log(`Queued connector-sync for ${provider} (job ${job.id}). Track with \`gbrain jobs get ${job.id}\`.`);
  return true;
}

function printResult(r: ConnectorSyncResult): void {
  const i = r.ingest;
  console.log(
    `${r.provider}: ${r.status}` +
      `  listed=${r.listed} fetched=${r.fetched} errors=${r.fetchErrors}` +
      (i ? `  imported=${i.imported} skipped=${i.skipped} redactions=${i.redactions}` : '') +
      (r.watermarkAdvancedTo ? `  watermark→${r.watermarkAdvancedTo}` : '') +
      (r.embedKickoff !== 'none' && r.embedKickoff !== 'below_threshold' ? `  embed:${r.embedKickoff}` : ''),
  );
  if (r.hint) console.log(`  ${r.hint.split('\n')[0]}`);
}
