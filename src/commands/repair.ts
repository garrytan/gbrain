/**
 * `gbrain repair [<kind>] [--apply] [--source <id>] [--limit <n>] [--no-embed] [--json]`
 *
 * Host-side repairs for residual damage the doctor reports. Every kind is a
 * dry run unless `--apply` is passed; applying publishes each item through a
 * coordinated page write (or, for `safe-chunks`, a projection-only rebuild
 * that takes no admission), resumes after an interruption, and stops before
 * crossing 90% of a cumulative journal cap. Thin clients refuse (cli.ts).
 */
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { OperationError, type OperationContext } from '../core/ops/contract.ts';
import { REPAIR_KINDS, resolveRepairScope, runRepair, type RepairHandler, type RepairKind, type RepairResult } from '../core/repair/core.ts';
import { timelineRepair } from '../core/repair/timeline.ts';
import { visibilityRepair } from '../core/repair/visibility.ts';
import { safeChunksRepair } from '../core/repair/safe-chunks.ts';

const HANDLERS: Record<RepairKind, RepairHandler> = { timeline: timelineRepair, visibility: visibilityRepair, 'safe-chunks': safeChunksRepair };

export const REPAIR_HELP = `Usage: gbrain repair [<kind>] [--apply] [--source <id>] [--limit <n>] [--no-embed] [--json]
       gbrain repair --all [--apply] [--source <id>] [--json]

Repair residual damage that \`gbrain doctor\` reports. Dry run unless --apply.

Kinds:
  timeline     Write database-only timeline rows back into their pages as marked
               bullets (#5567). Rows that cannot round-trip are kept and counted.
  visibility   Stamp explicit visibility on extracted atoms and synthesized
               concepts, tighten-only (#5525). Transcript and missing origins
               become private; nothing is ever loosened.
  safe-chunks  Re-seal pages of every kind (markdown and code) chunked before the
               safe-chunk fence, which remote/MCP search withholds (#5050, #5247).
               Projection-only: no page write and no journal admission. Unchanged
               vectors are kept; the rest are embedded unless --no-embed.

Options:
  --apply        Write the repair (no prompt). Without it, only preview.
  --source <id>  Limit to one source (default: every active source).
  --limit <n>    Repair at most n items; rerun the same command to continue.
  --no-embed     safe-chunks: re-seal text only; embed later with gbrain embed --stale.
  --all          Run every kind in order (${REPAIR_KINDS.join(', ')}).
  --json         Machine-readable output with a stable shape.

With no kind, previews every kind. Run it on the brain host.`;

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith('--')) throw new OperationError('invalid_params', `${name} requires a value.`);
  return value;
}

function human(result: RepairResult): string {
  const lines = [`${result.kind}: ${result.affected} item(s) ${result.mode === 'apply' ? 'pending before this run' : 'to repair'}`];
  if (result.sample.length) lines.push(`  e.g. ${result.sample.join(', ')}`);
  const residuals = Object.entries(result.residuals).map(([k, v]) => `${k}=${v}`).join(', ');
  if (residuals) lines.push(`  ${residuals}`);
  lines.push(`  cost: ${result.cost.lifetime_ids} request ID(s), ${result.cost.receipt_bytes} receipt bytes, `
    + `${result.cost.embedding_pages} page(s) to re-embed${result.cost.embedding_usd === null ? '' : ` (~$${result.cost.embedding_usd.toFixed(4)})`}`);
  for (const c of result.capacity) lines.push(`  capacity ${c.scope} ${c.resource}: ${c.used} of ${c.limit} (stops at ${c.stop_at})`);
  if (result.resumed_from) lines.push(`  resuming after item ${result.resumed_from.phase}:${result.resumed_from.id}`);
  if (result.mode === 'apply') lines.push(`  applied ${result.applied}, skipped ${result.skipped}${result.complete ? ', complete' : ''}`);
  if (result.stopped) lines.push(`  STOPPED: ${result.stopped.message}`);
  if (result.mode === 'dry_run' && result.affected) lines.push(`  apply: ${result.apply_command}`);
  return lines.join('\n');
}

export async function runRepairCommand(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(REPAIR_HELP); return; }
  if (args.includes('--yes')) throw new OperationError('invalid_params', '`--yes` is not accepted by gbrain repair; pass --apply to write.');
  const json = args.includes('--json');
  const noEmbed = args.includes('--no-embed');
  const apply = args.includes('--apply');
  const source = flag(args, '--source');
  const limitText = flag(args, '--limit');
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new OperationError('invalid_params', '--limit must be a positive integer.');
  const positional = args.filter((arg, i) => !arg.startsWith('--') && !['--source', '--limit'].includes(args[i - 1] ?? ''));
  const kind = positional[0];
  if (kind && !REPAIR_KINDS.includes(kind as RepairKind)) {
    throw new OperationError('invalid_params', `Unknown repair kind '${kind}'.`, `Kinds: ${REPAIR_KINDS.join(', ')}.`);
  }
  if (!kind && apply && !args.includes('--all')) throw new OperationError('invalid_params', 'Name a kind or pass --all with --apply.');
  const kinds: RepairKind[] = kind ? [kind as RepairKind] : [...REPAIR_KINDS];
  const scope = await resolveRepairScope(engine, source);
  const config = loadConfig() ?? { engine: engine.kind };
  const ctx: OperationContext = { engine, config, logger: { info: console.error, warn: console.error, error: console.error },
    dryRun: !apply, remote: false, sourceId: scope.source_ids[0] } as OperationContext;
  let embeddingModel: string | undefined;
  try { embeddingModel = config.embedding_disabled ? undefined : (await import('../core/ai/gateway.ts')).getEmbeddingModel(); } catch { embeddingModel = undefined; }
  const results: RepairResult[] = [];
  for (const k of kinds) {
    const result = await runRepair(ctx, HANDLERS[k], scope, { apply, limit, embeddingModel, sourceFlag: source,
      embed: !noEmbed && embeddingModel !== undefined, applyArgs: noEmbed && k === 'safe-chunks' ? ['--no-embed'] : [] });
    results.push(result);
    if (result.stopped) break;
  }
  if (json) {
    console.log(JSON.stringify({ scope, mode: apply ? 'apply' : 'dry_run', results }, null, 2));
  } else {
    console.log(`Scope: brain ${scope.brain_id}; sources ${scope.source_ids.join(', ') || '(none)'}`);
    for (const result of results) console.log(human(result));
  }
  if (results.some(r => r.stopped)) setCliExitVerdict(1);
}
