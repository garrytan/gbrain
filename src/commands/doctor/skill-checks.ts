/**
 * Skill-check cluster — verbatim peel from src/commands/doctor.ts
 * (containment sprint). No behavior change; doctor.ts re-exports every
 * symbol (tests and scripts/live-brain-first-check.ts import them from
 * doctor.ts) and buildChecks consumes them.
 */
import { join, resolve as resolvePath } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import type { BrainEngine } from '../../core/engine.ts';
import {
  SKILLS_MANIFEST_FILENAME,
  verifySkillsManifest,
  type SkillsManifest,
} from '../../core/skills-integrity.ts';
import { loadOrDeriveManifest } from '../../core/skill-manifest.ts';
import { computeSkillCurrency } from '../../core/skillpack/skill-currency.ts';
import { findGbrainRoot } from '../../core/skillpack/bundle.ts';
import { checkPreconditions, type PreconditionContext } from '../../core/skillpack/preconditions.ts';
import { parseSkillFrontmatter } from '../../core/skill-frontmatter.ts';
import {
  analyzeSkillBrainFirst,
  buildBrainFirstSummaryLine,
  type BrainFirstAnalysis,
} from '../../core/skill-brain-first.ts';
import {
  loadSnapshot,
  writeSnapshotAtomically,
  diffAgainstSnapshot,
  appendAuditEventsForTransitions,
} from '../../core/audit-skill-brain-first.ts';
import type { Check } from '../doctor.ts';

/** Quick skill conformance check — frontmatter + required sections */
export function skillConformanceCheck(skillsDir: string): Check {
  try {
    // Host workspaces are allowed to omit a gbrain-specific manifest. Keep
    // conformance aligned with resolver_health and skill_brain_first by using
    // the canonical fallback that derives entries from direct SKILL.md files.
    const manifest = loadOrDeriveManifest(skillsDir);
    const skills = manifest.skills;
    let passing = 0;
    const failing: string[] = [];

    for (const skill of skills) {
      const skillPath = join(skillsDir, skill.path);
      if (!existsSync(skillPath)) {
        failing.push(`${skill.name}: file missing`);
        continue;
      }
      const content = readFileSync(skillPath, 'utf-8');
      // Check frontmatter exists
      if (!content.startsWith('---')) {
        failing.push(`${skill.name}: no frontmatter`);
        continue;
      }
      passing++;
    }

    if (failing.length === 0) {
      const derivedNote = manifest.derived ? ' (derived from SKILL.md files)' : '';
      return { name: 'skill_conformance', status: 'ok', message: `${passing}/${skills.length} skills pass${derivedNote}` };
    }
    return {
      name: 'skill_conformance',
      status: 'warn',
      message: `${passing}/${skills.length} pass. Failing: ${failing.join(', ')}`,
    };
  } catch {
    return { name: 'skill_conformance', status: 'warn', message: 'Could not load or derive skills manifest' };
  }
}

/**
 * v0.36.x skill_brain_first doctor check (supersedes PR #1206).
 *
 * Walks the skills manifest, runs the pure `analyzeSkillBrainFirst()`
 * helper on each, surfaces violators with structured issues[]. Snapshot-
 * diff against the previous run drives audit JSONL writes (transition-
 * only) — stable brains produce zero audit churn per doctor invocation.
 *
 * Exit shape:
 *   - 0 violators → status: 'ok', message: '<n> skills compliant or exempt'
 *   - any violator → status: 'warn', message + per-skill summary lines +
 *     formerly-EXEMPT_SKILLS hint when applicable (CMT1 replaces the
 *     dropped upgrade migration with a guided opt-in)
 *
 * Test seam: pure function, no `process.exit`. Direct call from tests
 * with a synthetic skills dir under tempdir.
 */
/**
 * Skills-manifest integrity check (#159). Verifies the skills tree against
 * the committed skills.lock.json tamper-evidence manifest. Advisory only:
 * drift is a WARN (local edits are legitimate), and a missing/unreadable
 * manifest is an ok/skip — a user's workspace skills dir or a compiled
 * binary far from the repo has no manifest, and that is not a problem.
 */
