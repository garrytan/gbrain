/**
 * Tests for src/core/skillpack/post-install-advisory.ts (v0.25.1).
 *
 * The advisory is meant to be read by the agent (openclaw, claude-code)
 * from the terminal output of `gbrain init` and `gbrain post-upgrade`.
 * These tests pin:
 *   - empty/no-workspace path renders a workspace-detection note
 *   - all-installed path returns null (no-op)
 *   - partial-install path lists ONLY the missing skills
 *   - the rendered text contains the explicit "ASK THE USER FIRST"
 *     framing so future changes to the prose can't accidentally
 *     drop the user-sovereignty contract
 */

import { describe, expect, it, afterEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildAdvisory,
  detectInstalledSlugs,
} from '../src/core/skillpack/post-install-advisory.ts';

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length) {
    const d = cleanup.pop();
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

function scratchWorkspace(receiptSlugs: string[] | null): {
  workspace: string;
  skillsDir: string;
} {
  const workspace = mkdtempSync(join(tmpdir(), 'advisory-test-'));
  cleanup.push(workspace);
  const skillsDir = join(workspace, 'skills');
  mkdirSync(skillsDir, { recursive: true });

  if (receiptSlugs === null) {
    writeFileSync(
      join(skillsDir, 'RESOLVER.md'),
      '# RESOLVER\n\n| Trigger | Skill |\n|---------|-------|\n',
    );
  } else {
    const slugList = receiptSlugs.sort().join(',');
    const block = [
      '# RESOLVER',
      '',
      '| Trigger | Skill |',
      '|---------|-------|',
      '',
      '<!-- gbrain:skillpack:begin -->',
      `<!-- gbrain:skillpack:manifest cumulative-slugs="${slugList}" version="0.25.1" -->`,
      ...receiptSlugs.map(
        (s) => `| "${s}" | \`skills/${s}/SKILL.md\` |`,
      ),
      '<!-- gbrain:skillpack:end -->',
      '',
    ].join('\n');
    writeFileSync(join(skillsDir, 'RESOLVER.md'), block);
  }

  return { workspace, skillsDir };
}

describe('detectInstalledSlugs', () => {
  it('returns empty set when no managed block', () => {
    const { workspace, skillsDir } = scratchWorkspace(null);
    expect(detectInstalledSlugs(skillsDir, workspace).size).toBe(0);
  });

  it('reads cumulative-slugs receipt', () => {
    const { workspace, skillsDir } = scratchWorkspace([
      'brain-ops',
      'idea-ingest',
    ]);
    const set = detectInstalledSlugs(skillsDir, workspace);
    expect(set.has('brain-ops')).toBe(true);
    expect(set.has('idea-ingest')).toBe(true);
    expect(set.size).toBe(2);
  });
});

describe('buildAdvisory — partial-install path', () => {
  it('lists ONLY missing skills when most are already installed', () => {
    const { workspace, skillsDir } = scratchWorkspace([
      'brain-ops',
      'article-enrichment',
      'strategic-reading',
      'concept-synthesis',
      'perplexity-research',
      'archive-crawler',
      'academic-verify',
      'brain-pdf',
      'voice-note-ingest',
    ]);
    const advisory = buildAdvisory({
      version: '0.25.1',
      context: 'upgrade',
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
    });
    expect(advisory).not.toBeNull();
    expect(advisory).toContain('book-mirror');
    expect(advisory).not.toContain('article-enrichment');
    expect(advisory).not.toContain('strategic-reading');
    expect(advisory).toContain('gbrain skillpack install book-mirror');
  });

  it('uses --all command when ALL recommended are missing (fresh workspace)', () => {
    const { workspace, skillsDir } = scratchWorkspace([]);
    const advisory = buildAdvisory({
      version: '0.25.1',
      context: 'init',
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
    });
    expect(advisory).not.toBeNull();
    expect(advisory).toContain('gbrain skillpack install --all');
    expect(advisory).toContain('book-mirror');
    expect(advisory).toContain('article-enrichment');
    expect(advisory).toContain('strategic-reading');
  });
});

describe('buildAdvisory — all-installed → null (no nag)', () => {
  it('returns null when every recommended skill is already installed', () => {
    const allRecommended = [
      'book-mirror',
      'article-enrichment',
      'strategic-reading',
      'concept-synthesis',
      'perplexity-research',
      'archive-crawler',
      'academic-verify',
      'brain-pdf',
      'voice-note-ingest',
    ];
    const { workspace, skillsDir } = scratchWorkspace(allRecommended);
    const advisory = buildAdvisory({
      version: '0.25.1',
      context: 'upgrade',
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
    });
    expect(advisory).toBeNull();
  });
});

describe('buildAdvisory — agent-readable framing', () => {
  it('contains the user-sovereignty contract phrasing', () => {
    const { workspace, skillsDir } = scratchWorkspace([]);
    const advisory = buildAdvisory({
      version: '0.25.1',
      context: 'init',
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
    })!;
    expect(advisory).toContain('ACTION FOR THE AGENT');
    expect(advisory).toContain('Ask the user');
    expect(advisory).toContain('Do NOT install without asking');
    expect(advisory).toContain('user owns this decision');
  });

  it('names the version + context (init vs upgrade)', () => {
    const { workspace, skillsDir } = scratchWorkspace([]);
    const initAdvisory = buildAdvisory({
      version: '0.25.1',
      context: 'init',
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
    })!;
    const upgradeAdvisory = buildAdvisory({
      version: '0.25.1',
      context: 'upgrade',
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
    })!;
    expect(initAdvisory).toContain('0.25.1');
    expect(initAdvisory).toContain('installed');
    expect(upgradeAdvisory).toContain('0.25.1');
    expect(upgradeAdvisory).toContain('upgraded to');
  });

  it('describes each skill with a one-line value prop', () => {
    const { workspace, skillsDir } = scratchWorkspace([]);
    const advisory = buildAdvisory({
      version: '0.25.1',
      context: 'init',
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
    })!;
    expect(advisory).toContain('FLAGSHIP');
    expect(advisory).toContain('two-column');
    expect(advisory).toContain('verbatim');
    expect(advisory).toContain('Brain-augmented web research');
  });

  it('shows the exact install command per the missing-set', () => {
    const { workspace, skillsDir } = scratchWorkspace([]);
    const advisory = buildAdvisory({
      version: '0.25.1',
      context: 'init',
      targetWorkspace: workspace,
      targetSkillsDir: skillsDir,
    })!;
    expect(advisory).toContain('gbrain skillpack install --all');
    expect(advisory).toContain('gbrain skillpack list');
  });
});

describe('buildAdvisory — no workspace detected', () => {
  it('still renders an advisory with a workspace-detection note', () => {
    const advisory = buildAdvisory({
      version: '0.25.1',
      context: 'init',
      targetWorkspace: '/non/existent/workspace-xyz-' + Math.random().toString(36).slice(2),
      targetSkillsDir: '/non/existent/skills-xyz-' + Math.random().toString(36).slice(2),
    });
    expect(advisory).not.toBeNull();
    // No workspace -> empty installed set -> all recommended treated as missing.
    expect(advisory).toContain('gbrain skillpack install --all');
  });
});
