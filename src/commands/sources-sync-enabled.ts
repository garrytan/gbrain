/**
 * `gbrain sources set-sync <id> <on|off> [--dry-run] [--expect <on|off>] [--json]` (GBRA-108): sets `config.syncEnabled`,
 * the switch that excludes a source from automatic sync (`sync --all`, autopilot's freshness dispatcher and the full-cycle
 * fan-out; sync-policy.ts). An explicit `gbrain sync --source <id>` still runs either way. Before this verb the only way
 * to set it was a raw write to `sources.config`.
 *
 * Preview first: `--dry-run` prints the current state, the target and the exact apply command, which carries
 * `--expect <current>`; the apply refuses `preview_changed` when the state moved since. One writer:
 * `updateSourceConfig`'s single-key merge, as `set-strategy` and `set-pull-strategy` do.
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../core/agent-output.ts';
import { isSyncDisabledConfig } from '../core/sync-policy.ts';

const USAGE = 'gbrain sources set-sync <id> <on|off> [--dry-run] [--expect <on|off>] [--json]';
type SyncSwitch = 'on' | 'off';
const isSwitch = (value: unknown): value is SyncSwitch => value === 'on' || value === 'off';

export interface SetSyncResult { source_id: string; dry_run: boolean; current: SyncSwitch; target: SyncSwitch; changed: boolean; apply?: string[] }

export function parseSetSyncArgs(args: string[]): { sourceId: string; target: SyncSwitch; dryRun: boolean; expect?: SyncSwitch } {
  const positional: string[] = [];
  let expect: string | undefined, dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--expect') { expect = args[++i]; continue; }
    if (arg.startsWith('-')) throw opError('invalid_params', `Unknown flag ${arg}.`, `Usage: ${USAGE}`);
    positional.push(arg);
  }
  const [sourceId, target] = positional;
  if (!sourceId || !isSwitch(target) || positional.length > 2) throw opError('invalid_params', 'Name one source and on or off.', `Usage: ${USAGE}`);
  if (expect !== undefined && !isSwitch(expect)) throw opError('invalid_params', '--expect takes on or off.', `Usage: ${USAGE}`);
  return { sourceId, target, dryRun, ...(expect ? { expect } : {}) };
}

export async function setSourceSync(engine: BrainEngine, opts: ReturnType<typeof parseSetSyncArgs>): Promise<SetSyncResult> {
  const [src] = await engine.executeRaw<{ config: unknown; archived: boolean | null }>('SELECT config, archived FROM sources WHERE id=$1', [opts.sourceId]);
  if (!src || src.archived) {
    throw opError('invalid_params', `No active source ${opts.sourceId}.`, 'Name an active source; gbrain sources list prints them.',
      { fix: { argv: ['gbrain', 'sources', 'list', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists the active source ids, read-only.' } });
  }
  const current: SyncSwitch = isSyncDisabledConfig(src.config) ? 'off' : 'on';
  const preview = ['gbrain', 'sources', 'set-sync', opts.sourceId, opts.target, '--dry-run', '--json'];
  if (opts.expect && opts.expect !== current) {
    throw opError('preview_changed', `Automatic sync of source ${opts.sourceId} is ${current}, not ${opts.expect} as the preview showed; nothing changed.`,
      `Preview again with ${preview.join(' ')} and apply the command it prints.`,
      { fix: { argv: preview, consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the current state and the apply command for it; changes nothing.' } });
  }
  const changed = current !== opts.target;
  if (opts.dryRun) return { source_id: opts.sourceId, dry_run: true, current, target: opts.target, changed,
    apply: ['gbrain', 'sources', 'set-sync', opts.sourceId, opts.target, '--expect', current] };
  if (changed) await engine.updateSourceConfig(opts.sourceId, { syncEnabled: opts.target === 'on' });
  return { source_id: opts.sourceId, dry_run: false, current, target: opts.target, changed };
}

function describe(result: SetSyncResult): string {
  const what = result.target === 'on' ? 'included in automatic sync' : 'excluded from automatic sync (an explicit gbrain sync --source still runs)';
  if (result.dry_run) return `Source "${result.source_id}": automatic sync is ${result.current}; ${result.changed ? `it would be ${what}` : 'nothing would change'}.\nApply: ${result.apply!.join(' ')}`;
  return result.changed ? `Source "${result.source_id}" is now ${what} (was ${result.current}).` : `Source "${result.source_id}": automatic sync is already ${result.current}; nothing changed.`;
}

export async function runSetSync(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    const result = await setSourceSync(engine, parseSetSyncArgs(args));
    console.log(json ? JSON.stringify(result) : describe(result));
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const env = toAgentError(error, { transport: 'cli', command: 'sources set-sync', render: cliRenderContext() });
    console.log(json ? JSON.stringify(env) : `Refused (${error.code}): ${error.message}\nFix: ${error.suggestion ?? USAGE}`);
    setCliExitVerdict(error.code === 'invalid_params' ? 2 : 1);
  }
}