export function skillsManifestIntegrityCheck(skillsDir: string): Check {
  const name = 'skills_manifest_integrity';
  const manifestPath = join(skillsDir, SKILLS_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    return { name, status: 'ok', message: `No ${SKILLS_MANIFEST_FILENAME} in ${skillsDir} — integrity check not applicable` };
  }
  let drift: ReturnType<typeof verifySkillsManifest>;
  let tracked: number;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as SkillsManifest;
    tracked = Object.keys(manifest).length;
    drift = verifySkillsManifest(skillsDir, manifest);
  } catch (err) {
    // Fail-safe: an unreadable/unparseable manifest or a filesystem error
    // skips the check rather than warning — this check must never block.
    const msg = err instanceof Error ? err.message : String(err);
    return { name, status: 'ok', message: `Could not verify ${SKILLS_MANIFEST_FILENAME} (${msg}) — integrity check skipped` };
  }
  const total = drift.modified.length + drift.missing.length + drift.extra.length;
  if (total === 0) {
    return { name, status: 'ok', message: `${tracked} bundled skill files match ${SKILLS_MANIFEST_FILENAME}` };
  }
  const sample = (files: string[]): string =>
    files.slice(0, 5).join(', ') + (files.length > 5 ? `, … +${files.length - 5} more` : '');
  const parts: string[] = [];
  if (drift.modified.length > 0) parts.push(`${drift.modified.length} modified (${sample(drift.modified)})`);
  if (drift.missing.length > 0) parts.push(`${drift.missing.length} missing (${sample(drift.missing)})`);
  if (drift.extra.length > 0) parts.push(`${drift.extra.length} extra (${sample(drift.extra)})`);
  return {
    name,
    status: 'warn',
    message:
      `skills/ drifted from ${SKILLS_MANIFEST_FILENAME} (advisory — local edits are fine): ${parts.join('; ')}. ` +
      `If intentional, regenerate: bun run scripts/generate-skills-manifest.ts`,
    details: { modified: drift.modified, missing: drift.missing, extra: drift.extra },
  };
}

/**
 * Skill currency check — compares the built-in skills bundle against what
 * the downstream workspace has scaffolded and surfaces NEW skills the user
 * doesn't have yet. Advisory: `new` skills are a WARN (you're missing
 * shipped capability); `drifted` skills are informational only (local edits
 * are legitimate — the ownership model). No-ops when running inside the
 * gbrain repo itself (bundle == install, always current) or when the bundle
 * can't be located.
 */
export function skillCurrencyCheck(skillsDir: string): Check {
  const name = 'skill_currency';
  const targetWorkspace = resolvePath(skillsDir, '..');
  const gbrainRoot = findGbrainRoot();
  if (!gbrainRoot) {
    return { name, status: 'ok', message: 'skill currency not applicable (no bundled skills pack found)' };
  }
  if (resolvePath(targetWorkspace) === resolvePath(gbrainRoot)) {
    return { name, status: 'ok', message: 'skill currency not applicable (running inside the gbrain repo)' };
  }
  let report: ReturnType<typeof computeSkillCurrency>;
  try {
    report = computeSkillCurrency({ gbrainRoot, targetWorkspace });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, status: 'ok', message: `skill currency check skipped (${msg})` };
  }
  const { counts, skills } = report;
  const sample = (status: 'new' | 'drifted'): string => {
    const s = skills.filter(k => k.status === status).map(k => k.slug);
    return s.slice(0, 8).join(', ') + (s.length > 8 ? `, … +${s.length - 8} more` : '');
  };
  if (counts.new === 0) {
    const drift = counts.drifted > 0 ? ` (${counts.drifted} drifted — local edits are fine)` : '';
    return { name, status: 'ok', message: `${counts.current}/${counts.total} built-in skills current${drift}` };
  }
  return {
    name,
    status: 'warn',
    message:
      `${counts.new} new built-in skill(s) available that this workspace hasn't installed: ${sample('new')}. ` +
      `Add them with \`gbrain skillpack sync\`.` +
      (counts.drifted > 0 ? ` (${counts.drifted} drifted from the bundle — local edits are fine.)` : ''),
    details: {
      new: skills.filter(k => k.status === 'new').map(k => k.slug),
      drifted: skills.filter(k => k.status === 'drifted').map(k => k.slug),
    },
  };
}

/**
 * Skill preconditions check — the LIVE half of the `requires:` frontmatter
 * contract. For every skill INSTALLED in this workspace that declares
 * preconditions, verify each against the connected brain and WARN on unmet
 * ones with a paste-ready hint. Engine-dependent: skips cleanly when there
 * is no brain to check against (the static list lives in
 * `gbrain skillpack setup`).
 */
