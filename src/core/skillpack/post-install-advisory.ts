/**
 * post-install-advisory.ts (v0.25.1) — agent-readable "what to do next"
 * after `gbrain init` or `gbrain upgrade`.
 *
 * gbrain users typically interact through their host agent (openclaw,
 * claude-code) rather than the gbrain CLI directly. So an interactive
 * TTY prompt at install time misses most of the audience.
 *
 * Instead: every `init` and `post-upgrade` ends by printing an advisory
 * that the agent reads from terminal output. The advisory:
 *
 *   1. Names the version that just landed.
 *   2. Lists the new skills that aren't yet installed in this workspace.
 *   3. Includes a one-line description per skill.
 *   4. Tells the agent EXPLICITLY: ask the user before installing.
 *   5. Prints the exact command to run if the user says yes.
 *
 * Detection: parse the cumulative-slugs receipt in the workspace's
 * managed block (RESOLVER.md / AGENTS.md). Any skill in the recommended
 * set that isn't in the receipt is "not yet installed."
 *
 * Recommended set: hardcoded for v0.25.1 (the 9 new skills). Future
 * releases either bump the constant or read it from the latest
 * migration file's frontmatter; for v0.25.1 the constant is the simpler
 * path.
 *
 * No-op safely:
 *   - No workspace detected → no advisory (don't fabricate paths).
 *   - All recommended skills already installed → no advisory
 *     (don't nag the agent every command).
 *   - Pre-v0.19 fence with no receipt → use the row-extracted slug set.
 */

import { existsSync, readFileSync } from 'fs';
import { findResolverFile } from '../resolver-filenames.ts';
import { extractManagedSlugs, parseReceipt } from './installer.ts';
import { autoDetectSkillsDir } from '../repo-root.ts';
import { resolve as resolvePath } from 'path';

interface RecommendedSkill {
  slug: string;
  description: string;
}

const V0_25_1_RECOMMENDED: RecommendedSkill[] = [
  {
    slug: 'book-mirror',
    description:
      'FLAGSHIP. Take any book (EPUB/PDF), produce a personalized two-column chapter-by-chapter analysis. Left column preserves the chapter; right column maps every idea to your life using brain context. ~$6 for a 20-chapter book at Opus.',
  },
  {
    slug: 'article-enrichment',
    description:
      'Turn raw article dumps into structured pages with executive summary, verbatim quotes, key insights, why-it-matters.',
  },
  {
    slug: 'strategic-reading',
    description:
      'Read a book / article / case study through ONE specific problem-lens. Output: applied playbook with do / avoid / watch-for.',
  },
  {
    slug: 'concept-synthesis',
    description:
      'Deduplicate raw concept stubs into a tiered intellectual map (T1 Canon to T4 Riff). Trace idea evolution across years.',
  },
  {
    slug: 'perplexity-research',
    description:
      'Brain-augmented web research. Sends brain context to Perplexity so the search focuses on what is NEW vs already-known.',
  },
  {
    slug: 'archive-crawler',
    description:
      'Universal archivist for personal file archives (Dropbox / B2 / Gmail-takeout). REFUSES to run without a gbrain.yml allow-list — safe-by-default.',
  },
  {
    slug: 'academic-verify',
    description:
      'Trace a research claim through publication → methodology → raw data → independent replication. Verdict-shaped brain page.',
  },
  {
    slug: 'brain-pdf',
    description:
      'Render any brain page to publication-quality PDF via the gstack make-pdf binary. Optional gstack co-install.',
  },
  {
    slug: 'voice-note-ingest',
    description:
      'Capture voice notes with EXACT-PHRASING preservation (never paraphrased). Routes content to originals/concepts/people/companies/ideas.',
  },
];

/**
 * Read the managed block's cumulative-slugs receipt to find what's
 * already installed. Returns the empty set when no managed block
 * exists (fresh workspace).
 */
export function detectInstalledSlugs(targetSkillsDir: string, targetWorkspace: string): Set<string> {
  const resolver =
    findResolverFile(targetSkillsDir) ?? findResolverFile(targetWorkspace);
  if (!resolver) return new Set();
  const content = readFileSync(resolver, 'utf-8');
  const receipt = parseReceipt(content);
  if (receipt) return new Set(receipt.cumulativeSlugs);
  return new Set(extractManagedSlugs(content));
}

