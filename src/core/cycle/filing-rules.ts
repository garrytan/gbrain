/**
 * #2397 — dream allow-list loader (`skills/_brain-filing-rules.json` →
 * `dream_synthesize_paths.globs`), peeled from synthesize.ts.
 *
 * The legacy loader probed exactly two filesystem candidates: the process
 * cwd and `__dirname/../../../skills`. Both can miss on a production
 * install — `bun build --compile` bakes the BUILD machine's `__dirname`
 * into the binary (the path doesn't exist at runtime), and the dream
 * worker's cwd is rarely the brain repo — so the synthesize + patterns
 * phases hard-failed every cycle with NO_ALLOWLIST.
 *
 * Resolution ladder (first EXISTING file wins and is authoritative — an
 * absent file falls open to the next rung, but a present-yet-invalid file
 * keeps the legacy NO_ALLOWLIST hard failure instead of being shadowed):
 *   1. `<cwd>/skills/_brain-filing-rules.json` — dev runs from the repo.
 *   2. Engine-resolved brain repo — `sync.repo_path` config, else the
 *      default source's `local_path` (compiled worker with a foreign cwd).
 *   3. `__dirname` source tree — bun-test / non-compiled runs.
 *   4. Statically-bundled JSON — ships inside the compiled binary, so the
 *      ladder never resolves to `[]` for a stock filing-rules file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
// Bundled last-rung copy: a static import so `bun build --compile` embeds
// it in the binary (mirrors brain-repo-durability.ts's import of the same
// file). NOT a runtime dynamic import — nothing to resolve on disk.
import bundledFilingRules from '../../../skills/_brain-filing-rules.json';

type FilingRulesDoc = { dream_synthesize_paths?: { globs?: unknown } };

function globsFromDoc(doc: FilingRulesDoc): string[] | null {
  const globs = doc?.dream_synthesize_paths?.globs;
  if (Array.isArray(globs) && globs.every(g => typeof g === 'string')) {
    return globs as string[];
  }
  return null;
}

/**
 * #2415: `outputRoot` remaps the canonical `wiki/`-rooted globs to the
 * configured namespace (e.g. `notes/personal/reflections/*`). Default
 * 'wiki' returns the globs verbatim. #4387: the legacy unrooted
 * `dream-cycle-summaries/*` glob is nested UNDER the custom root (not left
 * verbatim) so a non-default root authorizes nothing outside its namespace.
 */
function remapGlobs(globs: string[], outputRoot: string): string[] {
  if (outputRoot === 'wiki') return globs;
  return globs.map(g => {
    if (g.startsWith('wiki/')) return `${outputRoot}/${g.slice('wiki/'.length)}`;
    if (g.startsWith('dream-cycle-summaries/')) return `${outputRoot}/${g}`;
    return g;
  });
}

/**
 * Bundled-JSON rung of the ladder, exported for tests. Non-empty as long
 * as the repo's own `skills/_brain-filing-rules.json` carries
 * `dream_synthesize_paths.globs` (pinned by cycle-dream-output-root tests).
 */
export function bundledDreamGlobs(outputRoot = 'wiki'): string[] {
  return remapGlobs(globsFromDoc(bundledFilingRules as FilingRulesDoc) ?? [], outputRoot);
}

/**
 * Engine-resolved brain repo path: `sync.repo_path` config first (matches
 * the legacy global key every synced brain carries), else the seeded
 * default source's `local_path`. Best-effort — any engine error returns
 * null so the ladder falls through to the next rung instead of failing
 * the phase.
 */
async function resolveBrainRepoPath(engine: BrainEngine): Promise<string | null> {
  try {
    const cfg = await engine.getConfig('sync.repo_path');
    if (cfg) return cfg;
    const rows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = 'default'`,
    );
    return rows[0]?.local_path ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve globs from an ordered candidate list. The FIRST existing file is
 * authoritative: unreadable/invalid JSON or a missing/malformed
 * `dream_synthesize_paths.globs` returns [] — the legacy NO_ALLOWLIST hard
 * failure the phases turn into a loud error — rather than silently
 * shadowing a present operator file with a later rung or the bundled
 * defaults. Fail-open to the bundled JSON happens ONLY when no candidate
 * file exists at all (compiled binary, foreign cwd).
 */
function loadFromCandidates(candidates: string[], outputRoot: string): string[] {
  for (const path of candidates) {
    if (!existsSync(path)) continue; // absent → next rung
    try {
      const globs = globsFromDoc(JSON.parse(readFileSync(path, 'utf8')) as FilingRulesDoc);
      return globs ? remapGlobs(globs, outputRoot) : [];
    } catch {
      return []; // present but unreadable/unparseable → hard failure
    }
  }
  return bundledDreamGlobs(outputRoot);
}

/**
 * Load the dream trusted-workspace allow-list, remapped by `outputRoot`.
 * Shared by the synthesize and patterns phases (the two must enforce the
 * same allow-list). Pass the engine so a compiled binary running with a
 * foreign cwd still finds the brain repo's filing rules; without it the
 * ladder skips rung 2.
 */
export async function loadAllowedSlugPrefixes(
  outputRoot = 'wiki',
  engine?: BrainEngine,
): Promise<string[]> {
  const candidates = [join(process.cwd(), 'skills', '_brain-filing-rules.json')];
  if (engine) {
    const repo = await resolveBrainRepoPath(engine);
    if (repo) candidates.push(join(repo, 'skills', '_brain-filing-rules.json'));
  }
  candidates.push(join(__dirname, '..', '..', '..', 'skills', '_brain-filing-rules.json'));
  return loadFromCandidates(candidates, outputRoot);
}

/** Test seam for the candidate-ladder semantics (both fail arms). */
export const __filingRulesTesting = { loadFromCandidates };
