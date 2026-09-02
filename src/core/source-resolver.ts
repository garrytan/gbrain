/**
 * Source resolution for CLI commands (v0.18.0).
 *
 * Resolution priority (highest first):
 *   1. Explicit --source <id> flag (caller passes this as `explicit`)
 *   2. GBRAIN_SOURCE env var
 *   3. .gbrain-source dotfile in CWD or any ancestor directory
 *   4. Registered source whose local_path contains CWD
 *   5. Brain-level default via `gbrain sources default <id>`
 *   6. Literal 'default' (backward compat for pre-v0.17 brains)
 *
 * This helper is shared by the sources CLI, future sync/extract/query
 * commands (Steps 4/5), and the operation layer (Step 2+).
 */

import { readFileSync, lstatSync, type Stats } from 'fs';
import { join, dirname, resolve } from 'path';
import type { BrainEngine } from './engine.ts';
import { isSourceFederated, parseSourceConfig } from './sources-load.ts';
import { SOURCE_ID_RE, isValidSourceId, ALL_SOURCES } from './source-id.ts';
import { isTrustedDotfile, realpathOrResolve, realpathOrResolveAsync } from './path-confine.ts';

// Re-export so scope-resolution call sites can import the sentinel from
// either module (#1712).
export { ALL_SOURCES };

/** A caller-selected source id is invalid, missing, or archived. */
export class SourceTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceTargetError';
  }
}

const DOTFILE = '.gbrain-source';
// Canonical SOURCE_ID_RE imported from `source-id.ts` (single source of truth).
// Re-exported below as `__testing.SOURCE_ID_RE` for legacy test imports.
// Two validator shapes per codex r2 P1-F:
//   - `isValidSourceId(s)`: boolean — used by tiers that silently fall through
//     on invalid input (dotfile tier 3, brain_default tier 5)
//   - explicit throw — used by tiers that must reject loudly with a tailored
//     message (explicit `--source` flag tier 1, GBRAIN_SOURCE env tier 2).
//     Tier-specific messages are clearer than the generic assertValidSourceId
//     error, so the throws stay inline.

