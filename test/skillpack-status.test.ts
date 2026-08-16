/**
 * Tests for the `gbrain skillpack status` core logic.
 *
 * cmdStatus itself calls process.exit + console.log (hard to intercept
 * cleanly), so this pins the two pure pieces it reports:
 *   - computeSkillCurrency — the new / drifted / current split
 *   - parseSkillFrontmatter — a skill's declared `requires:` list
 *
 * Fixture shape mirrors test/skillpack-reference.test.ts.
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { computeSkillCurrency } from '../src/core/skillpack/skill-currency.ts';
import { runScaffold } from '../src/core/skillpack/scaffold.ts';
import { parseSkillFrontmatter } from '../src/core/skill-frontmatter.ts';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const p = created.pop()!;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

/**
 * A scratch gbrain bundle with two skills:
 *   - alpha — declares `requires: [source]`
 *   - beta  — no preconditions
 */
function scratchGbrain(): string {
  const root = mkdtempSync(join(tmpdir(), 'sp-status-gbrain-'));
  created.push(root);
  mkdirSync(join(root, 'src', 'commands'), { recursive: true });
  writeFileSync(join(root, 'src', 'cli.ts'), '// stub');

  mkdirSync(join(root, 'skills', 'alpha'), { recursive: true });
  writeFileSync(
    join(root, 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ntriggers:\n  - a\nrequires:\n  - source\n---\n# alpha skill\n\nLine A\nLine B\n',
  );

  mkdirSync(join(root, 'skills', 'beta'), { recursive: true });
  writeFileSync(
    join(root, 'skills', 'beta', 'SKILL.md'),
    '---\nname: beta\ntriggers:\n  - b\n---\n# beta skill\n',
  );

  writeFileSync(
    join(root, 'openclaw.plugin.json'),
    JSON.stringify(
      {
        name: 'gbrain-test',
        version: '0.33.0-test',
        skills: ['skills/alpha', 'skills/beta'],
        shared_deps: [],
      },
      null,
      2,
    ),
  );
  return root;
}

function scratchWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'sp-status-ws-'));
  created.push(ws);
  return ws;
}

describe('skillpack status — currency split (computeSkillCurrency)', () => {
  it('all new when nothing is scaffolded', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();

    const report = computeSkillCurrency({ gbrainRoot, targetWorkspace: ws });

    expect(report.counts.total).toBe(2);
    expect(report.counts.new).toBe(2);
    expect(report.counts.drifted).toBe(0);
    expect(report.counts.current).toBe(0);
  });

  it('current after a clean scaffold; the un-scaffolded skill stays new', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'alpha' });

    const report = computeSkillCurrency({ gbrainRoot, targetWorkspace: ws });

    expect(report.counts.current).toBe(1);
    expect(report.counts.new).toBe(1);
    expect(report.counts.drifted).toBe(0);
    expect(report.skills.find(s => s.slug === 'alpha')!.status).toBe('current');
    expect(report.skills.find(s => s.slug === 'beta')!.status).toBe('new');
  });

  it('drifted after a scaffolded file is edited', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'alpha' });

    const skillMd = join(ws, 'skills', 'alpha', 'SKILL.md');
    writeFileSync(skillMd, readFileSync(skillMd, 'utf-8') + '\n## My local edits\n');

    const report = computeSkillCurrency({ gbrainRoot, targetWorkspace: ws });

    expect(report.counts.drifted).toBe(1);
    expect(report.skills.find(s => s.slug === 'alpha')!.status).toBe('drifted');
  });
});

describe('skillpack status — declared preconditions (parseSkillFrontmatter)', () => {
  it('surfaces a skill\'s declared requires and none for a skill without them', () => {
    const gbrainRoot = scratchGbrain();

    const alpha = parseSkillFrontmatter(
      readFileSync(join(gbrainRoot, 'skills', 'alpha', 'SKILL.md'), 'utf-8'),
    );
    const beta = parseSkillFrontmatter(
      readFileSync(join(gbrainRoot, 'skills', 'beta', 'SKILL.md'), 'utf-8'),
    );

    expect(alpha?.requires).toEqual(['source']);
    expect(beta?.requires ?? []).toEqual([]);
  });
});
