/**
 * skillpack/harvest.ts — `gbrain skillpack harvest <slug> --from <host-repo-root>`.
 *
 * Inverse of scaffold: lifts a skill from a host repo (e.g. wintermute)
 * into gbrain's tree so other clients can scaffold it via the normal
 * path.
 *
 * Source contract (D11): `--from` points at the host repo root.
 * `<from>/skills/<slug>/` is the skill dir. Paired source files
 * declared in the host skill's frontmatter `sources:` array land at
 * the mirror path inside gbrain.
 *
 * Security (D13): every harvested file goes through canonical-path
 * validation and symlink rejection. `realpath(file).startsWith
 * (realpath(host-skill-dir))`. Mirrors `validateUploadPath` from
 * `src/core/operations.ts`. Without this gate, a malicious or careless
 * symlink could leak secrets into gbrain's source tree.
 *
 * Privacy (D4, T7): after copying but before declaring success, the
 * harvested files are scanned against a regex allowlist of "private
 * patterns" (defaults + user-maintained `~/.gbrain/harvest-private-patterns.txt`).
 * Any match → rollback (delete harvested files) and exit non-zero.
 * `--no-lint` bypasses the linter (used by the editorial workflow
 * skill after a manual scrub).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join, relative } from 'path';

import { copyArtifacts, walkSourceDir } from './copy.ts';
import { loadSkillSources } from './bundle.ts';
import { runPrivacyLint, PrivacyLintError } from './harvest-lint.ts';

export interface HarvestOptions {
  /** Slug of the skill to harvest (e.g. "my-fork-skill"). */
  slug: string;
  /** Absolute path to the host repo root (e.g. ~/git/wintermute). */
  hostRepoRoot: string;
  /** Absolute path to gbrain repo root (destination). */
  gbrainRoot: string;
  /** Skip the privacy linter. */
  noLint?: boolean;
  /** Dry-run: preview, no writes. */
  dryRun?: boolean;
  /** Custom private-patterns file (defaults to ~/.gbrain/harvest-private-patterns.txt). */
  privatePatternsPath?: string;
  /** Allow overwriting an existing gbrain/skills/<slug>/ tree. */
  overwriteLocal?: boolean;
}

export type HarvestStatus = 'harvested' | 'host_skill_missing' | 'slug_collision' | 'lint_failed';

export interface HarvestResult {
  status: HarvestStatus;
  slug: string;
  hostSkillDir: string;
  /** Files written under gbrain/. */
  filesCopied: string[];
  /** Paired source files (from frontmatter) included. */
  pairedSources: string[];
  /** Privacy-lint hits, when status === 'lint_failed'. */
  lintHits: string[];
  /** True when the manifest was updated (only on success, non-dry-run). */
  manifestUpdated: boolean;
  dryRun: boolean;
}

export class HarvestError extends Error {
  constructor(
    message: string,
    public code:
      | 'host_skill_missing'
      | 'host_skill_malformed'
      | 'slug_collision'
      | 'path_traversal'
      | 'symlink_rejected',
  ) {
    super(message);
    this.name = 'HarvestError';
  }
}

const PLUGIN_JSON = 'openclaw.plugin.json';
const DEFAULT_PRIVATE_PATTERNS_PATH = join(
  homedir(),
  '.gbrain',
  'harvest-private-patterns.txt',
);

