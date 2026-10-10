/**
 * Engine graduation orchestrator (PGLite -> Postgres): plan, run, status,
 * resume, rollback and reconciliation over one custody protocol.
 *
 * The kernel lock on the source is held from step 1 to the end of step 8
 * (quiesce, record, drain, fence target, copy, verify, fence both then grant
 * authority, flip routing). Exactly one engine accepts writes at every
 * instant: before step 7 only the source (the target is fenced in the
 * database from step 4), during step 7 neither, after it only the target.
 * Every state change is driven by the transition tables in
 * engine-graduation.types.ts and recorded in the 0600 manifest
 * (`<GBRAIN_HOME>/graduation-manifest.json`), the sibling intent marker and
 * the `persistence_graduation` rows; restart reconciliation continues from the
 * first incomplete step using the recorded identities, never current routing.
 *
 * Graduation is CLI-only: no operations.ts entry, no remote caller.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BrainEngine } from '../engine.ts';
import type { EngineConfig } from '../types.ts';
import { configDir, loadConfigFileOnly, saveConfig, type GBrainConfig } from '../config.ts';
import { liveServeOwner } from '../exclusive-fix.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { acquireKernelLockOnly, inspectLockHolder, PgliteBusyError, peekLock, releaseLock, type LockHandle } from '../pglite-lock.ts';
import { localHostId } from './identity.ts';
import { quiesceAutopilot } from '../../commands/migrate-engine.ts';
import { LATEST_VERSION } from '../migrate.ts';
import {
  assertTransition, GRADUATION_MANIFEST_VERSION, graduationBoundary, MANIFEST_TRANSITIONS,
  type GraduationBoundary, type GraduationBoundaryDetail,
  type GraduationBlocker, type GraduationCommandOptions, type GraduationManifest, type GraduationPathState, type GraduationPhase, type GraduationPlan,
  type GraduationReceipt, type GraduationRollbackResult, type GraduationStatusDoc, type GraduationTargetSpelling, type IntentMarker, type Inventory, type InventoryEntry, type LossKind,
  type ManifestState, type TableCheckpoint, type TableReceipt, type TargetIdentity, type TargetProbe, type TargetRoutes, type TargetRowState, type TriggerBypass,
} from './engine-graduation.types.ts';
import {
  currentProcessIdentity, engineGraduatedFor, fsyncParent, graduatedPath, graduationDataDir, inspectGraduationPath, markerLiveness,
  allowGraduationInspection, moveAsideHeld, moveHeldDatastore, readIntentMarker, readTombstone, registerGraduationRunInProcess, removeIntentMarker, removeTombstone, splitBrainFor,
  TERMINAL_STATES, TombstonePathOccupiedError, writeFileDurably, writeIntentMarker, writeTombstone,
} from './graduation-custody.ts';
import {
  drainTimeoutError, embeddingDimensionMismatchError, foreignHostBindingError, inProgressError, interruptedError, planArgv as planArgvOf,
  resumeArgv, retainedCopyMissingError, rollbackWritesLostError, runArgv as runArgvOf, sourceWriterHeldError, statusArgv, targetAuthFailedError, targetNotEmptyError,
  targetUnsupportedError, unsupportedPlatformError, verifyFailedError,
} from './graduation-errors.ts';
import { rollbackLosses, type RollbackLoss } from './graduation-losses.ts';
import {
  dropGraduationFence, graduationFenceStatus, installGraduationFence, readGraduationRow, setSourceState, setTargetState,
  withGraduationRun,
} from './graduation-schema.ts';
import { assertRelationSet, copyOrder, fkClosure, GRADUATION_INVENTORY } from './graduation-inventory.ts';
import { digestTable } from './graduation-digest.ts';
import { verifyGraduation } from './graduation-verify.ts';
import {
  assertTargetReachable, chooseTriggerBypass, connectTargetEngines, crossCheckRoutes, probeTarget, resolveTargetRoutes, sourceEmbeddingLayout,
  targetIdentity, targetProbeBlockers,
} from './graduation-target.ts';
import { drainForGraduation, freezeSource, graduationBlockers, withSourceWritable } from './graduation-drain.ts';
import { buildDeferredIndexes, copySequences, copyTable, deferIndexes, detectTriggerBypass, reenableTriggers } from './graduation-copy.ts';
import { TRUST_BACKFILL_COMPLETED_KEY } from '../trust/schema.ts';
import { WRITE_GATE_SCAN_BASELINE_KEY } from '../write-gate-schema.ts';

const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;
const HANDOFF_TIMEOUT_MS = 30_000;
const STATUS_ARGV = statusArgv();

const STATE_RANK: Readonly<Record<ManifestState, number>> = {
  planned: 0, quiesced: 1, draining: 2, copying: 3, verifying: 4, verify_failed: 4, verified: 5, cutover: 6, tombstoned: 7,
  authoritative: 8, graduated: 9, rollback_fenced: 10, rollback_approved: 11, source_restoring: 12, rolled_back: 13, abandoned: 13,
};

// ── dependencies ───────────────────────────────────────────────────────────

export interface GraduationSourceEngine extends BrainEngine {
  closeRetainingLock(): Promise<LockHandle>;
  connectWithHeldLock(config: EngineConfig, lock: LockHandle): Promise<void>;
}

type Routes = TargetRoutes & { mainUrl: string; ddlUrl: string };

/** Everything the orchestrator calls outside custody; tests replace any part. */
export interface GraduationDeps {
  inventory: Inventory;
  assertRelationSet: typeof assertRelationSet;
  copyOrder: typeof copyOrder;
  fkClosure: typeof fkClosure;
  digestTable: typeof digestTable;
  verifyGraduation: typeof verifyGraduation;
  resolveTargetRoutes: typeof resolveTargetRoutes;
  targetIdentity: typeof targetIdentity;
  probeTarget: typeof probeTarget;
  crossCheckRoutes: typeof crossCheckRoutes;
  graduationBlockers: typeof graduationBlockers;
  drainForGraduation: typeof drainForGraduation;
  freezeSource: typeof freezeSource;
  detectTriggerBypass: typeof detectTriggerBypass;
  copyTable: typeof copyTable;
  copySequences: typeof copySequences;
  deferIndexes: typeof deferIndexes;
  buildDeferredIndexes: typeof buildDeferredIndexes;
  reenableTriggers: typeof reenableTriggers;
  /** Open the PGLite source (full connect; `migrate` applies pending migrations). */
  openSource(dataDir: string, opts: { migrate: boolean }): Promise<GraduationSourceEngine>;
  /** A fresh, unconnected PGLite engine for a held-lock open. */
  newSourceEngine(): Promise<GraduationSourceEngine>;
  /** Main and DDL target engines; the DDL route is an explicit override (no pooler fallback). */
  connectTargets(routes: Routes): Promise<{ main: BrainEngine; ddl: BrainEngine; close(): Promise<void> }>;
  /** Target schema bootstrap, sized from the source's embedding layout. */
  initTargetSchema(target: BrainEngine, source: BrainEngine): Promise<void>;
  claimAutopilotPause(): Promise<(() => void) | null>;
  /** Failing check names of `gbrain doctor --no-migrate --json` against the fenced target. */
  runTargetDoctor(runId: string, mainUrl: string): Promise<{ failing: readonly string[]; exempted: readonly string[] }>;
  /** Failing source checks, measured with the source open under the run's lock. */
  runSourceDoctor(source: BrainEngine): Promise<readonly string[]>;
  hostId(): string;
  mountsPath(): string;
}

export function defaultGraduationDeps(): GraduationDeps {
  return {
    inventory: GRADUATION_INVENTORY,
    assertRelationSet, copyOrder, fkClosure, digestTable, verifyGraduation,
    resolveTargetRoutes, targetIdentity, probeTarget, crossCheckRoutes,
    graduationBlockers, drainForGraduation, freezeSource,
    detectTriggerBypass, copyTable, copySequences, deferIndexes, buildDeferredIndexes, reenableTriggers,
    async openSource(dataDir, opts) {
      const engine = await this.newSourceEngine();
      await engine.connect({ engine: 'pglite', database_path: dataDir });
      if (opts.migrate) {
        try {
          const { hasPendingMigrations } = await import('../migrate.ts');
          if (await hasPendingMigrations(engine)) await engine.initSchema();
        } catch (error) { await engine.disconnect(); throw error; }
      }
      return engine;
    },
    async newSourceEngine() {
      const { createEngine } = await import('../engine-factory.ts');
      return await createEngine({ engine: 'pglite' }) as GraduationSourceEngine;
    },
    async connectTargets(routes) {
      try { return await connectTargetEngines(routes); }
      catch (error) { throw mapTargetConnectError(error, routes); }
    },
    async initTargetSchema(target, source) {
      const layout = await sourceEmbeddingLayout(source);
      const chunks = layout.columns.find(c => c.relation === 'content_chunks' && c.column === 'embedding');
      const dimensions = chunks?.dims ?? (Number(layout.config.embedding_dimensions) || null);
      const model = layout.config.embedding_model;
      const sized = target as BrainEngine & { initSchema(opts?: { embedding?: { dimensions: number; model: string } }): Promise<void> };
      await sized.initSchema(dimensions && model ? { embedding: { dimensions, model } } : {});
    },
    claimAutopilotPause: () => withStdoutOnStderr(() => quiesceAutopilot()),
    async runTargetDoctor(runId, mainUrl) { return spawnTargetDoctor(runId, mainUrl); },
    async runSourceDoctor(source) {
      // In process, on the engine this run (or plan) already opened; GBRAIN_GRADUATION_RUN keeps doctor read-only.
      const { buildChecks } = await import('../../commands/doctor.ts');
      const prior = process.env.GBRAIN_GRADUATION_RUN;
      process.env.GBRAIN_GRADUATION_RUN = prior || 'source-doctor';
      try {
        const checks = await buildChecks(source, ['--json', '--scope=brain']);
        return checks.filter(c => c.status === 'fail').map(c => c.name);
      } finally {
        if (prior === undefined) delete process.env.GBRAIN_GRADUATION_RUN; else process.env.GBRAIN_GRADUATION_RUN = prior;
      }
    },
    hostId: () => localHostId(),
    mountsPath: () => process.env.GBRAIN_MOUNTS_PATH || join(homedir(), '.gbrain', 'mounts.json'),
  };
}

function withStdoutOnStderrSync(fn: () => void): void {
  const log = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try { fn(); } finally { console.log = log; }
}

async function withStdoutOnStderr<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try { return await fn(); } finally { console.log = log; }
}

