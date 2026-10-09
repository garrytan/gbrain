/**
 * `gbrain repair content [--source <id>] [--only <path>]... [--skip <path>]... [--no-llm] [--max-usd <n>] [--diff]
 *                        [--apply [--expect <h1>[,<h2>]]] [--json]`
 *
 * The content-repair lane (#6377) as one command: every kind in
 * `CONTENT_REPAIR_KINDS` (src/core/repair/content-lane.ts) over the same
 * source and file selection, each kind printing its own preview hash. `content`
 * is a lane, not a repair kind: it has no registry entry, no cursor of its own
 * and no help row under "Kinds"; it runs the registered kinds through the same
 * runner `gbrain repair <kind>` uses, so every refusal, receipt and cap is the
 * kind's own. Dry run unless `--apply`: the preview plans every kind before
 * anything is written and prints each kind's own hash; `--apply --expect
 * <h1>,<h2>` applies exactly the previewed sets, one hash per kind in lane
 * order; `--apply` alone applies each kind's current plan as `gbrain repair
 * <kind> --apply` does. `--max-usd` is the lane's allowance
 * for the run: what the first kind spends is gone for the next. Thin clients
 * refuse (cli.ts); the parse and the help text live in repair.ts so one flag
 * grammar serves every `gbrain repair` form.
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { clearHealthMemo } from '../core/health-memo.ts';
import { resolveRepairScope } from '../core/repair/core.ts';
import { CONTENT_REPAIR_KINDS, contentLaneArgv, parseContentLaneExpect, runContentLane } from '../core/repair/content-lane.ts';
import { repairMaySpend, repairSpec } from '../core/repair/registry.ts';
import { renderRepairResult } from './repair.ts';

export interface RepairContentArgs { apply: boolean; json: boolean; diff: boolean; noLlm: boolean; noEmbed: boolean; source?: string; expect?: string; maxUsd?: number;
  only: string[]; skip: string[]; limit?: number }

export async function runRepairContentCommand(engine: BrainEngine, args: RepairContentArgs): Promise<void> {
  const kinds = [...CONTENT_REPAIR_KINDS];
  const preview = contentLaneArgv({ source: args.source, only: args.only, skip: args.skip, noLlm: args.noLlm, maxLlmUsd: args.maxUsd });
  const expect = args.expect === undefined ? undefined : parseContentLaneExpect(args.expect, kinds, [...preview, '--json']);
  const scope = await resolveRepairScope(engine, args.source);
  const lane = await runContentLane(engine, scope, { apply: args.apply, kinds, only: args.only, skip: args.skip, expect, noLlm: args.noLlm, maxLlmUsd: args.maxUsd,
    limit: args.limit, noEmbed: args.noEmbed, sourceFlag: args.source });
  if (args.apply) clearHealthMemo(engine);
  const paidKinds = lane.kinds.filter(kind => repairMaySpend(repairSpec(kind), args.noEmbed));
  if (args.json) {
    console.log(JSON.stringify({ lane: 'content', scope, mode: lane.mode, kinds: lane.kinds, results: lane.results.map(result => ({ ...result, paid: paidKinds.includes(result.kind) })),
      preview_hashes: lane.preview_hashes, cost: lane.cost, stopped: lane.stopped, paid_kinds: paidKinds, apply_command: lane.apply_command }, null, 2));
  } else {
    console.log(`Scope: brain ${scope.brain_id}; sources ${scope.source_ids.join(', ') || '(none)'}; lane content (${lane.kinds.join(', ')})`);
    for (const result of lane.results) console.log(renderRepairResult(result, { diff: args.diff }));
    const hashes = lane.kinds.map(kind => `${kind}=${lane.preview_hashes[kind] ?? '(none)'}`).join(', ');
    console.log(`Lane: paid model ${lane.mode === 'apply' ? `$${lane.cost.llm_usd.toFixed(4)} spent` : `~$${lane.cost.llm_usd.toFixed(4)}`}`
      + `${lane.cost.llm_allowance_remaining_usd === null ? '' : ` ($${lane.cost.llm_allowance_remaining_usd.toFixed(4)} left of this run's --max-usd)`}; preview hashes: ${hashes}`);
    for (const stop of lane.stopped) console.log(`  ${stop.kind} STOPPED (${stop.reason}): ${stop.message}`);
    if (lane.mode === 'dry_run') console.log(`  apply: ${lane.apply_command}`);
  }
  if (lane.stopped.length) setCliExitVerdict(1);
}
