import { loadConfig } from '../config.ts';
import type { DreamCycleRunInput, DreamCycleRunResult } from './dream-cycle-runner-service.ts';
import {
  defaultAutopilotConfig,
  redactDsn,
  slotForAutopilotCycle,
  type AutopilotConfig,
  type AutopilotMode,
  type AutopilotWarning,
} from '../maintenance/autopilot.ts';
import { createMaintenanceRuntimeService, type MaintenanceJob, type MaintenanceRuntimeService } from './maintenance-runtime-service.ts';

export interface AutopilotInstallProfileInput {
  profile: AutopilotMode;
  command?: string;
  config_path?: string;
  schedule?: string;
  database_url?: string;
  env?: Record<string, string | undefined>;
  log_dir?: string;
}

export interface AutopilotInstallProfile {
  profile: AutopilotMode;
  content: string;
  redacted_database_url?: string;
}

export interface AutopilotScheduler {
  install(input: { mode: AutopilotMode; profile?: AutopilotMode }): Promise<void>;
  startForeground(input: { mode: AutopilotMode }): Promise<void>;
  stop(input: { mode: AutopilotMode }): Promise<void>;
}

export interface AutopilotRuntimeAdapter {
  enqueueJob(input: Record<string, unknown>): Promise<{ status: string; job: Record<string, unknown> }>;
  claimJob?(input: { job_id: string; queue: string; worker_id: string; lease_ms: number }): Promise<Record<string, unknown> | null>;
  completeJob?(input: { job_id: string; lock_token: string; result_json?: Record<string, unknown> }): Promise<Record<string, unknown>>;
  failJob?(input: { job_id: string; lock_token: string; failure_class: string; message: string; retryable?: boolean }): Promise<Record<string, unknown>>;
  sweepTimedOutJobs?(): Promise<Array<Record<string, unknown>>>;
  listJobs?(): Promise<Array<Record<string, unknown>>>;
  listWorkerHeartbeats?(): Promise<Array<Record<string, unknown>>>;
  getActiveCycleLock?(): Promise<Record<string, unknown> | null>;
  getLastCycleResult?(): Promise<Record<string, unknown> | null>;
}

export interface AutopilotServiceOptions {
  now?: () => string;
  slotFor?: (nowIso: string) => string;
  getConfig?: () => Promise<Partial<AutopilotConfig>>;
  setConfig?: (key: string, value: unknown) => Promise<void>;
  scheduler?: AutopilotScheduler;
  runtime?: AutopilotRuntimeAdapter;
  dreamRunner?: (input: DreamCycleRunInput) => Promise<DreamCycleRunResult | Record<string, unknown>>;
}

export interface AutopilotStatus {
  scheduler_installed: boolean;
  daemon_running: boolean;
  active_cycle_lock: Record<string, unknown> | null;
  last_cycle_result: Record<string, unknown> | null;
  next_scheduled_run: string | null;
  worker_heartbeat: Record<string, unknown> | null;
  queue_depth: number;
  failed_jobs: number;
  stuck_jobs: number;
  postgres_health: 'ok' | 'unknown';
  source_health: 'ok' | 'unknown';
  warnings: AutopilotWarning[];
}

