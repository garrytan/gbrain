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
 * Probes are local READ subcommands only (`remote get-url`,
 * `status --porcelain`, `rev-list --count`) via execFile array args — never
 * fetch/push/network. Per-repo failures degrade that asset to 'unknown';
 * a failed compute never clobbers an existing cache (getBackupStatus).
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { VERSION } from '../../version.ts';
import type { BrainEngine } from '../engine.ts';
import { loadAllSources } from '../sources-load.ts';
import { discoverGitRoot } from '../sync-git.ts';
import { GIT_ENV, detectDefaultBranch, isWorkingTreeDirty } from '../git-remote.ts';
import { aheadCount, readPushStatusForRoot } from '../workspace-push.ts';
import { sanitizePushReason } from '../workspace-push.ts';
import { realpathOrResolve } from '../path-confine.ts';
import { resolveBrainId } from '../brain-resolver.ts';
import { readManifest, readReceipt } from '../bootstrap/format.ts';
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
  type BackupAssetVerdict,
  type BackupComputedBy,
  type BackupStatus,
} from './status-file.ts';

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
  /** Provenance stamp for the status file (default 'cli'). */
  computedBy?: BackupComputedBy;
}

const RECIPE_DETAIL =
  'fix: git remote add origin <url> && git push -u origin <branch>, then gbrain sources harden <id>';

function pushAsset(assets: BackupAssetVerdict[], a: BackupAssetVerdict): void {
  assets.push(a);
}

/**
 * Event-loop yield between synchronous git probes. The probe helpers are
 * execFileSync (10-30s timeouts each); in the stdio-serve refresher this
 * compute runs on the MCP server's loop, so without yields a multi-repo brain
 * would freeze ALL tool dispatch for the duration of the sweep. A yield before
 * EACH probe bounds the stall to one subprocess (worst case one subprocess
 * timeout on a wedged repo — accepted residual; the compute is at most daily).
 */
function yieldLoop(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * POSITIVE origin determination. `hasOriginRemote` (sync-git) collapses every
 * failure to `false`, which would turn a git timeout / wedged mount into a
 * false "no remote — a disk loss loses them" warn persisted for a month.
 * Exit code 2 is git's documented "no such remote"; anything else that throws
 * is a probe failure ('unknown').
 */
function originRemoteState(root: string): 'present' | 'absent' | 'unknown' {
  try {
    execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: GIT_ENV,
    });
    return 'present';
  } catch (err) {
    const status = (err as { status?: number }).status;
    return status === 2 ? 'absent' : 'unknown';
  }
}

/**
 * Does the remote-tracking ref origin/<branch> exist locally? false = the
 * remote has NOTHING pushed for this branch (the half-completed `git remote
 * add` state — zero recoverable history); null = probe failure.
 */