function spawnTargetDoctor(runId: string, mainUrl: string): { failing: readonly string[]; exempted: readonly string[] } {
  const script = process.argv[1] && /\.(ts|js|mjs)$/.test(process.argv[1]) ? [process.argv[1]] : [];
  const child = spawnSync(process.execPath, [...script, 'doctor', '--no-migrate', '--json', '--scope=brain'], {
    env: { ...process.env, GBRAIN_DATABASE_URL: mainUrl, GBRAIN_GRADUATION_RUN: runId },
    encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
  });
  try {
    const doc = JSON.parse(child.stdout) as { checks?: Array<{ name?: string; status?: string; details?: { graduation_exempt?: boolean } }> };
    if (!Array.isArray(doc.checks)) return { failing: ['doctor_output_unreadable'], exempted: [] };
    return { failing: doc.checks.filter(c => c.status === 'fail').map(c => String(c.name ?? 'unnamed')),
      exempted: doc.checks.filter(c => c.details?.graduation_exempt === true).map(c => String(c.name ?? 'unnamed')) };
  } catch { return { failing: ['doctor_unavailable'], exempted: [] }; }
}

function mapTargetConnectError(error: unknown, routes: Routes): unknown {
  const e = error as { code?: string; message?: string };
  if (e?.code === '28P01' || /password authentication failed/i.test(e?.message ?? '')) {
    return targetAuthFailedError({ host: routes.main, ...(routes.urlEnv ? { urlEnv: routes.urlEnv } : {}) });
  }
  if (/unsupported startup parameter/i.test(e?.message ?? '')) {
    return targetUnsupportedError({ requirement: 'pooler_startup_parameters', host: routes.main,
      detail: 'the connection pooler refuses the statement_timeout and idle_in_transaction_session_timeout startup parameters gbrain sends; add both to ignore_startup_parameters in pgbouncer.ini, or point --url-env (and GBRAIN_DIRECT_DATABASE_URL) at a direct or session-mode connection',
      ...(routes.urlEnv ? { spelling: { urlEnv: routes.urlEnv } } : {}) });
  }
  return error;
}

// ── manifest v3 ────────────────────────────────────────────────────────────

export function graduationManifestPath(): string { return join(configDir(), 'graduation-manifest.json'); }

export function readGraduationManifest(path = graduationManifestPath()): GraduationManifest | null {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const parsed = JSON.parse(raw) as GraduationManifest;
  if (parsed?.version !== GRADUATION_MANIFEST_VERSION) throw new Error(`Unsupported graduation manifest at ${path} (version ${String(parsed?.version)}).`);
  return parsed;
}

