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

function parseFlags(args: string[]): { provider: string; flags: SyncFlags } {
  const flags: SyncFlags = { full: false, dryRun: false, embed: false, background: false, json: false, all: false };
  let provider = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') flags.all = true;
    else if (a === '--full') flags.full = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--embed') flags.embed = true;
    else if (a === '--background') flags.background = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--limit') flags.limit = Number(args[++i]);
    else if (a === '--window-days') flags.windowDays = Number(args[++i]);
    else if (a === '--source') flags.source = args[++i];
    else if (!a.startsWith('-')) provider = a;
  }
  return { provider, flags };
}

export async function runConnectorSyncCmd(engine: BrainEngine, args: string[]): Promise<void> {
  const { provider, flags } = parseFlags(args);

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
    console.error('Usage: gbrain connectors sync <chatgpt|claude>|--all [--full] [--dry-run] [--limit N]');
    setCliExitVerdict(1);
    return;
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
