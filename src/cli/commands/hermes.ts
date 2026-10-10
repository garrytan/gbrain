import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { BrainEngine } from '../../core/engine.ts';
import type { CliDispatchContext } from '../command-table.ts';
import type { HermesMaintenanceReport } from '../../core/hermes-maintenance.ts';
import { writeStdoutFinal } from '../../core/cli-force-exit.ts';

const HELP = `Usage:
  gbrain hermes setup [options]
  gbrain hermes maintain [options]

maintain explicitly imports Hermes conversation text into this brain.
Automatic scheduled capture requires separate operator opt-in.
A live local PGLite owner runs maintenance through its authenticated local IPC.
Older or unbound owners refuse safely; this command never kills an owner.

  --state-db PATH       Hermes SQLite store (default: $HERMES_HOME/state.db)
  --source ID           Destination GBrain source (normal source resolution)
  --session-source NAME Import only this Hermes session origin; repeatable
  --since ISO           Select sessions with messages newer than this time
  --messages-since ISO  Import turns newer than this time
  --limit N             Maximum new sessions (default 100, maximum 10000)
  --window SECONDS      Admission deadline (default 300, maximum 3600)
  --enrich              Opt into configured paid facts drain and synthesis
  --dir PATH            Brain checkout for configured synthesis
  --json                Complete maintenance receipt

Without --enrich, no model enrichment runs. With --enrich, existing spend caps
and kill switches still apply. The existing facts drain processes queued pages
across this brain, so enrichment requires unrestricted source authority.
Synthesis requires both dream.synthesize.enabled
and dream.synthesize.conversation_pages; this command never enables them.
Skipped locks, zero input, deferred jobs and incomplete validation are reported.
`;

export interface HermesMaintenanceArgs {
  stateDb: string; source?: string; brainDir?: string; enrich: boolean;
  windowSeconds: number; limit: number; sinceIso?: string;
  messagesSinceIso?: string; sessionSources: string[]; json: boolean;
}

/** Preserve progress receipts while satisfying the CLI's non-success JSON contract. */
export function maintenanceJsonReceipt<T extends HermesMaintenanceReport>(report: T): T | (T & {
  code: 'command_failed'; error: 'command_failed'; suggestion: string; contract_version: 1;
}) {
  return report.status === 'ok' ? report : { ...report, code: 'command_failed', error: 'command_failed', contract_version: 1,
    suggestion: 'Read the reasons and phase receipts, then run gbrain doctor --json to diagnose the cause before retrying maintenance.' };
}

export function parseHermesMaintenanceArgs(args: string[]): HermesMaintenanceArgs {
  const options: HermesMaintenanceArgs = {
    stateDb: resolve(process.env.HERMES_HOME || join(process.env.HOME || homedir(), '.hermes'), 'state.db'),
    enrich: false, windowSeconds: 300, limit: 100, sessionSources: [], json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') { options.json = true; continue; }
    if (flag === '--enrich') { options.enrich = true; continue; }
    if (!['--state-db', '--source', '--dir', '--window', '--limit', '--since', '--messages-since', '--session-source'].includes(flag)) {
      throw new Error(`Unknown Hermes maintenance flag: ${flag}`);
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--state-db') options.stateDb = resolve(value);
    else if (flag === '--source') options.source = value;
    else if (flag === '--dir') options.brainDir = resolve(value);
    else if (flag === '--session-source') options.sessionSources.push(value);
    else if (flag === '--window' || flag === '--limit') {
      const n = Number(value), max = flag === '--window' ? 3600 : 10000;
      if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${flag} must be 1..${max}`);
      if (flag === '--window') options.windowSeconds = n;
      else options.limit = n;
    } else {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) throw new Error(`${flag} requires an ISO timestamp`);
      if (flag === '--since') options.sinceIso = date.toISOString();
      else options.messagesSinceIso = date.toISOString();
    }
  }
  return options;
}

export async function run(args: string[], ctx: CliDispatchContext): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h' || (command === 'maintain' && rest.includes('--help'))) {
    console.log(HELP); return;
  }
  if (command === 'setup') {
    const { runHermesSetup } = await import('../../commands/hermes-setup.ts');
    await runHermesSetup(rest);
    return;
  }
  const { finishCliTeardown, setCliExitVerdict } = await import('../../core/cli-force-exit.ts');
  if (command !== 'maintain') { console.error(HELP); setCliExitVerdict(2); return; }
  let engine: BrainEngine | undefined;
  let parsedFlags = false;
  try {
    const options = parseHermesMaintenanceArgs(rest);
    parsedFlags = true;
    const { loadConfig, isThinClient } = await import('../../core/config.ts');
    if (isThinClient(loadConfig())) throw new Error('Hermes maintenance requires the local brain owner. Run it on the GBrain host; hermes setup remains available on this thin-client machine.');
    const { maybeDelegateHermesMaintenance } = await import('../../commands/hermes-delegate.ts');
    if (await maybeDelegateHermesMaintenance(options)) return;
    if (!ctx.makeContext) throw new Error('Hermes maintenance requires the CLI write coordinator');
    engine = await ctx.connectEngine();
    const { resolveSourceWithTier } = await import('../../core/source-resolver.ts');
    const { source_id: sourceId } = await resolveSourceWithTier(engine, options.source ?? null);
    const context = await ctx.makeContext(engine, { source: sourceId });
    const { runHermesMaintenance } = await import('../../core/hermes-maintenance.ts');
    const report = await runHermesMaintenance(engine, { ...options, sourceId, context });
    if (report.status !== 'ok') setCliExitVerdict(1);
    if (options.json) await writeStdoutFinal(`${JSON.stringify(maintenanceJsonReceipt(report), null, 2)}\n`);
    else console.log(`Hermes maintenance: ${report.status}; ${report.ingest?.sessionsImported ?? 0} sessions imported, ${report.validation.checked} pages checked${report.reasons.length ? `; ${report.reasons.join(', ')}` : ''}`);
  } catch (error) {
    setCliExitVerdict(parsedFlags ? 1 : 2);
    const message = error instanceof Error ? error.message : String(error);
    const code = parsedFlags ? 'command_failed' : 'invalid_params';
    if (rest.includes('--json')) await writeStdoutFinal(`${JSON.stringify({ schema_version: 1, contract_version: 1, status: 'failed', code, error: code,
      reasons: [message], suggestion: parsedFlags ? 'Read the failure reason and run gbrain doctor --json before retrying maintenance.'
        : 'Run gbrain hermes maintain --help and correct the named flag before retrying.' }, null, 2)}\n`);
    else console.error(message);
  } finally {
    if (engine) await finishCliTeardown({ engine });
  }
}