function hasRemoteTrackingRef(root: string, branch: string): boolean | null {
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: GIT_ENV,
    });
    return true;
  } catch (err) {
    const status = (err as { status?: number }).status;
    // --quiet --verify exits 1 when the ref does not exist; other failures
    // (timeout, spawn error) are indeterminate.
    return status === 1 ? false : null;
  }
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

  // ── Bootstrap workspace (carries skills/, memory/, brain/, identity) ──────
  // File plane only — no git subprocess needed here.
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
        // THIS workspace's own push status only — a failing entry from some
        // other push-tracked repo must not be misattributed to the workspace.
        const own = readPushStatusForRoot(receipt.workspace_dir);
        if (own && own.ok === false) {
          pushAsset(assets, {
            kind: 'bootstrap_workspace',
            id: receipt.workspace_dir,
            state: 'failing',
            detail: sanitizePushReason(own.reason),
            fix_argv: ['gbrain', 'sources', 'push', '--path', receipt.workspace_dir],
          });
        } else {
          pushAsset(assets, { kind: 'bootstrap_workspace', id: receipt.workspace_dir, state: 'ok' });
        }
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
      try {
        // "No origin" must be a POSITIVE determination — a probe failure
        // (timeout, wedged mount) is 'unknown', never a false "a disk loss
        // loses them" warn persisted for a month.
        await yieldLoop();
        const origin = originRemoteState(root);
        if (origin === 'unknown') {
          pushAsset(assets, { kind: 'source_repo', id, state: 'unknown', detail: 'probe_failed', fix_argv: null });
          continue;
        }
        if (origin === 'absent') {
          // Bootstrap-initialized roots get the mechanical fix; plain repos
          // get the recipe in detail (no single mechanical fix — argv null).
          let initialized = false;
          try {
            initialized = readManifest(root).state === 'initialized';
          } catch {
            /* manifest unreadable — plain-repo recipe */
          }
          pushAsset(assets, {
            kind: 'source_repo',
            id,
            state: 'no_remote',
            detail: RECIPE_DETAIL,
            fix_argv: initialized ? ['gbrain', 'bootstrap', 'repo'] : null,
          });
          continue;
        }
        await yieldLoop();
        const branch = detectDefaultBranch(root);
        // A remote with NOTHING pushed is not a backup: origin/<branch>
        // unresolvable means zero recoverable history — that is the
        // half-completed `git remote add` state and it must WARN, not read ok.
        if (hasRemoteTrackingRef(root, branch) === false) {
          pushAsset(assets, {
            kind: 'source_repo',
            id,
            state: 'no_remote',
            detail: `remote configured but nothing pushed (origin/${branch} not found) — run: git push -u origin ${branch}`,
            fix_argv: null,
          });
          continue;
        }
        await yieldLoop();
        const ahead = aheadCount(root, branch);
        if (ahead === undefined) {
          pushAsset(assets, { kind: 'source_repo', id, state: 'unknown', detail: 'probe_failed', fix_argv: null });
          continue;
        }
        if (ahead > 0) {
          pushAsset(assets, {
            kind: 'source_repo',
            id,
            state: 'unpushed',
            ahead,
            detail: `${ahead} commit(s) ahead of origin/${branch}`,
            fix_argv: null,
          });
          continue;
        }
        await yieldLoop();
        let dirty = false;
        try {
          dirty = isWorkingTreeDirty(root);
        } catch {
          /* dirtiness probe failure is not worth degrading the asset */
        }
        pushAsset(
          assets,
          dirty
            ? { kind: 'source_repo', id, state: 'dirty', detail: 'uncommitted changes', fix_argv: null }
            : { kind: 'source_repo', id, state: 'ok' },
        );
      } catch {
        pushAsset(assets, { kind: 'source_repo', id, state: 'unknown', detail: 'probe_failed', fix_argv: null });
      }
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
  // Pages exist but nothing is git-backed: on PGLite that is total loss on a
  // disk failure; on managed Postgres the DB survives by construction, but it
  // still isn't the git system of record.
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
          `your DB is remote (${pageCount} pages survive a disk loss), but it isn't the git system of record — ` +
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
    recoverable_repos: assets.filter(
      (a) =>
        (a.kind === 'source_repo' || a.kind === 'bootstrap_workspace') &&
        a.state !== 'no_remote' &&
        a.state !== 'unknown' &&
        // A failing push means the remote is BEHIND — counting it recoverable
        // would overstate the recovery statement.
        a.state !== 'failing',
    ).length,
    pages_at_risk: pagesAtRisk,
  };

  return {
    schema_version: BACKUP_STATUS_SCHEMA_VERSION,
    checked_at: now.toISOString(),
    gbrain_version: VERSION,
    interval_days: Math.round(backupIntervalMs() / (24 * 60 * 60 * 1000)) || BACKUP_INTERVAL_DAYS_DEFAULT,
    computed_by: opts.computedBy ?? 'cli',
    overall: totals.no_remote > 0 ? 'warn' : 'ok',
    totals,
    assets,
    ...(degraded ? { degraded: true } : {}),
  };
}

/**
 * The single choke point every compute site routes through: a fresh cache is
 * returned as-is; a stale/absent one triggers a compute. Probed results are
 * persisted; probe-less results are NOT (see module header). A failed compute
 * never clobbers an existing cache — the prior verdict is returned instead.
 */
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
  if (!opts.forceRefresh && cached && !isBackupStatusStale(cached, nowMs)) return cached;
  try {
    const fresh = await computeBackupCoverage(engine, opts);
    // A DEGRADED verdict (engine down mid-compute — sources/pages unreadable)
    // must never replace a probed cache: prefer the prior verdict outright.
    if (fresh.degraded && cached) return cached;
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
    if (cached) return cached;
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
