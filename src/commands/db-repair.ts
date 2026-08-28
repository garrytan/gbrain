/**
 * `gbrain db-repair` — ENGINE-FREE Postgres-access repair, the fix half of
 * the db-availability loop (marker → skills/db-repair → this command).
 *
 * Sibling of `pglite-repair` (that command owns the PGLite lane; this one
 * redirects there). Never calls `connectEngine` — the whole point is that
 * the DB may be unreachable. Default invocation is DIAGNOSE-ONLY.
 *
 * Consent is tiered and flag-gated, never TTY-dependent:
 *   auto tier    (--yes):                  retries, pending migrations,
 *                                          CREATE EXTENSION vector,
 *                                          `docker start` of gbrain's own container
 *   rewrite tier (--yes --apply-rewrites): config-file database_url rewrites
 *                                          (printed first, receipted with undo)
 *   manual tier  (never applied):          credentials, env recipes, paused
 *                                          projects — exact recipe printed
 *
 * Boundary vs `doctor --remediate`: that lane heals brain-DATA quality and
 * needs a LIVE engine (Minion jobs). This command heals DB ACCESS and needs
 * none. Two appliers, disjoint failure domains.
 *
 * Safety invariants:
 *   - Fix targets derive only from the CURRENT config URL — never error text.
 *   - The prober uses exactly ONE connection (diagnosing pool exhaustion
 *     with a 10-connection pool would worsen the outage).
 *   - Every rewrite stores the prior URL (0600 undo file, NOT the redacted
 *     receipt) and `--undo-last-rewrite` restores it.
 *   - Rewrite-tier cooldown ≤24h per (reason, action), `--force` bypasses;
 *     auto-tier fixes are never cooldown-blocked (availability first).
 *   - Receipts JSONL is redacted, fail-open, and bounded: 200-row flat cap,
 *     with recent `applied` rows exempt (separately capped — worst case ~400
 *     rows; a diagnose flood must never evict the cooldown/recurrence memory).
 *   - Thin-client and non-host-brain resolutions REFUSE (no local DB to
 *     repair / a mount outage must never rewrite host config).
 */

import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import {
  effectiveEnvDatabaseUrl,
  gbrainPath,
  getDbUrlSource,
  isThinClient,
  loadConfig,
  loadConfigFileOnly,
  saveConfig,
  toEngineConfig,
  type GBrainConfig,
} from '../core/config.ts';
import { HOST_BRAIN_ID, loadMounts } from '../core/brain-registry.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { connectWithRetry } from '../core/db.ts';
import { createEngine } from '../core/engine-factory.ts';
import { deriveSessionPoolerUrl } from '../core/connection-manager.ts';
import { isProcessAlive } from '../core/pglite-lock.ts';
import { redactPgUrl } from '../core/url-redact.ts';
import {
  classifyPgAccessError,
  diagnoseDbConfig,
  formatDbAccessMarker,
  type PgAccessDiagnosis,
  type PgAccessReason,
  type PgDbUrlSource,
} from '../core/pg-access-classify.ts';
import {
  GBRAIN_PG_CONTAINER,
  containerState,
  dockerAvailable,
  inspectCredentials,
  isGbrainDockerUrl,
  startContainer,
} from '../core/docker-postgres.ts';
import { rewriteCooldownBlocked, writeReceipt } from '../core/db-repair-receipts.ts';
import type { BrainEngine } from '../core/engine.ts';

class UnknownFlagError extends Error {}

interface DbRepairOpts {
  yes: boolean;
  applyRewrites: boolean;
  json: boolean;
  force: boolean;
  undoLastRewrite: boolean;
  help: boolean;
}

function parseArgs(args: string[]): DbRepairOpts {
  const opts: DbRepairOpts = { yes: false, applyRewrites: false, json: false, force: false, undoLastRewrite: false, help: false };
  for (const a of args) {
    if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--apply-rewrites') opts.applyRewrites = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--undo-last-rewrite') opts.undoLastRewrite = true;
    else if (a === '--dry-run') { /* explicit alias of the diagnose-only default */ }
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new UnknownFlagError(`Unknown flag for db-repair: ${a}`);
  }
  return opts;
}