/** Atomic write + fsync, mode 0600 (it holds the full target URLs). */
export function writeGraduationManifest(manifest: GraduationManifest, path = graduationManifestPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileDurably(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Apply a manifest transition from MANIFEST_TRANSITIONS; an illegal one throws. */
export function transitionManifest(manifest: GraduationManifest, to: ManifestState): void {
  if (manifest.state !== to) assertTransition(MANIFEST_TRANSITIONS, manifest.state, to);
  manifest.state = to;
  manifest.updatedAt = new Date().toISOString();
}

export function redactManifest(manifest: GraduationManifest): Omit<GraduationManifest, 'targetUrls'> {
  const { targetUrls: _secret, ...rest } = manifest;
  return rest;
}

// ── options ────────────────────────────────────────────────────────────────

export interface GraduationProgressEvent {
  phase: string;
  state?: ManifestState;
  relation?: string;
  rows?: number;
  done?: number;
  total?: number;
  message?: string;
}

/** Seams beyond the CLI surface: tests and embedders. The CLI passes `GraduationCommandOptions` only. */
export interface GraduationInternals {
  /** The source brain config; defaults to the config file (never env overrides). */
  config?: GBrainConfig;
  env?: NodeJS.ProcessEnv;
  manifestPath?: string;
  deps?: Partial<GraduationDeps>;
  onProgress?: (event: GraduationProgressEvent) => void;
  /** Crash-test seam; defaults to GBRAIN_GRADUATION_PAUSE_AT. */
  pauseAt?: string;
  /** In-process tests: awaited at the pause seam instead of blocking. */
  pauseHook?: (step: string) => Promise<void>;
  handoffTimeoutMs?: number;
}

export type GraduationOptions = GraduationCommandOptions & GraduationInternals;
type RunOptions = Partial<GraduationCommandOptions> & GraduationInternals;

// ── run context ────────────────────────────────────────────────────────────

interface Run {
  m: GraduationManifest;
  path: string;
  deps: GraduationDeps;
  opts: RunOptions;
  /** True when a live serve handed the source over during this process. */
  serveHandoff: boolean;
  dataDir: string;
  source: GraduationSourceEngine | null;
  lock: LockHandle | null;
  main: BrainEngine | null;
  ddl: BrainEngine | null;
  closeTargets: (() => Promise<void>) | null;
  resumePause: (() => void) | null;
  unregister: () => void;
}

function newRun(m: GraduationManifest, path: string, opts: Run['opts']): Run {
  return {
    m, path, opts, deps: { ...defaultGraduationDeps(), ...opts.deps }, dataDir: m.source.dataDir,
    source: null, lock: null, main: null, ddl: null, closeTargets: null, resumePause: null, serveHandoff: false, unregister: registerGraduationRunInProcess(m.runId),
  };
}

function progress(run: Pick<Run, 'opts'>, event: GraduationProgressEvent): void { run.opts.onProgress?.(event); }
function phase(run: Pick<Run, 'opts'>, name: GraduationPhase, total?: number): void {
  run.opts.progress?.phase(name, total);
  progress(run, { phase: name, ...(total !== undefined ? { total } : {}) });
}

/** SIGINT stops the run at the next boundary before cutover, leaving a resumable state. */
function checkInterrupt(run: Run): void {
  if (!run.opts.signal?.aborted || STATE_RANK[run.m.state] >= STATE_RANK.cutover) return;
  throw opError('interrupted', `The move stopped after an interrupt at ${run.m.state}; it is resumable.`,
    'Resume it when ready (fix); nothing was cut over and the PGLite brain stays authoritative.',
    { why: 'An interrupt stops the run at the next custody boundary before cutover.',
      fix: { argv: resumeArgv(), consent: [], actor: 'agent', requires_exclusive: true, why: 'Continues from the recorded state.', verify: { argv: STATUS_ARGV } } });
}

function markerFor(run: Run): IntentMarker {
  return { runId: run.m.runId, state: run.m.state, ...currentProcessIdentity(), target: run.m.target, updatedAt: new Date().toISOString() };
}

/** Persist a manifest transition and mirror it into the intent marker (terminal states remove the marker). */
function advance(run: Run, to: ManifestState, patch: Partial<GraduationManifest> = {}): void {
  transitionManifest(run.m, to);
  Object.assign(run.m, patch);
  writeGraduationManifest(run.m, run.path);
  if (to === 'rolled_back' || to === 'abandoned') removeIntentMarker(run.dataDir);
  else writeIntentMarker(run.dataDir, markerFor(run));
  progress(run, { phase: 'state', state: to });
}

function save(run: Run): void {
  run.m.updatedAt = new Date().toISOString();
  writeGraduationManifest(run.m, run.path);
}

/**
 * A custody boundary: announced right after the step's durable write
 * (test hooks may SIGKILL here), then the GBRAIN_GRADUATION_PAUSE_AT seam
 * under the same name.
 */
async function boundary(run: Run, name: GraduationBoundary, detail: GraduationBoundaryDetail = {}): Promise<void> {
  await graduationBoundary(name, { runId: run.m.runId, ...detail });
  await pauseSeam(run, name);
  checkInterrupt(run);
}

async function pauseSeam(run: Pick<Run, 'opts'>, step: string): Promise<void> {
  const env = run.opts.env ?? process.env;
  if ((run.opts.pauseAt ?? env.GBRAIN_GRADUATION_PAUSE_AT) !== step) return;
  progress(run, { phase: 'paused', message: step });
  if (run.opts.pauseHook) { await run.opts.pauseHook(step); return; }
  process.stderr.write(`[graduation] paused at ${step} (GBRAIN_GRADUATION_PAUSE_AT)\n`);
  const release = env.GBRAIN_GRADUATION_PAUSE_RELEASE;
  for (;;) {
    if (release && existsSync(release)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function cleanup(run: Run): Promise<void> {
  const errors: unknown[] = [];
  const attempt = async (fn: () => Promise<void> | void) => { try { await fn(); } catch (error) { errors.push(error); } };
  if (run.source) { const source = run.source; run.source = null; await attempt(() => source.disconnect()); }
  if (run.lock) { const lock = run.lock; run.lock = null; await attempt(() => releaseLock(lock)); }
  if (run.closeTargets) { const close = run.closeTargets; run.closeTargets = null; await attempt(close); }
  run.main = null; run.ddl = null;
  if (run.resumePause) { const resume = run.resumePause; run.resumePause = null; await attempt(resume); }
  run.unregister();
  if (errors.length) process.stderr.write(`[graduation] cleanup: ${errors.map(String).join('; ')}\n`);
}

function invokedAs(run: { m: GraduationManifest }): GraduationTargetSpelling { return run.m.invokedAs ?? 'postgres'; }
function spellingOf(run: { m: GraduationManifest }): { to: GraduationTargetSpelling; urlEnv?: string } {
  return { to: invokedAs(run), ...(run.m.routes.urlEnv ? { urlEnv: run.m.routes.urlEnv } : {}) };
}
/** Escape hatches the user passed; every emitted command repeats them so the plan hash matches. */
function hatchArgs(input: Pick<PlanInputs, 'force' | 'triggerBypassOverride' | 'batchBytes'>): string[] {
  return [
    ...(input.triggerBypassOverride ? ['--trigger-bypass', input.triggerBypassOverride === 'session_replication_role' ? 'replica' : 'disable-trigger'] : []),
    ...(input.batchBytes ? ['--batch-size', String(input.batchBytes)] : []),
    ...(input.force ? ['--force'] : []),
  ];
}

// ── plan ───────────────────────────────────────────────────────────────────

interface PlanInputs {
  config: GBrainConfig;
  env: NodeJS.ProcessEnv;
  routes: Routes;
  target: TargetIdentity;
  invokedAs: GraduationTargetSpelling;
  force: boolean;
  triggerBypassOverride?: TriggerBypass;
  batchBytes?: number;
}

function sourceConfig(opts: RunOptions): GBrainConfig {
  const config = opts.config ?? loadConfigFileOnly();
  if (!config) {
    throw opError('no_brain', 'No brain is configured on this machine.', 'Run `gbrain init --pglite --no-embedding` first.',
      { fix: { argv: ['gbrain', 'init', '--pglite', '--no-embedding'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Creates a local PGLite brain.' } });
  }
  return config;
}

function sourceDataDir(config: GBrainConfig): string {
  if (config.engine !== 'pglite' || !config.database_path) {
    throw opError('invalid_params', 'Engine graduation moves a PGLite brain; this brain is not configured as PGLite.',
      'Run graduation only from a PGLite brain (`gbrain engine status --json` shows the configured engine).',
      { why: 'Graduation copies a PGLite datastore into Postgres; other directions use the legacy copier.',
        fix: { argv: ['gbrain', 'engine', 'status', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the configured engine and datastore.' } });
  }
  return graduationDataDir(config.database_path);
}

function planHashOf(input: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value as object).sort().map(k => [k, canonical((value as Record<string, unknown>)[k])]))
      : value;
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex').slice(0, 16);
}

function probeTargetEmpty(probe: TargetProbe): boolean { return probe.empty; }

/** initSchema writes these config keys (plus the copier's deferred-index marker); any other key is user data. */
// The trust migrations seed two bookkeeping keys on an empty brain (v226 backfill completion, v227 scan baseline).
const SEED_CONFIG_KEYS = new Set(['chunk_strategy', 'embedding_dimensions', 'embedding_model', 'engine', 'version', 'graduation.deferred_indexes',
  TRUST_BACKFILL_COMPLETED_KEY, WRITE_GATE_SCAN_BASELINE_KEY]);
async function userConfigKeys(main: BrainEngine): Promise<string[]> {
  const rows = await main.executeRaw<{ key: string }>('SELECT key FROM config ORDER BY key COLLATE "C"');
  return rows.map(r => r.key).filter(key => !SEED_CONFIG_KEYS.has(key));
}

function planArgvFor(input: Pick<PlanInputs, 'invokedAs' | 'routes'>): string[] {
  return planArgvOf({ to: input.invokedAs, ...(input.routes.urlEnv ? { urlEnv: input.routes.urlEnv } : {}) });
}

async function countTables(source: BrainEngine, inventory: Inventory): Promise<GraduationPlan['tables']> {
  const relations = inventory.entries.filter(e => e.kind === 'table' && e.engines.pglite).map(e => e.relation);
  const present = await source.executeRaw<{ relname: string; q: string; bytes: string }>(
    `SELECT c.relname, quote_ident(c.relname) AS q, pg_total_relation_size(c.oid)::text AS bytes FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind IN ('r','p') AND c.relname = ANY($1::text[])`, [relations]);
  const byName = new Map(present.map(r => [r.relname, r]));
  const rows: GraduationPlan['tables'][number][] = [];
  for (const entry of inventory.entries) {
    const found = byName.get(entry.relation);
    if (!found) continue;
    const [count] = await source.executeRaw<{ n: string }>(`SELECT count(*)::text AS n FROM ${found.q}`);
    rows.push({ relation: entry.relation, class: entry.class, rows: Number(count?.n ?? 0), bytes: Number(found.bytes) });
  }
  return rows;
}

function envOverrideBlockers(env: NodeJS.ProcessEnv, routes: Routes): GraduationBlocker[] {
  return (['GBRAIN_DATABASE_URL', 'DATABASE_URL'] as const)
    .filter(name => env[name] && env[name] !== routes.mainUrl)
    .map(name => ({ kind: 'env_override' as const, id: name, needsUser: true,
      detail: `${name} is set in this environment and would override the routing flip; unset it (or point it at the target) before graduating.` }));
}

/** Read-only plan assembly over an open source (or none when a live serve holds it) and a target session. */
async function assemblePlan(deps: GraduationDeps, input: PlanInputs, source: BrainEngine | null, main: BrainEngine | null, targetOurs: boolean): Promise<GraduationPlan> {
  const dataDir = sourceDataDir(input.config);
  const hostId = deps.hostId();
  const blockers: GraduationBlocker[] = [...envOverrideBlockers(input.env, input.routes)];
  if (process.platform === 'win32') {
    blockers.push({ kind: 'unsupported_platform', id: 'win32', needsUser: true, detail: 'Engine graduation is unavailable on Windows until its tombstone and crash tests run there.' });
  }
  let brainId = '';
  let tables: GraduationPlan['tables'] = [];
  if (source) {
    try { await deps.assertRelationSet(source, 'pglite', deps.inventory); }
    catch (error) { blockers.push({ kind: 'unclassified_relation', id: 'source', needsUser: false, detail: (error as Error).message }); }
    blockers.push(...await deps.graduationBlockers(source, hostId));
    for (const failing of await deps.runSourceDoctor(source)) {
      blockers.push({ kind: 'source_doctor', id: failing, needsUser: true, detail: `Doctor check ${failing} fails on the source; fix it before graduating.`, argv: ['gbrain', 'doctor', '--json'] });
    }
    const [brain] = await source.executeRaw<{ brain_id: string }>('SELECT brain_id::text AS brain_id FROM persistence_brain WHERE singleton = 1');
    brainId = brain?.brain_id ?? '';
    tables = await countTables(source, deps.inventory);
  }
  const probe = await deps.probeTarget(input.routes);
  assertTargetReachable(probe, input.routes);
  const layout = source ? await sourceEmbeddingLayout(source) : { columns: [] };
  const userConfig = main && probe.gbrainSchema && !targetOurs ? await userConfigKeys(main) : [];
  const targetAcceptable = targetOurs || (probe.empty && !userConfig.length);
  for (const blocker of targetProbeBlockers(probe, input.routes, layout.columns)) {
    if (blocker.kind === 'target_not_empty' && (targetOurs || input.force)) continue;
    blockers.push(blocker);
  }
  if (userConfig.length && !input.force) {
    blockers.push({ kind: 'target_not_empty', id: 'config', needsUser: true, argv: planArgvFor(input),
      detail: `the target config holds keys initSchema does not write: ${userConfig.slice(0, 10).join(', ')}` });
  }
  const triggerBypass = chooseTriggerBypass(probe, input.triggerBypassOverride) ?? (main && !input.triggerBypassOverride ? await deps.detectTriggerBypass(main) : null);
  if (!triggerBypass && !blockers.some(b => b.kind === 'target_unsupported' && b.id === 'trigger_bypass')) {
    blockers.push({ kind: 'target_unsupported', id: 'trigger_bypass', needsUser: true, detail: 'The requested trigger bypass is not permitted for the target role.' });
  }
  let forceSnapshot: Array<[string, string]> | null = null;
  if (input.force && !targetAcceptable && main) {
    forceSnapshot = [];
    for (const entry of deps.inventory.entries.filter(e => e.lossKind === 'user_data' && e.engines.postgres && e.kind === 'table')) {
      const [present] = await main.executeRaw<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [entry.relation]);
      if (present?.ok) forceSnapshot.push([entry.relation, (await deps.digestTable(main, entry)).rootSha256]);
    }
  }
  const planHash = planHashOf({
    v: 1, source: { dataDir, hostId }, target: input.target.id, inventory: deps.inventory.version, schema: LATEST_VERSION,
    classes: deps.inventory.entries.map(e => `${e.relation}:${e.class}`).sort(),
    blockers: blockers.filter(b => b.needsUser).map(b => `${b.kind}:${b.id}`).sort(),
    triggerBypass, targetAcceptable, force: input.force, forceSnapshot, batchBytes: input.batchBytes ?? null,
  });
  const rows = tables.filter(t => t.class === 'carry' || t.class === 'rebind').reduce((sum, t) => sum + t.rows, 0);
  const bytes = tables.filter(t => t.class === 'carry' || t.class === 'rebind').reduce((sum, t) => sum + t.bytes, 0);
  const copy = Math.ceil(rows / 5_000 + bytes / 20_000_000);
  const verify = Math.ceil(copy * 0.6);
  const doctor = 30;
  return {
    planHash, source: { dataDir, brainId, hostId }, target: input.target, routes: { main: input.routes.main, ddl: input.routes.ddl, ...(input.routes.urlEnv ? { urlEnv: input.routes.urlEnv } : {}) },
    triggerBypass, tables, blockers, estimateSeconds: { copy, verify, doctor, total: copy + verify + doctor },
    sourceMeasured: source ? 'now' : 'at_run_start',
    nextArgv: runArgvOf({ to: input.invokedAs, ...(input.routes.urlEnv ? { urlEnv: input.routes.urlEnv } : {}) }, planHash, hatchArgs(input)),
  };
}

function planInputs(deps: GraduationDeps, opts: RunOptions): PlanInputs {
  const env = opts.env ?? process.env;
  const routes = deps.resolveTargetRoutes({ url: opts.url, urlEnv: opts.urlEnv, env });
  return { config: sourceConfig(opts), env, routes, target: deps.targetIdentity(routes.mainUrl), invokedAs: opts.to ?? 'postgres',
    force: !!opts.force, triggerBypassOverride: opts.triggerBypass, batchBytes: opts.batchSize };
}

function refuseOnPathState(state: GraduationPathState): void {
  if (state.state === 'graduated') throw engineGraduatedFor(state, 'cli');
  if (state.state === 'split_brain') throw splitBrainFor(state);
  if (state.state === 'in_progress' && state.marker) throw inProgressError({ runId: state.marker.runId, state: state.marker.state, pid: state.marker.pid, dataDir: state.dataDir });
}

/**
 * The read-only plan: zero mutations on either engine (no schema migration,
 * no target DDL, no marker). The source opens through a probe-only connect
 * under a short kernel-lock hold; a live serve holding it marks counts
 * `measured at run start`.
 */
export async function planGraduation(opts: GraduationOptions): Promise<GraduationPlan> {
  const deps = { ...defaultGraduationDeps(), ...opts.deps };
  const input = planInputs(deps, opts);
  const dataDir = sourceDataDir(input.config);
  phase({ opts }, 'plan');
  const recorded = readGraduationManifest(opts.manifestPath ?? graduationManifestPath());
  if (recorded && !TERMINAL_STATES.has(recorded.state)) throw existingRunError(recorded);
  refuseOnPathState(inspectGraduationPath(dataDir));
  let source: GraduationSourceEngine | null = null;
  let targets: { main: BrainEngine; close(): Promise<void> } | null = null;
  try {
    try { source = await deps.openSource(dataDir, { migrate: false }); }
    catch (error) { if (!(error instanceof PgliteBusyError)) throw error; }
    targets = await deps.connectTargets(input.routes);
    return await assemblePlan(deps, input, source, targets.main, false);
  } finally {
    if (source) await source.disconnect();
    if (targets) await targets.close();
  }
}

// ── run ────────────────────────────────────────────────────────────────────

/** Blockers the drain resolves inside --drain-timeout; every other blocker refuses before anything is fenced. */
const DRAIN_RESOLVED_BLOCKERS: ReadonlySet<GraduationBlocker['kind']> = new Set(['request', 'topology_recovery', 'effect_recovery']);
function refusesRun(blocker: GraduationBlocker): boolean { return blocker.needsUser || !DRAIN_RESOLVED_BLOCKERS.has(blocker.kind); }

function blockerRefusal(blocker: GraduationBlocker, run: { m: GraduationManifest; opts: RunOptions }, probe?: TargetProbe): OperationError {
  const spelling = spellingOf(run);
  const host = run.m.routes.main;
  switch (blocker.kind) {
    case 'foreign_host_binding':
      return foreignHostBindingError({ sourceId: blocker.argv?.at(-1) ?? blocker.id, ownerHost: /host ([0-9a-f-]+)/.exec(blocker.detail)?.[1] ?? 'another host', spelling });
    case 'target_not_empty':
      return targetNotEmptyError({ host, tables: (probe?.nonEmptyTables ?? [blocker.id]).map(relation => ({ relation, rows: -1 })), spelling });
    case 'unsupported_platform':
      return unsupportedPlatformError({ platform: process.platform });
    case 'embedding_dimension': {
      const m = /source (\S+), target (\S+)/.exec(blocker.detail);
      return embeddingDimensionMismatchError({ column: blocker.id, source: m?.[1] ?? 'unknown', target: m?.[2] ?? 'unknown', host, spelling });
    }
    case 'target_unsupported':
    case 'env_override':
      return targetUnsupportedError({ requirement: blocker.kind === 'env_override' ? 'env_override' : blocker.id, detail: blocker.detail, host, spelling });
    case 'writer_held':
      return sourceWriterHeldError({ owner: null, rerun: runArgvOf(spelling, run.m.planHash) });
    default:
      return drainTimeoutError({ blockers: [blocker], timeoutSec: Math.ceil((run.opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS) / 1000) });
  }
}

function planArgv(run: { m: GraduationManifest }, extra: readonly string[] = []): string[] {
  return planArgvOf(spellingOf(run), extra);
}

function writerHeldError(run: Run, error: unknown): OperationError {
  const peek = peekLock(run.dataDir);
  const holder = inspectLockHolder(run.dataDir);
  const owner = liveServeOwner(error) ?? (peek.held && peek.isServe && peek.pid ? { pid: peek.pid, transport: peek.http ? 'http' as const : 'stdio' as const, is_self: false } : null);
  return sourceWriterHeldError({ owner, ...(peek.pid ? { pid: peek.pid } : {}), ...(holder.subcommand ? { subcommand: holder.subcommand } : {}),
    rerun: runArgvOf(spellingOf(run), run.m.planHash) });
}

async function openSourceUnderLock(run: Run): Promise<void> {
  const deadline = Date.now() + (run.opts.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS);
  for (;;) {
    try { run.source = await run.deps.openSource(run.dataDir, { migrate: true }); return; }
    catch (error) {
      if (!(error instanceof PgliteBusyError)) throw error;
      if (Date.now() >= deadline) throw writerHeldError(run, error);
      run.serveHandoff = true;
      progress(run, { phase: 'handoff', message: 'waiting for the live serve to hand off the datastore' });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

async function claimPause(run: Run): Promise<void> {
  if (run.resumePause) return;
  const resume = await run.deps.claimAutopilotPause();
  if (!resume) throw inProgressError({ runId: run.m.runId, state: run.m.state, dataDir: run.dataDir });
  run.resumePause = () => withStdoutOnStderrSync(resume);
}

function recordedRoutes(run: Run): Routes {
  const urls = run.m.targetUrls;
  if (!urls) throw new Error('The graduation manifest has no target URLs.');
  return { ...run.m.routes, mainUrl: urls.main, ddlUrl: urls.ddl };
}

async function openTargets(run: Run): Promise<void> {
  if (run.main && run.ddl) return;
  const targets = await run.deps.connectTargets(recordedRoutes(run));
  run.main = targets.main; run.ddl = targets.ddl; run.closeTargets = targets.close;
}

/** Step 1 (fresh run): marker before the lock, pause marker, source under the lock, in-run plan bound to the approval. */
async function quiesceFresh(run: Run, input: PlanInputs, expect: string): Promise<void> {
  phase(run, 'quiesce');
  writeGraduationManifest(run.m, run.path);
  writeIntentMarker(run.dataDir, markerFor(run));
  await claimPause(run);
  await openSourceUnderLock(run);
  await openTargets(run);
  await run.deps.crossCheckRoutes(run.main!, run.ddl!, run.m.runId);
  const plan = await assemblePlan(run.deps, input, run.source, run.main, false);
  if (plan.planHash !== expect) throw previewChanged(run, hatchArgs(input), plan.planHash);
  const blocker = plan.blockers.find(refusesRun);
  if (blocker) throw blockerRefusal(blocker, run);
  run.m.source = plan.source;
  run.m.triggerBypass = plan.triggerBypass!;
  const [pending] = await run.source!.executeRaw<{ request_id: string | null }>(
    `SELECT request_id::text AS request_id FROM persistence_requests WHERE state IN ('queued','running','recovering') ORDER BY sequence LIMIT 1`).catch(() => [{ request_id: null }]);
  run.m.replayRequestId = pending?.request_id ?? null;
  save(run);
}

function previewChanged(run: { m: GraduationManifest }, extra: readonly string[], freshHash: string): OperationError {
  return opError('preview_changed', 'The brain or target changed since the approved plan; nothing was moved.',
    'Show the user the fresh plan (fix) and run the move with its plan_hash after they agree.',
    { why: 'The approval binds identities, inventory, person-needed blockers, trigger bypass and target emptiness; one of them changed.',
      fix: { argv: planArgv(run, extra), consent: [], actor: 'agent', requires_exclusive: false, plan_hash: freshHash,
        why: 'Shows the fresh read-only plan and its plan_hash.', verify: { argv: planArgv(run, extra) } } });
}

/** Step 1 on resume: same custody, recorded identities; before cutover the recorded approval must still match. */
async function quiesceResume(run: Run): Promise<void> {
  phase(run, 'quiesce');
  writeIntentMarker(run.dataDir, markerFor(run));
  await claimPause(run);
  await openSourceUnderLock(run);
  const [brain] = await run.source!.executeRaw<{ brain_id: string }>('SELECT brain_id::text AS brain_id FROM persistence_brain WHERE singleton = 1');
  if (run.m.source.brainId && brain?.brain_id !== run.m.source.brainId) {
    throw splitBrainFor({ dataDir: run.dataDir, movedTo: existsSync(graduatedPath(run.dataDir, run.m.runId)) ? graduatedPath(run.dataDir, run.m.runId) : null });
  }
  await openTargets(run);
  if (STATE_RANK[run.m.state] < STATE_RANK.cutover) await recheckApproval(run);
}

async function recheckApproval(run: Run): Promise<void> {
  const config = run.opts.config ?? loadConfigFileOnly() ?? ({ engine: 'pglite', database_path: run.dataDir } as GBrainConfig);
  const row = await readGraduationRow(run.main!);
  const input: PlanInputs = {
    config: { ...config, engine: 'pglite', database_path: run.dataDir }, env: run.opts.env ?? process.env,
    routes: { ...run.m.routes, mainUrl: run.m.targetUrls!.main, ddlUrl: run.m.targetUrls!.ddl }, target: run.m.target,
    invokedAs: invokedAs(run), force: false, triggerBypassOverride: run.m.triggerBypass, batchBytes: run.m.batchSize,
  };
  const ours = row?.role === 'target' && row.run_id === run.m.runId;
  const plan = await assemblePlan(run.deps, input, run.source, run.main, ours);
  const blocker = plan.blockers.find(refusesRun);
  if (blocker) throw blockerRefusal(blocker, run);
  if (!run.m.force && plan.planHash !== run.m.planHash) throw previewChanged(run, [], plan.planHash);
}

async function sourceReceipts(run: Run): Promise<TableReceipt[]> {
  const receipts: TableReceipt[] = [];
  for (const entry of await run.deps.copyOrder(run.source!, run.deps.inventory)) {
    receipts.push(await run.deps.digestTable(run.source!, entry, { applyTransforms: true }));
  }
  return receipts;
}

function changedRelations(before: readonly TableReceipt[], after: readonly TableReceipt[]): string[] {
  const old = new Map(before.map(r => [r.relation, r.rootSha256]));
  return after.filter(r => old.get(r.relation) !== r.rootSha256).map(r => r.relation)
    .concat(before.filter(r => !after.some(a => a.relation === r.relation)).map(r => r.relation));
}

/** Mark relations and their FK dependency closure for re-copy. */
async function markForRecopy(run: Run, relations: readonly string[]): Promise<void> {
  const closure = new Set<string>();
  for (const relation of relations) {
    closure.add(relation);
    for (const child of await run.deps.fkClosure(run.source!, relation)) closure.add(child);
  }
  run.m.tables = run.m.tables.map(t => closure.has(t.relation) ? { ...t, state: 'pending' as const, batches: 0 } : t);
}

/** Lock-gap re-check: a resumed run before the tombstone recomputes source digests; any change returns it to the drain. */
async function lockGapRecheck(run: Run): Promise<void> {
  const state = run.m.state;
  if (!run.m.sourceReceipts?.length || STATE_RANK[state] < STATE_RANK.copying || STATE_RANK[state] > STATE_RANK.cutover) return;
  const changed = changedRelations(run.m.sourceReceipts, await sourceReceipts(run));
  const failed = state === 'verify_failed' ? (run.m.verifyFailures ?? []).map(f => f.relation).filter(Boolean) : [];
  if (!changed.length && !failed.length) return;
  await markForRecopy(run, [...changed, ...failed]);
  progress(run, { phase: 'lock_gap', message: changed.length ? `source changed while unlocked: ${changed.join(', ')}` : `re-copying ${failed.join(', ')}` });
  if (state === 'cutover') await withSourceWritable(run.source!, tx => setSourceState(tx, run.m.runId, 'quiesced'));
  const row = await readGraduationRow(run.main!);
  if (row?.run_id === run.m.runId && (row.state === 'verifying' || row.state === 'verified')) {
    await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'copying'));
  }
  advance(run, changed.length ? 'draining' : 'copying');
}

async function stepRecord(run: Run): Promise<void> {
  await withSourceWritable(run.source!, tx => setSourceState(tx, run.m.runId, 'quiesced', { sourceBrainId: run.m.source.brainId || null, sourceDataDir: run.dataDir }));
  advance(run, 'quiesced');
  await boundary(run, 'quiesced');
}

async function stepDrain(run: Run): Promise<void> {
  if (run.m.state !== 'draining') advance(run, 'draining');
  phase(run, 'drain');
  await boundary(run, 'drain_started');
  const started = Date.now();
  const timeoutMs = run.opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const { blockers } = await run.deps.drainForGraduation(run.source!, { timeoutMs, hostId: run.m.source.hostId, config: sourceConfig(run.opts) });
  if (blockers.length) throw drainTimeoutError({ blockers, timeoutSec: Math.ceil(timeoutMs / 1000) });
  await run.deps.freezeSource(run.source!);
  const receipts = await sourceReceipts(run);
  if (run.m.sourceReceipts?.length) await markForRecopy(run, changedRelations(run.m.sourceReceipts, receipts));
  run.m.sourceReceipts = receipts;
  run.m.timings = { ...run.m.timings, drain_ms: Date.now() - started };
  save(run);
  await boundary(run, 'drained');
}

/** Step 4: route cross-check, read-only emptiness, schema, target row `copying`, fence, emptiness again under the fence. */
async function stepFenceTarget(run: Run, opts: { force?: boolean }): Promise<void> {
  const { main, ddl } = run as Required<Pick<Run, 'main' | 'ddl'>>;
  phase(run, 'schema');
  await run.deps.crossCheckRoutes(main!, ddl!, run.m.runId);
  const existing = await readGraduationRow(main!);
  const ours = existing?.role === 'target' && existing.run_id === run.m.runId;
  const reuse = !!opts.force && existing?.role === 'target' && existing.state === 'abandoned';
  if (!ours) {
    const routes = recordedRoutes(run);
    if (existing && !reuse) throw notEmpty(run, [{ relation: `persistence_graduation (run ${existing.run_id}, ${existing.state})`, rows: 1 }]);
    if (!existing) {
      const probe = await run.deps.probeTarget(routes);
      if (!probeTargetEmpty(probe) && !opts.force) throw notEmpty(run, await tableCounts(main!, probe.nonEmptyTables));
    }
    await run.deps.initTargetSchema(ddl!, run.source!);
    await withGraduationRun(main!, existing?.run_id ?? run.m.runId, tx => setTargetState(tx, run.m.runId, 'copying', { sourceBrainId: run.m.source.brainId || null, sourceDataDir: run.dataDir, triggerBypass: run.m.triggerBypass }, { reuse }));
    await installGraduationFence(ddl!, run.m.runId);
    if (!opts.force) {
      const probe = await run.deps.probeTarget(routes);
      if (!probeTargetEmpty(probe)) throw notEmpty(run, await tableCounts(main!, probe.nonEmptyTables));
    }
    if (opts.force) await wipeUncopiedTables(run);
    await boundary(run, 'target_fenced');
    return;
  }
  if ((await graduationFenceStatus(ddl!)).unfenced.length && existing!.state !== 'authoritative') await installGraduationFence(ddl!, run.m.runId);
}

/** `--force`: clear the tables the copy does not replace (rebuild and discard classes); carried tables are replaced by the copy. */
async function wipeUncopiedTables(run: Run): Promise<void> {
  const relations = run.deps.inventory.entries.filter(e => (e.class === 'rebuild' || e.class === 'discard') && e.engines.postgres && e.kind === 'table').map(e => e.relation);
  await withGraduationRun(run.main!, run.m.runId, async tx => {
    const present = await tx.executeRaw<{ q: string }>(`SELECT quote_ident(c.relname) AS q FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname = ANY($1::text[])`, [relations]);
    if (present.length) await tx.executeRaw(`TRUNCATE ${present.map(r => r.q).join(', ')}`);
  });
}

function notEmpty(run: Run, tables: readonly { relation: string; rows: number }[]): OperationError {
  return targetNotEmptyError({ host: run.m.routes.main, tables, spelling: spellingOf(run) });
}

async function tableCounts(engine: BrainEngine, relations: readonly string[]): Promise<Array<{ relation: string; rows: number }>> {
  const out: Array<{ relation: string; rows: number }> = [];
  for (const relation of relations.slice(0, 10)) {
    const [q] = await engine.executeRaw<{ q: string | null }>('SELECT CASE WHEN to_regclass($1) IS NULL THEN NULL ELSE quote_ident($1) END AS q', [relation]);
    if (!q?.q) continue;
    const [n] = await engine.executeRaw<{ n: string }>(`SELECT count(*)::text AS n FROM ${q.q}`);
    out.push({ relation, rows: Number(n?.n ?? 0) });
  }
  return out;
}

/** Step 5: per-table copy with manifest checkpoints, then sequences, deferred indexes and trigger re-enable. */
async function stepCopy(run: Run): Promise<void> {
  if (run.m.state !== 'copying') advance(run, 'copying');
  const row = await readGraduationRow(run.main!);
  if (row?.state === 'verifying' || row?.state === 'verified' || row?.state === 'verify_failed') {
    await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'copying'));
  }
  const started = Date.now();
  const engines = { source: run.source!, target: run.main! };
  const order = await run.deps.copyOrder(run.source!, run.deps.inventory);
  const known = new Map(run.m.tables.map(t => [t.relation, t]));
  run.m.tables = order.map(e => known.get(e.relation) ?? { relation: e.relation, state: 'pending', batches: 0, disabledTriggers: false });
  save(run);
  const pending = order.filter(e => !['copied', 'verified'].includes(known.get(e.relation)?.state ?? 'pending'));
  phase(run, 'copy', pending.length);
  if (pending.length) await run.deps.deferIndexes(run.main!, { runId: run.m.runId });
  const sourceRows = new Map((run.m.sourceReceipts ?? []).map(r => [r.relation, r.rows]));
  let done = order.length - pending.length;
  for (const entry of pending) {
    checkInterrupt(run);
    setCheckpoint(run, entry.relation, { state: 'copying', batches: 0, disabledTriggers: run.m.triggerBypass === 'disable_trigger' });
    run.opts.progress?.table(entry.relation, sourceRows.get(entry.relation) ?? 0);
    let batches = 0;
    await run.deps.copyTable(engines, entry, { bypass: run.m.triggerBypass, batchBytes: run.m.batchSize, runId: run.m.runId,
      onBatch: async rows => {
        batches += 1;
        run.opts.progress?.batch(entry.relation, rows);
        progress(run, { phase: 'copy', relation: entry.relation, rows, done, total: order.length });
        await graduationBoundary('batch_copied', { runId: run.m.runId, relation: entry.relation, batch: batches });
        checkInterrupt(run);
      } });
    setCheckpoint(run, entry.relation, { state: 'copied', batches });
    done += 1;
    await boundary(run, 'table_copied', { relation: entry.relation });
  }
  await run.deps.copySequences(engines, { runId: run.m.runId });
  phase(run, 'indexes');
  await run.deps.buildDeferredIndexes(run.ddl!, { runId: run.m.runId, log: line => progress(run, { phase: 'index', message: line }) });
  const disabled = run.m.tables.filter(t => t.disabledTriggers).map(t => t.relation);
  if (disabled.length) {
    await run.deps.reenableTriggers(run.main!, disabled, { runId: run.m.runId });
    run.m.tables = run.m.tables.map(t => ({ ...t, disabledTriggers: false }));
  }
  run.m.timings = { ...run.m.timings, copy_ms: (run.m.timings.copy_ms ?? 0) + Date.now() - started };
  save(run);
  await boundary(run, 'copied');
}

function setCheckpoint(run: Run, relation: string, patch: Partial<TableCheckpoint>): void {
  run.m.tables = run.m.tables.map(t => t.relation === relation ? { ...t, ...patch } : t);
  save(run);
}

/** Step 6: verify with the target fenced; only a passing verify writes `verified`. */
async function stepVerify(run: Run): Promise<void> {
  const prior = run.m.verifyFailures ?? [];
  if (run.m.state !== 'verifying') advance(run, 'verifying');
  await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'verifying'));
  const started = Date.now();
  await run.deps.assertRelationSet(run.main!, 'postgres', run.deps.inventory);
  phase(run, 'verify');
  let exempted: readonly string[] = [];
  const result = await run.deps.verifyGraduation({ source: run.source!, target: run.main! }, {
    inventory: run.deps.inventory, sourceReceipts: run.m.sourceReceipts ?? [], replayRequestId: run.m.replayRequestId ?? undefined,
    runId: run.m.runId, expectFence: true,
    runDoctor: async () => {
      phase(run, 'doctor');
      const doctor = await run.deps.runTargetDoctor(run.m.runId, run.m.targetUrls!.main);
      exempted = doctor.exempted;
      return doctor.failing;
    },
  });
  const timings = { ...run.m.timings, verify_ms: Date.now() - started };
  if (!result.ok) {
    await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'verify_failed', { tableReceipts: result.tables, replayProbe: result.replay, timings, doctor: { source: [], target: result.doctorFailingChecks, exempted } }));
    advance(run, 'verify_failed', { verifyFailures: result.failures, timings });
    const repeated = result.failures.some(f => prior.some(p => p.relation === f.relation && p.kind === f.kind));
    throw verifyFailedError({ failures: result.failures, repeated });
  }
  await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'verified', { tableReceipts: result.tables, replayProbe: result.replay, timings, triggerBypass: run.m.triggerBypass, doctor: { source: [], target: result.doctorFailingChecks, exempted } }));
  run.m.tables = run.m.tables.map(t => ({ ...t, state: 'verified' as const }));
  advance(run, 'verified', { verifyFailures: [], timings });
  await boundary(run, 'verified');
}

/** Step 7a: re-apply sequences, fence the source (`cutover`), close it keeping the lock, move aside, tombstone. */
async function stepCutover(run: Run): Promise<void> {
  phase(run, 'cutover');
  await run.deps.copySequences({ source: run.source!, target: run.main! }, { runId: run.m.runId });
  const [brain] = await run.source!.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton = 1');
  const [seq] = await run.source!.executeRaw<{ s: string }>('SELECT COALESCE(max(sequence), 0)::text AS s FROM persistence_requests');
  const row = await readGraduationRow(run.source!);
  if (row?.state !== 'cutover') await withSourceWritable(run.source!, tx => setSourceState(tx, run.m.runId, 'cutover', { cutoverSequence: seq?.s ?? '0' }));
  if (run.m.state !== 'cutover') advance(run, 'cutover', { sourceEnabled: brain?.enabled === true, cutoverSequence: seq?.s ?? '0' });
  await boundary(run, 'source_cutover');
  const source = run.source!;
  run.lock = await source.closeRetainingLock();
  run.source = null;
  await source.disconnect();
  await boundary(run, 'source_closed');
  await moveAsideHeld(run.dataDir, run.lock, run.m.runId);
  await boundary(run, 'moved_aside');
  await tombstoneUnderLock(run);
}

async function tombstoneUnderLock(run: Run): Promise<void> {
  const movedTo = graduatedPath(run.dataDir, run.m.runId);
  const existing = readTombstone(run.dataDir);
  if (!(existing && existing.runId === run.m.runId)) {
    try {
      writeTombstone(run.dataDir, {
        kind: 'gbrain-engine-graduated', runId: run.m.runId, brainId: run.m.source.brainId, movedTo, target: run.m.target,
        targetDisplayUrl: run.m.routes.main, graduatedAt: new Date().toISOString(),
        fixArgv: ['gbrain', 'config', 'set', 'database_url', '<GBRAIN_TARGET_URL>'],
      });
    } catch (error) {
      if (error instanceof TombstonePathOccupiedError) throw splitBrainFor(inspectGraduationPath(run.dataDir));
      throw error;
    }
  }
  advance(run, 'tombstoned', { graduatedAt: run.m.graduatedAt ?? new Date().toISOString() });
  await boundary(run, 'tombstoned');
}

/** Step 7b: one target transaction grants authority (persistence enabled as on the source) and drops the fence. */
async function stepAuthority(run: Run): Promise<void> {
  const state = inspectGraduationPath(run.dataDir);
  if (state.state === 'split_brain' || readTombstone(run.dataDir)?.runId !== run.m.runId) throw splitBrainFor(state);
  await openTargets(run);
  await withGraduationRun(run.main!, run.m.runId, async tx => {
    await tx.executeRaw('UPDATE persistence_brain SET enabled = $1 WHERE singleton = 1', [run.m.sourceEnabled === true]);
    await dropGraduationFence(tx);
    await setTargetState(tx, run.m.runId, 'authoritative', { cutoverSequence: run.m.cutoverSequence ?? '0', graduatedAt: 'now', timings: run.m.timings });
  });
  advance(run, 'authoritative');
  await boundary(run, 'authoritative');
}

/** Step 8: routing flip, registry/mount rewrite, manifest `graduated`, then the caller releases lock and pause marker. */
async function stepFlip(run: Run): Promise<void> {
  phase(run, 'flip');
  const file = loadConfigFileOnly() ?? run.opts.config ?? ({ engine: 'pglite' } as GBrainConfig);
  const next = { ...file, engine: 'postgres' as const, database_url: run.m.targetUrls!.main };
  delete (next as { database_path?: string }).database_path;
  saveConfig(next as GBrainConfig);
  await boundary(run, 'config_flipped');
  const mounts = rewriteMounts(run.deps.mountsPath(), mount => mount.engine === 'pglite' && !!mount.database_path && graduationDataDir(mount.database_path) === run.dataDir,
    mount => { const { database_path: _p, ...rest } = mount; return { ...rest, engine: 'postgres', database_url: run.m.targetUrls!.main }; });
  if (mounts.length) { run.m.rewrittenMounts = [...new Set([...(run.m.rewrittenMounts ?? []), ...mounts])]; save(run); }
  await boundary(run, 'registry_rewritten');
  advance(run, 'graduated');
  await boundary(run, 'graduated');
}

interface MountRecord { id: string; engine: string; database_path?: string; database_url?: string; [key: string]: unknown }

function rewriteMounts(path: string, match: (m: MountRecord) => boolean, rewrite: (m: MountRecord) => MountRecord): string[] {
  if (!existsSync(path)) return [];
  const file = JSON.parse(readFileSync(path, 'utf8')) as { version: number; mounts?: MountRecord[] };
  const ids: string[] = [];
  const mounts = (file.mounts ?? []).map(m => { if (!match(m)) return m; ids.push(m.id); return rewrite(m); });
  if (ids.length) writeFileDurably(path, `${JSON.stringify({ ...file, mounts }, null, 2)}\n`);
  return ids;
}

async function receiptOf(run: Run): Promise<GraduationReceipt> {
  if (!run.main) await openTargets(run);
  const row = await readGraduationRow(run.main!);
  const doctor = (row?.doctor ?? {}) as { source?: readonly string[]; target?: readonly string[]; exempted?: readonly string[] };
  return { runId: run.m.runId, state: (row?.state ?? 'authoritative') as GraduationReceipt['state'], tables: row?.table_receipts ?? [],
    triggerBypass: run.m.triggerBypass, replay: row?.replay_probe ?? { status: 'not_available', reason: 'no_uncompacted_request' }, timings: run.m.timings,
    targetDisplayUrl: run.m.routes.main, retainedPath: graduatedPath(run.dataDir, run.m.runId), serveHandoff: run.serveHandoff,
    doctor: { source: doctor.source ?? [], target: doctor.target ?? [], exempted: doctor.exempted ?? [] } };
}

async function takeKernelLock(run: Run): Promise<void> {
  if (run.lock) return;
  const movedTo = graduatedPath(run.dataDir, run.m.runId);
  run.lock = await acquireKernelLockOnly(run.dataDir, { lockDir: join(existsSync(movedTo) ? movedTo : run.dataDir, '.gbrain-lock'), timeoutMs: run.opts.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS });
}

/** Continue a run from its recorded state to `graduated`. */
async function continueRun(run: Run, opts: { force?: boolean } = {}): Promise<GraduationReceipt> {
  if (run.m.state === 'cutover' || run.m.state === 'tombstoned') {
    let path = inspectGraduationPath(run.dataDir);
    if (path.state === 'split_brain') {
      if (!run.opts.yes) throw splitBrainFor(path);
      moveStrayAside(run);
      path = inspectGraduationPath(run.dataDir);
    }
    const tombstone = readTombstone(run.dataDir);
    if (tombstone?.runId === run.m.runId || (!existsSync(run.dataDir) && path.movedTo)) {
      await claimPause(run);
      await takeKernelLock(run);
      await tombstoneUnderLock(run);
    }
  }
  if (STATE_RANK[run.m.state] < STATE_RANK.tombstoned) {
    if (run.m.state !== 'planned' || !run.source) await quiesceResume(run);
    if (run.m.state === 'planned') await stepRecord(run);
    await stepFenceTargetIfStarted(run, opts);
    await lockGapRecheck(run);
    if (run.m.state === 'quiesced' || run.m.state === 'draining') await stepDrain(run);
    else await run.deps.freezeSource(run.source!);
    if (STATE_RANK[run.m.state] <= STATE_RANK.draining) await stepFenceTarget(run, opts);
    if (STATE_RANK[run.m.state] <= STATE_RANK.copying || run.m.state === 'verify_failed') await stepCopy(run);
    if (run.m.state === 'copying' || run.m.state === 'verifying') await stepVerify(run);
    await stepCutover(run);
  }
  if (run.m.state === 'tombstoned') { await claimPause(run); await takeKernelLock(run); await stepAuthority(run); }
  if (run.m.state === 'authoritative') { await claimPause(run); await takeKernelLock(run); await stepFlip(run); }
  return receiptOf(run);
}

/** Past the fence step the target row must stay fenced; reconnect and repair before the lock-gap re-check reads it. */
async function stepFenceTargetIfStarted(run: Run, opts: { force?: boolean }): Promise<void> {
  if (STATE_RANK[run.m.state] > STATE_RANK.draining) await stepFenceTarget(run, opts);
}

/**
 * `--resume --yes` after the user decided about a stray datastore at the old
 * path: move it to `<path>.stray-<run_id>` (never deleted) so the tombstone
 * can be written and the move can finish.
 */
function moveStrayAside(run: Run): void {
  const stray = `${run.dataDir}.stray-${run.m.runId}`;
  if (existsSync(stray)) throw splitBrainFor(inspectGraduationPath(run.dataDir));
  renameSync(run.dataDir, stray);
  fsyncParent(run.dataDir);
  progress(run, { phase: 'split_brain', message: `moved the stray datastore to ${stray}` });
}

function newManifest(input: PlanInputs, expect: string, runId: string): GraduationManifest {
  const now = new Date().toISOString();
  return {
    version: GRADUATION_MANIFEST_VERSION, runId, state: 'planned',
    source: { dataDir: sourceDataDir(input.config), brainId: '', hostId: '' }, target: input.target,
    routes: { main: input.routes.main, ddl: input.routes.ddl, ...(input.routes.urlEnv ? { urlEnv: input.routes.urlEnv } : {}) },
    inventoryVersion: 0, schemaVersion: LATEST_VERSION, planHash: expect, triggerBypass: input.triggerBypassOverride ?? 'session_replication_role',
    tables: [], timings: {}, startedAt: now, updatedAt: now,
    targetUrls: { main: input.routes.mainUrl, ddl: input.routes.ddlUrl }, invokedAs: input.invokedAs, force: input.force,
    ...(input.batchBytes ? { batchSize: input.batchBytes } : {}),
  };
}

/** Abandon a run that never fenced anything (refused at step 1): the source stays exactly as it was. */
function abandonUnstarted(run: Run): void {
  try { transitionManifest(run.m, 'abandoned'); writeGraduationManifest(run.m, run.path); } catch { /* best effort */ }
  try { removeIntentMarker(run.dataDir); } catch { /* best effort */ }
}

/**
 * Run the approved graduation end to end. Refusals before the fence leave
 * the source unchanged and writable; a drain timeout or verify failure is
 * resumable with `resumeGraduation`.
 */
export async function runGraduation(opts: GraduationOptions): Promise<GraduationReceipt> {
  const path = opts.manifestPath ?? graduationManifestPath();
  const existing = readGraduationManifest(path);
  if (existing && !TERMINAL_STATES.has(existing.state)) throw existingRunError(existing);
  const deps = { ...defaultGraduationDeps(), ...opts.deps };
  const input = planInputs(deps, opts);
  const dataDir = sourceDataDir(input.config);
  refuseOnPathState(inspectGraduationPath(dataDir));
  const expect = opts.yes ? opts.expectPlanHash : undefined;
  if (!expect) {
    const fresh = await planGraduation(opts);
    throw opError('confirmation_required', 'Moving this brain to Postgres needs the user\'s approval of the plan; nothing was changed.',
      'Show the user the plan and run the command in fix after they agree.',
      { why: 'The move copies the brain to another database and fences this one; it runs only against an approved plan_hash.',
        fix: { argv: [...fresh.nextArgv], consent: ['egress', 'destructive'], actor: 'agent', requires_exclusive: true, plan_hash: fresh.planHash,
          preview_argv: planArgvFor(input), why: 'Runs the move against the approved plan.', verify: { argv: STATUS_ARGV } } });
  }
  if (existing) renameSync(path, `${path.replace(/\.json$/, '')}.${existing.runId}.json`);
  const manifest = newManifest(input, expect, randomUUID());
  manifest.inventoryVersion = deps.inventory.version;
  const run = newRun(manifest, path, { ...opts, deps });
  try {
    try { await quiesceFresh(run, input, expect); }
    catch (error) { abandonUnstarted(run); throw error; }
    return await continueRun(run, { force: opts.force });
  } finally { await cleanup(run); }
}

function existingRunError(m: GraduationManifest): OperationError {
  const marker = (() => { try { return readIntentMarker(m.source.dataDir); } catch { return null; } })();
  if (marker && markerLiveness(marker) === 'alive') return inProgressError({ runId: m.runId, state: m.state, pid: marker.pid, dataDir: m.source.dataDir });
  return interruptedError({ runId: m.runId, state: m.state, dataDir: m.source.dataDir });
}

function loadRun(opts: RunOptions): Run {
  const path = opts.manifestPath ?? graduationManifestPath();
  const m = readGraduationManifest(path);
  if (!m) {
    throw opError('not_found', 'No graduation run is recorded on this machine.',
      'Start one with the plan command: `gbrain migrate --to postgres --url-env GBRAIN_TARGET_URL --plan --json`.',
      { why: 'Resume, rollback and reconcile act on the run recorded in the graduation manifest.',
        fix: { argv: ['gbrain', 'migrate', '--to', 'postgres', '--url-env', 'GBRAIN_TARGET_URL', '--plan', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the read-only graduation plan.' } });
  }
  const run = newRun(m, path, opts);
  if (opts.url || opts.urlEnv) {
    const routes = run.deps.resolveTargetRoutes({ url: opts.url, urlEnv: opts.urlEnv, env: opts.env ?? process.env });
    if (run.deps.targetIdentity(routes.mainUrl).id !== m.target.id) {
      run.unregister();
      throw opError('invalid_params', 'The given target is not the database this run recorded.',
        'Drop --url/--url-env to use the recorded target, or pass a URL for the same host, port, database and user.',
        { why: 'A run continues against the target identity recorded in its manifest.', fix: { argv: STATUS_ARGV, consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the recorded target (redacted).' } });
    }
    m.targetUrls = { main: routes.mainUrl, ddl: routes.ddlUrl };
    if (routes.urlEnv) m.routes = { ...m.routes, urlEnv: routes.urlEnv };
    writeGraduationManifest(m, path);
  }
  return run;
}

/** Continue the recorded run from its first incomplete step (reconciling first). */
export async function resumeGraduation(opts: RunOptions = {}): Promise<GraduationReceipt> {
  const run = loadRun(opts);
  try {
    await reconcileRun(run);
    // Reconciliation finishes an interrupted rollback (rolled_back) or returns the target to authority (graduated).
    if (run.m.state === 'graduated' || run.m.state === 'rolled_back') return await receiptOf(run);
    if (run.m.state === 'abandoned') {
      throw opError('not_found', `Graduation run ${run.m.runId} was abandoned; there is nothing to resume.`,
        'Start a new move from the plan (fix); the PGLite brain is authoritative.',
        { fix: { argv: planArgv(run), consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows a fresh read-only plan.' } });
    }
    if (STATE_RANK[run.m.state] >= STATE_RANK.rollback_fenced) throw existingRunError(run.m);
    return await continueRun(run, { force: run.m.force });
  } finally { await cleanup(run); }
}

// ── reconciliation ─────────────────────────────────────────────────────────

/** A crash under the DISABLE TRIGGER fallback can leave user triggers off: re-enable every table the manifest recorded. */
async function repairDisabledTriggers(run: Run): Promise<boolean> {
  const disabled = run.m.tables.filter(t => t.disabledTriggers).map(t => t.relation);
  if (!disabled.length) return false;
  await openTargets(run);
  await run.deps.reenableTriggers(run.main!, disabled, { runId: run.m.runId });
  run.m.tables = run.m.tables.map(t => ({ ...t, disabledTriggers: false }));
  save(run);
  return true;
}

export interface ReconcileResult { state: ManifestState | 'none'; actions: readonly string[]; detail: string }

async function reconcileRun(run: Run): Promise<ReconcileResult> {
  const actions: string[] = [];
  const path = inspectGraduationPath(run.dataDir);
  if (path.state === 'split_brain' && !(run.opts.yes && (run.m.state === 'cutover' || run.m.state === 'tombstoned'))) throw splitBrainFor(path);
  if (run.m.state === 'rollback_fenced') {
    if (run.m.rollbackFrom === 'authoritative' || run.m.rollbackFrom === 'graduated') { await returnToAuthority(run); actions.push('returned target to authority'); }
    else { await approveAndRestore(run); actions.push('finished rollback'); }
  } else if (run.m.state === 'rollback_approved' || run.m.state === 'source_restoring') {
    await finishRollback(run);
    actions.push('finished rollback');
  } else if (STATE_RANK[run.m.state] >= STATE_RANK.copying && STATE_RANK[run.m.state] <= STATE_RANK.tombstoned && run.m.state !== 'cutover' || run.m.state === 'cutover') {
    await openTargets(run);
    const row = await readGraduationRow(run.main!);
    if (row?.role === 'target' && row.run_id === run.m.runId && row.state !== 'authoritative' && (await graduationFenceStatus(run.ddl!)).unfenced.length) {
      await installGraduationFence(run.ddl!, run.m.runId);
      actions.push('re-installed target fence');
    }
    if (await repairDisabledTriggers(run)) actions.push('re-enabled user triggers left disabled');
  }
  return { state: run.m.state, actions, detail: actions.join('; ') };
}

/** Repair after a crash: fence re-install, rollback roll-forward or return to authority. Never starts a move. */
export async function reconcileGraduation(opts: RunOptions = {}): Promise<ReconcileResult> {
  const path = opts.manifestPath ?? graduationManifestPath();
  if (!readGraduationManifest(path)) return { state: 'none', actions: [], detail: '' };
  const run = loadRun(opts);
  try { return await reconcileRun(run); } finally { await cleanup(run); }
}

// ── rollback ───────────────────────────────────────────────────────────────


/**
 * Roll back to the source. Before cutover: mark the target abandoned (it keeps
 * its fence) and release the source. After cutover: fence the target
 * (`rollback_fenced`), take the kernel lock, then compare; withdrawals and
 * security changes refuse finally, other user-data loss needs
 * `--yes --expect <hash>`; a refusal returns the target to authority.
 */
export async function rollbackGraduation(opts: RunOptions = {}): Promise<GraduationRollbackResult> {
  const run = loadRun(opts);
  try {
    phase(run, 'rollback');
    await reconcileRun(run);
    const state = run.m.state;
    if (state === 'rolled_back') return { state, restoredPath: run.dataDir, dropped: [] };
    if (state === 'abandoned') return { state, restoredPath: null, dropped: [] };
    if (STATE_RANK[state] <= STATE_RANK.verified) return await rollbackBeforeCutover(run);
    return await rollbackAfterCutover(run, opts);
  } finally { await cleanup(run); }
}

async function rollbackBeforeCutover(run: Run): Promise<GraduationRollbackResult> {
  writeIntentMarker(run.dataDir, markerFor(run));
  await claimPause(run);
  await openSourceUnderLock(run);
  const sourceRow = await readGraduationRow(run.source!);
  if (sourceRow?.run_id === run.m.runId && sourceRow.state === 'quiesced') {
    await withSourceWritable(run.source!, tx => setSourceState(tx, run.m.runId, 'rolled_back'));
  }
  if (STATE_RANK[run.m.state] >= STATE_RANK.draining) {
    await openTargets(run);
    const row = await readGraduationRow(run.main!);
    if (row?.role === 'target' && row.run_id === run.m.runId && row.state !== 'abandoned') {
      await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'abandoned'));
      await installGraduationFence(run.ddl!, run.m.runId);
    }
    if (row?.role === 'target' && row.run_id === run.m.runId) await repairDisabledTriggers(run);
  }
  advance(run, 'abandoned');
  return { state: 'abandoned', restoredPath: null, dropped: [] };
}

async function rollbackAfterCutover(run: Run, opts: RunOptions): Promise<GraduationRollbackResult> {
  const from = run.m.state;
  const noRetainedCopy = () => retainedCopyMissingError({ runId: run.m.runId, retainedPath: graduatedPath(run.dataDir, run.m.runId) });
  if (!retainedDatastore(run, from)) throw noRetainedCopy();
  const hadAuthority = from === 'authoritative' || from === 'graduated';
  await openTargets(run);
  if (hadAuthority) {
    const carried = run.deps.inventory.entries.filter(e => (e.class === 'carry' || e.class === 'rebind') && e.engines.postgres && e.kind === 'table').map(e => e.relation);
    await withGraduationRun(run.main!, run.m.runId, async tx => {
      await setTargetState(tx, run.m.runId, 'rollback_fenced');
      await installGraduationFence(tx, run.m.runId);
      const present = await tx.executeRaw<{ q: string }>(`SELECT quote_ident(c.relname) AS q FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname = ANY($1::text[])`, [carried]);
      if (present.length) await tx.executeRaw(`LOCK TABLE ${present.map(r => r.q).join(', ')} IN EXCLUSIVE MODE`);
    });
  }
  advance(run, 'rollback_fenced', { rollbackFrom: from });
  await boundary(run, 'rollback_fenced');
  let losses: RollbackLoss[] = [];
  try {
    await claimPause(run);
    await takeKernelLock(run);
    if (!retainedDatastore(run, from)) throw noRetainedCopy();
    if (hadAuthority) losses = await detectRollbackLosses(run);
  } catch (error) {
    if (hadAuthority) await returnToAuthority(run);
    throw error;
  }
  const final = losses.filter(l => l.final);
  if (final.length) {
    await returnToAuthority(run);
    throw rollbackLostError(run, final, null);
  }
  const confirmable = losses.filter(l => l.lossKind !== 'operational');
  if (confirmable.length) {
    const hash = lossHash(run.m.runId, confirmable);
    if (!(opts.yes && opts.expectPlanHash === hash)) {
      await returnToAuthority(run);
      throw rollbackLostError(run, confirmable, hash);
    }
  }
  await approveAndRestore(run);
  return { state: 'rolled_back', restoredPath: run.dataDir,
    dropped: losses.filter(l => l.lossKind === 'operational').map(l => ({ relation: l.relation, rows: l.rows, lossKind: l.lossKind })) };
}

/**
 * Where the PGLite datastore a post-cutover rollback would restore is right
 * now, or null when it no longer exists. Cutover renames it to
 * `<dataDir>.graduated-<run>`; only a run interrupted in `cutover` before that
 * rename still has it at the data dir itself, and there it must be a
 * directory (from `tombstoned` on, the data dir path is the tombstone file).
 * Without it, finishRollback would open a fresh empty PGLite brain at the old
 * path and route this machine to it.
 */
function retainedDatastore(run: Run, from: ManifestState): string | null {
  const renamed = graduatedPath(run.dataDir, run.m.runId);
  if (existsSync(renamed)) return renamed;
  if (from !== 'cutover') return null;
  try {
    return lstatSync(run.dataDir).isDirectory() ? run.dataDir : null;
  } catch {
    return null;
  }
}

async function approveAndRestore(run: Run): Promise<void> {
  const row = run.main ? await readGraduationRow(run.main) : null;
  if (row?.run_id === run.m.runId && row.state === 'rollback_fenced') {
    await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'rollback_approved'));
  }
  advance(run, 'rollback_approved');
  await boundary(run, 'rollback_approved');
  await finishRollback(run);
}

/** After approval, reconciliation only rolls forward: restore the datastore, reset the source row, flip routing back. */
async function finishRollback(run: Run): Promise<void> {
  await openTargets(run);
  await claimPause(run);
  await takeKernelLock(run);
  const row = await readGraduationRow(run.main!);
  const authorityPath = row?.run_id === run.m.runId && ['rollback_approved', 'source_restoring'].includes(row.state);
  if (authorityPath && row!.state === 'rollback_approved') await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'source_restoring'));
  if (run.m.state !== 'source_restoring') advance(run, 'source_restoring');
  await boundary(run, 'source_restoring');
  const movedTo = graduatedPath(run.dataDir, run.m.runId);
  if (readTombstone(run.dataDir)) { removeTombstone(run.dataDir, run.m.runId); await boundary(run, 'tombstone_removed'); }
  if (existsSync(movedTo)) {
    if (existsSync(run.dataDir)) throw splitBrainFor(inspectGraduationPath(run.dataDir));
    await moveHeldDatastore(movedTo, run.dataDir, run.lock!);
    await boundary(run, 'renamed_back');
  }
  const source = await run.deps.newSourceEngine();
  await source.connectWithHeldLock({ engine: 'pglite', database_path: run.dataDir }, run.lock!);
  run.lock = null;
  run.source = source;
  const sourceRow = await readGraduationRow(source);
  if (sourceRow?.run_id === run.m.runId && sourceRow.state !== 'rolled_back') {
    await withSourceWritable(source, tx => setSourceState(tx, run.m.runId, 'rolled_back'));
  }
  const file = loadConfigFileOnly();
  if (file && file.engine === 'postgres') {
    const next = { ...file, engine: 'pglite' as const, database_path: run.dataDir };
    delete (next as { database_url?: string }).database_url;
    saveConfig(next as GBrainConfig);
  }
  const ids = new Set(run.m.rewrittenMounts ?? []);
  rewriteMounts(run.deps.mountsPath(), mount => ids.has(mount.id) && mount.engine === 'postgres',
    mount => { const { database_url: _u, ...rest } = mount; return { ...rest, engine: 'pglite', database_path: run.dataDir }; });
  await boundary(run, 'config_restored');
  const target = await readGraduationRow(run.main!);
  if (target?.run_id === run.m.runId) {
    if (target.state === 'source_restoring') await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'rolled_back'));
    else if (target.state === 'verified' || target.state === 'verifying' || target.state === 'copying' || target.state === 'verify_failed') {
      await withGraduationRun(run.main!, run.m.runId, tx => setTargetState(tx, run.m.runId, 'abandoned'));
    }
    if ((await graduationFenceStatus(run.ddl!)).unfenced.length) await installGraduationFence(run.ddl!, run.m.runId);
  }
  advance(run, 'rolled_back');
  fsyncParent(run.dataDir);
  await boundary(run, 'rolled_back');
}

/** Any refusal, decline or timeout returns the target from `rollback_fenced` to authority, dropping the fence in the same transaction. */
async function returnToAuthority(run: Run): Promise<void> {
  await openTargets(run);
  await withGraduationRun(run.main!, run.m.runId, async tx => {
    const row = await readGraduationRow(tx);
    if (row?.state === 'rollback_fenced') await setTargetState(tx, run.m.runId, 'authoritative');
    await dropGraduationFence(tx);
  });
  const back = run.m.rollbackFrom === 'graduated' ? 'graduated' : 'authoritative';
  if (run.m.state === 'rollback_fenced') advance(run, back);
  if (run.lock) { const lock = run.lock; run.lock = null; await releaseLock(lock); }
}

function lossHash(runId: string, losses: readonly RollbackLoss[]): string {
  return planHashOf({ runId, losses: losses.map(l => `${l.relation}:${l.change}:${l.rows}`).sort() });
}

function rollbackLostError(_run: Run, losses: readonly RollbackLoss[], hash: string | null): OperationError {
  return rollbackWritesLostError({ losses: losses.map(l => ({ relation: `${l.relation} ${l.change}`, rows: l.rows })), final: hash === null, ...(hash ? { planHash: hash } : {}) });
}

async function detectRollbackLosses(run: Run): Promise<RollbackLoss[]> {
  const row = await readGraduationRow(run.main!);
  const movedTo = graduatedPath(run.dataDir, run.m.runId);
  return rollbackLosses({
    target: run.main!, inventory: run.deps.inventory, receipts: row?.table_receipts ?? [], cutoverSequence: run.m.cutoverSequence ?? '0',
    digestTable: run.deps.digestTable, openRetained: existsSync(movedTo) ? () => run.deps.openSource(movedTo, { migrate: false }) : null,
  });
}

// ── status ─────────────────────────────────────────────────────────────────

/**
 * `gbrain migrate --status`: never reconciles, migrates, repairs fences,
 * rewrites routing or touches graduation markers. It reads the manifest, the
 * marker and tombstone, and the target row through a read-only session; for
 * split brain it also opens both datastores read-only for their row counts.
 */
export async function graduationStatus(opts: Pick<GraduationInternals, 'manifestPath' | 'config' | 'deps'> = {}): Promise<GraduationStatusDoc> {
  const m = readGraduationManifest(opts.manifestPath ?? graduationManifestPath());
  const configured = opts.config ?? loadConfigFileOnly();
  const dataDir = m?.source.dataDir ?? (configured?.engine === 'pglite' && configured.database_path ? graduationDataDir(configured.database_path) : null);
  const path = dataDir ? inspectGraduationPath(dataDir) : null;
  const liveRun = path?.marker && path.liveness === 'alive' ? { pid: path.marker.pid } : null;
  if (!m) {
    return { schema_version: 1, state: 'none', runId: path?.marker?.runId ?? null, to: 'postgres', source: null, sourcePath: path, target: null, receipt: null,
      liveRun, tables: [], nextArgv: path?.state === 'graduated' ? ['gbrain', 'config', 'set', 'database_url', '<target_url>'] : null };
  }
  const deps = { ...defaultGraduationDeps(), ...opts.deps };
  let row: Awaited<ReturnType<typeof readGraduationRow>> = null;
  let reachable = false;
  if (m.targetUrls) {
    try {
      const targets = await deps.connectTargets({ ...m.routes, mainUrl: m.targetUrls.main, ddlUrl: m.targetUrls.ddl });
      try { row = await targets.main.transaction(async tx => { await tx.executeRaw('SET TRANSACTION READ ONLY'); return readGraduationRow(tx); }); reachable = true; }
      finally { await targets.close(); }
    } catch { reachable = false; }
  }
  const ours = row?.role === 'target' && row.run_id === m.runId ? row : null;
  const receipt: GraduationReceipt | null = ours?.table_receipts ? {
    runId: m.runId, state: ours.state as GraduationReceipt['state'], tables: ours.table_receipts, triggerBypass: m.triggerBypass,
    replay: ours.replay_probe ?? { status: 'not_available', reason: 'no_uncompacted_request' }, timings: m.timings,
    targetDisplayUrl: m.routes.main, retainedPath: graduatedPath(m.source.dataDir, m.runId),
  } : null;
  const to = m.invokedAs ?? 'postgres';
  const nextArgv = TERMINAL_STATES.has(m.state) ? null
    : path?.state === 'split_brain' ? resumeArgv(['--yes'])
      : liveRun ? STATUS_ARGV
        : STATE_RANK[m.state] >= STATE_RANK.rollback_fenced ? ['gbrain', 'migrate', '--rollback-to-source'] : resumeArgv();
  return {
    schema_version: 1, state: m.state, runId: m.runId, to, source: m.source, sourcePath: path,
    target: { identity: m.target, displayUrl: m.routes.main, row: (ours?.state ?? null) as TargetRowState | null, reachable },
    receipt, liveRun, tables: m.tables,
    ...(path?.state === 'split_brain' ? { splitBrain: await splitBrainSides(deps, path, m) } : {}),
    nextArgv,
  };
}

/** Both datastores of a split brain, opened read-only for row counts and newest page writes. */
async function splitBrainSides(deps: GraduationDeps, path: GraduationPathState, m: GraduationManifest): Promise<NonNullable<GraduationStatusDoc['splitBrain']>> {
  const sides = [path.dataDir, graduatedPath(m.source.dataDir, m.runId)];
  const out: Array<NonNullable<GraduationStatusDoc['splitBrain']>[number]> = [];
  for (const side of sides) {
    const entry = { path: side, brainId: null as string | null, rows: 0, newestWriteAt: null as string | null };
    if (!existsSync(side)) continue;
    const release = allowGraduationInspection(side);
    try {
      const engine = await deps.openSource(side, { migrate: false });
      try {
        const [brain] = await engine.executeRaw<{ brain_id: string }>(`SELECT brain_id::text AS brain_id FROM persistence_brain WHERE singleton = 1`).catch(() => []);
        const [pages] = await engine.executeRaw<{ n: string; newest: string | null }>(`SELECT count(*)::text AS n, max(updated_at)::text AS newest FROM pages`).catch(() => []);
        Object.assign(entry, { brainId: brain?.brain_id ?? null, rows: Number(pages?.n ?? 0), newestWriteAt: pages?.newest ?? null });
      } finally { await engine.disconnect(); }
    } catch { /* unreadable side: reported with what the filesystem shows */ } finally { release(); }
    out.push(entry);
  }
  return out;
}

export type { InventoryEntry };
