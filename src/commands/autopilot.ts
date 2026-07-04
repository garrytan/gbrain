import { existsSync, readFileSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { configPath, loadConfig, saveConfig, type MBrainConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import { createConnectedEngine } from '../core/engine-factory.ts';
import { createSqlMaintenanceRuntimeAdapter } from '../core/services/maintenance-runtime-db-adapter.ts';
import { maybeCreateLifecycleForgettingServiceForEngine } from '../core/services/lifecycle-forgetting-engine-service.ts';
import { createAutopilotService, type AutopilotService } from '../core/services/autopilot-service.ts';
import { createProofAgentDreamReplayCanary } from '../core/services/dream-replay-canary-service.ts';
import { runDreamCycle, type DreamCycleRunInput, type DreamCycleRunResult } from '../core/services/dream-cycle-runner-service.ts';
import { parseDreamArgs } from './dream.ts';
import type { AutopilotMode } from '../core/maintenance/autopilot.ts';
import { createAutoPromoteDreamDependency } from './auto-promote.ts';
import { createGovernedRecompileDreamDependency } from './governed-recompile.ts';
import { saveMemoryReviewReport, type MemoryReportNotifyConfig } from './memory-report.ts';
import { runWatchedQuestionProbes } from '../core/services/watched-question-service.ts';

export interface RunAutopilotDeps {
  service?: AutopilotService;
  engine?: BrainEngine;
  dreamRunner?: (input: DreamCycleRunInput) => Promise<DreamCycleRunResult | Record<string, unknown>>;
}

export async function runAutopilot(args: string[], deps: RunAutopilotDeps = {}): Promise<void> {
  const command = args[0];
  if (!command || command === '--help' || command === '-h') {
    printAutopilotHelp();
    return;
  }

  const subArgs = args.slice(1);
  if (command === 'dream' && (hasFlag(subArgs, '--help') || hasFlag(subArgs, '-h'))) {
    printAutopilotDreamHelp();
    return;
  }
  const restoreConfigDir = applyConfigPathArg(subArgs);
  let ownedEngine: BrainEngine | null = null;

  try {
    const service = deps.service ?? await createCommandService(command, subArgs, deps.engine);

    switch (command) {
      case 'enable':
        printJsonish(await service.enable({
          mode: readMode(subArgs),
          schedule: readFlag(subArgs, '--schedule') ?? undefined,
          start_now: hasFlag(subArgs, '--start-now'),
        }));
        return;
      case 'disable':
        printJsonish(await service.disable());
        return;
      case 'start':
        printJsonish(await service.start());
        return;
      case 'stop':
        printJsonish(await service.stop());
        return;
      case 'status':
        printStatus(await service.status({}));
        return;
      case 'install':
        printJsonish(await service.install({ profile: readProfile(subArgs) }));
        return;
      case 'uninstall':
        printJsonish(await service.uninstall({ profile: readProfile(subArgs) }));
        return;
      case 'logs':
        printLogs(await service.logs({ lines: readNumberFlag(subArgs, '--lines') }));
        return;
      case 'config':
        printConfig(await service.config({ json: hasFlag(subArgs, '--json') }), hasFlag(subArgs, '--json'));
        return;
      case 'run-once':
        printJsonish(await service.runOnce({ requested_by: 'cli' }));
        return;
      case 'dream':
        printJsonish(await service.dream(parseDreamArgs(subArgs, 'autopilot')));
        return;
      case '_daemon-tick':
        printJsonish(await service.tick({ trigger: 'daemon' }));
        return;
      default:
        console.error(`Unknown autopilot command: ${command}`);
        printAutopilotHelp();
        process.exitCode = 1;
    }
  } finally {
    if (ownedEngine !== null) await (ownedEngine as BrainEngine).disconnect();
    restoreConfigDir();
  }

  async function createCommandService(
    currentCommand: string,
    currentArgs: string[],
    injectedEngine: BrainEngine | undefined,
  ): Promise<AutopilotService> {
    const defaultReportDir = resolveConfiguredBrainDir();
    const reportNotify = readReportNotifyConfig();
    const needsRuntime = currentCommand === 'status'
      || currentCommand === 'run-once'
      || currentCommand === 'dream'
      || currentCommand === '_daemon-tick'
      || (currentCommand === 'enable' && hasFlag(currentArgs, '--start-now'));
    const engine = needsRuntime ? injectedEngine ?? await connectCommandEngine() : injectedEngine;
    const runtime = engine && !(currentCommand === 'dream' && deps.dreamRunner)
      ? createSqlMaintenanceRuntimeAdapter(engine)
      : undefined;
    return createAutopilotService({
      getConfig: async () => readAutopilotConfig(),
      setConfig: async (_key, value) => writeAutopilotConfig(value as Record<string, unknown>),
      ...(runtime ? { runtime } : {}),
      ...(engine ? {
        dreamRunner: async (input) => deps.dreamRunner
          ? deps.dreamRunner(input)
          : runDreamCycle(engine, input, {
              ...(runtime ? { runtime } : {}),
              lifecycleForgetting: maybeCreateLifecycleForgettingServiceForEngine(engine, () => input.now ?? new Date().toISOString()),
              autoPromote: createAutoPromoteDreamDependency(engine),
              replayCanary: createProofAgentDreamReplayCanary(),
              governedRecompile: createGovernedRecompileDreamDependency(engine),
              watchedQuestions: {
                run: (watchedInput) => runWatchedQuestionProbes(engine, watchedInput),
              },
              ...((currentCommand !== 'dream' || input.report_dir !== undefined) ? {
                memoryReport: {
                  save: (reportInput) => saveMemoryReviewReport(engine, {
                    ...reportInput,
                    report_dir: input.report_dir ?? defaultReportDir,
                    ...(reportNotify ? { notify: reportNotify } : {}),
                  }),
                },
              } : {}),
            }),
      } : {}),
    });
  }

  async function connectCommandEngine(): Promise<BrainEngine> {
    const config = loadConfig();
    if (!config) {
      throw new Error('No brain configured. Run: mbrain init or set MBRAIN_DATABASE_URL / DATABASE_URL.');
    }
    ownedEngine = await createConnectedEngine(config);
    await ownedEngine.initSchema();
    return ownedEngine;
  }
}

function readAutopilotConfig(): Record<string, unknown> {
  const raw = readRawConfigFile();
  const autopilot = raw?.autopilot ?? {};
  return {
    ...autopilot,
    ...(autopilot.phase_timeout_ms === undefined && raw?.maintenance?.phase_timeout_ms !== undefined
      ? { phase_timeout_ms: raw.maintenance.phase_timeout_ms }
      : {}),
    ...(autopilot.governed_recompile_enabled === undefined && raw?.maintenance?.governed_recompile_enabled !== undefined
      ? { governed_recompile_enabled: raw.maintenance.governed_recompile_enabled }
      : {}),
  };
}

function writeAutopilotConfig(value: Record<string, unknown>): void {
  const raw = readRawConfigFile();
  if (!raw) {
    throw new Error('Autopilot config writes require ~/.mbrain/config.json so env-only secrets are not persisted.');
  }
  saveConfig({ ...raw, autopilot: value } as MBrainConfig & { autopilot: Record<string, unknown> });
}

function readRawConfigFile(): (MBrainConfig & { autopilot?: Record<string, unknown> }) | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as MBrainConfig & { autopilot?: Record<string, unknown> };
}

function readReportNotifyConfig(): MemoryReportNotifyConfig | undefined {
  const raw = readRawConfigFile() as (MBrainConfig & { report?: { notify?: Record<string, unknown> } }) | null;
  const notify = raw?.report?.notify;
  if (!notify) return undefined;
  const mode = notify?.mode;
  if (mode !== 'off' && mode !== 'auto' && mode !== 'command') return undefined;
  const command = notify.command;
  return {
    mode,
    ...(typeof command === 'string' ? { command } : {}),
  };
}

function resolveConfiguredBrainDir(): string {
  const configFile = configPath();
  const configDir = dirname(configFile);
  const raw = readRawConfigFile();
  const databasePath = typeof raw?.database_path === 'string' && raw.database_path.trim().length > 0
    ? raw.database_path.trim()
    : null;
  if (!databasePath) return resolve(configDir);
  const absoluteDatabasePath = isAbsolute(databasePath)
    ? databasePath
    : resolve(configDir, databasePath);
  return dirname(absoluteDatabasePath);
}

function applyConfigPathArg(args: string[]): () => void {
  const config = readFlag(args, '--config');
  if (!config) return () => {};
  const previousConfigDir = process.env.MBRAIN_CONFIG_DIR;
  const previousConfigPath = process.env.MBRAIN_CONFIG_PATH;
  process.env.MBRAIN_CONFIG_DIR = dirname(config);
  process.env.MBRAIN_CONFIG_PATH = config;
  return () => {
    if (previousConfigDir === undefined) {
      delete process.env.MBRAIN_CONFIG_DIR;
    } else {
      process.env.MBRAIN_CONFIG_DIR = previousConfigDir;
    }
    if (previousConfigPath === undefined) {
      delete process.env.MBRAIN_CONFIG_PATH;
    } else {
      process.env.MBRAIN_CONFIG_PATH = previousConfigPath;
    }
  };
}

function readMode(args: string[]): AutopilotMode | undefined {
  return normalizeProfile(readFlag(args, '--mode'));
}

function readProfile(args: string[]): AutopilotMode | undefined {
  return normalizeProfile(readFlag(args, '--profile'));
}

function normalizeProfile(value: string | undefined): AutopilotMode | undefined {
  if (value === 'launchd' || value === 'systemd' || value === 'cron' || value === 'manual') {
    return value;
  }
  return undefined;
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

function printJsonish(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printStatus(status: Awaited<ReturnType<AutopilotService['status']>>): void {
  console.log('MBrain autopilot status');
  console.log(`scheduler installed: ${status.scheduler_installed}`);
  console.log(`daemon running: ${status.daemon_running}`);
  if (status.active_cycle_lock) {
    console.log(`active cycle: ${status.active_cycle_lock.cycle_name ?? 'unknown'}`);
  } else {
    console.log('active cycle: none');
  }
  if (status.last_cycle_result) {
    console.log(`last cycle: ${status.last_cycle_result.idempotency_key ?? 'unknown'} ${status.last_cycle_result.status ?? 'unknown'}`);
  } else {
    console.log('last cycle: none');
  }
  for (const warning of status.warnings) {
    console.log(`warning: ${warning.code} ${warning.message}`);
  }
}

function printLogs(result: { lines: string[] }): void {
  for (const line of result.lines) {
    console.log(line);
  }
}

function printConfig(config: unknown, json: boolean): void {
  if (json) {
    printJsonish(config);
    return;
  }
  console.log('MBrain autopilot config');
  console.log(JSON.stringify(config, null, 2));
}

function printAutopilotHelp(): void {
  console.log(`mbrain autopilot -- maintenance automation

USAGE
  mbrain autopilot <command> [options]

COMMANDS
  enable [--mode launchd|systemd|cron|manual] [--schedule CRON] [--start-now]
  disable
  start
  stop
  status
  install [--profile launchd|systemd|cron|manual]
  uninstall [--profile launchd|systemd|cron|manual]
  logs [--lines N]
  config [--json]
  run-once
  dream [--dry-run|--apply] [--apply-auto-promote] [--allow-canonical-page-writes]
        [--scope-id SCOPE] [--now ISO] [--limit N]
        [--governed-recompile|--no-governed-recompile]
`);
}

function printAutopilotDreamHelp(): void {
  console.log(`mbrain autopilot dream -- run the Dream phase runner through autopilot policy

USAGE
  mbrain autopilot dream [--dry-run|--apply] [--write-candidates]
                        [--scope-id SCOPE] [--now ISO] [--limit N]
                        [--apply-auto-promote] [--allow-canonical-page-writes]
                        [--max-runner-calls N] [--time-budget-ms MS]
                        [--max-candidates-per-cycle N]
                        [--governed-recompile|--no-governed-recompile]
                        [--allow-llm] [--allow-local-runner]
`);
}
