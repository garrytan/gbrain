/**
 * Git plumbing for `gbrain sync`: invocation building, repo discovery,
 * baseline-commit self-heal, and path-containment guards. Peeled out of
 * src/commands/sync.ts (containment sprint C13-C14) as a pure move.
 */
import { existsSync, readFileSync, realpathSync } from 'fs';
import { execFileSync } from 'child_process';
import { isAbsolute, join, relative, sep } from 'path';
import type { BrainEngine } from './engine.ts';
import { resolveSlugForPath, DEFAULT_SOURCE_ID } from './sync.ts';
import { DELETE_BATCH_SIZE } from './engine-constants.ts';
import { loadStorageConfig } from './storage-config.ts';

/**
 * v0.32.7 CJK wave (codex post-merge F4): resolve a slug by `pages.source_path`
 * first, falling back to `resolveSlugForPath(path)`.
 *
 * Frontmatter-fallback pages (emoji-only / Thai / Arabic / exotic-script
 * filenames where `slugifyPath` returns empty and the slug came from the
 * frontmatter) have a slug that ISN'T derivable from the path. Delete and
 * rename operations that only know the path would otherwise orphan these
 * pages by trying to delete the path-derived (wrong) slug.
 *
 * Returns the actual stored slug when source_path matches a row, or the
 * path-derived slug when there's no match (normal-case path-derived pages).
 */
export async function resolveSlugByPathOrSourcePath(
  engine: BrainEngine,
  path: string,
  sourceId?: string,
): Promise<string> {
  // v0.41.19.0 (D8): when sourceId is set, delegate to the new batch
  // resolveSlugsByPaths so single-call and batched paths share one SQL
  // owner + one fallback semantic. One Map allocation per single-call;
  // negligible cost. When sourceId is undefined (legacy unscoped callers),
  // a direct executeRaw runs instead — the batch method requires sourceId
  // to prevent the multi-source-bug-class on its new surface (D5). That
  // branch is NOT the historical unscoped query any more; see below.
  try {
    if (sourceId) {
      const m = await engine.resolveSlugsByPaths([path], { sourceId });
      const slug = m.get(path);
      if (slug) return slug;
    } else {
      // #3583 gate14: scoped to 'default', matching every WRITE the bare
      // no-sourceId path performs (updateSlug, deletePage, the rename
      // bookkeeping repair — all default-scoped). The historical unscoped
      // form could hand back a row from ANOTHER source that happened to
      // share the source_path; the rename loop takes this return value
      // directly as its cheap-move target, so that foreign slug went to
      // updateSlug, the default-scoped move silently no-opped, and the
      // fallback import landed under a cross-source dedup. Resolve and
      // mutate must agree on the scope.
      const rows = await engine.executeRaw<{ slug: string }>(
        `SELECT slug FROM pages WHERE source_path = $1 AND source_id = $2 LIMIT 1`,
        [path, DEFAULT_SOURCE_ID],
      );
      if (rows.length > 0 && rows[0].slug) return rows[0].slug;
    }
  } catch {
    // Fall through — best-effort. Pre-migration brains or query errors
    // shouldn't break delete/rename for path-derived pages.
  }
  return resolveSlugForPath(path);
}

/** #3942: a fallback resolution refused because the derived slug belongs to a different file. */
export interface RefusedSlugResolution {
  /** The removed file path the caller asked about. */
  path: string;
  /** The re-slugified slug that path derived to. */
  slug: string;
  /** The DIFFERENT file the page at that slug records as its origin. */
  originPath: string;
}

export interface RemovedPathSlugResolution {
  /** path → slug that is safe to act on (delete / rename-from). */
  slugs: Map<string, string>;
  /** Foreign-origin fallbacks the caller must skip (and should log). */
  refused: RefusedSlugResolution[];
}

