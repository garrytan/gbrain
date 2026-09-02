/**
 * default-source-path-check — detect a `default` source whose null
 * `local_path` DEMONSTRABLY breaks the write-through / sync plane.
 *
 * The `default` source is the implicit write-through target for any unscoped
 * `gbrain put` / `gbrain capture` call that doesn't name a `--source`.
 * IMPORTANT: `local_path: null` on the `default` row is NOT an error by
 * itself — it is the designed fallback topology. `resolvePageWriteTarget`
 * (write-through.ts) nests default-source pages under `sync.repo_path` when
 * `default.local_path` is null, and the #2018 leak guard already refuses to
 * write into a path that is another source's own working tree. A fresh
 * `gbrain init` leaves `default.local_path` null on purpose.
 *
 * So this check warns ONLY when the null pointer provably breaks something:
 *
 *   - LEAK-GUARDED FALLBACK: `sync.repo_path` is literally another source's
 *     own `local_path`, so every unscoped write-through for default-source
 *     pages is silently skipped (`source_repo_belongs_to_other_source`).
 *   - UNRESOLVABLE ROOT: default has FILE-BACKED pages (`source_path` set —
 *     they were imported from real files) but neither `default.local_path`
 *     nor a resolvable `sync.repo_path` names the tree they live in, so
 *     write-through, fence writes, and delete-reconcile cannot find them.
 *
 * Everything else (no pages yet, resolvable repo fallback, deliberate
 * DB-only brain) reports ok. The repair for a genuinely broken pointer is
 * the non-destructive `gbrain sources set-path default <path>`.
 *
 * Pure assessment helper (no DB/FS access — the caller supplies the
 * gathered inputs) so it is unit-testable, in the same shape as
 * npm-squat-check.ts / pglite-leftovers-check.ts. The gathering wrapper
 * lives on the doctor surface (doctor/checks/default-source-path.ts).
 */
export interface DefaultSourcePathInput {
  /** The `default` sources row, or undefined when no such row exists. */
  defaultSource: { local_path: string | null } | undefined;
  /** Live (deleted_at IS NULL) pages on the default source. */
  livePages: number;
  /** Live default-source pages with a recorded source_path (file-backed). */
  fileBackedPages: number;
  /** The `sync.repo_path` config value, if any. */
  repoPath: string | null;
  /** True when repoPath exists on disk and is a directory. */
  repoPathIsDir: boolean;
  /** A non-default source whose own local_path equals repoPath (#2018 leak guard), if any. */
  collidingSourceId: string | null;
}

export interface DefaultSourcePathAssessment {
  status: 'skip' | 'ok' | 'warn';
  message: string;
}

export function assessDefaultSourcePath(
  input: DefaultSourcePathInput,
): DefaultSourcePathAssessment {
  const { defaultSource, livePages, fileBackedPages, repoPath, repoPathIsDir, collidingSourceId } = input;
  if (!defaultSource) {
    // No `default` row at all is a different, more fundamental problem than
    // this check's scope — leave it to whatever check owns sources-table
    // integrity.
    return { status: 'skip', message: '' };
  }
  if (defaultSource.local_path) {
    return {
      status: 'ok',
      message: `default source local_path is set: ${defaultSource.local_path}`,
    };
  }
  // null local_path — the designed fallback topology. Only warn when the
  // fallback demonstrably fails for pages that actually route through it.
  if (livePages === 0) {
    return {
      status: 'ok',
      message:
        'default source has no local_path and no pages — nothing routes through it yet ' +
        '(the sync.repo_path fallback applies when pages arrive).',
    };
  }
  const rootResolvable = Boolean(repoPath) && repoPathIsDir;
  if (rootResolvable && collidingSourceId) {
    return {
      status: 'warn',
      message:
        `default source has local_path: null and sync.repo_path (${repoPath}) is source ` +
        `"${collidingSourceId}"'s own working tree — the #2018 leak guard silently SKIPS every ` +
        `unscoped write-through for the ${livePages} default-source page(s), so \`gbrain put\`/` +
        '`gbrain capture` writes never reach disk. Fix with `gbrain sources set-path default <path>` ' +
        '(non-destructive pointer repair).',
    };
  }
  if (rootResolvable) {
    return {
      status: 'ok',
      message:
        `default source has no local_path; its ${livePages} page(s) write through ` +
        `sync.repo_path (${repoPath}) — the designed fallback topology.`,
    };
  }
  if (fileBackedPages > 0) {
    return {
      status: 'warn',
      message:
        `default source has local_path: null and no resolvable sync.repo_path ` +
        `(${repoPath ? `set to ${repoPath}, which is not a directory on disk` : 'not set'}), ` +
        `but ${fileBackedPages} of its ${livePages} page(s) are file-backed (source_path recorded) — ` +
        'write-through, fence writes, and delete-reconcile cannot locate their files. ' +
        'Fix with `gbrain sources set-path default <path>` (non-destructive pointer repair).',
    };
  }
  return {
    status: 'ok',
    message:
      `default source is DB-only (no local_path, no resolvable sync.repo_path, ` +
      `${livePages} page(s) with no file of record) — nothing demonstrably broken.`,
  };
}
