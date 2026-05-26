import type { BrainEngine } from '../core/engine.ts';
import { createSqlMaintenanceRuntimeAdapter } from '../core/services/maintenance-runtime-db-adapter.ts';
import { maybeCreateLifecycleForgettingServiceForEngine } from '../core/services/lifecycle-forgetting-engine-service.ts';
import {
  runDreamCycle,
  type DreamCycleRunInput,
  type DreamCycleRunResult,
} from '../core/services/dream-cycle-runner-service.ts';

export interface RunDreamDeps {
  runner?: (input: DreamCycleRunInput) => Promise<DreamCycleRunResult | Record<string, unknown>>;
}

export async function runDream(
  engine: BrainEngine,
  args: string[],
  deps: RunDreamDeps = {},
): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') {
    printDreamHelp();
    return;
  }
  const input = parseDreamArgs(args, 'cli');
  const result = deps.runner
    ? await deps.runner(input)
    : await runDreamCycle(engine, input, {
        runtime: createSqlMaintenanceRuntimeAdapter(engine),
        lifecycleForgetting: maybeCreateLifecycleForgettingServiceForEngine(engine, () => input.now ?? new Date().toISOString()),
      });
  console.log(JSON.stringify(result, null, 2));
}

export function parseDreamArgs(
  args: string[],
  trigger: NonNullable<DreamCycleRunInput['trigger']>,
): DreamCycleRunInput {
  const apply = hasFlag(args, '--apply');
  const dryRunFlag = hasFlag(args, '--dry-run');
  const dryRun = dryRunFlag || !apply;
  return {
    scope_id: readFlag(args, '--scope-id') ?? readFlag(args, '--scope') ?? 'workspace:default',
    now: readFlag(args, '--now'),
    dry_run: dryRun,
    write_candidates: !dryRun && (apply || hasFlag(args, '--write-candidates')),
    trigger,
    ...(hasFlag(args, '--allow-llm') ? { allow_llm: true } : {}),
    ...(hasFlag(args, '--allow-local-runner') ? { allow_local_runner: true } : {}),
    ...(readNumberFlag(args, '--limit') !== undefined ? { limit: readNumberFlag(args, '--limit') } : {}),
  };
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readFlag(args: string[], flag: string): string | undefined {
  const eq = args.find((arg) => arg.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const index = args.indexOf(flag);
  if (index !== -1) return args[index + 1];
  return undefined;
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const raw = readFlag(args, flag);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function printDreamHelp(): void {
  console.log(`mbrain dream -- run the Dream maintenance phase runner

USAGE
  mbrain dream [--dry-run|--apply] [--scope-id SCOPE] [--now ISO] [--limit N]
               [--allow-llm] [--allow-local-runner]
`);
}