export interface AutopilotService {
  renderInstallProfile(input: AutopilotInstallProfileInput): AutopilotInstallProfile;
  enable(input?: Partial<AutopilotConfig> & { start_now?: boolean }): Promise<Record<string, unknown>>;
  disable(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  start(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  stop(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  install(input: { profile?: AutopilotMode }): Promise<Record<string, unknown>>;
  uninstall(input: { profile?: AutopilotMode }): Promise<Record<string, unknown>>;
  logs(input?: { lines?: number }): Promise<{ lines: string[] }>;
  config(input?: Record<string, unknown>): Promise<AutopilotConfig>;
  tick(input: { trigger: 'daemon' | 'cron' | 'manual' }): Promise<Record<string, unknown>>;
  runOnce(input: { requested_by: string }): Promise<Record<string, unknown>>;
  dream(input: DreamCycleRunInput): Promise<DreamCycleRunResult | Record<string, unknown>>;
  status(input?: { now?: string }): Promise<AutopilotStatus>;
}

export function createAutopilotService(options: AutopilotServiceOptions = {}): AutopilotService {
  const now = options.now ?? (() => new Date().toISOString());
  const slotFor = options.slotFor ?? slotForAutopilotCycle;
  const getStoredConfig = options.getConfig ?? defaultGetConfig;
  const setStoredConfig = options.setConfig ?? defaultSetConfig;
  const scheduler = options.scheduler;
  const dreamRunner = options.dreamRunner;
  const runtime = options.runtime ?? createInProcessRuntimeAdapter(createMaintenanceRuntimeService({
    now,
    max_waiting_by_name: { autopilot_cycle: 1 },
  }), now);
  let localConfig: AutopilotConfig | null = null;

  async function readConfig(): Promise<AutopilotConfig> {
    if (localConfig) return localConfig;
    return normalizeAutopilotConfig(await getStoredConfig());
  }

  async function writeConfig(config: AutopilotConfig): Promise<void> {
    localConfig = config;
    await setStoredConfig('autopilot', config);
  }

  async function submitCycle(trigger: string): Promise<Record<string, unknown>> {
    const config = await readConfig();
    if (!config.enabled) {
      return { status: 'disabled' };
    }

    // Dead-letter jobs whose lease expired (a crashed worker leaks an `active` row that
    // can stall a slot via dedup) before submitting the next cycle, so the loop self-heals
    // instead of blocking on an orphaned job.
    if (runtime.sweepTimedOutJobs) {
      try {
        await runtime.sweepTimedOutJobs();
      } catch {
        // Sweep is best-effort; never block a cycle on cleanup.
      }
    }

    const runAt = now();
    const slot = slotFor(runAt);
    const result = await runtime.enqueueJob({
      name: 'autopilot_cycle',
      queue: 'maintenance',
      payload_json: {
        slot,
        trigger,
        allow_llm: config.allow_llm,
        allow_local_runner: config.allow_local_runner,
        source_consent_defaults: config.source_consent_defaults,
      },
      idempotency_key: `autopilot-cycle:${slot}`,
      max_attempts: 1,
      max_waiting: 1,
      timeout_ms: config.cycle_timeout_ms,
    });
    if (result.status === 'deduped' || result.status === 'coalesced') {
      return { status: result.status, job: result.job };
    }
    if (!dreamRunner) {
      return { status: 'submitted', job: result.job };
    }
    const dreamInput: DreamCycleRunInput = {
      scope_id: 'workspace:default',
      now: runAt,
      dry_run: false,
      write_candidates: true,
      allow_llm: config.allow_llm,
      allow_local_runner: config.allow_local_runner,
      trigger: 'autopilot',
    };
    const jobId = typeof result.job.id === 'string' ? result.job.id : null;
    if (jobId && runtime.claimJob && runtime.completeJob && runtime.failJob) {
      const claimed = await runtime.claimJob({
        job_id: jobId,
        queue: 'maintenance',
        worker_id: 'autopilot:inline',
        lease_ms: config.cycle_timeout_ms,
      });
      const lockToken = typeof claimed?.lock_token === 'string' ? claimed.lock_token : null;
      if (claimed?.id === jobId && lockToken) {
        try {
          const dreamResult = await dreamRunner(dreamInput);
          if (isFailedDreamResult(dreamResult)) {
            const failedJob = await runtime.failJob({
              job_id: jobId,
              lock_token: lockToken,
              failure_class: 'internal',
              message: dreamFailureMessage(dreamResult),
              retryable: false,
            });
            return { status: 'failed', job: failedJob, dream_result: dreamResult };
          }
          const completedJob = await runtime.completeJob({
            job_id: jobId,
            lock_token: lockToken,
            result_json: { dream_result: dreamResult as unknown as Record<string, unknown> },
          });
          return { status: 'completed', job: completedJob, dream_result: dreamResult };
        } catch (error) {
          await runtime.failJob({
            job_id: jobId,
            lock_token: lockToken,
            failure_class: 'internal',
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          });
          throw error;
        }
      }
    }
    const dreamResult = await dreamRunner(dreamInput);
    return { status: 'submitted', job: result.job, dream_result: dreamResult };
  }

  return {
    renderInstallProfile,

    async enable(input = {}) {
      const config = normalizeAutopilotConfig({
        ...(await readConfig()),
        ...withoutUndefined(input),
        enabled: true,
      });
      await writeConfig(config);

      if (input.start_now) {
        if (config.mode === 'manual' && scheduler) {
          await scheduler.startForeground({ mode: config.mode });
        } else if (scheduler) {
          await scheduler.install({ mode: config.mode });
          await submitCycle('enable');
        } else if (config.mode !== 'manual') {
          await submitCycle('enable');
        }
      }

      return { enabled: true, mode: config.mode };
    },

    async disable() {
      const config = normalizeAutopilotConfig({
        ...(await readConfig()),
        enabled: false,
      });
      await writeConfig(config);
      if (scheduler) {
        await scheduler.stop({ mode: config.mode });
      }
      return { enabled: false, mode: config.mode };
    },

    async start() {
      const config = await readConfig();
      if (!scheduler) {
        return { running: false, mode: config.mode, reason: 'scheduler_not_configured' };
      }
      if (config.mode === 'manual') {
        await scheduler.startForeground({ mode: config.mode });
      } else {
        await scheduler.install({ mode: config.mode });
      }
      return { running: true, mode: config.mode };
    },

    async stop() {
      const config = await readConfig();
      if (!scheduler) {
        return { running: false, mode: config.mode, reason: 'scheduler_not_configured' };
      }
      await scheduler.stop({ mode: config.mode });
      return { running: false, mode: config.mode };
    },

    async install(input) {
      const config = await readConfig();
      const profile = input.profile ?? config.mode;
      if (!scheduler) {
        return {
          installed: false,
          profile,
          reason: 'scheduler_not_configured',
          profile_content: renderInstallProfile({ profile, schedule: config.schedule }).content,
        };
      }
      await scheduler.install({ mode: profile, profile });
      return { installed: true, profile };
    },

    async uninstall(input) {
      const config = await readConfig();
      const profile = input.profile ?? config.mode;
      if (!scheduler) {
        return { installed: false, profile, reason: 'scheduler_not_configured' };
      }
      await scheduler.stop({ mode: profile });
      return { installed: false, profile };
    },

    async logs(input = {}) {
      const lines = Math.max(1, input.lines ?? 50);
      return { lines: [`autopilot logs are available from the configured scheduler (${lines} requested)`] };
    },

    async config() {
      return readConfig();
    },

    async tick(input) {
      return submitCycle(input.trigger);
    },

    async runOnce(_input) {
      return submitCycle('run-once');
    },

    async dream(input) {
      const config = await readConfig();
      if (!dreamRunner) {
        return { status: 'unavailable', reason: 'dream_runner_not_configured' };
      }
      return dreamRunner({
        ...input,
        allow_llm: input.allow_llm ?? config.allow_llm,
        allow_local_runner: input.allow_local_runner ?? config.allow_local_runner,
        trigger: 'autopilot',
      });
    },

    async status(input = {}) {
      const statusNow = input.now ?? now();
      const [config, jobs, heartbeats, activeCycleLock, lastCycleResult] = await Promise.all([
        readConfig(),
        runtime.listJobs?.() ?? Promise.resolve([]),
        runtime.listWorkerHeartbeats?.() ?? Promise.resolve([]),
        runtime.getActiveCycleLock?.() ?? Promise.resolve(null),
        runtime.getLastCycleResult?.() ?? Promise.resolve(null),
      ]);
      const waitingJobs = jobs.filter((job) => job.status === 'waiting' || job.status === 'delayed');
      const failedJobs = jobs.filter((job) => job.status === 'failed' || job.status === 'dead');
      const stuckJobs = jobs.filter((job) => job.status === 'active' && typeof job.lock_expires_at === 'string'
        && Date.parse(job.lock_expires_at) <= Date.parse(statusNow));
      const recentHeartbeats = heartbeats.filter((heartbeat) => {
        const raw = heartbeat.heartbeat_at ?? heartbeat.last_seen_at;
        return typeof raw === 'string' && Date.parse(raw) >= Date.parse(statusNow) - 10 * 60 * 1000;
      });
      const warnings: AutopilotWarning[] = [];
      if (waitingJobs.length >= 3 && recentHeartbeats.length === 0) {
        warnings.push({
          code: 'no_recent_worker_heartbeat',
          severity: 'warning',
          message: 'Queued autopilot work exists but no recent worker heartbeat was observed.',
          queue_depth: waitingJobs.length,
        });
      }

      return {
        scheduler_installed: config.mode !== 'manual',
        daemon_running: config.enabled && config.mode !== 'cron',
        active_cycle_lock: activeCycleLock,
        last_cycle_result: lastCycleResult,
        next_scheduled_run: config.enabled ? slotFor(statusNow) : null,
        worker_heartbeat: recentHeartbeats[0] ?? null,
        queue_depth: waitingJobs.length,
        failed_jobs: failedJobs.length,
        stuck_jobs: stuckJobs.length,
        postgres_health: 'unknown',
        source_health: 'unknown',
        warnings,
      };
    },
  };
}

function renderInstallProfile(input: AutopilotInstallProfileInput): AutopilotInstallProfile {
  const profile = input.profile;
  const command = input.command ?? 'mbrain';
  const configPath = input.config_path ?? '~/.mbrain/config.json';
  const logDir = input.log_dir ?? '~/.mbrain/logs';
  const schedule = input.schedule ?? '*/15 * * * *';
  const redactedDatabaseUrl = redactDsn(input.database_url);
  const base = `${command} autopilot run-once --config ${configPath}`;
  const envHint = redactedDatabaseUrl ? `# database: ${redactedDatabaseUrl}\n` : '';

  if (profile === 'launchd') {
    return {
      profile,
      redacted_database_url: redactedDatabaseUrl,
      content: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0">',
        '<dict>',
        '<key>Label</key><string>com.mbrain.autopilot</string>',
        `<key>ProgramArguments</key><array><string>${command}</string><string>autopilot</string><string>run-once</string><string>--config</string><string>${configPath}</string></array>`,
        `<key>StandardOutPath</key><string>${logDir}/autopilot.out.log</string>`,
        `<key>StandardErrorPath</key><string>${logDir}/autopilot.err.log</string>`,
        '</dict>',
        '</plist>',
      ].join('\n'),
    };
  }

  if (profile === 'systemd') {
    return {
      profile,
      redacted_database_url: redactedDatabaseUrl,
      content: [
        '[Unit]',
        'Description=MBrain Autopilot',
        '',
        '[Service]',
        'Type=oneshot',
        `ExecStart=${base}`,
        '',
        '[Install]',
        'WantedBy=default.target',
      ].join('\n'),
    };
  }

  if (profile === 'cron') {
    return {
      profile,
      redacted_database_url: redactedDatabaseUrl,
      content: `${envHint}${schedule} ${base} >> ${logDir}/autopilot.cron.log 2>&1`,
    };
  }

  return {
    profile,
    redacted_database_url: redactedDatabaseUrl,
    content: `${envHint}${base}`,
  };
}

function normalizeAutopilotConfig(input: Partial<AutopilotConfig> | null | undefined): AutopilotConfig {
  const defaults = defaultAutopilotConfig();
  const mode = isAutopilotMode(input?.mode) ? input.mode : defaults.mode;
  return {
    enabled: input?.enabled ?? defaults.enabled,
    mode,
    schedule: input?.schedule ?? defaults.schedule,
    allow_llm: input?.allow_llm ?? defaults.allow_llm,
    allow_local_runner: input?.allow_local_runner ?? defaults.allow_local_runner,
    source_consent_defaults: input?.source_consent_defaults === 'allow_registered_sources'
      ? 'allow_registered_sources'
      : defaults.source_consent_defaults,
    cycle_timeout_ms: Math.max(1, input?.cycle_timeout_ms ?? defaults.cycle_timeout_ms),
  };
}

function withoutUndefined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function isAutopilotMode(value: unknown): value is AutopilotMode {
  return value === 'launchd' || value === 'systemd' || value === 'cron' || value === 'manual';
}

function isFailedDreamResult(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.status === 'failed';
}

function dreamFailureMessage(result: Record<string, unknown>): string {
  const summaryLines = result.summary_lines;
  if (Array.isArray(summaryLines)) {
    const firstSummary = summaryLines.find((line): line is string => typeof line === 'string' && line.length > 0);
    if (firstSummary) return firstSummary;
  }

  const phases = result.phases;
  if (Array.isArray(phases)) {
    for (const phase of phases) {
      if (!isRecord(phase) || phase.status !== 'failed' || !Array.isArray(phase.errors)) continue;
      const firstError = phase.errors.find((line): line is string => typeof line === 'string' && line.length > 0);
      if (firstError) return firstError;
    }
  }

  return 'dream cycle reported failed status';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function defaultGetConfig(): Promise<Partial<AutopilotConfig>> {
  const raw = loadConfig() as unknown as { autopilot?: Partial<AutopilotConfig> } | null;
  return raw?.autopilot ?? {};
}

async function defaultSetConfig(_key: string, _value: unknown): Promise<void> {
  throw new Error('Autopilot config writes require a command-level config writer.');
}

export function createInProcessRuntimeAdapter(
  service: MaintenanceRuntimeService,
  now: () => string = () => new Date().toISOString(),
): AutopilotRuntimeAdapter {
  return {
    async enqueueJob(input) {
      const result = await service.enqueueJob({
        name: String(input.name),
        queue: String(input.queue ?? 'maintenance'),
        payload_json: input.payload_json as Record<string, unknown> | undefined,
        idempotency_key: input.idempotency_key as string | undefined,
        max_attempts: input.max_attempts as number | undefined,
        timeout_ms: input.timeout_ms as number | undefined,
      });
      return { status: result.status === 'enqueued' ? 'submitted' : result.status, job: result.job as unknown as Record<string, unknown> };
    },
    async claimJob(input) {
      const job = await service.getJob(input.job_id);
      if (!job || job.queue !== input.queue) return null;
      const nextClaimable = await getNextClaimableInProcessJob(service, input.queue, now());
      if (nextClaimable?.id !== input.job_id) return null;
      const claimed = await service.claimNextJob({
        queue: input.queue,
        worker_id: input.worker_id,
        lease_ms: input.lease_ms,
      });
      return claimed?.id === input.job_id ? claimed as unknown as Record<string, unknown> : null;
    },
    async completeJob(input) {
      return service.completeJob(input) as unknown as Record<string, unknown>;
    },
    async failJob(input) {
      return service.failJob({
        job_id: input.job_id,
        lock_token: input.lock_token,
        failure_class: input.failure_class as any,
        message: input.message,
        retryable: input.retryable,
      }) as unknown as Record<string, unknown>;
    },
    async sweepTimedOutJobs() {
      return service.sweepTimedOutJobs() as unknown as Array<Record<string, unknown>>;
    },
    async listJobs() {
      return service.listJobs() as unknown as Array<Record<string, unknown>>;
    },
    async listWorkerHeartbeats() {
      const status = await service.getStatus();
      return status.worker_heartbeats as unknown as Array<Record<string, unknown>>;
    },
    async getActiveCycleLock() {
      const status = await service.getStatus();
      return status.active_cycle_locks[0] as unknown as Record<string, unknown> | undefined ?? null;
    },
    async getLastCycleResult() {
      const status = await service.getStatus();
      return status.last_cycle_result as unknown as Record<string, unknown> | null;
    },
  };
}

async function getNextClaimableInProcessJob(
  service: MaintenanceRuntimeService,
  queue: string,
  nowIso: string,
): Promise<MaintenanceJob | null> {
  const jobs = await service.listJobs({ queue, limit: 1000 });
  return jobs.find((entry) => isInProcessClaimableJob(entry, nowIso)) ?? null;
}

function isInProcessClaimableJob(job: MaintenanceJob, nowIso: string): boolean {
  if (job.status === 'waiting') return true;
  if (job.status === 'delayed') return isoAtOrBefore(job.next_run_at, nowIso);
  if (job.status === 'active') return isoAtOrBefore(job.lock_expires_at, nowIso);
  return false;
}

function isoAtOrBefore(value: string | null, nowIso: string): boolean {
  return value !== null && Date.parse(value) <= Date.parse(nowIso);
}
