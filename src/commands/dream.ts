import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, type MBrainConfig } from '../core/config.ts';
import { createSqlMaintenanceRuntimeAdapter } from '../core/services/maintenance-runtime-db-adapter.ts';
import { maybeCreateLifecycleForgettingServiceForEngine } from '../core/services/lifecycle-forgetting-engine-service.ts';
import { createProofAgentDreamReplayCanary } from '../core/services/dream-replay-canary-service.ts';
import {
  runDreamCycle,
  type DreamCycleRunInput,
  type DreamCycleRunResult,
} from '../core/services/dream-cycle-runner-service.ts';
import { createAutoPromoteDreamDependency } from './auto-promote.ts';
import { createGovernedRecompileDreamDependency } from './governed-recompile.ts';
import { saveMemoryReviewReport } from './memory-report.ts';
import { runWatchedQuestionProbes } from '../core/services/watched-question-service.ts';

const STRICT_ISO_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

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
  const input = applyDreamConfigDefaults(parseDreamArgs(args, 'cli'), loadConfig());
  const result = deps.runner
    ? await deps.runner(input)
    : await runDreamCycle(engine, input, {
        runtime: createSqlMaintenanceRuntimeAdapter(engine),
        lifecycleForgetting: maybeCreateLifecycleForgettingServiceForEngine(engine, () => input.now ?? new Date().toISOString()),
        autoPromote: createAutoPromoteDreamDependency(engine),
        replayCanary: createProofAgentDreamReplayCanary(),
        governedRecompile: createGovernedRecompileDreamDependency(engine),
        watchedQuestions: {
          run: (watchedInput) => runWatchedQuestionProbes(engine, watchedInput),
        },
        ...(input.report_dir ? {
          memoryReport: {
            save: (reportInput) => saveMemoryReviewReport(engine, {
              ...reportInput,
              report_dir: input.report_dir!,
            }),
          },
        } : {}),
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
  const limit = readNumberFlag(args, '--limit');
  const maxRunnerCalls = readNumberFlag(args, '--max-runner-calls');
  const timeBudgetMs = readNumberFlag(args, '--time-budget-ms');
  const phaseTimeoutMs = readNumberFlag(args, '--phase-timeout-ms');
  const maxCandidatesPerCycle = readNumberFlag(args, '--max-candidates-per-cycle');
  const now = readFlag(args, '--now');
  const governedRecompileEnabled = hasFlag(args, '--governed-recompile')
    ? true
    : hasFlag(args, '--no-governed-recompile')
      ? false
      : undefined;
  return {
    scope_id: readFlag(args, '--scope-id') ?? readFlag(args, '--scope') ?? 'workspace:default',
    now: now === undefined ? undefined : parseIsoDateTimeFlag(now),
    dry_run: dryRun,
    write_candidates: !dryRun && (apply || hasFlag(args, '--write-candidates')),
    apply_auto_promote: !dryRun && hasFlag(args, '--apply-auto-promote'),
    allow_canonical_page_writes: !dryRun && hasFlag(args, '--allow-canonical-page-writes'),
    trigger,
    ...(hasFlag(args, '--allow-llm') ? { allow_llm: true } : {}),
    ...(hasFlag(args, '--allow-local-runner') ? { allow_local_runner: true } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(maxRunnerCalls !== undefined ? { max_runner_calls: maxRunnerCalls } : {}),
    ...(timeBudgetMs !== undefined ? { time_budget_ms: timeBudgetMs } : {}),
    ...(phaseTimeoutMs !== undefined ? { phase_timeout_ms: phaseTimeoutMs } : {}),
    ...(maxCandidatesPerCycle !== undefined ? { max_candidates_per_cycle: maxCandidatesPerCycle } : {}),
    ...(governedRecompileEnabled !== undefined ? { governed_recompile_enabled: governedRecompileEnabled } : {}),
    ...(readFlag(args, '--report-dir') !== undefined ? { report_dir: readFlag(args, '--report-dir') } : {}),
  };
}

function applyDreamConfigDefaults(input: DreamCycleRunInput, config: MBrainConfig | null): DreamCycleRunInput {
  return {
    ...input,
    ...(input.phase_timeout_ms === undefined && config?.maintenance_phase_timeout_ms !== undefined
      ? { phase_timeout_ms: config.maintenance_phase_timeout_ms }
      : {}),
    ...(input.governed_recompile_enabled === undefined && config?.maintenance_governed_recompile_enabled === true
      ? { governed_recompile_enabled: config.maintenance_governed_recompile_enabled }
      : {}),
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

function parseIsoDateTimeFlag(value: string): string {
  if (!isStrictIsoDateTime(value)) {
    throw new Error('--now must be a valid ISO datetime string');
  }
  return value;
}

function isStrictIsoDateTime(value: string): boolean {
  const match = STRICT_ISO_DATETIME_PATTERN.exec(value);
  if (!match) return false;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, , offsetHourRaw, offsetMinuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  if (month < 1 || month > 12) return false;
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > maxDay) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHourRaw !== undefined || offsetMinuteRaw !== undefined) {
    const offsetHour = Number(offsetHourRaw);
    const offsetMinute = Number(offsetMinuteRaw);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function printDreamHelp(): void {
  console.log(`mbrain dream -- run the Dream maintenance phase runner

USAGE
  mbrain dream [--dry-run|--apply] [--write-candidates]
               [--scope-id SCOPE] [--now ISO] [--limit N]
               [--apply-auto-promote] [--allow-canonical-page-writes]
               [--max-runner-calls N] [--time-budget-ms MS] [--phase-timeout-ms MS]
               [--max-candidates-per-cycle N]
               [--report-dir BRAIN_DIR]
               [--governed-recompile|--no-governed-recompile]
               [--allow-llm] [--allow-local-runner]
`);
}
