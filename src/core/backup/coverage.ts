/**
 * backup/coverage.ts — engine-side compute for the monthly backup-coverage
 * check. Answers "if this disk died right now, could the user recreate their
 * agent?" across every asset class gbrain knows about, and persists the
 * verdict to the engine-free cache in backup/status-file.ts.
 *
 * Trust boundary (D4, extraction-sync.ts:870): git subprocesses against
 * DB-supplied local_path values run ONLY when the caller passes
 * `localGitProbes: true` — trusted-local contexts (CLI, local doctor/advisor,
 * sync completion, the detached spawn) and the STDIO serve refresher (see
 * maybeRefreshBackupStatusInProcess below). Probe-less computes are NEVER
 * persisted: a probe-less write would clobber a probed verdict (reset
 * checked_at, mutate the nag fingerprint, silence a real warn).
 *
 */

import { existsSync } from 'node:fs';

import { VERSION } from '../../version.ts';
import type { BrainEngine } from '../engine.ts';
import { loadAllSources } from '../sources-load.ts';
import { discoverGitRoot } from '../sync-git.ts';
import { realpathOrResolve } from '../path-confine.ts';
import { resolveBrainId } from '../brain-resolver.ts';
import { readReceipt } from '../bootstrap/format.ts';
import { resolveGbrainHome } from '../gbrain-home.ts';
import { loadBridgeState } from '../skillpack/bridge-state.ts';
import { loadStorageConfig } from '../storage-config.ts';
import {
  BACKUP_INTERVAL_DAYS_DEFAULT,
  BACKUP_STATUS_SCHEMA_VERSION,
  backupCheckDisabled,
  backupIntervalMs,
  isBackupStatusStale,
  loadBackupStatus,
  saveBackupStatus,
  currentBackupEvidence,
  BACKUP_VERIFICATION_MAX_AGE_MS,
  BACKUP_RECOVERY_SCOPE,
  type BackupAssetVerdict,
  type BackupComputedBy,
  type BackupStatus,
} from './status-file.ts';
import { assessBackupRepository, BACKUP_REMOTE_PROBE_CAP, type RemoteProbeBudget } from './repository.ts';

/** No silent caps: at most this many deduped git roots are probed per run;
 * anything beyond is logged as skipped. */
export const BACKUP_PROBE_ROOT_CAP = 500;

export interface BackupCoverageOpts {
  now?: Date;
  /**
   * Trust gate (D4): true only in trusted-local contexts. When false, source
   * repos come back 'unknown' and the result is NEVER persisted.
   */
  localGitProbes: boolean;
  verifyRemoteRefs?: boolean;
  previousStatus?: BackupStatus;
  /** Provenance stamp for the status file (default 'cli'). */
  computedBy?: BackupComputedBy;
}

function pushAsset(assets: BackupAssetVerdict[], a: BackupAssetVerdict): void {
  assets.push(a);
}

