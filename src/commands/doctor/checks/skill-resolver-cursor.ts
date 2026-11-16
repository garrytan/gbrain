/**
 * The Cursor half of doctor's skill_resolver check: the pinned-skills rule
 * gbrain setup cursor --skill-loading resolve writes per project
 * (src/core/setup/cursor-skill-pins.ts). For each recorded project it reports
 * whether the rule file is gbrain's and present, the project catalog's
 * freshness and the pin count. Cursor's coverage is always partial: pinned
 * only, no per-turn hook, and unverified, since nothing on this host can
 * see Cursor's model request.
 *
 * Read-only. Null when no project is recorded.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogStatus } from '../../../core/skills/resolver/build.ts';
import { CURSOR_COVERAGE_NOTE, CURSOR_PINS_HEAD, cursorPinsRulePath, readCursorPinsState } from '../../../core/setup/cursor-skill-pins.ts';

export interface CursorProjectView { project: string; catalog: string; rule: 'present' | 'absent' | 'foreign'; fresh: boolean | null; stale_reason: string | null; skills: number; pins: number }
export interface CursorSkillView { projects: CursorProjectView[]; coverage: 'partial'; coverage_note: string }

export async function cursorSkillView(home: string): Promise<CursorSkillView | null> {
  const entries = Object.entries(readCursorPinsState(home).projects);
  if (entries.length === 0) return null;
  const projects: CursorProjectView[] = [];
  for (const [project, rec] of entries) {
    const path = cursorPinsRulePath(project);
    const rule = !existsSync(path) ? 'absent' : (() => { try { return readFileSync(path, 'utf8').startsWith(CURSOR_PINS_HEAD) ? 'present' as const : 'foreign' as const; } catch { return 'foreign' as const; } })();
    const s = existsSync(join(home, 'skill-index', rec.catalog, 'receipt.json')) ? await catalogStatus(rec.catalog, { home }) : null;
    projects.push({ project, catalog: rec.catalog, rule, fresh: s ? s.fresh : null, stale_reason: s?.stale_reason ?? (s ? null : 'missing'), skills: s?.receipt?.skill_count ?? 0, pins: rec.pinned_ids.length });
  }
  return { projects, coverage: 'partial', coverage_note: CURSOR_COVERAGE_NOTE };
}

/** The line for harness_wiring, and the first problem with its code and project, if any. */
export function describeCursorSkillView(v: CursorSkillView): { line: string; problem: { code: string; what: string; project: string } | null } {
  const parts = v.projects.map((p) => p.project + ' ' + p.pins + ' pinned, rule ' + p.rule + ', ' + (p.fresh ? 'fresh' : 'stale (' + p.stale_reason + ')'));
  const line = 'cursor pins in ' + v.projects.length + ' project(s): ' + parts.join('; ') + ' (partial: ' + v.coverage_note + ')';
  const bad = v.projects.find((p) => p.fresh === null || (p.pins > 0 && p.rule !== 'present'));
  const problem = !bad ? null
    : bad.fresh === null ? { code: 'skill_index_missing', what: 'the ' + bad.catalog + ' catalog for ' + bad.project + ' is missing, so its pins cannot be checked', project: bad.project }
      : { code: 'skill_resolver_plugin_not_installed', what: bad.rule === 'foreign' ? 'the pinned-skills rule in ' + bad.project + ' is not gbrain\'s any more' : 'the pinned-skills rule is gone from ' + bad.project, project: bad.project };
  return { line, problem };
}