function readDotfileWalk(startDir: string): string | null {
  let dir = resolve(startDir);
  // Guard against infinite loops on malformed paths.
  for (let i = 0; i < 50; i++) {
    const candidate = join(dir, DOTFILE);
    // lstatSync (NOT statSync) so a planted symlink is seen here, not silently
    // followed-then-trusted. Any stat error (ENOENT / permission) → skip this
    // candidate and keep walking (fail-closed). On a multi-user host an
    // attacker who can write a shared ancestor dir could otherwise plant a
    // forged `.gbrain-source`; `isTrustedDotfile` refuses symlinks,
    // foreign-owned, and world-writable files (#418).
    let st: Stats | null = null;
    try { st = lstatSync(candidate); } catch { st = null; }
    if (st && isTrustedDotfile(st)) {
      try {
        const content = readFileSync(candidate, 'utf8').trim().split('\n')[0].trim();
        // Silent-fallback tier per codex P1-F: invalid dotfile content
        // (legacy ids with underscores, hand-edits with whitespace, etc.)
        // falls through to the next tier instead of throwing. The CLI's
        // explicit/env tiers throw; dotfiles are operator-edited and the
        // forgiving behavior preserves the resolver's existing semantics.
        if (isValidSourceId(content)) return content;
      } catch {
        // Unreadable dotfile — skip and keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Resolve the source id for a CLI command.
 *
 * @param engine  Connected brain engine (for sources table lookups).
 * @param explicit  The --source <id> flag value, if the caller parsed one.
 * @param cwd  The working directory to walk for .gbrain-source. Defaults
 *             to process.cwd(). Exposed for testability.
 * @returns  The resolved source id. Falls back to 'default' if no other
 *           signal is present. Never returns null — every command must
 *           target exactly one default source.
 * @throws  If the resolved id doesn't correspond to a registered source
 *          (prevents silently writing to a nonexistent source and bloating
 *          pages with a dead FK).
 */
/**
 * Tier-4 shared core: "registered source whose local_path contains CWD",
 * longest-prefix-wins. Realpaths BOTH sides (not bare resolve) so a
 * symlinked CWD can't forge a prefix match against a registered local_path
 * it doesn't really live under (codex #9); `realpathOrResolveAsync` falls
 * back to lexical resolve() for a stale registration whose path no longer
 * exists.
 *
 * All N `local_path` realpaths (plus cwd's) resolve via `Promise.all`
 * (#4091-class fix): a synchronous `realpathSync` loop blocks the event
 * loop for the FULL duration of every call in sequence, so wrapping the
 * sync calls in `Promise.all` doesn't parallelize anything — a single slow
 * or interrupted filesystem path (network mount, macOS on-access security
 * scan, degraded disk) still serializes the whole tier behind itself times
 * the registered-source count. The async realpath here truly overlaps I/O
 * across sources, so the tier's cost is bounded by the SLOWEST single
 * source, not their sum.
 *
 * Shared by `resolveSourceId` and `resolveSourceWithTier` so the two
 * resolution-chain entry points can't drift on this tier (mirrors how
 * `pickSoleNonDefaultSource` is already shared for tier 5.5).
 */
async function resolveRegisteredPathMatch(
  engine: BrainEngine,
  cwd: string,
): Promise<{ id: string; path: string; pathLen: number } | null> {
  const registered = await listRegisteredLocalPathSources(engine);
  if (registered.length === 0) return null;
  const [cwdResolved, resolvedPaths] = await Promise.all([
    realpathOrResolveAsync(cwd),
    Promise.all(registered.map(r => realpathOrResolveAsync(r.local_path))),
  ]);
  // #3880: ACTIVE sources win the prefix match — an archived (deeper)
  // registration must not shadow an active parent source. When cwd lands
  // ONLY in archived trees, the caller's assertSourceExists still throws
  // (explicit unavailable target — never silent continuation). The paths
  // are already resolved above, so the tiering is a pure in-memory pass.
  for (const archivedTier of [false, true]) {
    let best: { id: string; path: string; pathLen: number } | null = null;
    for (let i = 0; i < registered.length; i++) {
      if ((registered[i].archived === true) !== archivedTier) continue;
      const p = resolvedPaths[i];
      if (cwdResolved === p || cwdResolved.startsWith(p + '/')) {
        if (!best || p.length > best.pathLen) {
          best = { id: registered[i].id, path: p, pathLen: p.length };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

export async function resolveSourceId(
  engine: BrainEngine,
  explicit: string | null | undefined,
  cwd: string = process.cwd(),
): Promise<string> {
  // 1. Explicit flag wins. The __all__ sentinel passes through verbatim
  //    (#1712) — it is not a source id, so it skips both the regex and
  //    assertSourceExists; sourceScopeOpts gives it span-everything semantics.
  if (explicit) {
    if (explicit === ALL_SOURCES) return ALL_SOURCES;
    if (!SOURCE_ID_RE.test(explicit)) {
      throw new SourceTargetError(`Invalid --source value "${explicit}". Must match [a-z0-9-]{1,32}.`);
    }
    await assertSourceExists(engine, explicit);
    return explicit;
  }

  // 2. Env var. Same __all__ pass-through (#2140).
  const env = process.env.GBRAIN_SOURCE;
  if (env && env.length > 0) {
    if (env === ALL_SOURCES) return ALL_SOURCES;
    if (!SOURCE_ID_RE.test(env)) {
      throw new SourceTargetError(`Invalid GBRAIN_SOURCE value "${env}". Must match [a-z0-9-]{1,32}.`);
    }
    await assertSourceExists(engine, env);
    return env;
  }

  // 3. .gbrain-source dotfile walk-up.
  const dotfile = readDotfileWalk(cwd);
  if (dotfile) {
    await assertSourceExists(engine, dotfile);
    return dotfile;
  }

  // 4. Registered source whose local_path contains CWD.
  //    Uses longest-prefix match so nested-path configurations (e.g.
  //    gstack at ~/gstack + plans at ~/gstack/plans) pick the deepest.
  //    #3880 active-over-archived tiering + parallel realpath both live in
  //    the shared resolveRegisteredPathMatch helper.
  const best = await resolveRegisteredPathMatch(engine, cwd);
  if (best) {
    // A local_path registration can outlive source archival. Treat landing in
    // that tree as an explicit unavailable target, never as permission to
    // continue writing through an archived source id.
    await assertSourceExists(engine, best.id);
    return best.id;
  }

  // 5. Brain-level default.
  // Silent-fallback tier per codex P1-F: an invalid `sources.default` config
  // value (operator hand-edit gone wrong, legacy underscore id) falls through
  // to tier 6 rather than throwing. Resolver stays robust to bad config.
  const globalDefault = await engine.getConfig('sources.default');
  if (globalDefault && isValidSourceId(globalDefault)) {
    await assertSourceExists(engine, globalDefault);
    return globalDefault;
  }

  // 5.5. Single-non-default-source convenience (v0.41.13, #1434).
  //      When NO brain_default is set AND exactly one registered source has
  //      local_path set AND it isn't 'default', route there. This closes
  //      the "532 silent edit failures" bug class where users with a single
  //      Vault-mounted source ran `gbrain sync` without --source and routed
  //      to source_id='default' (which held 0 pages). Conservative: fires
  //      only when there's literally one option AND 'default' is empty
  //      (#3070) — multi-source brains and established default corpora
  //      still require explicit --source or sources.default.
  //
  //      Placed AFTER brain_default per codex review: a user who explicitly
  //      set sources.default has stated intent, that wins over auto-routing.
  const soleNonDefault = await pickSoleNonDefaultSource(engine);
  if (soleNonDefault) return soleNonDefault;

  // 6. Fallback: the seeded 'default' source. Always exists post-migration
  //    v16 so this is a safe terminal.
  return 'default';
}

/**
 * Engine-free tiers (1-3) of the resolution chain: explicit flag →
 * GBRAIN_SOURCE env → .gbrain-source dotfile walk. Used by the thin-client
 * CLI path (#2098), which has no local engine to run tiers 4-6 or
 * assertSourceExists against — the remote server enforces existence + grant.
 * Returns null when no engine-free tier fires.
 */
export function resolveSourceIdEngineFree(
  explicit: string | null | undefined,
  cwd: string = process.cwd(),
): string | null {
  if (explicit) {
    if (explicit === ALL_SOURCES) return ALL_SOURCES; // #1712 sentinel pass-through
    if (!SOURCE_ID_RE.test(explicit)) {
      throw new Error(`Invalid --source value "${explicit}". Must match [a-z0-9-]{1,32}.`);
    }
    return explicit;
  }
  const env = process.env.GBRAIN_SOURCE;
  if (env && env.length > 0) {
    if (env === ALL_SOURCES) return ALL_SOURCES; // #2140 sentinel pass-through
    if (!SOURCE_ID_RE.test(env)) {
      throw new Error(`Invalid GBRAIN_SOURCE value "${env}". Must match [a-z0-9-]{1,32}.`);
    }
    return env;
  }
  return readDotfileWalk(cwd);
}

/**
 * Returns the id of the SINGLE registered non-default source with a
 * local_path, when exactly one such row exists. Returns null when:
 *   - zero non-default sources are registered (fresh install)
 *   - 2+ non-default sources are registered (ambiguous — user must pick)
 *   - the only non-default source has a NULL local_path (no on-disk shape)
 *   - the only registered source IS 'default'
 *   - 'default' holds an established corpus (#3070 — any active page): the
 *     tier's charter is rescuing brains whose 'default' is EMPTY (#1434's
 *     "532 silent edit failures"); when 'default' is actively used,
 *     auto-routing would hijack every bare `put`/`capture`/`sync` into the
 *     sole side-source, so the resolver falls through to seed_default and
 *     the user must pick via --source / sources.default. The flip prints a
 *     one-line stderr warning naming both sides (suppressed by
 *     GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE=1) so the reroute is diagnosable.
 *
 * Excludes archived sources (`archived = false`) so a soft-deleted source
 * doesn't auto-resolve. Shared by `resolveSourceId` and `resolveSourceWithTier`
 * so the heuristic can't drift between the two entry points.
 *
 * NOTE (#2928): this tier deliberately does NOT consult config.federated —
 * `--no-federated` governs READ mixing, not write routing, and unqualified
 * `sync`/`import` on a single-vault brain must keep landing in the vault
 * (#1434, pinned by test/sync-sole-non-default-routing.test.ts). The
 * unfederate read fix lives in `localFederatedSourceIds` below.
 */
/**
 * #3880: list registered local_path sources WITH their archived flag so the
 * tier-4 cwd prefix match can prefer active sources. The archived column is
 * v34+ — fall back to the column-less query on older brains (rows then carry
 * no `archived` key and are treated as active, the pre-v34 behavior).
 */
async function listRegisteredLocalPathSources(
  engine: BrainEngine,
): Promise<Array<{ id: string; local_path: string; archived?: boolean }>> {
  try {
    return await engine.executeRaw<{ id: string; local_path: string; archived?: boolean }>(
      `SELECT id, local_path, archived FROM sources WHERE local_path IS NOT NULL`,
    );
  } catch {
    return engine.executeRaw<{ id: string; local_path: string }>(
      `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL`,
    );
  }
}

async function pickSoleNonDefaultSource(
  engine: BrainEngine,
  opts: { quiet?: boolean } = {},
): Promise<string | null> {
  // archived column was added in v34 (v0.26.5). Older brains may not have
  // it — fall back to the un-archived query in that case via try/catch.
  let rows: Array<{ id: string }>;
  try {
    rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE local_path IS NOT NULL AND id != 'default' AND archived = false`,
    );
  } catch {
    rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE local_path IS NOT NULL AND id != 'default'`,
    );
  }
  if (rows.length !== 1) return null;
  // #3070 emptiness guard: fire only when 'default' holds no active pages.
  try {
    const defaultPages = await engine.executeRaw<{ one: number }>(
      `SELECT 1 AS one FROM pages WHERE source_id = 'default' AND deleted_at IS NULL LIMIT 1`,
    );
    if (defaultPages.length > 0) {
      // The flip must not be silent: one stray page in 'default' reroutes
      // every bare command away from the sole side-source, and the user
      // hunts for "lost" writes. One stderr line names both sides so the
      // misroute is diagnosable; same suppression knob as the routing nudge.
      if (!opts.quiet && process.env.GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE !== '1') {
        console.error(
          `[gbrain] sole non-default source '${rows[0].id}' exists, but 'default' is non-empty — routing to 'default' (#3070 emptiness guard). Pass --source ${rows[0].id} or set sources.default to target it.`,
        );
      }
      return null;
    }
  } catch {
    // pages.deleted_at exists on every supported schema; a failure here means
    // an exotic/legacy brain — keep the pre-guard routing rather than breaking
    // resolution outright.
  }
  return rows[0].id;
}

/**
 * Once-per-process (per stale id) latch for the stale `sources.default`
 * warning below, so bulk callers don't spam stderr. Reset seam exported via
 * `__testing.resetStaleImplicitDefaultWarnings`.
 */
const warnedStaleImplicitDefaults = new Set<string>();

/**
 * Source id that represents the brain's implicit default target for a bare
 * local command (#4700). Unlike resolveSourceWithTier(), this deliberately
 * ignores env, dotfile, cwd, and local_path tiers so callers can distinguish
 * the canonical default-like source from an explicit/path-scoped source cycle.
 *
 * Fail-open on a STALE `sources.default` (the configured source was deleted
 * or archived after the config row was set): tier-5 posture, same as
 * resolveSourceId's brain_default tier being silent-fallback and
 * resolveLinkFallbackDefault never throwing. The stale value is treated as
 * absent — one stderr warning names it — and resolution falls through to the
 * legacy sole-non-default routing. Genuine engine failures still propagate.
 */
export async function resolveImplicitDefaultSourceId(engine: BrainEngine): Promise<string | null> {
  const globalDefault = await engine.getConfig('sources.default');
  if (globalDefault && isValidSourceId(globalDefault)) {
    try {
      await assertSourceExists(engine, globalDefault);
      return globalDefault;
    } catch (e) {
      if (!(e instanceof SourceTargetError)) throw e;
      if (!warnedStaleImplicitDefaults.has(globalDefault)) {
        warnedStaleImplicitDefaults.add(globalDefault);
        console.error(
          `[gbrain] config sources.default points at '${globalDefault}', which is not an active source — ` +
          `ignoring it for this run. Fix with \`gbrain config set sources.default <id>\` ` +
          `(see \`gbrain sources list\`) or restore it: \`gbrain sources restore ${globalDefault}\`.`,
        );
      }
    }
  }
  return pickSoleNonDefaultSource(engine, { quiet: true });
}

/**
 * Format the one-line stderr nudge that fires when source resolution falls
 * through to the `sole_non_default` tier. Returns null when suppressed via
 * `GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE=1` (CI / scripted-pipeline ergonomics).
 *
 * Single source of truth so the wording stays consistent across every CLI
 * dispatch site that fires the nudge (sync, import, extract, etc.). Callers
 * print to stderr; this helper just builds the line.
 */
export function formatSoleNonDefaultNudge(sourceId: string): string | null {
  if (process.env.GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE === '1') return null;
  return `[gbrain] routing to source '${sourceId}' (sole non-default source registered; pass --source to override).`;
}

// ---------------------------------------------------------------------------
// #4583 (fixes #4564's misrouted-write symptom) — write-time guard for the
// seed_default tier.
//
// `sole_non_default` (tier 5.5) only auto-routes when EXACTLY one non-default
// source with a local_path is registered. On a brain with 2+ non-default
// sources (or a sole one whose local_path is NULL), an unscoped mutating op
// still falls through to `seed_default` and silently lands in source_id
// 'default' — re-opening the cross-source duplicate-slug class (#1434 /
// PR #707), which can silently produce thousands of duplicates.
//
// The guard fires only when the brain's real content lives OUTSIDE 'default'
// (non-default sources hold the bulk of pages). A fresh brain, or a legacy
// brain whose content legitimately still sits in 'default', is left untouched.
// This is the ADVISORY sibling of the opt-in fail-closed serve-time guard
// (`sourceGuardBlocksWrite` / WRITE_SAFE_SOURCE_TIERS below).
// ---------------------------------------------------------------------------

/** Env escape hatch: scripted pipelines that intend to write to 'default'. */
export const GBRAIN_ALLOW_DEFAULT_WRITE_ENV = 'GBRAIN_ALLOW_DEFAULT_WRITE';

export interface DefaultWriteAssessment {
  /** True when an unscoped write to 'default' should be guarded (refused/warned). */
  shouldGuard: boolean;
  /** Pages currently held by source_id = 'default'. */
  defaultPages: number;
  /** Pages held across all non-default sources. */
  nonDefaultPages: number;
  /** Count of distinct non-default source_ids with at least one page. */
  nonDefaultSources: number;
  /**
   * True when the page-distribution aggregate FAILED and the verdict above is
   * the fail-open default rather than a measurement. A caller that caches or
   * latches on an assessment must not treat a failed one as settled.
   */
  failed?: true;
}

/**
 * Assess whether an unscoped write that resolved to source 'default' should be
 * guarded. Call ONLY after resolution returned tier `seed_default` (explicit /
 * env / dotfile / local_path / brain_default / sole_non_default writers have
 * stated intent and must never be guarded).
 *
 * Fires when non-default sources hold the bulk of the brain's pages, i.e.
 * `nonDefaultPages > defaultPages` with at least one non-default source.
 *
 * Fail-open: any query error (e.g. a half-migrated brain with no `pages`
 * table) returns `shouldGuard=false`. A guard must never be the reason a
 * legitimate write fails.
 */
export async function assessDefaultWriteGuard(
  engine: BrainEngine,
): Promise<DefaultWriteAssessment> {
  const empty: DefaultWriteAssessment = {
    shouldGuard: false,
    defaultPages: 0,
    nonDefaultPages: 0,
    nonDefaultSources: 0,
  };
  try {
    const rows = await engine.executeRaw<{
      default_pages: number | string | bigint | null;
      non_default_pages: number | string | bigint | null;
      non_default_sources: number | string | bigint | null;
    }>(
      // deleted_at IS NULL (review fix): soft-deleted pages skewed the
      // distribution both directions — a graveyard outside 'default' could
      // fire the guard on a live default-dominant brain, and a graveyard in
      // 'default' could mask a live non-default-dominant one. Every sibling
      // predicate in this module filters live rows; so does this.
      `SELECT
         COALESCE(SUM(CASE WHEN source_id = 'default' THEN 1 ELSE 0 END), 0) AS default_pages,
         COALESCE(SUM(CASE WHEN source_id <> 'default' THEN 1 ELSE 0 END), 0) AS non_default_pages,
         COUNT(DISTINCT source_id) FILTER (WHERE source_id <> 'default') AS non_default_sources
       FROM pages
       WHERE deleted_at IS NULL`,
    );
    const r = rows[0];
    if (!r) return empty;
    const defaultPages = Number(r.default_pages) || 0;
    const nonDefaultPages = Number(r.non_default_pages) || 0;
    const nonDefaultSources = Number(r.non_default_sources) || 0;
    // Strict `>` keeps a default-dominant (fresh / legacy) brain un-guarded:
    // with nonDefaultPages 0, the condition is false and 'default' stays valid.
    const shouldGuard = nonDefaultSources >= 1 && nonDefaultPages > defaultPages;
    return { shouldGuard, defaultPages, nonDefaultPages, nonDefaultSources };
  } catch {
    return { ...empty, failed: true };
  }
}

/**
 * Once-per-process memo of assessDefaultWriteGuard, keyed on the engine.
 * The assessment is an unindexed full-`pages` aggregate whose inputs are
 * process-stable (the brain's page distribution, the env escape hatch), so
 * in-process callers that run many unscoped writes — runImport under the
 * sync_brain MCP op, the autopilot daemon, minion sync — pay for it ONCE per
 * engine rather than on every call. Mirrors the stdio advisory latch
 * (createDefaultWriteAdvisory in mcp/server.ts): the memo arms on the first
 * SUCCESSFUL assessment, whatever its verdict. A FAILED assessment (the
 * fail-open `failed: true` shape) is returned to its caller but forgotten,
 * so one transient query error cannot pin "no guard" for the rest of the
 * process — the next caller retries. Concurrent callers share the in-flight
 * attempt. A WeakMap so a disconnected engine never pins its entry.
 */
let defaultWriteAssessments = new WeakMap<BrainEngine, Promise<DefaultWriteAssessment>>();

export function assessDefaultWriteGuardOnce(engine: BrainEngine): Promise<DefaultWriteAssessment> {
  const memo = defaultWriteAssessments;
  let pending = memo.get(engine);
  if (!pending) {
    const attempt: Promise<DefaultWriteAssessment> = assessDefaultWriteGuard(engine).then(a => {
      if (a.failed && memo.get(engine) === attempt) memo.delete(engine);
      return a;
    });
    pending = attempt;
    memo.set(engine, attempt);
  }
  return pending;
}

/** Test seam: forget every memoized assessment (e.g. after reseeding a shared engine). */
export function __resetDefaultWriteGuardMemo(): void {
  defaultWriteAssessments = new WeakMap();
}

/** True when the operator opted into unscoped 'default' writes for this process. */
export function defaultWriteAllowedByEnv(): boolean {
  return process.env[GBRAIN_ALLOW_DEFAULT_WRITE_ENV] === '1';
}

/**
 * Multi-line refusal shown when a CLI mutating op (sync / import) would write
 * to 'default' on a bulk-non-default brain. `command` is the bare subcommand
 * (e.g. `sync`, `import <dir>`). `sourceFlag` is the flag that scopes THIS
 * command (source for sync, source-id for import). Escape hatches are spelled
 * out inline.
 *
 * NOTE: never spell a NEW CLI flag with its leading double dash anywhere in
 * this file. scripts/generate-flag-registry.ts scans this module one level
 * deep from nearly every command and harvests such literals, which would
 * grant that flag to all ~90 commands in the generated registry — they would
 * then accept and silently ignore it. The `sourceFlag` default below is the
 * UNIVERSAL source flag (already legal everywhere); callers with a different
 * flag pass it in from their own module.
 */
export function formatDefaultWriteRefusal(
  command: string,
  a: DefaultWriteAssessment,
  sourceFlag: string = '--source',
): string {
  return [
    `[gbrain] Refusing unscoped ${command}: it would write to source 'default'.`,
    `  This brain keeps its content in ${a.nonDefaultSources} non-default source(s) ` +
      `(${a.nonDefaultPages} pages); 'default' holds ${a.defaultPages}.`,
    `  An unscoped write to 'default' re-creates cross-source duplicate slugs.`,
    `  Choose a target:`,
    `    gbrain ${command} ${sourceFlag} <id>      route to a real source (see: gbrain sources list)`,
    `    gbrain ${command} ${sourceFlag} default   write to 'default' on purpose (escape hatch)`,
    `    ${GBRAIN_ALLOW_DEFAULT_WRITE_ENV}=1 gbrain ${command}  allow, for scripted pipelines`,
  ].join('\n');
}

/**
 * One-line warning for surfaces where refusing would be worse than writing
 * (the tokenless MCP stdio pipe; in-process import callers). Non-fatal: the
 * write proceeds, but the operator is told how to scope future writes.
 */
export function formatDefaultWriteWarning(a: DefaultWriteAssessment, sourceFlag?: string): string {
  const escape = sourceFlag
    ? `Pass ${sourceFlag} <id>`
    : `Set ${'GBRAIN_SOURCE'}=<id>`;
  return (
    `[gbrain] WARNING: writing to source 'default' on a multi-source brain ` +
    `(${a.nonDefaultSources} non-default source(s), ${a.nonDefaultPages} pages). ` +
    `${escape} to scope writes and avoid cross-source duplicate slugs.`
  );
}

/**
 * #4583 rework for the stdio MCP lane: decide the once-per-process advisory
 * warning from the ALREADY-RESOLVED source tier, not from raw env presence.
 * Master's stdio dispatch runs the full ambient chain
 * (resolveMcpStdioSourceScope), so a dotfile / local_path / brain_default pin
 * resolves a REAL source — warning there would be a false positive. Only the
 * `seed_default` tier actually lands the write in 'default'. Returns the
 * warning line (null when nothing should be printed) plus `assessed`: true
 * when the decision is settled for the process (a successful assessment, a
 * non-writing tier, or the process-stable env escape hatch), false when the
 * aggregate FAILED — the null is fail-open for this write only and the caller
 * must not latch on it. Never throws.
 */
export async function assessUnscopedDefaultWrite(
  engine: BrainEngine,
  tier: SourceTier,
  mutating: boolean,
): Promise<{ warning: string | null; assessed: boolean }> {
  if (!mutating || tier !== 'seed_default') return { warning: null, assessed: true };
  if (defaultWriteAllowedByEnv()) return { warning: null, assessed: true };
  const assessment = await assessDefaultWriteGuard(engine);
  if (assessment.failed) return { warning: null, assessed: false };
  return { warning: assessment.shouldGuard ? formatDefaultWriteWarning(assessment) : null, assessed: true };
}

/** The warning-only projection of assessUnscopedDefaultWrite. */
export async function maybeWarnUnscopedDefaultWrite(
  engine: BrainEngine,
  tier: SourceTier,
  mutating: boolean,
): Promise<string | null> {
  return (await assessUnscopedDefaultWrite(engine, tier, mutating)).warning;
}

async function assertSourceExists(engine: BrainEngine, id: string): Promise<void> {
  const rows = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE id = $1 AND archived = false`,
    [id],
  );
  if (rows.length === 0) {
    throw new SourceTargetError(
      `Source "${id}" not found or is archived. Available active sources: ` +
      `run \`gbrain sources list\` to see registered sources, ` +
      `or create/restore "${id}" before retrying.`,
    );
  }
}

/**
 * Predicate: is this error one of THIS module's user-facing throws (an
 * unknown / archived source from `assertSourceExists`, or an invalid
 * `--source` / `GBRAIN_SOURCE` value from the resolve chain) that a CLI
 * command should surface as a clean stderr line + exit 1?
 *
 * Lives next to the messages it matches so the wordings cannot drift apart
 * again — three commands (dream, agent, the code-* scope resolver) once
 * carried their own copies, and one of them missed the fail-closed
 * ` not found or is archived.` wording, so an archived source escaped as a
 * stack trace. Anything else (TypeError / connection failures / genuine
 * bugs) is deliberately NOT matched and keeps propagating.
 */
export function isResolverUserError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const m = e.message;
  return (m.startsWith('Source "')
      && (m.includes(' not found.') || m.includes(' not found or is archived.')))
    || m.startsWith('Invalid --source value')
    || m.startsWith('Invalid GBRAIN_SOURCE value');
}

/**
 * #3765 — resolve the source id for an EXPLICIT repo path (`sync --repo <dir>`
 * / the sync_brain op's `repo` param), anchored at the REPO DIR instead of
 * process.cwd(). Without this, `gbrain sync --repo ~/other-vault` parsed the
 * path but resolved the SOURCE from the caller's cwd — anchors, page writes,
 * and the per-source sync lock all routed to whatever source the cwd implied.
 *
 * Two tiers, mirroring resolveSourceId's dotfile + local_path tiers but
 * rooted at `dir`:
 *   1. `.gbrain-source` dotfile walk up from the repo dir (same trust rules)
 *   2. registered source whose local_path contains the repo dir
 *      (longest-prefix match; realpath both sides — codex #9 rationale)
 *
 * Returns null when neither tier fires — the caller falls back to its ambient
 * resolution (cwd chain / ctx.sourceId). Never consults env/cwd: an explicit
 * repo path is a statement of intent about THAT tree.
 */
export async function resolveSourceForRepoPath(
  engine: BrainEngine,
  dir: string,
): Promise<{ source_id: string; tier: 'dotfile' | 'local_path'; detail: string } | null> {
  // 1. Dotfile pinned in (or above) the repo tree.
  const dotfile = readDotfileWalk(dir);
  if (dotfile) {
    await assertSourceExists(engine, dotfile);
    return { source_id: dotfile, tier: 'dotfile', detail: `.gbrain-source under ${dir}` };
  }

  // 2. Registered local_path containing the repo dir (longest prefix wins).
  const registered = await engine.executeRaw<{ id: string; local_path: string }>(
    `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL`,
  );
  const dirResolved = realpathOrResolve(dir);
  let best: { id: string; path: string; pathLen: number } | null = null;
  for (const r of registered) {
    const p = realpathOrResolve(r.local_path);
    if (dirResolved === p || dirResolved.startsWith(p + '/')) {
      if (!best || p.length > best.pathLen) {
        best = { id: r.id, path: p, pathLen: p.length };
      }
    }
  }
  if (best) {
    await assertSourceExists(engine, best.id);
    return { source_id: best.id, tier: 'local_path', detail: best.path };
  }
  return null;
}

/**
 * Get the local_path of the resolved source (per the resolveSourceId chain).
 *
 * Returns the on-disk brain repo path for the source the user is currently
 * operating against. Used by `gbrain storage status` and `gbrain export
 * --restore-only` to find the brain repo without raw SQL or bare try/catch.
 *
 * Resolution order:
 *   1. `sources.local_path` for the resolved source id (multi-source v0.18+ path)
 *   2. Legacy global `sync.repo_path` config key (pre-v0.18 default-source brains)
 *   3. null
 *
 * @returns local_path string, or null if no path is configured anywhere.
 * @throws  If DB error occurs (does NOT silently swallow). Callers handle
 *          the null case to provide their own fallback (typically a hard error
 *          telling the user to pass --repo).
 */
export async function getDefaultSourcePath(
  engine: BrainEngine,
  cwd: string = process.cwd(),
): Promise<string | null> {
  const sourceId = await resolveSourceId(engine, null, cwd);
  const rows = await engine.executeRaw<{ local_path: string | null }>(
    `SELECT local_path FROM sources WHERE id = $1`,
    [sourceId],
  );
  if (rows[0]?.local_path) return rows[0].local_path;

  // Legacy fallback: pre-v0.18 brains stored the repo path in the global
  // config table under sync.repo_path. The sources table exists but its
  // local_path is NULL for the seeded 'default' row. Fall back so storage
  // tiering works without forcing a `gbrain sources add . --path .` migration.
  const legacyPath = await engine.getConfig('sync.repo_path');
  return legacyPath ?? null;
}

/**
 * v0.37.7.0 — tier labels for `resolveSourceWithTier()`. Exported so
 * `gbrain sources current --json` and downstream consumers share a
 * canonical vocabulary instead of redefining strings inline.
 *
 * Order matches the 1-6 priority of `resolveSourceId()`.
 */
export const SOURCE_TIER_NAMES = [
  'flag',
  'env',
  'dotfile',
  'local_path',
  'brain_default',
  'sole_non_default',
  'seed_default',
] as const;
export type SourceTier = typeof SOURCE_TIER_NAMES[number];

/**
 * Same resolution chain as `resolveSourceId()`, but also returns
 * WHICH tier won. Additive — does not duplicate the logic; runs the
 * same six steps in the same order. Used by `gbrain sources current`
 * so users can verify the resolved source AND the reason it resolved
 * before destructive ops.
 *
 * @returns `{ source_id, tier, detail? }` where `detail` is an
 *          optional human-readable extra (e.g. the env-var name or
 *          the matched dotfile / local_path).
 */
export async function resolveSourceWithTier(
  engine: BrainEngine,
  explicit: string | null | undefined,
  cwd: string = process.cwd(),
): Promise<{ source_id: string; tier: SourceTier; detail?: string }> {
  // 1. Explicit flag wins. __all__ sentinel passes through verbatim (#1712).
  if (explicit) {
    if (explicit === ALL_SOURCES) {
      return { source_id: ALL_SOURCES, tier: 'flag', detail: `--source ${ALL_SOURCES} (spans all sources)` };
    }
    if (!SOURCE_ID_RE.test(explicit)) {
      throw new SourceTargetError(`Invalid --source value "${explicit}". Must match [a-z0-9-]{1,32}.`);
    }
    await assertSourceExists(engine, explicit);
    return { source_id: explicit, tier: 'flag', detail: `--source ${explicit}` };
  }

  // 2. Env var. Same __all__ pass-through (#2140).
  const env = process.env.GBRAIN_SOURCE;
  if (env && env.length > 0) {
    if (env === ALL_SOURCES) {
      return { source_id: ALL_SOURCES, tier: 'env', detail: `GBRAIN_SOURCE=${ALL_SOURCES} (spans all sources)` };
    }
    if (!SOURCE_ID_RE.test(env)) {
      throw new SourceTargetError(`Invalid GBRAIN_SOURCE value "${env}". Must match [a-z0-9-]{1,32}.`);
    }
    await assertSourceExists(engine, env);
    return { source_id: env, tier: 'env', detail: `GBRAIN_SOURCE=${env}` };
  }

  // 3. .gbrain-source dotfile walk-up.
  const dotfile = readDotfileWalk(cwd);
  if (dotfile) {
    await assertSourceExists(engine, dotfile);
    return { source_id: dotfile, tier: 'dotfile', detail: `.gbrain-source` };
  }

  // 4. Registered source whose local_path contains CWD.
  //    #3880 active-over-archived tiering + parallel realpath both live in
  //    the shared resolveRegisteredPathMatch helper.
  const best = await resolveRegisteredPathMatch(engine, cwd);
  if (best) {
    await assertSourceExists(engine, best.id);
    return { source_id: best.id, tier: 'local_path', detail: best.path };
  }

  // 5. Brain-level default. Silent-fallback (P1-F) like tier 5 in resolveSourceId.
  const globalDefault = await engine.getConfig('sources.default');
  if (globalDefault && isValidSourceId(globalDefault)) {
    await assertSourceExists(engine, globalDefault);
    return { source_id: globalDefault, tier: 'brain_default', detail: 'sources.default config' };
  }

  // 5.5. Single-non-default-source convenience (v0.41.13, #1434).
  //      See resolveSourceId for the design rationale. Same helper, same
  //      precedence (AFTER brain_default).
  const soleNonDefault = await pickSoleNonDefaultSource(engine);
  if (soleNonDefault) {
    return {
      source_id: soleNonDefault,
      tier: 'sole_non_default',
      detail: `only non-default registered source with local_path`,
    };
  }

  // 6. Fallback: seeded 'default' source.
  return { source_id: 'default', tier: 'seed_default' };
}

/**
 * #3242 parity: the widening set a TRANSPORT should attach for a caller that
 * carries no operator source grant, or `undefined` when the caller must keep
 * its scalar scope.
 *
 * The gate is deliberately `hasSourceGrant === false` rather than falsy.
 * `false` is set only for a legacy bearer token whose
 * `access_tokens.permissions.source_id` is absent — the historical no-grant
 * floor. `true` is an operator-set scope and `undefined` is an OAuth client,
 * and neither may widen, so a falsy check would hand OAuth clients the
 * federated set.
 *
 * Resolution is best-effort by design: a source table that cannot be read
 * leaves the scalar scope standing rather than failing the request, matching
 * the surrounding transport behaviour.
 */
export async function noGrantFederatedScope(
  engine: BrainEngine,
  hasSourceGrant: boolean | undefined,
  sourceId: string | undefined,
): Promise<string[] | undefined> {
  if (hasSourceGrant !== false || !sourceId) return undefined;
  try {
    return await localFederatedSourceIds(engine, sourceId, 'seed_default');
  } catch {
    return undefined;
  }
}

/**
 * #2561 — compute the federated read scope for an UNQUALIFIED local CLI call.
 *
 * `sources add --federated` promises that a `config.federated = true` source
 * "participates in unqualified `gbrain search` results"
 * (docs/guides/multi-source-brains.md). This helper turns that promise into a
 * scope: given the resolved source and WHICH tier resolved it, return
 * `[resolvedSource, ...other federated source ids]` — or `undefined` when the
 * expansion must not apply:
 *
 *   - explicit tiers (`flag` / `env` / `dotfile`): the user named a source;
 *     scalar scope stands (that IS the qualified case);
 *   - no other federated source exists: keep the scalar fast path unchanged;
 *   - #2928: the resolved source is explicitly isolated (config.federated =
 *     false): it must not be mixed into a cross-source read in EITHER
 *     direction, so the scalar scope stands.
 *
 * Archived sources are excluded (same rationale as pickSoleNonDefaultSource);
 * the archived column is v34+, so fall back to the un-archived query on older
 * brains. Callers put the result on `OperationContext.localFederatedSourceIds`,
 * consumed by `federatedSearchScope`. Two caller classes exist: local CLI/MCP
 * stdio (`remote === false`, the original #2561 path) and — via
 * `noGrantFederatedScope` below — remote transports for a legacy no-grant
 * bearer token (#3242 parity), where the transport itself decides the caller
 * may see the federated floor.
 */
export async function localFederatedSourceIds(
  engine: BrainEngine,
  sourceId: string,
  tier: SourceTier,
): Promise<string[] | undefined> {
  if (tier === 'flag' || tier === 'env' || tier === 'dotfile') return undefined;
  let rows: Array<{ id: string; config: unknown; archived?: boolean }>;
  try {
    rows = await engine.executeRaw<{ id: string; config: unknown; archived?: boolean }>(
      `SELECT id, config, archived FROM sources WHERE archived = false ORDER BY id`,
    );
  } catch {
    rows = await engine.executeRaw<{ id: string; config: unknown }>(
      `SELECT id, config FROM sources ORDER BY id`,
    );
  }
  // #2928: an EXPLICITLY isolated anchor (`sources unfederate` /
  // `--no-federated` → config.federated = false) opted out of cross-source
  // read mixing — never widen it into the federated set (which would drag
  // other sources' pages into its unqualified reads and vice versa). Scalar
  // scope stands. UNSET federated keeps the pre-#2928 widening behavior;
  // write routing (tier 5.5 above) is deliberately untouched.
  const resolvedRow = rows.find((row) => row.id === sourceId);
  if (resolvedRow && parseSourceConfig(resolvedRow.config).federated === false) {
    return undefined;
  }
  const ids = [
    sourceId,
    ...rows
      .filter((row) => row.archived !== true && isSourceFederated(row.config))
      .map((row) => row.id)
      .filter((id) => id !== sourceId),
  ];
  return ids.length > 1 ? ids : undefined;
}

/**
 * Source-guard write policy (`gbrain serve --source-guard`) — the plugin
 * lanes' fail-closed routing rule.
 *
 * A plugin-managed MCP server is user-global and runs with the plugin
 * snapshot as its cwd, so two ambient resolution tiers lose their meaning:
 * `dotfile` never finds the user's project pin, and `local_path` can match a
 * registered source whose local_path happens to CONTAIN the snapshot dir
 * (e.g. a source registered at $HOME) — the exact silent-wrong-source write
 * the guard exists to prevent. Under the guard, write/admin ops are allowed
 * only when the binding is deliberate or unambiguous:
 *
 *   flag / env / dotfile   deliberate binding (dotfile still counts: if it
 *                          resolved, someone placed a pin on the cwd path —
 *                          a hand-run from a real project, not the snapshot)
 *   brain_default          the operator configured sources.default
 *   sole_non_default       exactly one candidate — unambiguous
 *   seed_default           unambiguous ONLY while 'default' is the sole
 *                          source; ambiguous the moment others exist
 *   local_path             blocked — cwd-derived intent is invalid under a
 *                          plugin-managed serve
 *
 * Reads stay unrestricted on every tier (within-brain, and the federated
 * read scope is transport-computed) — the guard is a WRITE guard.
 */
export const WRITE_SAFE_SOURCE_TIERS: ReadonlySet<SourceTier> = new Set([
  'flag',
  'env',
  'dotfile',
  'brain_default',
  'sole_non_default',
]);

/**
 * Decide whether a write/admin op must be blocked under `--source-guard`
 * for the given resolution tier. Engine is consulted only on the
 * `seed_default` tier (source count decides ambiguity); errors fail CLOSED
 * — if the guard cannot prove the write is unambiguous, it blocks.
 */
/**
 * Which sources-query shape this engine's schema supports. Cached at module
 * level after the first successful probe so a pre-`archived`-column schema
 * pays the fallback exception ONCE, not on every guarded write (the guard
 * runs on the seed_default tier of every write/admin MCP call).
 */
let sourcesQueryShape: 'archived' | 'legacy' | null = null;

/** True iff a source other than the seeded 'default' exists. Bounded single-
 *  row probe (the verdict needs existence, not the list) with the
 *  pre-`archived`-column fallback. The `legacy` shape is memoized ONLY when
 *  the archived query fails with a missing-column error — a transient error
 *  (pool blip, connection reset) must NOT poison the shape for the process
 *  lifetime (which would make archived-capable brains block forever). Errors
 *  propagate to the caller, which decides the fail-closed verdict. */
async function otherSourceExists(engine: BrainEngine): Promise<boolean> {
  if (sourcesQueryShape !== 'legacy') {
    try {
      const rows = await engine.executeRaw<{ id: string }>(
        `SELECT id FROM sources WHERE id <> 'default' AND archived = false LIMIT 1`,
      );
      sourcesQueryShape = 'archived';
      return rows.length > 0;
    } catch (err) {
      // Cache 'legacy' ONLY for a genuine missing-column error; re-throw
      // anything else so a transient failure doesn't permanently degrade.
      const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
      const missingColumn = msg.includes('archived') && (msg.includes('column') || msg.includes('does not exist') || msg.includes('no such column'));
      if (!missingColumn) throw err;
      sourcesQueryShape = 'legacy';
    }
  }
  const rows = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE id <> 'default' LIMIT 1`,
  );
  return rows.length > 0;
}

export async function sourceGuardBlocksWrite(
  engine: BrainEngine,
  tier: SourceTier,
): Promise<boolean> {
  if (WRITE_SAFE_SOURCE_TIERS.has(tier)) return false;
  // local_path AND seed_default are cwd-derived / seed-fallback tiers under a
  // plugin serve — block ONLY when the binding is genuinely ambiguous (some
  // OTHER source exists). A sole-source brain is unambiguous even when its
  // local_path contains the serve cwd, so it must not be blocked. Engine
  // failure fails CLOSED.
  try {
    return await otherSourceExists(engine);
  } catch {
    return true;
  }
}

/** Test seam: reset the cached sources-query shape (module-level memo). */
export function __resetSourceGuardQueryShape(): void {
  sourcesQueryShape = null;
}

/** Exposed for tests. */
export const __testing = {
  readDotfileWalk,
  SOURCE_ID_RE,
  resetStaleImplicitDefaultWarnings(): void {
    warnedStaleImplicitDefaults.clear();
  },
};
