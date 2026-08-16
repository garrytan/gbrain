/**
 * skillpack/skill-currency.ts — classify every bundled built-in skill
 * against a downstream install as new / drifted / current.
 *
 * A thin, pure classifier over `runReference` (src/core/skillpack/
 * reference.ts). It does NOT reimplement diffing — it reuses the per-file
 * `ReferenceFileResult` (with its `sharedDep` flag) and classifies each
 * skill by its OWN files only.
 *
 * Why own-files-only (not `runReferenceAll`'s aggregate summary): that
 * summary counts a skill's shared-dep files (conventions/, `skills/_*.md`)
 * alongside its own. A genuinely-new skill whose shared deps are already on
 * disk (scaffolded by some earlier skill) would then show identical>0 &&
 * own-files-missing and misclassify as `drifted` instead of `new`. Keying
 * off `!sharedDep` files makes "new" mean "this skill's own body isn't
 * installed", which is what a caller deciding whether to scaffold cares about.
 *
 * Pure/deterministic: no console output, no filesystem writes. If the
 * bundle can't be read, the error propagates — callers guard.
 */

import { loadBundleManifest, bundledSkillSlugs } from './bundle.ts';
import { runReference } from './reference.ts';

export interface SkillCurrency {
  slug: string;
  status: 'new' | 'drifted' | 'current';
  differs: number;
  missing: number;
  identical: number;
}

export interface CurrencyReport {
  skills: SkillCurrency[];
  counts: { new: number; drifted: number; current: number; total: number };
}

/**
 * Classify one skill from its OWN-file counts (shared deps excluded).
 *
 *   - `new`     → this skill's own body isn't installed: no own file is
 *                 present (identical === 0 && differs === 0).
 *   - `drifted` → an own file differs (differs > 0) OR the skill is
 *                 partially installed (identical > 0 && missing > 0).
 *   - `current` → every own file present and identical
 *                 (differs === 0 && missing === 0 && identical > 0).
 */
function classify(own: {
  identical: number;
  differs: number;
  missing: number;
}): SkillCurrency['status'] {
  const { identical, differs, missing } = own;
  if (identical === 0 && differs === 0) return 'new';
  if (differs > 0 || (identical > 0 && missing > 0)) return 'drifted';
  return 'current';
}

const STATUS_RANK: Record<SkillCurrency['status'], number> = {
  new: 0,
  drifted: 1,
  current: 2,
};

/**
 * Classify every bundled built-in skill against `targetWorkspace`.
 * Skills are ordered new-first, then drifted, then current (slug order
 * within each group for determinism). Counts are computed from the
 * classification. Shared-dep files (conventions/, `skills/_*.md`) are
 * excluded from each skill's counts so a new skill whose shared deps are
 * already on disk isn't mistaken for a drifted one.
 */
export function computeSkillCurrency(opts: {
  gbrainRoot: string;
  targetWorkspace: string;
}): CurrencyReport {
  const manifest = loadBundleManifest(opts.gbrainRoot);
  const slugs = bundledSkillSlugs(manifest);

  const skills: SkillCurrency[] = slugs.map(slug => {
    const ref = runReference({
      gbrainRoot: opts.gbrainRoot,
      targetWorkspace: opts.targetWorkspace,
      skillSlug: slug,
    });
    const own = ref.files.filter(f => !f.sharedDep);
    const counts = {
      identical: own.filter(f => f.status === 'identical').length,
      differs: own.filter(f => f.status === 'differs').length,
      missing: own.filter(f => f.status === 'missing').length,
    };
    return { slug, status: classify(counts), ...counts };
  });

  skills.sort((a, b) => {
    const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    return byStatus !== 0 ? byStatus : a.slug.localeCompare(b.slug);
  });

  const counts = {
    new: skills.filter(s => s.status === 'new').length,
    drifted: skills.filter(s => s.status === 'drifted').length,
    current: skills.filter(s => s.status === 'current').length,
    total: skills.length,
  };

  return { skills, counts };
}