export async function skillPreconditionsCheck(
  skillsDir: string,
  engine: BrainEngine | null,
): Promise<Check> {
  const name = 'skill_preconditions';
  if (!engine) {
    return { name, status: 'ok', message: 'skill preconditions not checked (no connected brain)' };
  }
  // Collect installed skills declaring `requires:`.
  let installed: { slug: string; requires: string[] }[];
  try {
    installed = readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const md = join(skillsDir, e.name, 'SKILL.md');
        if (!existsSync(md)) return null;
        const fm = parseSkillFrontmatter(readFileSync(md, 'utf-8'));
        const requires = fm?.requires ?? [];
        return requires.length > 0 ? { slug: e.name, requires } : null;
      })
      .filter((x): x is { slug: string; requires: string[] } => x !== null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, status: 'ok', message: `skill preconditions check skipped (${msg})` };
  }
  if (installed.length === 0) {
    return { name, status: 'ok', message: 'no installed skills declare preconditions' };
  }

  // Engine-backed precondition context. Read-only COUNT/getConfig queries;
  // no source scoping (doctor is a trusted local context). Every accessor
  // fails soft to a conservative value so a query error never throws the check.
  const ctx: PreconditionContext = {
    async countPages() {
      try {
        const rows = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM pages');
        return rows[0]?.n ?? 0;
      } catch { return 0; }
    },
    async countPagesInDir(dir: string) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      try {
        const rows = await engine.executeRaw<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM pages WHERE slug LIKE $1 ESCAPE '\\'`,
          [`${prefix.replace(/[%_\\]/g, m => `\\${m}`)}%`],
        );
        return rows[0]?.n ?? 0;
      } catch { return 0; }
    },
    async listSourceIds() {
      // #4278: `source:<id>`'s contract is EXISTENCE — a registered-but-not-
      // yet-synced source is met. Includes 'default' (it always exists).
      try {
        const rows = await engine.executeRaw<{ id: string }>(`SELECT id FROM sources ORDER BY id`);
        return rows.map(r => r.id);
      } catch { return []; }
    },
    async listPopulatedSourceIds() {
      // #4278: bare `source` means "a corpus exists" — any source (including
      // 'default', where single-source brains hold everything) with >=1 live
      // page. Pre-fix this required a non-default source, so a healthy
      // default-only brain failed `requires: source` forever.
      try {
        const rows = await engine.executeRaw<{ id: string }>(
          `SELECT s.id
             FROM sources s
            WHERE EXISTS (
              SELECT 1 FROM pages p
               WHERE p.source_id = s.id
                 AND p.deleted_at IS NULL
            )
            ORDER BY s.id`,
        );
        return rows.map(r => r.id);
      } catch { return []; }
    },
    async countPagesForSource(id: string) {
      try {
        const rows = await engine.executeRaw<{ n: number }>(
          'SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1',
          [id],
        );
        return rows[0]?.n ?? 0;
      } catch { return 0; }
    },
    async getConfig(key: string) {
      try {
        return (await engine.getConfig(key)) ?? undefined;
      } catch { return undefined; }
    },
  };

  const unmet: string[] = [];
  for (const skill of installed) {
    const results = await checkPreconditions(skill.requires, ctx);
    for (const r of results) {
      if (!r.met) unmet.push(`${skill.slug}: ${r.req.raw} — ${r.hint}`);
    }
  }
  if (unmet.length === 0) {
    return { name, status: 'ok', message: `${installed.length} skill(s) with preconditions, all met` };
  }
  return {
    name,
    status: 'warn',
    message:
      `${unmet.length} unmet skill precondition(s):\n  ` +
      unmet.slice(0, 8).join('\n  ') +
      (unmet.length > 8 ? `\n  … +${unmet.length - 8} more` : ''),
    details: { unmet },
  };
}

export function skillBrainFirstCheck(skillsDir: string): Check {
  let manifest: ReturnType<typeof loadOrDeriveManifest>;
  try {
    manifest = loadOrDeriveManifest(skillsDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'skill_brain_first',
      status: 'warn',
      message: `Could not load skills manifest from ${skillsDir} (${msg})`,
    };
  }
  if (manifest.skills.length === 0) {
    return {
      name: 'skill_brain_first',
      status: 'ok',
      message: 'No skills found — skill_brain_first not applicable',
    };
  }

  const violators: BrainFirstAnalysis[] = [];
  const typoSkills: BrainFirstAnalysis[] = [];

  for (const entry of manifest.skills) {
    const skillPath = join(skillsDir, entry.path);
    if (!existsSync(skillPath)) continue; // resolver_health already reports
    let content: string;
    try {
      content = readFileSync(skillPath, 'utf-8');
    } catch {
      continue; // best-effort; permissions etc.
    }
    const fm = parseSkillFrontmatter(content);
    const result = analyzeSkillBrainFirst(content, entry.name, fm);
    if (result.typo_hint) typoSkills.push(result);
    if (result.status === 'warn') violators.push(result);
  }

  // --- Snapshot + diff audit (A2 contract) ---------------------------------
  // Best-effort: snapshot/audit failures don't poison the check result.
  const violatorSlugs = new Set(violators.map(v => v.skill));
  const patternsBySlug = new Map<string, string[]>();
  for (const v of violators) {
    patternsBySlug.set(v.skill, v.external_patterns_matched);
  }
  let priorSnapshotPresent = true;
  try {
    const snapshot = loadSnapshot();
    priorSnapshotPresent = snapshot.present;
    const diff = diffAgainstSnapshot(violatorSlugs, snapshot.violators);
    const doctorRunId = `${process.pid}-${Date.now()}`;
    if (snapshot.present) {
      // Steady-state path: write events only for transitions.
      appendAuditEventsForTransitions(diff, patternsBySlug, doctorRunId);
    } else {
      // First run / corrupt snapshot: bootstrap by writing one
      // `detected` line per current violator. This is the only path
      // that writes more than `diff.added.length` lines in a single
      // doctor invocation.
      const bootstrapDiff = { added: Array.from(violatorSlugs).sort(), removed: [], unchanged: [] };
      appendAuditEventsForTransitions(bootstrapDiff, patternsBySlug, doctorRunId);
    }
    writeSnapshotAtomically(violatorSlugs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gbrain] skill_brain_first audit step failed (${msg}); check continues\n`);
  }

  // --- Build the check result ---------------------------------------------
  if (violators.length === 0) {
    const typoNote = typoSkills.length > 0
      ? ` (note: ${typoSkills.length} skill(s) have brain_first typo hints: ${typoSkills.map(t => t.skill).join(', ')})`
      : '';
    return {
      name: 'skill_brain_first',
      status: 'ok',
      message: `${manifest.skills.length} skill(s) compliant or exempt${typoNote}`,
    };
  }

  // Sort for deterministic message + issues order.
  violators.sort((a, b) => a.skill.localeCompare(b.skill));

  const formerlyExempt = violators.filter(v => v.formerly_hardcoded_exempt);
  const summary: string[] = [];
  summary.push(
    `${violators.length} skill(s) do external lookups without a brain-first compliance signal. ` +
    `Fix via 'gbrain doctor --fix' (adds canonical Convention callout) ` +
    `or set 'brain_first: exempt' in skill frontmatter for genuine infra skills.`,
  );
  if (formerlyExempt.length > 0) {
    summary.push(
      `Of these, ${formerlyExempt.length} were hardcoded-exempt in PR #1206 (${formerlyExempt.map(v => v.skill).slice(0, 6).join(', ')}${formerlyExempt.length > 6 ? ', ...' : ''}). ` +
      `These need explicit opt-out now: run 'gbrain doctor --fix' to add the canonical callout, ` +
      `or add 'brain_first: exempt' to frontmatter for skills that genuinely shouldn't consult the brain.`,
    );
  }
  if (typoSkills.length > 0) {
    summary.push(
      `${typoSkills.length} skill(s) have brain_first typo hints: ` +
      typoSkills.slice(0, 6).map(t => `${t.skill} — ${t.typo_hint}`).join('; ') +
      (typoSkills.length > 6 ? '; ...' : ''),
    );
  }

  return {
    name: 'skill_brain_first',
    status: 'warn',
    message: summary.join(' '),
    issues: violators.map(v => ({
      type: 'skill_missing_brain_first',
      skill: v.skill,
      action: v.formerly_hardcoded_exempt
        ? `Add canonical Convention callout OR set 'brain_first: exempt' (was hardcoded-exempt in PR #1206)`
        : `Add canonical Convention callout OR set 'brain_first: exempt'`,
      fix: {
        kind: 'add-convention-callout',
        external_patterns: v.external_patterns_matched,
        typo_hint: v.typo_hint,
        formerly_hardcoded_exempt: v.formerly_hardcoded_exempt,
        summary_line: buildBrainFirstSummaryLine(v),
      },
    })),
  };
}
