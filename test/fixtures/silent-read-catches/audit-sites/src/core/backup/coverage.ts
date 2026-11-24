// @ts-nocheck
// Pinned audit sites: code copied verbatim from src/core/backup/coverage.ts at origin/master 7ef3d53a47 (parsed by the guard test, never run).
// The test asserts each catch below is counted under the path#function key that scripts/silent-read-catches-baseline.tsv uses.

// verbatim src/core/backup/coverage.ts:110-124
async function brainMaturity(engine: BrainEngine): Promise<BackupStatus['maturity'] | undefined> {
  try {
    const [row] = await engine.executeRaw<{ pages: number; facts: number; since: string | Date | null }>(
      `SELECT (SELECT COUNT(*)::int FROM pages WHERE deleted_at IS NULL) AS pages,
              (SELECT COUNT(*)::int FROM facts WHERE expired_at IS NULL) AS facts,
              LEAST((SELECT MIN(created_at) FROM sources), (SELECT MIN(created_at) FROM pages)) AS since`,
    );
    const items = Number(row?.pages) + Number(row?.facts);
    if (!row || !Number.isFinite(items)) return undefined;
    const sinceMs = row.since ? new Date(row.since).getTime() : NaN;
    return { items, since: Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null };
  } catch {
    return undefined;
  }
}

// verbatim src/core/backup/coverage.ts:126-138
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

// verbatim src/core/backup/coverage.ts:522-548
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

export async function computeBackupCoverage(engine: any) {
  // verbatim src/core/backup/coverage.ts:146-147
  const remoteBudget: RemoteProbeBudget | undefined = opts.localGitProbes === true && opts.verifyRemoteRefs === true
    ? { remaining: BACKUP_REMOTE_PROBE_CAP, timeoutMs: resolveBackupRemoteTimeoutMs(await Promise.resolve().then(() => engine.getConfig(BACKUP_REMOTE_TIMEOUT_KEY)).catch(() => null)) } : undefined;
  // ...
  // verbatim src/core/backup/coverage.ts:158-192
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
  // ...
  // verbatim src/core/backup/coverage.ts:261-265
      try {
        dbOnly = (loadStorageConfig(row.local_path)?.db_only?.length ?? 0) > 0;
      } catch {
        /* storage config unreadable — treat as no db_only tiering */
      }
  // ...
  // verbatim src/core/backup/coverage.ts:343-356
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
}