/** Separator-normalize for source_path comparisons (mirrors sync-reconcile.ts). */
function normalizeOriginPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** One-line operator warning for a refused resolution (#3942). */
export function refusedRemovedPathMessage(r: RefusedSlugResolution): string {
  return (
    `  [sync] refusing to touch '${r.slug}' for removed path '${r.path}': ` +
    `that page originates from '${r.originPath}' (#3942 — re-slugified paths ` +
    `can collide; remove the page directly if you really meant it).`
  );
}

/**
 * #3942 — THE delete-side slug resolver. Every sync lane that turns a
 * REMOVED file path into a slug to delete (or rename away from) routes
 * through here, so the delete side can never act on a re-slugified
 * approximation that names a different file's page.
 *
 * Two phases:
 *
 *  1. Exact `source_path` match — the import side's own record (the same
 *     derivation that wrote the row). Scoped via `resolveSlugsByPaths` when
 *     `sourceId` is set; the legacy unscoped shape otherwise.
 *  2. Path-derived fallback (`resolveSlugForPath`, identical to the import
 *     side's `slugifyPath` dispatch) — but VERIFIED before use:
 *     `slugifySegment` strips trailing hyphens (among other lossy rewrites),
 *     so `extracts/propose-/x.md` and `extracts/propose/x.md` derive the SAME
 *     slug. Verification inspects ALL live rows at the derived slug (the
 *     unscoped lane can see one per source): if every one records a DIFFERENT
 *     origin file, the resolution is REFUSED (returned in `refused`, absent
 *     from `slugs`) instead of silently deleting a page whose own file is
 *     untouched; any row whose origin IS the removed path allows it. Pages
 *     with a NULL `source_path` (legacy pre-source_path imports) and slugs
 *     with no live row at all (no-op deletes) keep today's fallback behavior;
 *     soft-deleted rows are ignored on both phases.
 *
 * Fail-open on lookup errors (pre-migration schemas): a failed verification
 * query preserves the legacy fallback rather than wedging deletes — matching
 * the long-standing best-effort posture of `resolveSlugByPathOrSourcePath`.
 */
export async function resolveSlugsForRemovedPaths(
  engine: BrainEngine,
  paths: string[],
  sourceId: string | undefined,
): Promise<RemovedPathSlugResolution> {
  const slugs = new Map<string, string>();
  const refused: RefusedSlugResolution[] = [];
  if (paths.length === 0) return { slugs, refused };

  // Phase 1: exact source_path → slug (chunked to the engine batch cap).
  const exact = new Map<string, string>();
  if (sourceId !== undefined) {
    for (let i = 0; i < paths.length; i += DELETE_BATCH_SIZE) {
      try {
        const m = await engine.resolveSlugsByPaths(paths.slice(i, i + DELETE_BATCH_SIZE), { sourceId });
        for (const [p, s] of m) exact.set(p, s);
      } catch {
        // Best-effort — fall through to the verified phase-2 fallback.
      }
    }
  } else {
    for (const p of paths) {
      try {
        // Unscoped lane: only LIVE rows may drive resolution (a soft-deleted
        // row's record must not name a slug for the delete side to act on),
        // and the pick is ORDER BY-deterministic when a multi-source brain
        // holds several rows for the same source_path.
        const rows = await engine.executeRaw<{ slug: string }>(
          `SELECT slug FROM pages WHERE source_path = $1 AND deleted_at IS NULL
            ORDER BY source_id, slug LIMIT 1`,
          [p],
        );
        if (rows.length > 0 && rows[0].slug) exact.set(p, rows[0].slug);
      } catch {
        // Best-effort.
      }
    }
  }

  const fallbacks: Array<{ path: string; slug: string }> = [];
  for (const p of paths) {
    const hit = exact.get(p);
    if (hit !== undefined) slugs.set(p, hit);
    else fallbacks.push({ path: p, slug: resolveSlugForPath(p) });
  }
  if (fallbacks.length === 0) return { slugs, refused };

  // Phase 2: verify each derived slug's recorded origin before trusting it.
  // Per-item placeholders (not ANY(array)) so the same executeRaw shape binds
  // identically on both engines — a query error here fails OPEN, which would
  // silently disable the guard, so the boring portable form wins.
  //
  // Collect ALL live rows per slug: the unscoped lane can see one row per
  // source at the same slug, and a single-value (last-row-wins) map made
  // refuse-vs-allow depend on engine row order. `deleted_at IS NULL` keeps
  // soft-deleted rows from vetoing (or licensing) a delete, and the ORDER BY
  // makes the reported refusal origin deterministic. The scoped lane has at
  // most one live row per slug, so its behavior is unchanged.
  const originsBySlug = new Map<string, Array<string | null>>();
  for (let i = 0; i < fallbacks.length; i += DELETE_BATCH_SIZE) {
    const chunk = fallbacks.slice(i, i + DELETE_BATCH_SIZE).map(f => f.slug);
    try {
      const params: unknown[] = [...chunk];
      const placeholders = chunk.map((_, j) => `$${j + 1}`).join(', ');
      let where = `slug IN (${placeholders}) AND deleted_at IS NULL`;
      if (sourceId !== undefined) {
        params.push(sourceId);
        where += ` AND source_id = $${params.length}`;
      }
      const rows = await engine.executeRaw<{ slug: string; source_path: string | null }>(
        `SELECT slug, source_path FROM pages WHERE ${where} ORDER BY source_id, slug`,
        params,
      );
      for (const r of rows) {
        const list = originsBySlug.get(r.slug);
        if (list) list.push(r.source_path);
        else originsBySlug.set(r.slug, [r.source_path]);
      }
    } catch {
      // Fail-open: without origin evidence, keep the legacy fallback.
    }
  }
  for (const f of fallbacks) {
    const origins = originsBySlug.get(f.slug) ?? [];
    // Allow when: no live row at the slug (harmless no-op delete), any legacy
    // NULL-origin row (pre-source_path brains keep today's fallback), or ANY
    // live row that records the removed path itself as its origin. Refuse
    // only when every live row positively names a DIFFERENT origin file.
    const anyNullOrigin = origins.some(o => o == null);
    const anyMatch = origins.some(
      o => o != null && normalizeOriginPath(o) === normalizeOriginPath(f.path),
    );
    if (origins.length > 0 && !anyNullOrigin && !anyMatch) {
      // All origins are non-null mismatches; origins[0] is source_id-ordered,
      // so the reported path is deterministic.
      refused.push({ path: f.path, slug: f.slug, originPath: origins[0] as string });
    } else {
      slugs.set(f.path, f.slug);
    }
  }
  return { slugs, refused };
}

/**
 * Single-path convenience over `resolveSlugsForRemovedPaths` for the per-path
 * sync lanes. Logs any refusal through `warn` and returns undefined so the
 * caller skips the destructive action (#3942).
 */
export async function resolveRemovedPathSlug(
  engine: BrainEngine,
  path: string,
  sourceId: string | undefined,
  warn: (msg: string) => void,
): Promise<string | undefined> {
  const res = await resolveSlugsForRemovedPaths(engine, [path], sourceId);
  for (const r of res.refused) warn(refusedRemovedPathMessage(r));
  return res.slugs.get(path);
}

/**
 * git CLI helper.
 *
 * `configs` flags are emitted as `-c key=val` pairs BEFORE `-C repoPath` and
 * BEFORE the subcommand. `core.quotepath=false` is always emitted first so CJK
 * (and other non-ASCII) paths arrive as UTF-8 in `diff --name-status` and
 * sibling commands. Callers that need additional git config should pass via
 * the `configs` parameter; never inline `-c` into `args`.
 *
 * Exported for `test/sync.test.ts` invariant assertion only.
 */
export function buildGitInvocation(repoPath: string, args: string[], configs: string[] = []): string[] {
  const cfg = ['core.quotepath=false', ...configs].flatMap(c => ['-c', c]);
  return [...cfg, '-C', repoPath, ...args];
}

export function buildAutoEmbedArgs(slugs: string[], sourceId?: string): string[] {
  return sourceId ? ['--source', sourceId, '--slugs', ...slugs] : ['--slugs', ...slugs];
}

/**
 * Resolve sync's effective no-embed mode from CLI args + config.
 *
 * The deferred-setup sentinel (`embedding_disabled: true`, written by
 * `gbrain init --no-embedding`) is an implicit `--no-embed`: without this,
 * the embed credential preflight demands provider credentials the user
 * deliberately deferred at init, and every `gbrain sync` on a keyless
 * brain exits 1. See embed-preflight.ts's skip protocol — the sentinel is
 * meant to be honored before the credential check ever runs.
 *
 * Exported for `test/sync-no-embed-sentinel.test.ts`.
 */
export function resolveNoEmbed(
  args: string[],
  cfg: { embedding_disabled?: boolean } | null,
): boolean {
  return args.includes('--no-embed') || cfg?.embedding_disabled === true;
}

/**
 * Shell out to git with a generous maxBuffer.
 *
 * Node's default maxBuffer is 1 MiB.  `git diff --name-status -M` on a
 * 60–100K file repo easily exceeds that, causing an ENOBUFS crash that
 * kills the sync process with no error message in the log.
 *
 * 100 MiB is generous but still bounded — a 100K-file diff with long
 * paths tops out around 10–20 MiB in practice.
 *
 * `silenceStderr`: Node's `execFileSync` writes the child's stderr straight
 * through to the parent's real stderr by default (in addition to attaching
 * it to the thrown error's `.stderr`) *unless* an explicit `stdio` array is
 * given. Callers that treat a failure as an expected, self-handled outcome
 * (rather than a crash to surface) pass `silenceStderr: true` so git's raw
 * `fatal: ...` line never reaches the process's own stderr — only the
 * caller's own (usually friendlier) handling of the caught error does.
 * Default `false` preserves today's passthrough for every other call site.
 */
export function git(
  repoPath: string,
  args: string[],
  configs: string[] = [],
  timeoutMs = 30000,
  { silenceStderr = false }: { silenceStderr?: boolean } = {},
): string {
  return execFileSync('git', buildGitInvocation(repoPath, args, configs), {
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 100 * 1024 * 1024,
    ...(silenceStderr ? { stdio: ['ignore', 'pipe', 'pipe'] as const } : {}),
  }).trim();
}

/**
 * git() minus the trim — REQUIRED for NUL-delimited listings (`ls-files -z`,
 * `ls-tree -z`): a filename that begins with a space is the FIRST entry of
 * the listing, and trim() silently rewrites it into a different path (#3583
 * review — the misread let a decoy blob stand in for the real file and a
 * live page was deleted on the corrupted evidence).
 */
export function gitRawOutput(repoPath: string, args: string[]): string {
  return execFileSync('git', buildGitInvocation(repoPath, args, []), {
    encoding: 'utf-8',
    timeout: 30000,
    maxBuffer: 100 * 1024 * 1024,
  });
}

/**
 * #753/#774: walk up from inputPath to the nearest git repo root via
 * `git -C <path> rev-parse --show-toplevel`. Handles worktrees and submodules
 * natively (git itself resolves them). Throws a user-friendly error when no
 * git repo is found.
 *
 * The probe's failure is expected and routine (a non-git-yet brain dir, a
 * scratch dir, a caller checking "is this a repo?") — `sync.ts` self-heals
 * it (git-init) or surfaces the message below, never the raw git stderr.
 * `silenceStderr: true` keeps git's own `fatal: not a git repository ...`
 * off the process's real stderr so operator log-scanning for `fatal:` as a
 * crash signature doesn't false-alarm on every routine probe miss (#2964
 * auto-recovery made the *outcome* self-healing; this keeps the *log* quiet
 * about the expected miss that triggered it).
 */
export function discoverGitRoot(inputPath: string): string {
  try {
    return git(inputPath, ['rev-parse', '--show-toplevel'], [], 30000, { silenceStderr: true });
  } catch {
    throw new Error(
      `Not inside a git repository: ${inputPath}. GBrain sync requires a git-initialized repo (or a subdirectory of one).`,
    );
  }
}

/**
 * #2964: snapshot the CURRENT on-disk state of a gbrain-owned brain dir as
 * a baseline commit — used both right after a self-healing `git init` (no
 * `.git` at all) and to recover a repo left with `.git` but zero commits
 * (an interrupted prior self-heal, or a `git init` from some other source
 * that never got a first commit). Respects `.gitignore` (written first) so
 * future incremental syncs diff against what's actually here rather than
 * an empty tree — an empty initial commit would make every existing file
 * look "added" again on the next sync, even though the full-sync pass that
 * follows already imported them from disk directly.
 *
 * `--no-gpg-sign` + explicit `-c user.name/user.email`: this runs from a
 * headless nightly cron/launchd invocation, which has no reason to have
 * git signing/identity configured, and must not block on an unavailable
 * signing agent or pinentry prompt.
 *
 * db_only exclusion is recomputed directly and passed to `git add` as
 * negative pathspecs, rather than relying solely on `manageGitignore`
 * having written `.gitignore` successfully: that helper is deliberately
 * best-effort (a broken gbrain.yml parse, or an unwritable .gitignore,
 * only warns and returns — the right default for its OTHER callers, where
 * .gitignore management is a side effect that must never kill the sync
 * job). For a commit we are about to create ourselves, "fail open" there
 * would mean silently committing db_only content into git history. Fail
 * closed instead: db_only exclusion doesn't depend on the .gitignore
 * write having succeeded. `loadStorageConfig` throwing (unreadable
 * gbrain.yml, or a semantic overlap) propagates — better to leave this
 * self-heal wedged with a clear error than commit unknown content.
 */
/**
 * Classify a caught `git rev-parse --verify --quiet HEAD` failure for the
 * baseline-commit guard. A genuinely UNBORN HEAD makes git exit with status
 * EXACTLY 1 and nothing on stderr — precisely what `--verify --quiet` emits
 * for an unresolvable HEAD (verified empirically: unborn => exit 1, empty
 * stderr; born => exit 0). Every OTHER failure shape — a 30s timeout (killed
 * by signal, so `status` is null), an index/ref lock (`fatal: Unable to
 * create ...lock`, non-empty stderr), or any nonzero-but-not-1 exit — is NOT
 * proof the repo is empty; it is the transient-probe-failure class that
 * corrupted the live brain on 2026-08-10. Return 'unborn' ONLY for the clean
 * signal so the caller fails CLOSED on 'ambiguous'. Pure (no I/O) so the
 * distinction is unit-testable without fault injection.
 */
export function classifyHeadProbeError(err: unknown): 'unborn' | 'ambiguous' {
  const e = (err ?? {}) as { status?: number | null; signal?: string | null; stderr?: unknown };
  const stderr = e.stderr == null ? '' : String(e.stderr).trim();
  return e.status === 1 && e.signal == null && stderr === '' ? 'unborn' : 'ambiguous';
}

export function createSyncBaselineCommit(repoPath: string): void {
  // Fail-closed backstop (2026-08-10 auto-init incident). This function's
  // ENTIRE contract is "snapshot an unborn/uninitialized repo as its FIRST
  // commit". It must NEVER run on a repo that already has commits: doing so
  // stacks a spurious `gbrain: initial commit (auto-init by sync)` commit ON
  // TOP of real history and, on a case-insensitive filesystem, re-cases the
  // whole tree (`projects` -> `Projects`) as a `git add -A` side effect.
  //
  // Both call sites are *supposed* to reach here only on an unborn/non-git
  // repo, but each infers "unborn" from a FAILURE to observe git state
  // (`discoverGitRoot` threw / `git rev-parse HEAD` threw), and those probes
  // ALSO fail transiently — a 30s timeout on a large brain, or a concurrent
  // `gbrain-sync` holding a git lock — against a fully-populated repo, which
  // is exactly what corrupted the live brain on 2026-08-10. So we cannot
  // trust "the caller said it's unborn"; verify POSITIVELY here — and, since
  // this very probe is subject to the same transient failures, accept ONLY a
  // CLEAN unborn signal. A born HEAD (exit 0) OR an ambiguous probe failure
  // (timeout / lock / other) both REFUSE, so the backstop is fail-closed
  // against every corruption path, not just the born-HEAD one.
  // `classifyHeadProbeError` isolates that born/unborn/ambiguous distinction
  // as a pure, unit-tested predicate.
  //
  // Known non-incident edge (B2, documented not fixed): an orphan branch
  // (`git switch --orphan`) in a repo with history elsewhere probes as unborn
  // and would still be baselined. A gbrain brain is never in that state; it is
  // not the incident (no stacking on real history, no re-case of other
  // branches), so it is left as a limitation rather than complicating the
  // guard with a `rev-list --all` "commits anywhere" probe.
  let headState: 'born' | 'unborn' | 'ambiguous';
  try {
    git(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD'], [], 30000, { silenceStderr: true });
    headState = 'born';
  } catch (err) {
    headState = classifyHeadProbeError(err);
  }
  if (headState !== 'unborn') {
    throw new Error(
      `Refusing to create a sync baseline commit in ${repoPath}: HEAD probe is ` +
        `'${headState}', expected a clean unborn HEAD. 'born' = the repo already ` +
        `has commits (real history); 'ambiguous' = the HEAD check failed ` +
        `transiently (30s timeout, or a concurrent gbrain-sync holding a git ` +
        `lock), which is NOT proof the repo is empty. Committing either way ` +
        `would stack a bogus auto-init commit on real history and re-case the ` +
        `tree on a case-insensitive filesystem.`,
    );
  }
  // #2964: db_only exclusion is computed directly from loadStorageConfig
  // and passed to `git add` as pathspecs — deliberately NOT via
  // manageGitignore/.gitignore, for two independent reasons:
  //
  // 1. Ordering (Codex review round 6, P1): `collectSyncableFiles` — the
  //    file enumeration `performFullSync` runs right after this function
  //    returns — honors `.gitignore` via `git ls-files --exclude-standard`.
  //    Writing db_only entries into `.gitignore` BEFORE that first import
  //    would silently exclude those pages from the database entirely.
  //    That's the exact bug class `runSync`'s existing "manage .gitignore
  //    ONLY on successful sync" ordering (this file, `manageGitignoreAtGitRoot`
  //    callers below — itself a prior Codex P1 fix) exists to prevent. Leave
  //    `.gitignore` untouched here; the existing post-sync flow writes it
  //    once this sync completes, same as it does for every other sync.
  // 2. Fail-closed (rounds 5-6): `manageGitignore`'s "warn and return" on a
  //    broken gbrain.yml/unwritable .gitignore is the right default for its
  //    OTHER callers (a side effect that must never kill the sync job), but
  //    wrong for a commit we are creating ourselves — silently committing
  //    db_only content into git history.
  const storageConfig = loadStorageConfig(repoPath);
  const dbOnlyDirs = storageConfig?.db_only ?? [];
  // Sniff-test fail-closed (round 6, P2): `loadStorageConfig` warns-and-
  // returns an EMPTY config for syntactically-valid-but-unsupported YAML
  // (e.g. flow-style `db_only: [dir/]` — the narrow custom parser only
  // handles block-style lists), which would silently resolve zero
  // exclusions from a file that clearly intended some. If gbrain.yml
  // exists and mentions db_only (or its deprecated pre-v0.22.11 alias
  // `supabase_only` — same keep-out-of-git semantics, still a supported
  // backward-compat key per storage-config.ts) but nothing resolved from
  // it, refuse rather than guess "genuinely empty" vs "syntax ignored".
  //
  // Known false-positive (round 8 review): a genuinely, intentionally
  // empty `db_only: []` mentioning the word also refuses, and can't be
  // told apart from the unsupported-syntax case — `loadStorageConfig`
  // returns the IDENTICAL `{db_tracked:[],db_only:[]}` for both (verified
  // directly: flow-style `[dir/]` and literal `[]` both collapse to that
  // same shape). Distinguishing them would mean teaching this function
  // about the parser's internal line-recognition rules, which belongs in
  // storage-config.ts, not here. Accepted trade-off: the false-positive
  // cost is low and self-resolving (the brain stays wedged with a clear,
  // actionable error until the user drops the pointless empty stanza or
  // fixes their syntax; retried on every subsequent sync); the
  // false-negative this guards against — silently committing db_only
  // content into permanent git history — is high-cost and hard to undo.
  if (dbOnlyDirs.length === 0) {
    const yamlPath = join(repoPath, 'gbrain.yml');
    const yamlContent = existsSync(yamlPath) ? readFileSync(yamlPath, 'utf-8') : '';
    // A YAML KEY line (`db_only:` / `supabase_only:`, ignoring leading
    // whitespace and `#` comments), not a bare substring search — round 9,
    // P2: a comment or unrelated prose value that happens to mention the
    // word (e.g. `# db_only handling TBD`) must not trip this guard on an
    // otherwise-genuinely-config-free gbrain.yml.
    const mentionsUnresolvedKey = yamlContent.split('\n').some((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('#') && /^(db_only|supabase_only)\s*:/.test(trimmed);
    });
    if (mentionsUnresolvedKey) {
      throw new Error(
        `${yamlPath} mentions db_only but no directories resolved from it — refusing to ` +
          `auto-commit (cannot tell "genuinely empty" from "unsupported syntax silently ignored"). ` +
          `Fix gbrain.yml's storage.db_only syntax, or git-init this directory manually.`,
      );
    }
  }
  // #2964 (round 9, P1): every db_only dir is ALWAYS pathspec-excluded,
  // unconditionally — never pre-filtered against what an existing
  // `.gitignore` claims to already cover. An earlier version checked
  // `git check-ignore -q dir` first and skipped the pathspec when it
  // already reported "ignored" (to dodge the advisory error below), but
  // `check-ignore` on a directory can say "ignored" even when a
  // pre-existing `.gitignore` re-includes a child via negation (e.g.
  // `private-cache/*` + `!private-cache/index.md`) — the filter would
  // then skip excluding it via pathspec, and `git add -A` would stage
  // that re-included child despite the whole directory being declared
  // db_only. Our OWN pathspec exclusion is unconditional and doesn't
  // consult `.gitignore` at all, so it can't be defeated by ANY
  // .gitignore content, negated or not. `:(exclude,literal)dir` (not the
  // `:!dir` shorthand) so a db_only dir name that itself starts with a
  // pathspec magic character like `:` is excluded literally rather than
  // reinterpreted (round 9, P2).
  const excludePathspecs = dbOnlyDirs.map((dir) => `:(exclude,literal)${dir}`);
  // Clear the index before staging (round 6, P1): the unborn-HEAD
  // recovery site can reach this function with a repo whose index
  // already has entries staged from some OTHER prior operation (a manual
  // `git add`, an interrupted workflow) before gbrain ever touched it.
  // `add -A` only adds/updates — it does not drop an already-staged path
  // that our exclusion pathspecs above now want excluded. `read-tree
  // --empty` resets the index without touching the working tree; a
  // no-op on a freshly-`git init`-ed repo, whose index is already empty.
  git(repoPath, ['read-tree', '--empty']);
  try {
    // #2964: 10 minutes, not the shared git() helper's 30s default — this
    // full-tree `git add -A` walks a legacy brain that may hold years of
    // accumulated content. A 30s timeout would abort staging after `git
    // init` already created `.git`, leaving an unborn repo that every
    // subsequent sync would retry (and time out identically) forever;
    // the unborn-HEAD recovery path exists for OTHER causes of that
    // state, not to be this one's normal first outcome.
    git(repoPath, ['add', '-A', '--', '.', ...excludePathspecs], [], 600_000);
  } catch (err) {
    // Now that exclusion is always applied (never pre-filtered), an
    // explicit pathspec exclusion for a path a pre-existing `.gitignore`
    // ALSO happens to cover trips git's advice.addIgnoredFile: nonzero
    // exit + "paths ignored by one of your .gitignore files, use -f",
    // even though the add otherwise fully succeeded (verified directly:
    // `git status --short` right after this exact error shows every
    // non-excluded path staged correctly). Recognize and swallow ONLY
    // this exact advisory; anything else (timeout, permission denied,
    // real corruption) rethrows.
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : '';
    if (!stderr.includes('ignored by one of your .gitignore files')) throw err;
  }
  git(
    repoPath,
    // --no-verify only skips pre-commit/commit-msg — prepare-commit-msg
    // and (worse, since it runs AFTER the commit object already exists,
    // synchronously inside this same git invocation) post-commit are
    // NOT covered by it. An operator's global core.hooksPath or
    // init.templateDir can wire either, expecting project tooling,
    // prompting interactively, or hanging — none of which a headless
    // self-heal commit can satisfy, and a hanging post-commit hook would
    // burn the 600s budget above without even being the slow step.
    // `-c core.hooksPath=/dev/null` (in configs, below) makes git look
    // for hook scripts inside a location that can't contain any,
    // disabling the entire hooks path for this one invocation — the
    // complete form of what --no-verify only partially covers, kept for
    // explicitness on the two hooks it does name.
    [
      'commit', '--quiet', '--allow-empty', '--no-gpg-sign', '--no-verify',
      '-m', 'gbrain: initial commit (auto-init by sync)',
    ],
    ['user.name=gbrain', 'user.email=gbrain@localhost', 'core.hooksPath=/dev/null'],
  );
}

/**
 * True when `childReal` is `rootReal` itself or lives inside it. Both arguments
 * must already be realpath-resolved. Containment is decided by `relative()`
 * rather than a string prefix, so it holds on Windows too: `realpathSync`
 * returns backslash paths there, and a literal `rootReal + '/'` prefix can
 * never match one. A sibling (`root-evil`) is rejected because `relative`
 * yields `../root-evil`, and a cross-drive path because it yields an absolute.
 * On Windows this intentionally follows the platform path semantics exposed by
 * `win32.relative`, including case-insensitive segment matching; detecting rare
 * per-directory case-sensitive NTFS siblings would require filesystem identity
 * checks rather than a pure path check. (#4044/#4144)
 */
interface PathContainmentOps {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
}

const nativePathContainmentOps: PathContainmentOps = { relative, isAbsolute, sep };

export function isWithinRoot(
  childReal: string,
  rootReal: string,
  pathOps: PathContainmentOps = nativePathContainmentOps,
): boolean {
  if (childReal === rootReal) return true;
  const rel = pathOps.relative(rootReal, childReal);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith('..' + pathOps.sep) && !pathOps.isAbsolute(rel);
}

/**
 * #774 NAV-1 TOCTOU: true only if filePath realpath-resolves inside gitRoot.
 * Guards symlink escape at the per-file level (a committed symlink whose
 * target lives outside the repo), not just at scope entry.
 */
export function isPathSafe(filePath: string, gitRoot: string): boolean {
  try {
    return isWithinRoot(realpathSync(filePath), realpathSync(gitRoot));
  } catch {
    return false;
  }
}

export function hasOriginRemote(repoPath: string): boolean {
  try {
    execFileSync('git', buildGitInvocation(repoPath, ['remote', 'get-url', 'origin']), {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function isDetachedHead(repoPath: string): boolean {
  try {
    git(repoPath, ['symbolic-ref', '--quiet', 'HEAD']);
    return false;
  } catch {
    return true;
  }
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