export function runHarvest(opts: HarvestOptions): HarvestResult {
  const dryRun = opts.dryRun ?? false;
  const hostSkillDir = join(opts.hostRepoRoot, 'skills', opts.slug);
  const hostSkillMd = join(hostSkillDir, 'SKILL.md');

  if (!existsSync(hostSkillMd)) {
    throw new HarvestError(
      `Host skill not found: ${hostSkillMd}. Pass --from <host-repo-root> pointing at a repo whose skills/<slug>/ exists.`,
      'host_skill_missing',
    );
  }

  const gbrainSkillDir = join(opts.gbrainRoot, 'skills', opts.slug);
  if (existsSync(gbrainSkillDir) && !opts.overwriteLocal) {
    throw new HarvestError(
      `Slug collision: gbrain already has skills/${opts.slug}/. Pass --overwrite-local to replace.`,
      'slug_collision',
    );
  }

  // Read frontmatter sources from the host SKILL.md. Reuse the bundler's
  // validation — but skip its existence check on the destination since
  // we're reading from a different root.
  const pairedSources = readHostSkillSources(opts.hostRepoRoot, opts.slug);

  // Build items list:
  //   - skill dir → gbrain/skills/<slug>/
  //   - paired sources → gbrain/<source-path>
  const items: Array<{ source: string; target: string }> = [];
  for (const item of walkSourceDir(hostSkillDir, gbrainSkillDir)) {
    items.push(item);
  }
  for (const src of pairedSources) {
    items.push({
      source: join(opts.hostRepoRoot, src),
      target: join(opts.gbrainRoot, src),
    });
  }

  // Copy with D13 confinement + symlink reject. The confinement root is
  // the HOST skill dir (every source must canonicalize inside it). For
  // paired sources outside the skill dir, fall through to symlink-only
  // protection (the host repo is user-trusted at this granularity).
  const skillItems = items.filter(i => i.source.startsWith(hostSkillDir));
  const pairedItems = items.filter(i => !i.source.startsWith(hostSkillDir));

  let filesCopied: string[] = [];
  try {
    if (!dryRun) {
      copyArtifacts(skillItems, {
        rejectSymlinks: true,
        confineRealpath: hostSkillDir,
      });
      copyArtifacts(pairedItems, { rejectSymlinks: true });
    } else {
      // Dry-run still validates safety gates but doesn't copy.
      copyArtifacts(skillItems, {
        rejectSymlinks: true,
        confineRealpath: hostSkillDir,
        dryRun: true,
      });
      copyArtifacts(pairedItems, { rejectSymlinks: true, dryRun: true });
    }
    filesCopied = items.map(i => i.target);
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === 'symlink_rejected') {
      throw new HarvestError(e.message, 'symlink_rejected');
    }
    if (e.code === 'path_traversal') {
      throw new HarvestError(e.message, 'path_traversal');
    }
    throw err;
  }

  // Privacy lint AFTER copy (lint scans the harvested files). On match,
  // rollback (delete) and report.
  const lintHits: string[] = [];
  if (!opts.noLint && !dryRun) {
    try {
      runPrivacyLint(
        filesCopied,
        opts.privatePatternsPath ?? DEFAULT_PRIVATE_PATTERNS_PATH,
      );
    } catch (err) {
      if (err instanceof PrivacyLintError) {
        // Rollback: remove every file we just wrote.
        rollbackHarvest(gbrainSkillDir, pairedItems.map(i => i.target));
        return {
          status: 'lint_failed',
          slug: opts.slug,
          hostSkillDir,
          filesCopied: [],
          pairedSources,
          lintHits: err.hits,
          manifestUpdated: false,
          dryRun: false,
        };
      }
      throw err;
    }
  }

  // Update openclaw.plugin.json — add slug to "skills" array if missing.
  let manifestUpdated = false;
  if (!dryRun) {
    manifestUpdated = addToBundleManifest(opts.gbrainRoot, opts.slug);
  }

  return {
    status: 'harvested',
    slug: opts.slug,
    hostSkillDir,
    filesCopied,
    pairedSources,
    lintHits,
    manifestUpdated,
    dryRun,
  };
}

/**
 * Read a host skill's frontmatter `sources:` without using the bundler
 * (the bundler resolves paths against gbrainRoot, not the host). Mirrors
 * `loadSkillSources`'s validation but resolves against the host root.
 */
function readHostSkillSources(hostRoot: string, slug: string): string[] {
  // Lean on bundle.ts's loadSkillSources but pass the host as the root.
  // Its validation (no abs paths, no `..`, must exist) applies to the
  // host's tree, which is what we want.
  const result = loadSkillSources(hostRoot, `skills/${slug}`);
  return result.sources;
}

/** Delete everything we just wrote. */
function rollbackHarvest(gbrainSkillDir: string, pairedTargets: string[]): void {
  try {
    if (existsSync(gbrainSkillDir)) {
      rmSync(gbrainSkillDir, { recursive: true, force: true });
    }
  } catch {}
  for (const p of pairedTargets) {
    try {
      if (existsSync(p)) rmSync(p, { force: true });
    } catch {}
  }
}

/**
 * Add `slugs/<slug>` to `openclaw.plugin.json#skills` if missing.
 * Preserves JSON formatting via 2-space indent. Idempotent.
 *
 * Returns true if the manifest was modified.
 */
export function addToBundleManifest(gbrainRoot: string, slug: string): boolean {
  const manifestPath = join(gbrainRoot, PLUGIN_JSON);
  if (!existsSync(manifestPath)) return false;
  const raw = readFileSync(manifestPath, 'utf-8');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(manifest.skills)) return false;
  const skillRel = `skills/${slug}`;
  if (manifest.skills.includes(skillRel)) return false;
  manifest.skills.push(skillRel);
  manifest.skills.sort();
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return true;
}