/**
 * Build the post-install advisory text. Returns null when there's
 * nothing to recommend (no workspace, all recommended skills already
 * installed, etc.) — caller should skip printing entirely on null.
 */
export function buildAdvisory(opts: {
  version: string;
  context: 'init' | 'upgrade';
  targetWorkspace?: string | null;
  targetSkillsDir?: string | null;
}): string | null {
  let workspace = opts.targetWorkspace ?? null;
  let skillsDir = opts.targetSkillsDir ?? null;

  if (!skillsDir) {
    const detected = autoDetectSkillsDir();
    if (detected.dir) {
      skillsDir = detected.dir;
      if (!workspace) workspace = resolvePath(skillsDir, '..');
    }
  }
  if (!workspace || !skillsDir) {
    return buildAdvisoryWithoutWorkspace(opts.version, opts.context);
  }

  const installed = detectInstalledSlugs(skillsDir, workspace);
  const missing = V0_25_1_RECOMMENDED.filter((s) => !installed.has(s.slug));

  if (missing.length === 0) return null;

  return renderAdvisory({
    version: opts.version,
    context: opts.context,
    missing,
    installCommand:
      missing.length === V0_25_1_RECOMMENDED.length
        ? 'gbrain skillpack install --all'
        : `gbrain skillpack install ${missing.map((s) => s.slug).join(' ')}`,
  });
}

function buildAdvisoryWithoutWorkspace(
  version: string,
  context: 'init' | 'upgrade',
): string {
  return renderAdvisory({
    version,
    context,
    missing: V0_25_1_RECOMMENDED,
    installCommand: 'gbrain skillpack install --all',
    workspaceNotDetected: true,
  });
}

function renderAdvisory(opts: {
  version: string;
  context: 'init' | 'upgrade';
  missing: RecommendedSkill[];
  installCommand: string;
  workspaceNotDetected?: boolean;
}): string {
  const lines: string[] = [];
  const bar = '='.repeat(72);
  const verb = opts.context === 'init' ? 'installed' : 'upgraded to';

  lines.push('');
  lines.push(bar);
  lines.push(`gbrain ${opts.version} — RECOMMENDED SKILLS FOR THE AGENT TO INSTALL`);
  lines.push(bar);
  lines.push('');
  lines.push(
    `The user just ${verb} gbrain ${opts.version}. This release ships ${opts.missing.length} ` +
      `${opts.missing.length === 1 ? 'skill' : 'skills'} that the user should ` +
      `consider installing into their workspace.`,
  );
  lines.push('');
  if (opts.workspaceNotDetected) {
    lines.push(
      '(NOTE: No OpenClaw workspace was detected at the default location. ' +
        'Set $OPENCLAW_WORKSPACE or pass --skills-dir to gbrain skillpack install.)',
    );
    lines.push('');
  }
  lines.push('THE NEW SKILLS:');
  lines.push('');
  for (const s of opts.missing) {
    lines.push(`  - ${s.slug}`);
    const wrapped = wrap(s.description, 68, '      ');
    for (const line of wrapped) lines.push(line);
    lines.push('');
  }
  lines.push('ACTION FOR THE AGENT:');
  lines.push('');
  lines.push('  1. Show this list to the user. Briefly explain each skill.');
  lines.push('  2. Ask the user explicitly: "Want me to install these now?"');
  lines.push('  3. If YES, run this command:');
  lines.push('');
  lines.push(`         ${opts.installCommand}`);
  lines.push('');
  lines.push('  4. If NO, tell them they can install any time with:');
  lines.push('');
  lines.push('         gbrain skillpack install <name>      # one skill');
  lines.push('         gbrain skillpack install --all       # all bundled');
  lines.push('         gbrain skillpack list                # see all options');
  lines.push('');
  lines.push('  Do NOT install without asking. The user owns this decision.');
  lines.push(bar);
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

/**
 * Print the advisory to stderr at the end of init / post-upgrade.
 * No-op when buildAdvisory returns null.
 */
export function printAdvisoryIfRecommended(opts: {
  version: string;
  context: 'init' | 'upgrade';
  targetWorkspace?: string | null;
  targetSkillsDir?: string | null;
}): void {
  const advisory = buildAdvisory(opts);
  if (!advisory) return;
  process.stderr.write(advisory);
}
