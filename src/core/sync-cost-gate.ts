/**
 * Inline-embed cost gate + token estimation for `gbrain sync` (#2139).
 * Peeled out of src/commands/sync.ts (containment sprint C13-C14) as a pure
 * move — see that file for the command surface that drives this gate.
 */
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import type { BrainEngine } from './engine.ts';
import { collectSyncableFiles } from '../commands/import.ts';
import { isSyncable } from './sync.ts';
// v0.42.42.0 (#2139): `buildDetachedWorkingTreeManifest` relocated to
// `src/core/sync-delta.ts` (re-imported below) so the inline cost estimator
// prices detached sources through the same code the executor imports them with.
import {
  computeSyncDelta,
  buildDetachedWorkingTreeManifest,
} from './sync-delta.ts';
import { fetchRemote } from './git-remote.ts';
import {
  parseUsdLimit,
  formatUsdLimit,
  resolveSpendPosture,
} from './spend-posture.ts';
import { estimateTokens, CHUNKER_VERSION } from './chunkers/code.ts';
import {
  estimateEmbeddingCostUsd,
  getEmbeddingModelName,
  currentEmbeddingPricePerMTok,
  currentEmbeddingSignature,
  shouldBlockSync,
  type SyncEmbedMode,
} from './embedding.ts';
import { estimateCostFromChars } from './embedding-pricing.ts';
import { SPEND_CAP_CONFIG_KEY } from './embed-backfill-submit.ts';
import { git, hasOriginRemote, isDetachedHead, unique } from './sync-git.ts';

/**
 * Walk ONE source's working tree and sum tokens for every syncable file.
 * Conservative full-tree CEILING (full file content, not the incremental
 * diff) — over-counts, never under-counts. Used only on the ceiling rungs of
 * `estimateInlineNewTokens` (first sync, chunker drift, git-unavailable),
 * where the delta is genuinely the whole tree or can't be computed.
 *
 * v0.31.2: routed through collectSyncableFiles (lstat + inode-cycle +
 * max-depth) so the preview walks exactly what the real sync walks.
 *
 * Exported (v0.42.42.0, #2139) for direct unit testing.
 */
export function estimateSourceTreeTokens(
  localPath: string,
  strategy: 'markdown' | 'code' | 'auto',
  opts: { includeGitignored?: boolean } = {},
): { tokens: number; files: number } {
  let tokens = 0;
  let files = 0;
  try {
    const fileList = collectSyncableFiles(localPath, { strategy, includeGitignored: opts.includeGitignored });
    for (const fullPath of fileList) {
      try {
        const stat = statSync(fullPath);
        if (stat.size > 5_000_000) continue; // skip large binaries
        const content = readFileSync(fullPath, 'utf-8');
        tokens += estimateTokens(content);
        files++;
      } catch {
        // Best-effort per file; sync itself tolerates the same.
      }
    }
  } catch {
    // Best-effort: a source whose local_path is gone/unreadable contributes 0.
  }
  return { tokens, files };
}

/** Sum tokens for an explicit set of repo-relative paths read at live working-tree content. */
function estimateDeltaTokens(localPath: string, relPaths: string[]): number {
  let tokens = 0;
  for (const rel of relPaths) {
    try {
      const full = join(localPath, rel);
      const stat = statSync(full);
      if (stat.size > 5_000_000) continue; // skip large binaries (matches tree walk)
      tokens += estimateTokens(readFileSync(full, 'utf-8'));
    } catch {
      // Listed in the diff but unreadable (e.g. since deleted) → 0, like the tree walk.
    }
  }
  return tokens;
}

