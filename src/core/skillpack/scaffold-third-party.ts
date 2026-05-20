/**
 * skillpack/scaffold-third-party.ts — orchestrator for scaffolding a
 * third-party skillpack into the user's workspace.
 *
 * Composes the foundation pieces:
 *   resolveSource → loadSkillpackManifest → askTrust → enumerateScaffoldEntries
 *   → copyArtifacts → saveState (~/.gbrain/skillpack-state.json) → buildBootstrapDisplay
 *
 * Mirrors the contracts of v0.36's `runScaffold` (no managed-block writes,
 * refuses to overwrite, partial-state policy via enumerateScaffoldEntries +
 * paired sources) — third-party packs land the same way bundled ones do.
 * The only difference is the source manifest format (skillpack.json vs
 * openclaw.plugin.json) and the trust gate that wraps the copy step.
 *
 * Returns a structured result the CLI and the publish-gate both consume.
 */

import { join } from 'path';

import { bundleManifestFromSkillpack, loadSkillpackManifest, type SkillpackManifest } from './manifest-v1.ts';
import { buildBootstrapDisplay, type BootstrapDisplayResult } from './bootstrap-display.ts';
import { copyArtifacts, type CopyItem, type CopyResult } from './copy.ts';
import { enumerateScaffoldEntries, type ScaffoldEntry } from './bundle.ts';
import {
  defaultStatePath,
  loadState,
  saveState,
  upsertEntry,
  type SkillpackState,
  type SkillpackStateEntry,
} from './state.ts';
import { askTrust, type SkillpackTier, type TrustPromptDecision } from './trust-prompt.ts';
import type { ResolvedSource } from './remote-source.ts';

export interface ScaffoldThirdPartyOptions {
  /** Result of resolveSource() (already cached/cloned/extracted). */
  resolved: ResolvedSource;
  /** Absolute path to the target workspace where files should land. */
  targetWorkspace: string;
  /** Tier the registry assigned the pack at scaffold time (informational). */
  tier?: SkillpackTier;
  /** Skip the trust prompt (CI / agent use). */
  trustFlag?: boolean;
  /** Test seam: TTY override. */
  isTTY?: boolean;
  /** Test seam: state-file path override. */
  statePath?: string;
  /** Dry-run: validate + enumerate; no writes. */
  dryRun?: boolean;
  /** Test seam: TTY reader injection (forwarded to askTrust). */
  readLine?: (question: string) => Promise<string>;
}

export type ScaffoldThirdPartyStatus =
  | 'wrote_new'
  | 'all_skipped_existing'
  | 'dry_run'
  | 'aborted_no_trust';

export interface ScaffoldThirdPartyResult {
  status: ScaffoldThirdPartyStatus;
  manifest: SkillpackManifest;
  resolved: ResolvedSource;
  trustDecision: TrustPromptDecision;
  copy: CopyResult | null;
  entries: ScaffoldEntry[];
  bootstrap: BootstrapDisplayResult;
  state: SkillpackState;
}

export class ScaffoldThirdPartyError extends Error {
  constructor(
    message: string,
    public code:
      | 'gbrain_version_too_old'
      | 'manifest_invalid'
      | 'scaffold_failed',
  ) {
    super(message);
    this.name = 'ScaffoldThirdPartyError';
  }
}

/** Semver compare: returns true when actualVer >= requiredVer. */
function semverGte(actual: string, required: string): boolean {
  const parse = (s: string): number[] => s.replace(/^v/, '').split(/[.-]/, 4).map((x) => parseInt(x, 10) || 0);
  const a = parse(actual);
  const r = parse(required);
  for (let i = 0; i < Math.max(a.length, r.length); i++) {
    const ai = a[i] ?? 0;
    const ri = r[i] ?? 0;
    if (ai > ri) return true;
    if (ai < ri) return false;
  }
  return true; // equal
}