function yieldLoop(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** null = the count could not be established (engine down / schema quirk). */
async function countLivePages(engine: BrainEngine): Promise<number | null> {
  try {
    const rows = await engine.executeRaw<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL',
    );
    const n = rows[0]?.n;
    // An empty rowset / non-numeric n is UNESTABLISHED, not zero — returning 0
    // would fabricate a "no pages at risk" all-clear and skip the degraded flag.
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function computeBackupCoverage(
  engine: BrainEngine,
  opts: BackupCoverageOpts,
): Promise<BackupStatus> {
  const now = opts.now ?? new Date();
  const assets: BackupAssetVerdict[] = [];
  const remoteBudget: RemoteProbeBudget | undefined = opts.localGitProbes === true && opts.verifyRemoteRefs === true
    ? { remaining: BACKUP_REMOTE_PROBE_CAP } : undefined;
  const previousAge = now.getTime() - Date.parse(opts.previousStatus?.checked_at ?? '');
  const previous = opts.localGitProbes === true && opts.previousStatus && !opts.previousStatus.degraded
    && Number.isFinite(previousAge) && previousAge >= 0 && !isBackupStatusStale(opts.previousStatus, now.getTime())
    ? currentBackupEvidence(opts.previousStatus, now.getTime()) : undefined;
  const previousAssets = new Map(previous?.assets.map(a => [`${a.kind}:${a.id}`, a]));
  const repositories: { root: string; index: number }[] = [];

  // ── Bootstrap workspace (carries skills/, memory/, brain/, identity) ──────
  let workspaceRoot: string | null = null;
  let receiptHasRepo = false;
  try {
    const home = resolveGbrainHome();
    const receipt = readReceipt(home);
    if (receipt) {
      // Normalized for the source-root dedup compare below — git prints a
      // resolved toplevel, so a symlinked/trailing-slash receipt path must
      // not double-count the workspace as a second asset.
      workspaceRoot = realpathOrResolve(receipt.workspace_dir);
      receiptHasRepo = typeof receipt.repo_url === 'string' && receipt.repo_url.length > 0;
      if (!receiptHasRepo) {
        pushAsset(assets, {
          kind: 'bootstrap_workspace',
          id: receipt.workspace_dir,
          state: 'no_remote',
          detail:
            'bootstrap workspace has no private repo yet — run `gbrain bootstrap repo` to create one ' +
            '(this is the right command for a truly empty/unconfigured origin). If this workspace was ' +
            'already pushed to an existing repo out-of-band, `bootstrap repo` will refuse — run ' +
            '`gbrain bootstrap attach` instead to reconcile the receipt.',
          // No single command is correct here without a git subprocess (coverage.ts is deliberately
          // file-plane only): an empty/unconfigured origin needs `bootstrap repo`, an already-pushed
          // one needs `bootstrap attach`, and this check can't tell which case it's in. Leave fix_argv
          // null rather than advertise a command that's wrong in the out-of-band-adopted case.
          fix_argv: null,
        });
      } else {
        if (opts.localGitProbes === true) repositories.push({ root: workspaceRoot, index: assets.length });
        pushAsset(assets, opts.localGitProbes === true
          ? await assessBackupRepository(workspaceRoot, 'bootstrap_workspace', receipt.workspace_dir, now, undefined, previousAssets.get(`bootstrap_workspace:${receipt.workspace_dir}`))
          : { kind: 'bootstrap_workspace', id: receipt.workspace_dir, state: 'unknown', configured_remote: true, detail: 'probes_skipped' });
      }
    }
  } catch {
    /* no receipt / unreadable home — the source sweep below stands alone */
  }

  // ── Source repos (deduped by git root) ────────────────────────────────────
  let sourceRootCount = 0;
  let degraded = false;
  try {
    const rows = await loadAllSources(engine);
    const byRoot = new Map<string, { ids: string[]; dbOnly: boolean }>();
    let skippedOverCap = 0;
    // Root discovery is itself a git subprocess — memoize per local_path, count
    // it against the probe cap, skip it entirely on probe-less runs (their
    // assets are 'unknown' either way and probe-less results never persist).
    const rootByPath = new Map<string, string | null>();
    let discoveries = 0;
    for (const row of rows) {
      if (row.archived) continue;
      if (!row.local_path) continue;
      if (!existsSync(row.local_path)) {
        // The most disk-loss-adjacent state of all: a registered path that is
        // GONE. Surface it (unknown — it may live on another machine or have
        // moved) instead of silently skipping.
        pushAsset(assets, {
          kind: 'source_repo',
          id: row.id,
          state: 'unknown',
          detail: 'local_path not found on this machine',
          fix_argv: null,
        });
        continue;
      }
      let root: string;
      if (!opts.localGitProbes) {
        root = row.local_path; // group by raw path — no subprocess on untrusted paths
      } else if (rootByPath.has(row.local_path)) {
        const memo = rootByPath.get(row.local_path)!;
        if (memo === null) {
          // Every source at a known non-repo path gets its own asset row.
          pushAsset(assets, { kind: 'source_repo', id: row.id, state: 'unknown', detail: 'not_a_git_repo', fix_argv: null });
          continue;
        }
        root = memo;
      } else if (discoveries >= BACKUP_PROBE_ROOT_CAP) {
        skippedOverCap++;
        pushAsset(assets, { kind: 'source_repo', id: row.id, state: 'unknown', detail: 'probe_cap', fix_argv: null });
        continue;
      } else {
        discoveries++;
        await yieldLoop();
        try {
          root = discoverGitRoot(row.local_path);
          rootByPath.set(row.local_path, root);
        } catch {
          rootByPath.set(row.local_path, null);
          pushAsset(assets, {
            kind: 'source_repo',
            id: row.id,
            state: 'unknown',
            detail: 'not_a_git_repo',
            fix_argv: null,
          });
          continue;
        }
      }
      if (root === workspaceRoot) continue; // the workspace asset above owns it
      const entry = byRoot.get(root);
      let dbOnly = false;
      try {
        dbOnly = (loadStorageConfig(row.local_path)?.db_only?.length ?? 0) > 0;
      } catch {
        /* storage config unreadable — treat as no db_only tiering */
      }
      if (entry) {
        entry.ids.push(row.id);
        entry.dbOnly = entry.dbOnly || dbOnly;
      } else {
        byRoot.set(root, { ids: [row.id], dbOnly });
      }
      // db_only exposure rides as its own info asset (per source repo).
      if (dbOnly) {
        pushAsset(assets, {
          kind: 'db_only',
          id: row.id,
          state: 'info',
          detail:
            'db_only dirs configured: those pages are not in git and the DB file is deliberately not backed up. ' +
            'Dump them somewhere OUTSIDE the gitignored dirs (--restore-only is the wrong direction for a backup); ' +
            'run gbrain doctor (undeclared_db_only_pages) for the page-level audit.',
          fix_argv: ['gbrain', 'export', '--dir', '<backup-dir>'],
        });
      }
    }

    sourceRootCount = byRoot.size;
    let probed = 0;
    for (const [root, { ids }] of byRoot) {
      const id = ids.join(', ');
      if (!opts.localGitProbes) {
        pushAsset(assets, { kind: 'source_repo', id, state: 'unknown', detail: 'probes_skipped', fix_argv: null });
        continue;
      }
      if (probed >= BACKUP_PROBE_ROOT_CAP) {
        skippedOverCap++;
        pushAsset(assets, { kind: 'source_repo', id, state: 'unknown', detail: 'probe_cap', fix_argv: null });
        continue;
      }
      probed++;
      await yieldLoop();
      repositories.push({ root, index: assets.length });
      pushAsset(assets, await assessBackupRepository(root, 'source_repo', id, now, undefined, previousAssets.get(`source_repo:${id}`)));
    }
    if (skippedOverCap > 0) {
      process.stderr.write(
        `[backup] probe cap: ${skippedOverCap} git root(s) beyond ${BACKUP_PROBE_ROOT_CAP} were not probed this run\n`,
      );
    }
  } catch {
    // Sources unreadable (engine down / legacy schema): the verdict is
    // DEGRADED — it must never overwrite a probed cache (getBackupStatus).
    degraded = true;
  }

  if (remoteBudget) {
    const ordered = repositories.filter(({ index }) => assets[index].configured_remote === true).sort((a, b) => {
      const left = assets[a.index].verification;
      const right = assets[b.index].verification;
      return Number(left?.state === 'verified') - Number(right?.state === 'verified')
        || (Date.parse(left?.checked_at ?? '') || 0) - (Date.parse(right?.checked_at ?? '') || 0);
    });
    for (const { root, index } of ordered) {
      const asset = assets[index];
      if (remoteBudget.remaining <= 0 || (remoteBudget.deadline !== undefined && Date.now() >= remoteBudget.deadline)) {
        if (asset.verification?.state !== 'verified') {
          asset.verification = { ...asset.verification, state: 'budget_exhausted' };
        }
        continue;
      }
      await yieldLoop();
      assets[index] = await assessBackupRepository(root, asset.kind as 'source_repo' | 'bootstrap_workspace', asset.id, now, remoteBudget);
    }
  }

  // ── Harness-native skill dirs (installed COPIES — info only) ──────────────
  try {
    const bridge = loadBridgeState();
    if (bridge.entries.length > 0) {
      pushAsset(assets, {
        kind: 'harness_skills',
        id: `${bridge.entries.length} harness skill dir(s)`,
        state: 'info',
        detail: 'installed copies; the originals live in brain/skill repos and are covered above',
        fix_argv: null,
      });
    }
  } catch {
    /* bridge state unreadable — cosmetic row only */
  }

  // ── DB-only brain (the worst-case user) ───────────────────────────────────
  const pageCountRaw = await countLivePages(engine);
  if (pageCountRaw === null) degraded = true;
  const pageCount = pageCountRaw ?? 0;
  const hasGitBackedAsset = assets.some(
    (a) => a.kind === 'source_repo' || (a.kind === 'bootstrap_workspace' && a.state !== 'no_remote'),
  );
  let pagesAtRisk = 0;
  if (!degraded && pageCount > 0 && sourceRootCount === 0 && !hasGitBackedAsset && workspaceRoot === null) {
    if (engine.kind === 'postgres') {
      pushAsset(assets, {
        kind: 'db_content',
        id: 'brain database',
        state: 'info',
        detail:
          `Postgres contains ${pageCount} pages; database placement and external backups were not verified — ` +
          'add a source repo (gbrain sources add) or dump with gbrain export',
        fix_argv: ['gbrain', 'bootstrap', 'repo'],
      });
    } else {
      pagesAtRisk = pageCount;
      pushAsset(assets, {
        kind: 'db_content',
        id: 'brain database',
        state: 'no_remote',
        detail: `${pageCount} pages live ONLY in the local DB — a disk loss loses all of them (gbrain sources add / gbrain bootstrap repo)`,
        fix_argv: ['gbrain', 'bootstrap', 'repo'],
      });
    }
  }

  const totals = {
    assets: assets.length,
    no_remote: assets.filter((a) => a.state === 'no_remote').length,
    unpushed: assets.filter((a) => a.state === 'unpushed').length,
    failing: assets.filter((a) => a.state === 'failing').length,
    configured_repos: assets.filter(a => a.configured_remote === true).length,
    recoverable_repos: assets.filter(a => a.state === 'ok' && a.verification?.state === 'verified').length,
    pages_at_risk: pagesAtRisk,
  };

  return currentBackupEvidence({
    schema_version: BACKUP_STATUS_SCHEMA_VERSION,
    checked_at: now.toISOString(),
    gbrain_version: VERSION,
    interval_days: Math.round(backupIntervalMs() / (24 * 60 * 60 * 1000)) || BACKUP_INTERVAL_DAYS_DEFAULT,
    computed_by: opts.computedBy ?? 'cli',
    overall: totals.no_remote > 0 ? 'warn' : 'ok',
    totals,
    assets,
    ...(degraded ? { degraded: true } : {}),
    ...(remoteBudget ? { remote_check_at: now.toISOString() } : {}),
    recovery_scope: BACKUP_RECOVERY_SCOPE,
  }, now.getTime());
}

/**
 * True when this process is operating on the HOST brain. The status cache is
 * host-scoped (~/.gbrain/backup-status.json has no brain dimension), so a
 * compute against a mounted brain (--brain flag threaded by the caller, or
 * GBRAIN_BRAIN_ID / a .gbrain-mount dotfile picked up by a detached spawn)
 * must neither read nor write the host cache — an empty mounted brain's `ok`
 * silencing a real host warn is cache poisoning.
 */
function operatingOnHostBrain(): boolean {
  try {
    return resolveBrainId(undefined) === 'host';
  } catch {
    return true; // resolver default is host; fail toward normal behavior
  }
}

export async function getBackupStatus(
  engine: BrainEngine,
  opts: BackupCoverageOpts & { forceRefresh?: boolean },
): Promise<BackupStatus> {
  const hostBrain = operatingOnHostBrain();
  const cached = hostBrain ? loadBackupStatus() : null;
  const nowMs = (opts.now ?? new Date()).getTime();
  const remoteAge = nowMs - Date.parse(cached?.remote_check_at ?? '');
  const remoteDue = opts.localGitProbes === true && opts.verifyRemoteRefs === true
    && (!Number.isFinite(remoteAge) || remoteAge < 0 || remoteAge > BACKUP_VERIFICATION_MAX_AGE_MS);
  if (!opts.forceRefresh && cached && !isBackupStatusStale(cached, nowMs) && !remoteDue) return currentBackupEvidence(cached, nowMs);
  try {
    const fresh = await computeBackupCoverage(engine, { ...opts, previousStatus: cached ?? undefined });
    if (fresh.degraded && cached) return currentBackupEvidence({ ...cached, degraded: true }, nowMs);
    if (opts.localGitProbes && !fresh.degraded && hostBrain) {
      // The save gets its own guard: a failed WRITE (disk full) must not
      // discard the fresh verdict the caller just probed for.
      try {
        saveBackupStatus(fresh);
      } catch {
        process.stderr.write('[backup] could not persist the verdict cache (continuing with the fresh result)\n');
      }
      process.stderr.write(
        `[backup] checked ${fresh.totals.assets} asset(s): ${fresh.totals.no_remote} without a git remote (computed_by=${fresh.computed_by})\n`,
      );
    }
    return fresh;
  } catch (err) {
    if (cached) return currentBackupEvidence({ ...cached, degraded: true }, nowMs);
    throw err;
  }
}

// ── Serve-side in-process refresher (stdio transport ONLY) ──────────────────
//
// For the primary cohort (Claude Code + PGLite + a long-running stdio serve
// holding the single-writer lock) this is the ONLY automatic compute path —
// the detached CLI spawn dies on the lock. Trust defense (D4 + WP1/D7): the
// caller (mcp/dispatch.ts) gates this on `opts.transport === 'stdio'` — the
// same transport-LOCALITY axis localOnly ops use; 'http' or UNSET never
// reaches here. The refresher is NOT caller-parameterized: it takes no
// request arguments, runs fixed read-only git subcommands via execFile array
// args, and only writes a machine-owned file under ~/.gbrain.

let refreshInFlight = false;
let lastRefreshAttemptMs = 0;
/** Failure/attempt throttle so a broken compute can't retry per dispatch. */
const REFRESH_ATTEMPT_FLOOR_MS = 60 * 60 * 1000;

export function __resetBackupRefreshForTests(): void {
  refreshInFlight = false;
  lastRefreshAttemptMs = 0;
}

/**
 * Fire-and-forget, module-level single-flight. Recomputes when the cache is
 * stale-or-absent OR when the cached verdict is `warn` and the cache is >24h
 * old (so a raw-git fix surfaces within a day in the serve cohort). Never
 * throws.
 */
export function maybeRefreshBackupStatusInProcess(engine: BrainEngine): void {
  try {
    if (refreshInFlight) return;
    if (backupCheckDisabled()) return;
    const now = Date.now();
    if (now - lastRefreshAttemptMs < REFRESH_ATTEMPT_FLOOR_MS) return;
    const cached = loadBackupStatus();
    const warnAging =
      cached?.overall === 'warn' && now - Date.parse(cached.checked_at) > 24 * 60 * 60 * 1000;
    if (cached && !isBackupStatusStale(cached, now) && !warnAging) {
      // Arm the attempt floor on the healthy path too: steady-state dispatch
      // must not pay three file reads per tool call — recheck at most hourly
      // (a <=1h detection delay is noise against the 30-day interval).
      lastRefreshAttemptMs = now;
      return;
    }
    refreshInFlight = true;
    lastRefreshAttemptMs = now;
    void getBackupStatus(engine, { localGitProbes: true, computedBy: 'serve', forceRefresh: true })
      .catch(() => {})
      .finally(() => {
        refreshInFlight = false;
      });
  } catch {
    /* never break dispatch over a refresher */
  }
}