/**
 * v0.42.42.0 (#2139): resolve the commit the estimate should diff AGAINST.
 *
 * The cost gate runs BEFORE sync's own `git pull`, so a stale local HEAD would
 * make the estimate blind to commits the run is about to pull (codex #1). So
 * we FETCH first (fail-open) and target `origin/<branch>` — the estimate then
 * prices exactly what this run will sync. The subsequent pull fast-forwards
 * the already-fetched objects, so net new network cost ≈ 0.
 *
 *   - detached HEAD → no upstream; target = local HEAD (+ caller merges the
 *     detached working-tree manifest, which sync imports on a detached repo).
 *   - attached + origin remote → fetch origin/<branch> (best-effort), target =
 *     origin/<branch> if resolvable, else local HEAD (offline / no upstream).
 *   - HEAD unresolvable (not a git repo) → null (caller treats as unavailable).
 *
 * NOTE: this makes `--dry-run` perform a network fetch so the preview reflects
 * what a real run would pull. Fail-open: offline dry-run still previews against
 * local HEAD. Uses the shared `git()` 30s budget (the fetch cost is the pull
 * cost paid a few seconds early — a tighter cap would frequently fall back to
 * local HEAD and underestimate the remote delta).
 */
function resolveEstimateTarget(localPath: string): { target: string; detached: boolean } | null {
  let head: string;
  try {
    head = git(localPath, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
  const detached = isDetachedHead(localPath);
  if (detached) return { target: head, detached: true };

  let branch: string | null = null;
  try {
    branch = git(localPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || null;
  } catch {
    branch = null;
  }
  if (branch && branch !== 'HEAD' && hasOriginRemote(localPath)) {
    try {
      // v0.42.42.0 (#2139): route through the SSRF-hardened fetch (same flags +
      // no-prompt env as pullRepo) — a cost preview / dry-run must NOT hit a
      // remote through a less-protected path than real sync.
      fetchRemote(localPath, branch, { timeoutMs: 30_000 });
    } catch {
      // fail-open: offline, auth failure, no upstream — fall through to local HEAD.
    }
    try {
      const remoteSha = git(localPath, ['rev-parse', `origin/${branch}`]);
      if (remoteSha) return { target: remoteSha, detached: false };
    } catch {
      // no remote-tracking ref for this branch — use local HEAD.
    }
  }
  return { target: head, detached: false };
}

export type EstimateKind = 'delta' | 'ceiling' | 'mixed' | 'unchanged';

export interface InlineEstimate {
  tokens: number;
  changedSources: number;
  unchangedSources: number;
  estimateKind: EstimateKind;
  /** Per-source ceiling reasons (chunker_drift / first_sync / git_unavailable) for honest labeling. */
  ceilingReasons: string[];
}

/**
 * v0.42.42.0 (#2139) — INLINE-path new-content estimate. The estimate now
 * MIRRORS EXECUTION instead of pricing the whole tree on every dirty sync (the
 * 400x overestimate that wedged the daily cron). Per-source fail-open ladder:
 *
 *   1. syncEnabled === false                  → skip (unchanged)
 *   2. chunker drift (stored !== current)     → full-tree CEILING (a drift forces
 *        performFullSync → full re-chunk → full re-embed; a delta would
 *        underestimate by the whole corpus). kind: ceiling_chunker_drift
 *   3. last_commit === fetch target           → 0 (mirrors `up_to_date` at
 *        sync.ts:1402 — NO clean-working-tree requirement; a dirty tree whose
 *        commits are caught up imports nothing). kind: unchanged
 *   4. last_commit === null (first sync)      → full-tree CEILING. kind: ceiling_first_sync
 *   5. computeSyncDelta ok                    → price added∪modified∪renamed.to
 *        (syncable, live working-tree content); deletes cost 0. kind: delta
 *   6. computeSyncDelta unavailable           → full-tree CEILING. kind: ceiling_git_unavailable
 *
 * The delta rung routes through the SAME `computeSyncDelta` the executor uses
 * (src/core/sync-delta.ts), so the gate's dollar figure can't drift from what
 * the sync imports. `--full`'s extra stale-backlog sweep is added by the gate
 * (it already has `staleCostUsd`), not here — see the call site.
 *
 * Exported for direct unit testing.
 */
export function estimateInlineNewTokens(
  sources: Array<{
    local_path: string | null;
    config: Record<string, unknown>;
    last_commit: string | null;
    chunker_version: string | null;
  }>,
  currentChunkerVersion: string,
  opts: { forceFullTree?: boolean } = {},
): InlineEstimate {
  let tokens = 0;
  let changedSources = 0;
  let unchangedSources = 0;
  let hadDelta = false;
  let hadCeiling = false;
  const ceilingReasons: string[] = [];

  const ceiling = (localPath: string, strategy: 'markdown' | 'code' | 'auto', reason: string) => {
    tokens += estimateSourceTreeTokens(localPath, strategy).tokens;
    changedSources++;
    hadCeiling = true;
    ceilingReasons.push(reason);
  };

  for (const src of sources) {
    if (!src.local_path) continue;
    const cfg = (src.config || {}) as { syncEnabled?: boolean; strategy?: 'markdown' | 'code' | 'auto' };
    if (cfg.syncEnabled === false) continue;
    const strategy = cfg.strategy ?? 'markdown';
    const localPath = src.local_path;

    if (opts.forceFullTree) {
      tokens += estimateSourceTreeTokens(localPath, strategy, { includeGitignored: true }).tokens;
      changedSources++;
      hadCeiling = true;
      ceilingReasons.push('include_gitignored');
      continue;
    }

    // Rung 2: chunker drift forces a full re-chunk → full re-embed. CEILING.
    if (src.chunker_version !== currentChunkerVersion) {
      ceiling(localPath, strategy, 'chunker_drift');
      continue;
    }

    // Rung 4 (early): no bookmark → first sync imports everything. CEILING.
    if (!src.last_commit) {
      ceiling(localPath, strategy, 'first_sync');
      continue;
    }

    const resolved = resolveEstimateTarget(localPath);
    if (!resolved) {
      // HEAD unresolvable (not a git repo / gone) — can't compute a delta. CEILING.
      ceiling(localPath, strategy, 'git_unavailable');
      continue;
    }

    // Rung 3: caught up to the fetch target AND no detached working-tree changes.
    // Mirrors the executor's `up_to_date` predicate — a dirty-but-committed-current
    // tree imports nothing, so it must price $0 (the heart of the false-fire fix).
    const detachedManifest = resolved.detached
      ? buildDetachedWorkingTreeManifest(localPath)
      : null;
    const detachedHasChanges = detachedManifest !== null &&
      (detachedManifest.added.length > 0 ||
        detachedManifest.modified.length > 0 ||
        detachedManifest.deleted.length > 0 ||
        detachedManifest.renamed.length > 0);
    if (src.last_commit === resolved.target && !detachedHasChanges) {
      unchangedSources++;
      continue;
    }

    // Rung 5/6: the delta itself — SAME helper the executor diffs with.
    const delta = computeSyncDelta(localPath, src.last_commit, resolved.target, {
      detachedManifest,
    });
    if (delta.status === 'unavailable') {
      ceiling(localPath, strategy, 'git_unavailable');
      continue;
    }
    const syncOpts = { strategy };
    const changedPaths = unique([
      ...delta.manifest.added.filter(p => isSyncable(p, syncOpts)),
      ...delta.manifest.modified.filter(p => isSyncable(p, syncOpts)),
      ...delta.manifest.renamed.filter(r => isSyncable(r.to, syncOpts)).map(r => r.to),
    ]);
    tokens += estimateDeltaTokens(localPath, changedPaths);
    changedSources++;
    hadDelta = true;
  }

  const estimateKind: EstimateKind =
    hadCeiling && hadDelta ? 'mixed' : hadCeiling ? 'ceiling' : hadDelta ? 'delta' : 'unchanged';
  return { tokens, changedSources, unchangedSources, estimateKind, ceilingReasons };
}

/**
 * Resolve the inline-path cost-gate floor in USD. Config key
 * `sync.cost_gate_min_usd` (DB plane), default $0.50. Below this estimate
 * the inline gate proceeds without blocking. Fail-open to the default on a
 * missing/invalid value or a config-read error (the gate must never crash
 * the sync). Accepts 0 (an operator can set the floor to $0 to make the
 * gate block on any nonzero inline cost).
 */
async function resolveCostGateFloorUsd(engine: BrainEngine): Promise<number> {
  try {
    const raw = await engine.getConfig('sync.cost_gate_min_usd');
    // v0.42.42.0 (#2139): `0` keeps meaning "block on any nonzero spend"
    // (allowZero); `off`/`unlimited`/`none` → Infinity so the gate never
    // blocks (`costUsd > Infinity` is always false).
    return parseUsdLimit(raw, 0.5, { allowZero: true });
  } catch {
    return 0.5;
  }
}

/**
 * Resolve the per-source embed-backfill 24h spend cap (USD) for the deferred
 * notice. Mirrors embed-backfill-submit.ts's own resolution of
 * SPEND_CAP_CONFIG_KEY (default 25). Fail-open to the default.
 */
async function resolveBackfillCapUsd(engine: BrainEngine): Promise<number> {
  try {
    const raw = await engine.getConfig(SPEND_CAP_CONFIG_KEY);
    // v0.42.42.0 (#2139): no allowZero — `0` falls back to the default
    // (off semantics ≠ 0); `off`/`unlimited`/`none` → Infinity (cap disabled).
    return parseUsdLimit(raw, 25);
  } catch {
    return 25;
  }
}

/** Interactive [y/N] prompt. Resolves false on non-y answers or EOF. */
async function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
    rl.on('close', () => resolve(false));
  });
}

