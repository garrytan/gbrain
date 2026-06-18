/**
 * advisor/render.ts — the shared `=`-bar agent-readable renderer.
 *
 * One renderer for BOTH `gbrain advisor` and the post-install advisory so the
 * two surfaces never drift (eng-review: shared render). Print-never-execute: the
 * output tells the harness to show the user and ask before acting.
 */

import type { AdvisorFinding, AdvisorReport, AdvisorSeverity } from './types.ts';

const BAR = '='.repeat(72);

const SEV_LABEL: Record<AdvisorSeverity, string> = {
  critical: 'CRITICAL',
  warn: 'WARN',
  info: 'INFO',
};

function fixLine(f: AdvisorFinding): string | null {
  if (!f.fix.command_argv || f.fix.command_argv.length === 0) return null;
  return f.fix.command_argv.join(' ');
}

/** Render a full advisor report as the agent-readable `=`-bar block. */
export function renderAdvisorReport(report: AdvisorReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(BAR);
  lines.push(`gbrain advisor — ${report.findings.length} thing${report.findings.length === 1 ? '' : 's'} worth your attention (gbrain ${report.version})`);
  lines.push(BAR);
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('Nothing pressing — this brain looks healthy. Re-run `gbrain advisor` any time.');
    lines.push(BAR);
    lines.push('');
    return lines.join('\n');
  }

  for (const f of report.findings) {
    lines.push(`[${SEV_LABEL[f.severity]}] ${f.title}`);
    if (f.detail) for (const wl of wrap(f.detail, 68, '    ')) lines.push(wl);
    const fl = fixLine(f);
    if (fl) lines.push(`    fix: ${fl}`);
    lines.push('');
  }

  lines.push('ACTION FOR THE AGENT:');
  lines.push('  1. Show this list to the user, highest-severity first.');
  lines.push('  2. Ask before running any fix. The user owns these decisions.');
  lines.push('  3. To run a single fix locally after they agree:');
  lines.push('');
  const appliable = report.findings.filter((f) => f.fix.dispatch_id);
  if (appliable.length > 0) {
    lines.push(`         gbrain advisor --apply <id>     # e.g. ${appliable[0]!.fix.dispatch_id}`);
  } else {
    lines.push('         (run the per-finding `fix:` command above)');
  }
  lines.push('');
  lines.push(BAR);
  lines.push('');
  return lines.join('\n');
}

/**
 * Render the post-install / upgrade flavor: the bundled-skill recommendations as
 * a single advisor finding set. Kept here so post-install-advisory.ts and the
 * advisor share one format.
 */
export function renderRecommendedSkills(opts: {
  version: string;
  context: 'init' | 'upgrade';
  skills: Array<{ slug: string; description: string }>;
  scaffoldAllCommand: string;
  workspaceNotDetected?: boolean;
}): string {
  const lines: string[] = [];
  const verb = opts.context === 'init' ? 'installed' : 'upgraded to';
  lines.push('');
  lines.push(BAR);
  lines.push(`gbrain ${opts.version} — RECOMMENDED SKILLS FOR THE AGENT TO INSTALL`);
  lines.push(BAR);
  lines.push('');
  lines.push(
    `The user just ${verb} gbrain ${opts.version}. ${opts.skills.length} ` +
      `${opts.skills.length === 1 ? 'skill is' : 'skills are'} recommended but not yet installed.`,
  );
  lines.push('');
  if (opts.workspaceNotDetected) {
    lines.push('(NOTE: no workspace detected at the default location — pass --workspace to scaffold.)');
    lines.push('');
  }
  lines.push('THE SKILLS:');
  lines.push('');
  for (const s of opts.skills) {
    lines.push(`  - ${s.slug}`);
    for (const wl of wrap(s.description, 68, '      ')) lines.push(wl);
    lines.push('');
  }
  lines.push('ACTION FOR THE AGENT:');
  lines.push('  1. Show this list to the user. Briefly explain each skill.');
  lines.push('  2. Ask the user explicitly: "Want me to install these now?"');
  lines.push('  3. If YES:');
  lines.push('');
  lines.push(`         ${opts.scaffoldAllCommand}`);
  lines.push('');
  lines.push('  Do NOT scaffold without asking. The user owns this decision.');
  lines.push(BAR);
  lines.push('');
  return lines.join('\n');
}

function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = indent;
  for (const word of words) {
    if ((current + (current === indent ? '' : ' ') + word).length > width + indent.length) {
      lines.push(current.trimEnd());
      current = indent + word;
    } else {
      current = current === indent ? indent + word : current + ' ' + word;
    }
  }
  if (current.trim().length > 0) lines.push(current.trimEnd());
  return lines;
}
