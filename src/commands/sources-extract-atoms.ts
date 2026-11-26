/**
 * `gbrain sources set-extract-atoms <id> <on|off> [--dry-run] [--expect <on|off>] [--json]` (#9888): sets
 * `config.extract_atoms`, the per-source switch that keeps a source's pages and transcripts out of provider-based atom
 * extraction (cycle/source-atom-policy.ts) while they stay synced and searchable. Preview-first like `set-sync`: the
 * dry run prints the apply command with `--expect <current>`, and an apply whose state moved refuses `preview_changed`.
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../core/agent-output.ts';
import { extractAtomsOffConfig } from '../core/cycle/source-atom-policy.ts';

const USAGE = 'gbrain sources set-extract-atoms <id> <on|off> [--dry-run] [--expect <on|off>] [--json]';
type Switch = 'on' | 'off';
const isSwitch = (value: unknown): value is Switch => value === 'on' || value === 'off';

export interface SetExtractAtomsResult { source_id: string; dry_run: boolean; current: Switch; target: Switch; changed: boolean; apply?: string[] }

function parseArgs(args: string[]): { sourceId: string; target: Switch; dryRun: boolean; expect?: Switch } {
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

async function setExtractAtoms(engine: BrainEngine, opts: ReturnType<typeof parseArgs>): Promise<SetExtractAtomsResult> {
  const src = (await engine.listAllSources()).find(source => source.id === opts.sourceId);
  if (!src) {
    throw opError('invalid_params', `No active source ${opts.sourceId}.`, 'Name an active source; gbrain sources list prints them.',
      { fix: { argv: ['gbrain', 'sources', 'list', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists the active source ids, read-only.' } });
  }
  const current: Switch = extractAtomsOffConfig(src.config) ? 'off' : 'on';
  const preview = ['gbrain', 'sources', 'set-extract-atoms', opts.sourceId, opts.target, '--dry-run', '--json'];
  if (opts.expect && opts.expect !== current) {
    throw opError('preview_changed', `Atom extraction of source ${opts.sourceId} is ${current}, not ${opts.expect} as the preview showed; nothing changed.`,
      `Preview again with ${preview.join(' ')} and apply the command it prints.`,
      { fix: { argv: preview, consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the current state and the apply command for it; changes nothing.' } });
  }
  const changed = current !== opts.target;
  if (opts.dryRun) return { source_id: opts.sourceId, dry_run: true, current, target: opts.target, changed,
    apply: ['gbrain', 'sources', 'set-extract-atoms', opts.sourceId, opts.target, '--expect', current] };
  if (changed) await engine.updateSourceConfig(opts.sourceId, { extract_atoms: opts.target === 'on' });
  return { source_id: opts.sourceId, dry_run: false, current, target: opts.target, changed };
}

function describe(result: SetExtractAtomsResult): string {
  const what = result.target === 'on'
    ? 'included in atom extraction'
    : 'kept out of atom extraction (its pages stay synced and searchable; nothing from it is sent to the chat model for atoms)';
  if (result.dry_run) return `Source "${result.source_id}": atom extraction is ${result.current}; ${result.changed ? `it would be ${what}` : 'nothing would change'}.\nApply: ${result.apply!.join(' ')}`;
  return result.changed ? `Source "${result.source_id}" is now ${what} (was ${result.current}).` : `Source "${result.source_id}": atom extraction is already ${result.current}; nothing changed.`;
}

export async function runSetExtractAtoms(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    const result = await setExtractAtoms(engine, parseArgs(args));
    console.log(json ? JSON.stringify(result) : describe(result));
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const env = toAgentError(error, { transport: 'cli', command: 'sources set-extract-atoms', render: cliRenderContext() });
    console.log(json ? JSON.stringify(env) : `Refused (${error.code}): ${error.message}\nFix: ${error.suggestion ?? USAGE}`);
    setCliExitVerdict(error.code === 'invalid_params' ? 2 : 1);
  }
}