// v0.42.42.0 (#2139): paste-ready knobs appended to every gate message so the
// spend-control surface is discoverable at the moment of need (humans + agents),
// not only after reading source. Closes the issue's "takes archaeology" complaint.
const SPEND_HINT =
  'widen: gbrain config set sync.cost_gate_min_usd 5 | ' +
  'never gate: gbrain config set spend.posture tokenmax | ' +
  'docs: docs/operations/spend-controls.md';

/** Honest token label — delta vs full-tree ceiling, with the ceiling reasons. */
function labelEstimate(inline: InlineEstimate): string {
  if (inline.estimateKind === 'unchanged') return '0 new tokens (sources caught up)';
  if (inline.estimateKind === 'delta') {
    return `~${inline.tokens.toLocaleString()} new tokens (delta: changed files since last sync)`;
  }
  // ceiling | mixed — be explicit that this is an over-count, not the real spend.
  const reasons = unique(inline.ceilingReasons).join(', ') || 'unknown';
  return (
    `<=${inline.tokens.toLocaleString()} tokens (full-tree ceiling for ${inline.changedSources} ` +
    `source(s): ${reasons} — unchanged files skip via content_hash at execution)`
  );
}

type CostGateSource = {
  local_path: string | null;
  config: Record<string, unknown>;
  last_commit: string | null;
  chunker_version: string | null;
};