export async function runScaffoldThirdParty(
  opts: ScaffoldThirdPartyOptions,
  currentGbrainVersion: string,
): Promise<ScaffoldThirdPartyResult> {
  // 1. Load + validate the manifest from the resolved pack root.
  let manifest: SkillpackManifest;
  try {
    manifest = loadSkillpackManifest(opts.resolved.path);
  } catch (err) {
    throw new ScaffoldThirdPartyError(
      `skillpack manifest invalid: ${(err as Error).message}`,
      'manifest_invalid',
    );
  }

  // 2. gbrain version check.
  if (!semverGte(currentGbrainVersion, manifest.gbrain_min_version)) {
    throw new ScaffoldThirdPartyError(
      `skillpack ${manifest.name} requires gbrain >= ${manifest.gbrain_min_version}; you have ${currentGbrainVersion}. Run \`gbrain upgrade\` first.`,
      'gbrain_version_too_old',
    );
  }

  // 3. Trust prompt (skipped for local sources, already-trusted, or --trust).
  const state = loadState({ statePath: opts.statePath });
  const tier: SkillpackTier = opts.tier ?? (opts.resolved.kind === 'local' ? 'local' : 'community');
  const trustDecision = await askTrust(
    { manifest, resolved: opts.resolved, tier, state },
    {
      trustFlag: opts.trustFlag,
      isTTY: opts.isTTY,
      readLine: opts.readLine,
    },
  );

  if (!trustDecision.trusted) {
    return {
      status: 'aborted_no_trust',
      manifest,
      resolved: opts.resolved,
      trustDecision,
      copy: null,
      entries: [],
      bootstrap: { shown: false, text: '', bootstrapPath: null },
      state,
    };
  }

  // 4. Project manifest to BundleManifest shape so enumerateScaffoldEntries works.
  const bundleManifest = bundleManifestFromSkillpack(manifest);

  // 5. Enumerate scaffold entries (every file under skills/<slug>/ + paired
  //    sources declared in each SKILL.md's frontmatter). Throws BundleError
  //    on missing skill dirs (we already validated that, but defense in depth).
  let entries: ScaffoldEntry[];
  try {
    entries = enumerateScaffoldEntries({
      gbrainRoot: opts.resolved.path,
      skillSlug: undefined, // third-party scaffold lands the whole pack
      manifest: bundleManifest,
    });
  } catch (err) {
    throw new ScaffoldThirdPartyError(
      `enumeration failed: ${(err as Error).message}`,
      'scaffold_failed',
    );
  }

  // 6. Copy.
  const items: CopyItem[] = entries.map((e) => ({
    source: e.source,
    target: join(opts.targetWorkspace, e.relWorkspaceTarget),
  }));
  const copy = copyArtifacts(items, { dryRun: opts.dryRun ?? false });

  // 7. Bootstrap runbook display (no executor — codex T1).
  const bootstrap = buildBootstrapDisplay({
    packRoot: opts.resolved.path,
    manifest,
    workspace: opts.targetWorkspace,
  });

  // 8. Update state.json (skip on dry-run).
  let newState = state;
  if (!opts.dryRun && copy.summary.wroteNew > 0) {
    const skillSlugs = manifest.skills;
    const entry: SkillpackStateEntry = {
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      source: opts.resolved.source,
      source_kind: opts.resolved.kind,
      pinned_commit: opts.resolved.pinned_commit,
      tarball_sha256: opts.resolved.tarball_sha256,
      tier,
      scaffolded_at: new Date().toISOString(),
      workspace: opts.targetWorkspace,
      skill_slugs: skillSlugs,
    };
    newState = upsertEntry(state, entry);
    saveState(newState, { statePath: opts.statePath });
  }

  const status: ScaffoldThirdPartyStatus = opts.dryRun
    ? 'dry_run'
    : copy.summary.wroteNew > 0
      ? 'wrote_new'
      : 'all_skipped_existing';

  return {
    status,
    manifest,
    resolved: opts.resolved,
    trustDecision,
    copy,
    entries,
    bootstrap,
    state: newState,
  };
}

// Re-export the default state path for convenience (so callers can pass it
// through without re-importing).
export { defaultStatePath } from './state.ts';
