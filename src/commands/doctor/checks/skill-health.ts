/**
 * SKILL check: `skill_health`, the doctor face of `gbrain skillpack health`
 * (src/core/skill-health.ts). Warn-only: a skill that shows a gbrain command,
 * flag or tool this gbrain does not have warns; size, growth and frontmatter
 * findings are reported without warning; a folder gbrain does not manage, with
 * no copies of bundled skills, is not applicable. Reads files only, so it runs
 * the same on repo-less brains.
 */

import { skillHealthFor } from '../../skillpack/health.ts';
import { skillHealthSummary } from '../../../core/skill-health.ts';
import type { Check } from '../../doctor.ts';
import type { DoctorContext, DoctorEntry } from '../context.ts';
import { checkError, infoCheck } from '../check-fix.ts';

async function runSkillHealth(ctx: DoctorContext): Promise<Check[]> {
  const skillsDir = ctx.skillsDirResolution.dir;
  const checks: Check[] = [];
  if (ctx.scope !== 'all' || !skillsDir) return checks;
  try {
    const report = skillHealthFor(skillsDir);
    const summary = skillHealthSummary(report);
    const issues = report.findings.slice(0, 50).map(f => ({ type: f.code, skill: f.skill, action: f.fix }));
    const details = { scope: report.scope, totals: report.totals };
    if (report.scope === 'not_gbrain') {
      checks.push(infoCheck('skill_health', summary, 'not_applicable'));
    } else if (report.totals.drift > 0) {
      checks.push({ name: 'skill_health', status: 'warn', message: `${summary}. Run: gbrain skillpack health`, issues, details });
    } else {
      checks.push({ name: 'skill_health', status: 'ok', message: report.findings.length ? `${summary} (gbrain skillpack health lists them)` : summary,
        ...(issues.length ? { issues } : {}), details });
    }
  } catch (err) {
    checks.push(checkError('skill_health', 'read skill health', err, { status: 'warn' }));
  }
  return checks;
}

export const skillHealthEntry: DoctorEntry = {
  name: 'skill_health',
  emits: ['skill_health'],
  run: runSkillHealth,
};