interface CostGateContext {
  sources: CostGateSource[];
  /** Resolved embed mode. Single-source is always 'inline' (not the parallel-deferred fan-out). */
  mode: SyncEmbedMode;
  dryRun: boolean;
  jsonOut: boolean;
  yesFlag: boolean;
  full: boolean;
  includeGitignored?: boolean;
  /** Message prefix ('sync --all' | 'sync'). */
  label: string;
}

type CostGateOutcome =
  | { action: 'proceed'; autoDeferEmbeds: boolean }
  | { action: 'stop' };

/**
 * v0.42.42.0 (#2139): the inline-embed cost gate, shared by BOTH `sync --all`
 * and single-source `sync` so the spend surface is consistent. Runs at the
 * COMMAND layer (never inside performSync, which `runOne` also calls — that
 * would double-gate `--all`).
 *
 * Behavior:
 *   - deferred mode → FYI only, never blocks (backfill cap is the money gate).
 *   - inline + below floor → proceed quietly.
 *   - inline + spend.posture=tokenmax → informational, proceed inline.
 *   - inline + above floor + TTY → [y/N] prompt.
 *   - inline + above floor + non-TTY/--json → AUTO-DEFER embeds to capped
 *     backfill jobs, exit 0 (NEVER exit 2 — the wedged-cron fix). Caller sets
 *     effectiveNoEmbed and enqueues the backfill.
 *
 * Output format splits on the EXPLICIT `--json` flag only (absorbs the
 * TODOS.md:340 #1784 conflation): JSON envelope iff `--json`, else human text.
 */
