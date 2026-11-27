/**
 * GST-3155 items 1-4: false alarms in `gbrain check-resolvable`.
 *
 *   1. A bolded prose bullet in a workspace AGENTS.md is not a resolver row.
 *   2. orphan_trigger matches a skill by its manifest path, not only its name.
 *   3. A manifest entry whose SKILL.md is gone is missing_file, not unreachable.
 *   4. `--fix --dry-run` proposes only fixes for findings the report shows, and
 *      a DRY replacement never swallows a heading.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { spawnSync, execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { checkResolvable } from '../src/core/check-resolvable.ts';
import { autoFixDryViolations } from '../src/core/dry-fix.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const REPO_ROOT = resolve(import.meta.dir, '..');

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

interface Skill {
  folder: string;
  name?: string;
  body?: string;
  triggers?: string[];
}

function workspace(skills: Skill[], opts: { manifest?: { name: string; path: string }[]; parentAgentsMd?: string; resolverMd?: string; git?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'gst-3155-'));
  created.push(root);
  const skillsDir = join(root, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  for (const s of skills) {
    mkdirSync(join(skillsDir, s.folder), { recursive: true });
    const fm = ['---', `name: ${s.name ?? s.folder}`, 'triggers:', ...(s.triggers ?? [`${s.folder} trigger`]).map(t => `  - "${t}"`), '---'];
    writeFileSync(join(skillsDir, s.folder, 'SKILL.md'), [...fm, s.body ?? `# ${s.folder}\n\nA test skill.\n`].join('\n'));
  }
  const manifest = opts.manifest ?? skills.map(s => ({ name: s.name ?? s.folder, path: `${s.folder}/SKILL.md` }));
  writeFileSync(join(skillsDir, 'manifest.json'), JSON.stringify({ skills: manifest }, null, 2));
  if (opts.resolverMd !== undefined) writeFileSync(join(skillsDir, 'RESOLVER.md'), opts.resolverMd);
  if (opts.parentAgentsMd !== undefined) writeFileSync(join(root, 'AGENTS.md'), opts.parentAgentsMd);
  if (opts.git) {
    execSync('git init --quiet && git config user.email test@example.com && git config user.name test && git add -A && git commit --quiet -m init', { cwd: root });
  }
  return skillsDir;
}

describe('GST-3155 item 1: prose bullets in a workspace AGENTS.md', () => {
  it('a bolded prose bullet naming no skill is not read as a resolver row', () => {
    const skillsDir = workspace([{ folder: 'alpha-skill' }], {
      parentAgentsMd: [
        '# Agent instructions',
        '',
        '## How to work',
        '- **memory**: search the brain before answering anything.',
        '- **tone**: keep replies short.',
        '',
        '## Skills',
        '- **alpha-skill**: run alpha | alpha please',
        '',
      ].join('\n'),
    });
    const report = checkResolvable(skillsDir);
    const missing = report.errors.filter(e => e.type === 'missing_file').map(e => e.skill);
    expect(missing).not.toContain('skills/memory/SKILL.md');
    expect(missing).not.toContain('skills/tone/SKILL.md');
    expect(report.issues.filter(i => i.skill === 'memory' || i.skill === 'tone')).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('a list row in a workspace AGENTS.md for a skill that exists still routes to it', () => {
    const skillsDir = workspace([{ folder: 'alpha-skill', triggers: [] }], {
      parentAgentsMd: '## Skills\n- **alpha-skill**: run alpha | alpha please\n',
    });
    const report = checkResolvable(skillsDir);
    expect(report.issues.filter(i => i.skill === 'alpha-skill' && i.type === 'unreachable')).toEqual([]);
    expect(report.summary.reachable).toBe(1);
  });

  it('a list row in skills/RESOLVER.md for a skill that is gone is still missing_file', () => {
    const skillsDir = workspace([{ folder: 'alpha-skill' }], {
      resolverMd: '## Skills\n- **alpha-skill**: run alpha\n- **ghost-skill**: run ghost\n',
    });
    const report = checkResolvable(skillsDir);
    expect(report.errors.filter(e => e.type === 'missing_file').map(e => e.skill)).toEqual(['skills/ghost-skill/SKILL.md']);
  });
});

describe('GST-3155 item 2: orphan_trigger when folder and frontmatter name differ', () => {
  it('a skill listed in manifest.json under its frontmatter name is not an orphan', () => {
    const skillsDir = workspace([{ folder: 'beta-folder', name: 'beta-skill' }], {
      resolverMd: '## Skills\n| beta | `skills/beta-folder/SKILL.md` |\n',
    });
    const report = checkResolvable(skillsDir);
    expect(report.issues.filter(i => i.type === 'orphan_trigger')).toEqual([]);
    expect(report.issues.filter(i => i.type === 'unreachable')).toEqual([]);
  });
});

describe('GST-3155 item 3: a manifest entry whose file is gone', () => {
  it('is reported as missing_file, not unreachable', () => {
    const skillsDir = workspace([{ folder: 'alpha-skill' }], {
      manifest: [
        { name: 'alpha-skill', path: 'alpha-skill/SKILL.md' },
        { name: 'ghost-skill', path: 'ghost-skill/SKILL.md' },
      ],
    });
    const report = checkResolvable(skillsDir);
    expect(report.issues.filter(i => i.type === 'unreachable')).toEqual([]);
    const missing = report.errors.filter(e => e.type === 'missing_file');
    expect(missing).toHaveLength(1);
    expect(missing[0].skill).toBe('ghost-skill');
    expect(missing[0].message).toContain('manifest.json');
    expect(report.summary.unreachable).toBe(0);
  });
});

describe('GST-3155 item 4: --fix preview agrees with the report', () => {
  function runCli(args: string[]) {
    const res = spawnSync('bun', [CLI, 'check-resolvable', ...args], { encoding: 'utf-8', cwd: REPO_ROOT, maxBuffer: 10 * 1024 * 1024 });
    return { status: res.status, json: JSON.parse(res.stdout) };
  }

  it('every proposed edit is for a dry_violation the same run reports', () => {
    const skillsDir = workspace(
      [
        { folder: 'lookup-skill', body: '# Lookup\n\nUse perplexity to answer the question.\n' },
        { folder: 'filing-skill', body: '# Filing\n\nCheck the notability gate before creating a page.\n' },
      ],
      { git: true },
    );
    const { json } = runCli(['--json', '--fix', '--dry-run', '--skills-dir', skillsDir]);
    const findings = new Set(
      json.report.issues.filter((i: any) => i.type === 'dry_violation').map((i: any) => i.skill),
    );
    const proposals = [...json.autoFix.fixed, ...json.autoFix.skipped];
    expect(proposals.map((p: any) => p.patternLabel)).not.toContain('brain-first compliance');
    for (const p of json.autoFix.fixed) expect(findings.has(p.skill)).toBe(true);
    expect(json.autoFix.fixed.map((p: any) => p.skill)).toEqual(['filing-skill']);
  }, 30_000);

  it('check-resolvable --fix without --dry-run leaves a skill missing the brain-first callout unchanged', () => {
    const skillsDir = workspace([{ folder: 'lookup-skill', body: '# Lookup\n\nUse perplexity to answer the question.\n' }], { git: true });
    const skillMd = join(skillsDir, 'lookup-skill', 'SKILL.md');
    const before = readFileSync(skillMd, 'utf-8');
    const { json } = runCli(['--json', '--fix', '--skills-dir', skillsDir]);
    expect(json.autoFix.fixed).toEqual([]);
    expect(readFileSync(skillMd, 'utf-8')).toBe(before);
  }, 30_000);

  it('autoFixDryViolations still proposes the brain-first callout by default, as doctor --fix relies on', () => {
    const skillsDir = workspace([{ folder: 'lookup-skill', body: '# Lookup\n\nUse perplexity to answer the question.\n' }], { git: true });
    expect(autoFixDryViolations(skillsDir, { dryRun: true }).fixed.map(f => f.patternLabel)).toEqual(['brain-first compliance']);
    expect(autoFixDryViolations(skillsDir, { dryRun: true, insertMissingRules: false }).fixed).toEqual([]);
  });

  it('a DRY replacement stops at a code fence', () => {
    const skillsDir = workspace(
      [{ folder: 'filing-skill', body: '# Filing\n\nCheck the notability gate before creating a page.\n```\nexample();\n```\n' }],
      { git: true },
    );
    const { fixed } = autoFixDryViolations(skillsDir, { dryRun: true });
    expect(fixed).toHaveLength(1);
    expect(fixed[0].before).toBe('Check the notability gate before creating a page.');
  });

  it('a DRY match on a heading replaces that heading alone, not the body under it', () => {
    const skillsDir = workspace(
      [{ folder: 'filing-skill', body: '# Filing\n\n## Iron Law: Back-Linking (MANDATORY)\nEvery page links back.\n' }],
      { git: true },
    );
    const { fixed } = autoFixDryViolations(skillsDir, { dryRun: true });
    expect(fixed).toHaveLength(1);
    expect(fixed[0].before).toBe('## Iron Law: Back-Linking (MANDATORY)');
  });

  it('a DRY replacement in an unbroken section never takes the headings with it', () => {
    const skillsDir = workspace(
      [{
        folder: 'filing-skill',
        body: [
          '# Filing',
          '',
          '## Before you file',
          'Check the notability gate before creating a page.',
          'Then pick the folder.',
          '## Next step',
          'This section must survive.',
          '',
        ].join('\n'),
      }],
      { git: true },
    );
    const { fixed } = autoFixDryViolations(skillsDir, { dryRun: true });
    expect(fixed).toHaveLength(1);
    expect(fixed[0].before).toBe('Check the notability gate before creating a page.\nThen pick the folder.');
  });

  it('a DRY replacement of a bullet under a heading leaves the heading alone', () => {
    const skillsDir = workspace(
      [{ folder: 'filing-skill', body: '# Filing\nIntro line.\n## Rules\n- Check the notability gate first\n- Keep going\n## After\nMore.\n' }],
      { git: true },
    );
    const { fixed } = autoFixDryViolations(skillsDir, { dryRun: true });
    expect(fixed).toHaveLength(1);
    expect(fixed[0].before).toBe('- Check the notability gate first');
  });
});