function printHelp(): void {
  console.log(`gbrain db-repair — diagnose and fix Postgres access, engine-free

Usage:
  gbrain db-repair                      diagnose only (mutates nothing)
  gbrain db-repair --yes                apply the auto tier (retries, migrations,
                                        CREATE EXTENSION vector, docker start)
  gbrain db-repair --yes --apply-rewrites
                                        also apply config-file database_url rewrites
                                        (printed first; undo with --undo-last-rewrite)
  gbrain db-repair --yes --undo-last-rewrite
                                        restore the URL from before the last rewrite
  Flags: --json --force (bypass the rewrite cooldown) --dry-run (alias of default)

PGLite brains: use gbrain pglite-repair. Data-quality healing: gbrain doctor --remediate.`);
}

// ---------------------------------------------------------------------------
// Receipts (shared core module) + undo file (0600, holds the secret)
// ---------------------------------------------------------------------------

interface UndoRecord {
  prior_url: string;
  ts: number;
  reason: string;
}

function undoPath(): string {
  return gbrainPath('db-repair-undo.json');
}

function writeUndoRecord(rec: UndoRecord): void {
  // The prior URL is a SECRET (same trust class as config.json, which holds
  // the current one) — 0600, never the redacted receipt.
  writeFileSync(undoPath(), JSON.stringify(rec), { mode: 0o600 });
  try { chmodSync(undoPath(), 0o600); } catch { /* mode set at create */ }
}

function readUndoRecord(): UndoRecord | null {
  try {
    const rec = JSON.parse(readFileSync(undoPath(), 'utf-8')) as UndoRecord;
    return typeof rec?.prior_url === 'string' ? rec : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Advisory lock (a concurrent repair must not double-rewrite config)
// ---------------------------------------------------------------------------

function lockPath(): string {
  return gbrainPath('db-repair.lock');
}

function acquireRepairLock(): boolean {
  // O_EXCL ('wx') closes the check-then-write race: two concurrent repairs
  // must never both proceed (last-writer-wins on the undo record would make
  // --undo-last-rewrite restore the WRONG url). One stale-holder retry; any
  // other write failure stays fail-open (an unwritable ~/.gbrain must not
  // block a repair).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        return true; // fail-open: an unwritable lock must not block a repair
      }
      try {
        const raw = JSON.parse(readFileSync(lockPath(), 'utf-8')) as { pid?: number };
        if (typeof raw.pid === 'number' && isProcessAlive(raw.pid)) return false;
      } catch { /* corrupt lock — a dead artifact; clear it */ }
      try { rmSync(lockPath(), { force: true }); } catch { return false; }
    }
  }
  return false;
}