export async function runInlineCostGate(
  engine: BrainEngine,
  ctx: CostGateContext,
): Promise<CostGateOutcome> {
  const { sources, mode, dryRun, jsonOut, yesFlag, full, label } = ctx;

  // Stale backlog: cheap single SQL; fail-open to 0 so a transient DB hiccup
  // never blocks the sync. Signature-aware (model/dims swap surfaces here).
  let staleChars = 0;
  try {
    // D9: signature is null when the gateway is unconfigured — fall back to
    // NULL-embedding-only staleness rather than filtering on a bogus stamp.
    const staleSig = currentEmbeddingSignature();
    staleChars = await engine.sumStaleChunkChars(staleSig ? { signature: staleSig } : {});
  } catch {
    staleChars = 0;
  }
  const staleCostUsd = estimateCostFromChars(staleChars, currentEmbeddingPricePerMTok());
  const embeddingModelName = getEmbeddingModelName();
  const floorUsd = await resolveCostGateFloorUsd(engine);
  const posture = await resolveSpendPosture(engine);

  if (mode === 'deferred') {
    // Deferred path: print an FYI, NEVER block. The backfill cap is the real
    // money gate.
    const capUsd = await resolveBackfillCapUsd(engine);
    let queuedBackfills = 0;
    try {
      const r = await engine.executeRaw<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM minion_jobs
          WHERE name = 'embed-backfill'
            AND status IN ('waiting','active','delayed','waiting-children')`,
      );
      queuedBackfills = Number(r[0]?.n) || 0;
    } catch {
      queuedBackfills = 0;
    }
    const deferredMsg =
      `${label}: embedding deferred to backfill jobs ` +
      `(capped $${formatUsdLimit(capUsd)}/source/24h, not charged by this sync). ` +
      `Current backlog ~${staleChars.toLocaleString()} chars (~$${staleCostUsd.toFixed(2)} on ` +
      `${embeddingModelName}) across ${sources.length} source(s); ` +
      `${queuedBackfills} backfill job(s) queued.`;
    if (dryRun) {
      if (jsonOut) {
        console.log(JSON.stringify({ status: 'dry_run', mode, gate: 'dry_run', staleChars, staleCostUsd, capUsd: formatUsdLimit(capUsd), floorUsd: formatUsdLimit(floorUsd), queuedBackfills, model: embeddingModelName }));
      } else {
        console.log(deferredMsg);
        console.log('--dry-run: exit without syncing.');
      }
      return { action: 'stop' };
    }
    if (jsonOut) {
      console.log(JSON.stringify({ status: 'deferred', mode, gate: 'deferred_notice', staleChars, staleCostUsd, capUsd: formatUsdLimit(capUsd), floorUsd: formatUsdLimit(floorUsd), queuedBackfills, model: embeddingModelName }));
    } else {
      console.log(deferredMsg);
    }
    return { action: 'proceed', autoDeferEmbeds: false };
  }

  // ── Inline path ───────────────────────────────────────────────
  const inline = estimateInlineNewTokens(sources, String(CHUNKER_VERSION), {
    forceFullTree: ctx.includeGitignored === true,
  });
  // D7A: `--full` runs `performFullSync` → `runEmbedCore({stale:true})`, which
  // sweeps the pre-existing stale backlog INLINE on top of the delta. Price it.
  const costUsd = estimateEmbeddingCostUsd(inline.tokens) + (full ? staleCostUsd : 0);
  const fullNote = full && staleChars > 0
    ? ` (includes ~${staleChars.toLocaleString()} stale-backlog chars swept by --full)`
    : '';
  const staleNote = !full && staleChars > 0
    ? ` (plus ~${staleChars.toLocaleString()} stale-backlog chars pending \`gbrain embed --stale\`)`
    : '';
  const previewMsg =
    `${label} preview (inline embed): ${inline.changedSources} changed source(s), ` +
    `${inline.unchangedSources} unchanged; ${labelEstimate(inline)}, ` +
    `est. $${costUsd.toFixed(2)} on ${embeddingModelName}${fullNote}${staleNote}.`;

  if (dryRun) {
    if (jsonOut) {
      console.log(JSON.stringify({ status: 'dry_run', mode, gate: 'dry_run', newTokens: inline.tokens, estimateKind: inline.estimateKind, staleChars, costUsd, floorUsd: formatUsdLimit(floorUsd), model: embeddingModelName }));
    } else {
      console.log(previewMsg);
      console.log('--dry-run: exit without syncing.');
    }
    return { action: 'stop' };
  }

  // --yes bypasses the gate entirely (embed inline, no preview).
  if (yesFlag) return { action: 'proceed', autoDeferEmbeds: false };

  // spend.posture=tokenmax → informational, proceed INLINE (operator declared
  // cost isn't the constraint; don't defer).
  if (posture === 'tokenmax') {
    if (jsonOut) {
      console.log(JSON.stringify({ status: 'proceeding', mode, gate: 'posture_tokenmax', newTokens: inline.tokens, estimateKind: inline.estimateKind, costUsd, floorUsd: formatUsdLimit(floorUsd), model: embeddingModelName, hint: SPEND_HINT }));
    } else {
      console.log(`${previewMsg} spend.posture=tokenmax: proceeding (informational). ${SPEND_HINT}`);
    }
    return { action: 'proceed', autoDeferEmbeds: false };
  }

  // Link intent: search.mode=tokenmax but spend posture unset → nudge once.
  let searchModeHint = '';
  try {
    const sm = await engine.getConfig('search.mode');
    if (typeof sm === 'string' && sm.trim().toLowerCase() === 'tokenmax') {
      searchModeHint =
        ` (search.mode=tokenmax detected — \`gbrain config set spend.posture tokenmax\` ` +
        `makes cost gates informational)`;
    }
  } catch {
    /* best-effort */
  }

  if (shouldBlockSync(costUsd, floorUsd, mode, posture)) {
    const isTTY = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
    if (isTTY && !jsonOut) {
      // Interactive TTY: prompt [y/N].
      console.log(previewMsg + searchModeHint);
      const answer = await promptYesNo('Proceed? [y/N] ');
      if (!answer) {
        console.log('Cancelled.');
        return { action: 'stop' };
      }
      return { action: 'proceed', autoDeferEmbeds: false };
    }
    // Non-TTY or --json: AUTO-DEFER embeds to capped backfill jobs. NEVER exit 2
    // (the wedged-cron fix). Format splits on the explicit --json flag only.
    if (jsonOut) {
      console.log(JSON.stringify({ status: 'auto_deferred', mode, gate: 'auto_deferred_embeds', newTokens: inline.tokens, estimateKind: inline.estimateKind, costUsd, floorUsd: formatUsdLimit(floorUsd), model: embeddingModelName, hint: SPEND_HINT }));
    } else {
      console.log(
        `${previewMsg} Exceeds floor $${formatUsdLimit(floorUsd)} in a non-interactive ` +
        `session — importing now, deferring embeds to capped backfill jobs. ` +
        `Drain: run the jobs worker or \`gbrain embed --stale\`. Pass --yes to embed inline.\n${SPEND_HINT}`,
      );
    }
    return { action: 'proceed', autoDeferEmbeds: true };
  }

  // Below floor → proceed without blocking (kills inline-cron noise).
  if (jsonOut) {
    console.log(JSON.stringify({ status: 'below_floor', mode, gate: 'below_floor', newTokens: inline.tokens, estimateKind: inline.estimateKind, staleChars, costUsd, floorUsd: formatUsdLimit(floorUsd), model: embeddingModelName }));
  } else {
    console.log(`${previewMsg} Below cost gate floor ($${formatUsdLimit(floorUsd)}), proceeding.`);
  }
  return { action: 'proceed', autoDeferEmbeds: false };
}