function releaseRepairLock(): void {
  try { rmSync(lockPath(), { force: true }); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Probing (injectable seam for tests)
// ---------------------------------------------------------------------------

type EngineConfigLike = import('../core/types.ts').EngineConfig;

export interface DbRepairDeps {
  /** Access probe: ONE connection, SELECT 1. Null = reachable. */
  probeAccess(config: EngineConfigLike, attempts?: number): Promise<PgAccessDiagnosis | null>;
  /** Schema probe (runs only after access succeeds): touches the pages table
   *  + the vector extension so schema_missing/pgvector_missing surface. */
  probeSchema(config: EngineConfigLike): Promise<PgAccessDiagnosis | null>;
  /** Run a callback with a connected single-connection engine. */
  withEngine<T>(config: EngineConfigLike, fn: (engine: BrainEngine) => Promise<T>): Promise<T>;
  docker: {
    available(): boolean;
    state(): 'absent' | 'running' | 'stopped';
    start(): boolean;
    /** Host port recovered from `docker inspect` of gbrain's container, or
     *  null. Lets the conn_refused arm match a reused container whose real
     *  port drifted from the default. */
    hostPort?(): number | null;
  };
  sleep(ms: number): Promise<void>;
  now(): number;
}

function probeCtx(config: EngineConfigLike): { url: string | null; source: PgDbUrlSource } {
  return { url: config.database_url ?? null, source: getDbUrlSource() as PgDbUrlSource };
}

async function realWithEngine<T>(config: EngineConfigLike, fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
  const engine = await createEngine(config);
  try {
    // ONE connection: never widen the pool while diagnosing exhaustion.
    await connectWithRetry(engine, { ...config, poolSize: 1 }, { noRetry: true, log: () => {} });
    return await fn(engine);
  } finally {
    try { await engine.disconnect(); } catch { /* cleanup is best-effort */ }
  }
}

export const defaultDeps: DbRepairDeps = {
  async probeAccess(config, attempts = 1) {
    try {
      const engine = await createEngine(config);
      try {
        await connectWithRetry(engine, { ...config, poolSize: 1 }, attempts > 1 ? { attempts } : { noRetry: true, log: () => {} });
        await engine.executeRaw('SELECT 1');
        return null;
      } finally {
        try { await engine.disconnect(); } catch { /* best-effort */ }
      }
    } catch (e) {
      return classifyPgAccessError(e, probeCtx(config));
    }
  },
  async probeSchema(config) {
    try {
      await realWithEngine(config, async (engine) => {
        await engine.executeRaw('SELECT 1 FROM pages LIMIT 1');
        const vector = await engine.executeRaw("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
        // ZERO ROWS is the missing-extension signal — the query itself never
        // errors on an absent extension, so without this check a vector-less
        // brain probes "healthy" and the pgvector_missing repair arm is
        // unreachable. The thrown message matches the classifier's
        // extension-"vector" pattern; the FIX stays the hardcoded per-reason
        // action (this is a probe RESULT, not error-text fix derivation).
        if (vector.length === 0) {
          throw new Error('extension "vector" is not installed (no pg_extension row)');
        }
      });
      return null;
    } catch (e) {
      return classifyPgAccessError(e, probeCtx(config));
    }
  },
  withEngine: realWithEngine,
  docker: {
    available: dockerAvailable,
    state: () => containerState(),
    start: () => startContainer(),
    hostPort: () => inspectCredentials()?.hostPort ?? null,
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

interface JsonReport {
  schema_version: 1;
  brain_id: string;
  reason?: PgAccessReason | 'undo' | 'healthy';
  tier?: 'auto' | 'rewrite' | 'manual';
  marker?: string;
  diagnosis?: PgAccessDiagnosis;
  plan: string[];
  applied: string[];
  fixed: boolean;
  remaining?: PgAccessDiagnosis | null;
}

function emit(json: boolean, report: JsonReport, humanLines: string[]): void {
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(humanLines.join('\n'));
}

function tierOf(reason: PgAccessReason): 'auto' | 'rewrite' | 'manual' {
  switch (reason) {
    case 'conn_dropped':
    case 'server_starting':
    case 'pool_exhausted':
    case 'schema_missing':
    case 'pgvector_missing':
      return 'auto';
    case 'conn_refused':
      return 'auto'; // docker arm; the supabase-direct rewrite path escalates to 'rewrite'
    case 'dns_failed':
      return 'auto'; // one bounded retry, then manual recipe
    case 'network_unreachable':
    case 'ssl_required':
      return 'rewrite';
    case 'auth_failed':
    case 'permission_denied':
    case 'tenant_not_found':
    case 'db_missing':
    case 'no_url':
    case 'env_shadowed':
    case 'unknown':
      return 'manual';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function appendSslmode(url: string): string {
  return url.includes('?') ? `${url}&sslmode=require` : `${url}?sslmode=require`;
}

export async function runDbRepair(args: string[], deps: DbRepairDeps = defaultDeps): Promise<number> {
  let opts: DbRepairOpts;
  try {
    opts = parseArgs(args);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  if (opts.help) {
    printHelp();
    return 0;
  }
  if (opts.applyRewrites && !opts.yes) {
    console.error('--apply-rewrites requires --yes (rewrites are the higher consent tier, not a lower one).');
    return 2;
  }
  if (opts.undoLastRewrite && !opts.yes) {
    console.error('--undo-last-rewrite requires --yes.');
    return 2;
  }

  const brainId = resolveBrainId(null);

  // A mount outage must never repair — or rewrite — the HOST config.
  if (brainId !== HOST_BRAIN_ID) {
    const mount = (() => { try { return loadMounts().find((m) => m.id === brainId) ?? null; } catch { return null; } })();
    console.error(
      `db-repair targets the host brain, but this context resolves to mount '${brainId}'` +
      (mount ? ` (engine ${mount.engine}, ${mount.database_url ? 'url: ' + redactPgUrl(mount.database_url) : 'path: ' + (mount.database_path ?? '?')})` : '') +
      `.\nMount-targeted repair is not supported yet — fix that brain on its host, or unset GBRAIN_BRAIN_ID/.gbrain-mount to repair the host brain.`,
    );
    return 1;
  }

  const cfg = loadConfig();

  if (isThinClient(cfg)) {
    console.error(
      'This machine is a thin client — there is no local database to repair. ' +
      'The brain lives on the remote MCP server; run db-repair on that host.',
    );
    return 1;
  }

  if (!cfg) {
    const shadowed =
      typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0 &&
      !process.env.GBRAIN_DATABASE_URL && effectiveEnvDatabaseUrl() === undefined;
    const d = diagnoseDbConfig({ source: getDbUrlSource() as PgDbUrlSource, envShadowed: shadowed, brainId });
    if (d) {
      writeReceipt({ ts: deps.now(), brain_id: brainId, reason: d.reason, action: 'diagnose', outcome: 'diagnose' });
      emit(opts.json, {
        schema_version: 1, brain_id: brainId, reason: d.reason, tier: 'manual',
        marker: formatDbAccessMarker(d), diagnosis: d, plan: [d.remediation], applied: [], fixed: false, remaining: d,
      }, [`${formatDbAccessMarker(d)}`, d.remediation]);
    }
    return 1;
  }

  if (cfg.engine === 'pglite') {
    console.error('This brain runs PGLite — its repair lane is: gbrain pglite-repair (WAL/data-dir recovery).');
    return 1;
  }

  if (!acquireRepairLock()) {
    console.error('repair in progress — another db-repair holds the advisory lock. Wait for it (do not retry in a loop).');
    return 1;
  }

  try {
    // Undo runs INSIDE the lock — it rewrites config.json the same as any
    // rewrite arm, and must never race a concurrent repair's rewrite.
    if (opts.undoLastRewrite) {
      return await runUndo(opts, brainId, deps);
    }
    return await repairHost(opts, cfg, brainId, deps);
  } finally {
    releaseRepairLock();
  }
}

async function runUndo(opts: DbRepairOpts, brainId: string, deps: DbRepairDeps): Promise<number> {
  const rec = readUndoRecord();
  if (!rec) {
    console.error('No rewrite to undo (no undo record on file).');
    return 1;
  }
  // The undo file is 0600 and same trust class as config.json, but validate
  // the scheme anyway before writing it INTO config — a corrupted/edited
  // record must not plant a non-postgres value in database_url.
  if (!/^postgres(ql)?:\/\//.test(rec.prior_url)) {
    console.error('The undo record does not hold a postgres:// URL — refusing to restore it. Remove it: rm ~/.gbrain/db-repair-undo.json');
    return 1;
  }
  const fileCfg = loadConfigFileOnly();
  const rewrittenUrl = fileCfg?.database_url; // the URL undo is about to replace
  saveConfig({ ...(fileCfg ?? {}), engine: 'postgres', database_url: rec.prior_url, database_path: undefined } as GBrainConfig);
  // Undo is itself reversible: the outgoing (rewritten) URL becomes the new
  // undo record, so an accidental undo doesn't destroy a probed-healthy fix.
  if (rewrittenUrl && rewrittenUrl !== rec.prior_url) {
    try { writeUndoRecord({ prior_url: rewrittenUrl, ts: deps.now(), reason: 'undo' }); } catch { /* best-effort */ }
  } else {
    try { rmSync(undoPath(), { force: true }); } catch { /* best-effort */ }
  }
  writeReceipt({ ts: deps.now(), brain_id: brainId, reason: 'undo', action: 'undo_last_rewrite', outcome: 'applied' });
  const probe = await deps.probeAccess({ engine: 'postgres', database_url: rec.prior_url });
  emit(opts.json, {
    schema_version: 1,
    brain_id: brainId,
    reason: 'undo',
    plan: [`restore database_url from before the last rewrite (${new Date(rec.ts).toISOString()}, reason ${rec.reason})`],
    applied: ['undo_last_rewrite'],
    fixed: probe === null,
    remaining: probe,
  }, [
    `Restored database_url from before the last rewrite (${new Date(rec.ts).toISOString()}, reason ${rec.reason}):`,
    `  -> ${redactPgUrl(rec.prior_url)}`,
    probe === null
      ? 'Restored URL probes healthy.'
      : `Restored, but the prior URL is not reachable either: ${probe.reason} — ${probe.remediation}`,
  ]);
  return probe === null ? 0 : 1;
}

async function repairHost(opts: DbRepairOpts, cfg: GBrainConfig, brainId: string, deps: DbRepairDeps): Promise<number> {
  const engineConfig = toEngineConfig(cfg) as EngineConfigLike;
  const url = cfg.database_url ?? null;
  const source = getDbUrlSource() as PgDbUrlSource;

  // Probe: access first, then schema (only reachable brains get schema-probed).
  let diagnosis = await deps.probeAccess(engineConfig);
  if (diagnosis === null) diagnosis = await deps.probeSchema(engineConfig);

  if (diagnosis === null) {
    writeReceipt({ ts: deps.now(), brain_id: brainId, reason: 'unknown', action: 'diagnose_healthy', outcome: 'diagnose' });
    const healthyLines = ['Nothing to fix — the database probes healthy. (A GBRAIN_DB_ACCESS marker in page content is not proof of failure.)'];
    // Connect-succeeded bonus, REPORT-ONLY: stale DB-plane engine/database_url
    // rows are historical footgun writes loadConfig() never reads — surface
    // them so operators stop trusting `config get` echoes of dead values.
    try {
      const staleKeys = await deps.withEngine(engineConfig, async (engine) => {
        const rows = (await engine.executeRaw(
          "SELECT key FROM config WHERE key IN ('engine', 'database_url', 'database_path')",
        )) as Array<{ key: string }>;
        return rows.map((r) => r.key);
      });
      if (staleKeys.length > 0) {
        healthyLines.push(
          `note: stale DB-plane config row(s) found (${staleKeys.join(', ')}) — these are IGNORED by gbrain ` +
            `(connection settings live in ~/.gbrain/config.json). Clear with: gbrain config unset <key>`,
        );
      }
    } catch { /* report-only: a bonus check never fails a healthy exit */ }
    emit(opts.json, { schema_version: 1, brain_id: brainId, reason: 'healthy', plan: [], applied: [], fixed: true, remaining: null },
      healthyLines);
    return 0;
  }

  diagnosis = { ...diagnosis, brainId };
  const tier = tierOf(diagnosis.reason);
  const report: JsonReport = {
    schema_version: 1, brain_id: brainId, reason: diagnosis.reason, tier,
    marker: formatDbAccessMarker(diagnosis), diagnosis, plan: [], applied: [], fixed: false,
  };

  // Build the plan line(s).
  const planLines = buildPlan(diagnosis, tier, url);
  report.plan = planLines;

  if (!opts.yes) {
    writeReceipt({ ts: deps.now(), brain_id: brainId, reason: diagnosis.reason, action: 'diagnose', outcome: 'diagnose' });
    emit(opts.json, { ...report, remaining: diagnosis }, [
      formatDbAccessMarker(diagnosis),
      `reason: ${diagnosis.reason} (${tier} tier)  ${diagnosis.message}`,
      ...planLines.map((p) => `plan: ${p}`),
      diagnosis.remediation,
      tier === 'auto' ? 'Apply: gbrain db-repair --yes' : tier === 'rewrite' ? 'Apply: gbrain db-repair --yes --apply-rewrites' : 'Manual fix required (see above).',
    ]);
    return 1;
  }

  const outcome = await applyLadder(diagnosis, tier, opts, cfg, engineConfig, url, source, brainId, deps, report);
  emit(opts.json, report, outcome.humanLines);
  return outcome.code;
}

function buildPlan(d: PgAccessDiagnosis, tier: 'auto' | 'rewrite' | 'manual', url: string | null): string[] {
  switch (d.reason) {
    case 'conn_dropped':
    case 'server_starting':
      return ['bounded reconnect (3 attempts, backoff)'];
    case 'pool_exhausted':
      return ['re-probe on a single connection; emit GBRAIN_POOL_SIZE=2 guidance'];
    case 'conn_refused': {
      const lines = [];
      if (url && isGbrainDockerUrl(url)) {
        lines.push(`docker start ${GBRAIN_PG_CONTAINER} (gbrain's own container), then re-probe`);
      }
      if (d.fix?.kind === 'rewrite_config_url') lines.push('rewrite database_url to the transaction pooler (rewrite tier)');
      if (lines.length === 0) lines.push('bounded reconnect; if the server is down, start it and re-run');
      return lines;
    }
    case 'dns_failed':
      return ['one bounded retry (EAI_AGAIN is transient); persistent failure → paused-project recipe'];
    case 'network_unreachable':
      return ['probe the session pooler; persist it if reachable (rewrite tier, undo-able)'];
    case 'ssl_required':
      return ['append ?sslmode=require to database_url (rewrite tier, undo-able)'];
    case 'schema_missing':
      return ['run pending migrations in-process'];
    case 'pgvector_missing':
      return ['CREATE EXTENSION IF NOT EXISTS vector'];
    default:
      return [d.remediation];
  }
}

interface LadderOutcome { code: number; humanLines: string[] }

async function applyLadder(
  d: PgAccessDiagnosis,
  tier: 'auto' | 'rewrite' | 'manual',
  opts: DbRepairOpts,
  cfg: GBrainConfig,
  engineConfig: EngineConfigLike,
  url: string | null,
  source: PgDbUrlSource,
  brainId: string,
  deps: DbRepairDeps,
  report: JsonReport,
): Promise<LadderOutcome> {
  const human: string[] = [formatDbAccessMarker(d), `reason: ${d.reason} (${tier} tier)`];
  const now = deps.now();

  const applied = (action: string): void => {
    report.applied.push(action);
    human.push(`applied: ${action}`);
    writeReceipt({ ts: deps.now(), brain_id: brainId, reason: d.reason, action, outcome: 'applied' });
  };
  const refused = (action: string, why: string): void => {
    human.push(`refused: ${action} — ${why}`);
    writeReceipt({ ts: deps.now(), brain_id: brainId, reason: d.reason, action, outcome: 'refused' });
  };
  const finishWithReprobe = async (): Promise<LadderOutcome> => {
    const remaining = (await deps.probeAccess(engineConfig)) ?? (await deps.probeSchema(engineConfig));
    report.remaining = remaining;
    report.fixed = remaining === null;
    if (remaining === null) {
      human.push('re-probe: healthy — fixed.');
      return { code: 0, humanLines: human };
    }
    human.push(`re-probe: still failing (${remaining.reason}) — ${remaining.remediation}`);
    return { code: 1, humanLines: human };
  };
  const manualStop = (): LadderOutcome => {
    report.remaining = d;
    human.push(d.remediation);
    human.push('Manual fix required — relaying the recipe is the repair.');
    return { code: 1, humanLines: human };
  };

  // Rewrite executor shared by every rewrite-tier arm.
  const applyRewrite = async (newUrl: string, action: string): Promise<LadderOutcome | null> => {
    if (source?.startsWith('env:')) {
      refused(action, `database_url comes from ${source} — an env var can't be rewritten. Export the new URL yourself: ${redactPgUrl(newUrl)}`);
      return manualStop();
    }
    if (!opts.applyRewrites) {
      refused(action, 'rewrite tier requires --yes --apply-rewrites');
      report.remaining = d;
      human.push(`Intended change: database_url -> ${redactPgUrl(newUrl)}`);
      human.push('Apply: gbrain db-repair --yes --apply-rewrites');
      return { code: 1, humanLines: human };
    }
    if (!opts.force && rewriteCooldownBlocked(d.reason, action, now)) {
      refused(action, 'applied within the last 24h (cooldown; bypass with --force)');
      return manualStop();
    }
    // Probe the candidate BEFORE persisting — never write an unverified URL.
    const candidateProbe = await deps.probeAccess({ engine: 'postgres', database_url: newUrl });
    if (candidateProbe !== null) {
      refused(action, `candidate URL failed its probe (${candidateProbe.reason}) — not persisting`);
      return manualStop();
    }
    human.push(`rewriting database_url -> ${redactPgUrl(newUrl)} (undo: gbrain db-repair --yes --undo-last-rewrite)`);
    if (url) writeUndoRecord({ prior_url: url, ts: deps.now(), reason: d.reason });
    const fileCfg = loadConfigFileOnly();
    saveConfig({ ...(fileCfg ?? {}), engine: 'postgres', database_url: newUrl, database_path: undefined } as GBrainConfig);
    applied(action);
    // Re-probe against the NEW config.
    const remaining = await deps.probeAccess({ engine: 'postgres', database_url: newUrl });
    report.remaining = remaining;
    report.fixed = remaining === null;
    human.push(remaining === null ? 're-probe: healthy — fixed.' : `re-probe: still failing (${remaining.reason})`);
    if (remaining === null) {
      // Honest scope: config rewrites reach NEW processes only.
      human.push('note: long-lived gbrain processes (serve, jobs workers) keep their old pool — restart them to pick up the new URL.');
    }
    return { code: remaining === null ? 0 : 1, humanLines: human };
  };

  switch (d.reason) {
    case 'conn_dropped':
    case 'server_starting': {
      const retry = await deps.probeAccess(engineConfig, 3);
      if (retry === null) {
        applied('bounded_reconnect');
        report.fixed = true;
        report.remaining = null;
        human.push('re-probe: healthy — the drop was transient.');
        return { code: 0, humanLines: human };
      }
      report.remaining = retry;
      human.push(`still failing after bounded reconnect: ${retry.reason} — ${retry.remediation}`);
      return { code: 1, humanLines: human };
    }

    case 'pool_exhausted': {
      const retry = await deps.probeAccess(engineConfig, 3);
      human.push('guidance: export GBRAIN_POOL_SIZE=2  (recommended for low-cap poolers like Supabase Supavisor)');
      if (retry === null) {
        applied('single_connection_reprobe');
        report.fixed = true;
        report.remaining = null;
        return { code: 0, humanLines: human };
      }
      report.remaining = retry;
      return { code: 1, humanLines: human };
    }

    case 'conn_refused': {
      // gbrain's own docker container first (auto tier, idempotent, cheap).
      // Match on the default port OR the surviving container's REAL port —
      // init's reuse path writes the inspected port into the URL, which can
      // drift from the default; the repair arm must follow it.
      const isDockerUrl =
        url !== null &&
        (isGbrainDockerUrl(url) ||
          (() => {
            try {
              const u = new URL(url);
              if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return false;
              if (!deps.docker.available() || deps.docker.state() === 'absent') return false;
              const port = deps.docker.hostPort?.();
              return port != null && String(port) === u.port;
            } catch {
              return false;
            }
          })());
      if (isDockerUrl && deps.docker.available() && deps.docker.state() === 'stopped') {
        if (deps.docker.start()) {
          applied(`docker_start_${GBRAIN_PG_CONTAINER}`);
          // Readiness poll: postgres in the container takes a few seconds.
          for (let i = 0; i < 15; i++) {
            await deps.sleep(1000);
            if ((await deps.probeAccess(engineConfig)) === null) break;
          }
          return finishWithReprobe();
        }
        refused(`docker_start_${GBRAIN_PG_CONTAINER}`, 'docker start failed');
      }
      if (d.fix?.kind === 'rewrite_config_url' && d.fix.to === 'transaction_pooler' && url) {
        // Supabase direct URL refused → the pooler is the fix. Derive from
        // the CURRENT url only: db.<ref>.supabase.co:5432 has no pooler host
        // to derive offline, so this arm only fires when a session-pooler
        // form is derivable; otherwise print the recipe.
        const candidate = deriveSessionPoolerUrl(url);
        if (candidate) return (await applyRewrite(candidate, 'rewrite_to_pooler')) ?? manualStop();
        human.push('This is a Supabase DIRECT url; get the Transaction pooler string from the dashboard (Connect > Connection String > Transaction pooler), then: gbrain init --url <pooler-conn>');
        report.remaining = d;
        return { code: 1, humanLines: human };
      }
      const retry = await deps.probeAccess(engineConfig, 3);
      if (retry === null) {
        applied('bounded_reconnect');
        report.fixed = true;
        report.remaining = null;
        return { code: 0, humanLines: human };
      }
      report.remaining = retry;
      human.push(retry.remediation);
      return { code: 1, humanLines: human };
    }

    case 'dns_failed': {
      const retry = await deps.probeAccess(engineConfig, 2); // EAI_AGAIN is transient
      if (retry === null) {
        applied('bounded_dns_retry');
        report.fixed = true;
        report.remaining = null;
        return { code: 0, humanLines: human };
      }
      report.remaining = retry;
      if (d.supabase?.pausedSuspect) {
        human.push('The hostname does not resolve and this looks like a Supabase project — free-tier projects pause after inactivity. Restore it from the dashboard, then re-run: gbrain db-repair --yes');
      } else {
        human.push(d.remediation);
      }
      return { code: 1, humanLines: human };
    }

    case 'network_unreachable': {
      if (!url) return manualStop();
      const candidate = deriveSessionPoolerUrl(url);
      if (!candidate) return manualStop();
      return (await applyRewrite(candidate, 'rewrite_to_session_pooler')) ?? manualStop();
    }

    case 'ssl_required': {
      if (!url) return manualStop();
      return (await applyRewrite(appendSslmode(url), 'append_sslmode_require')) ?? manualStop();
    }

    case 'schema_missing': {
      try {
        await deps.withEngine(engineConfig, async (engine) => {
          const { tryRunPendingMigrations } = await import('../core/migrate.ts');
          await tryRunPendingMigrations(engine);
        });
        applied('run_pending_migrations');
      } catch (e) {
        refused('run_pending_migrations', `migrations failed: ${classifyPgAccessError(e, { url, source, brainId }).message}`);
        human.push('Fallback: gbrain apply-migrations --yes (connect directly to Postgres, not the pooler, if it persists).');
        report.remaining = d;
        return { code: 1, humanLines: human };
      }
      return finishWithReprobe();
    }

    case 'pgvector_missing': {
      try {
        await deps.withEngine(engineConfig, async (engine) => {
          await engine.executeRaw('CREATE EXTENSION IF NOT EXISTS vector');
        });
        applied('create_extension_vector');
      } catch {
        refused('create_extension_vector', 'the role cannot create extensions here');
        human.push('Run manually in the SQL editor: CREATE EXTENSION IF NOT EXISTS vector;');
        report.remaining = d;
        return { code: 1, humanLines: human };
      }
      return finishWithReprobe();
    }

    case 'auth_failed':
    case 'permission_denied':
    case 'tenant_not_found':
    case 'db_missing':
    case 'no_url':
    case 'env_shadowed':
    case 'unknown':
      return manualStop();

    default: {
      const _exhaustive: never = d.reason;
      return _exhaustive;
    }
  }
}
