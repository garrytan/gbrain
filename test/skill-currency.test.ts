/**
 * Tests for src/core/skillpack/skill-currency.ts — classify every bundled
 * built-in skill against a downstream install as new / drifted / current.
 *
 * Fixture mirrors test/skillpack-reference.test.ts exactly: a scratch
 * gbrainRoot (src/cli.ts + skills/ tree + openclaw.plugin.json so
 * loadBundleManifest resolves the bundle) and a scratch target workspace
 * populated via runScaffold.
 *
 * Pins:
 *   - one skill identical to bundle          → current
 *   - one skill scaffolded then user-edited  → drifted
 *   - one bundle-only skill absent downstream → new
 *   - the counts block and per-skill status
 *   - new-first ordering
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { computeSkillCurrency } from '../src/core/skillpack/skill-currency.ts';
import { runScaffold } from '../src/core/skillpack/scaffold.ts';

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
 * Three bundled skills: `alpha`, `beta`, `gamma`. shared_deps is empty so
 * each skill's reference summary reflects only its own files (a shared dep
 * scaffolded once would make an otherwise-"new" skill count identical files
 * and muddy the classification).
 */
function scratchGbrain(): string {
  const root = mkdtempSync(join(tmpdir(), 'sc-gbrain-'));
  created.push(root);
  mkdirSync(join(root, 'src', 'commands'), { recursive: true });
  writeFileSync(join(root, 'src', 'cli.ts'), '// stub');

  for (const slug of ['alpha', 'beta', 'gamma']) {
    mkdirSync(join(root, 'skills', slug), { recursive: true });
    writeFileSync(
      join(root, 'skills', slug, 'SKILL.md'),
      `---\nname: ${slug}\ntriggers:\n  - ${slug[0]}\n---\n# ${slug} skill\n\nLine A\nLine B\nLine C\n`,
    );
  }

  writeFileSync(
    join(root, 'openclaw.plugin.json'),
    JSON.stringify(
      {
        name: 'gbrain-test',
        version: '0.33.0-test',
        skills: ['skills/alpha', 'skills/beta', 'skills/gamma'],
        shared_deps: [],
      },
      null,
      2,
    ),
  );
  return root;
}

function scratchWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'sc-ws-'));
  created.push(ws);
  return ws;
}

describe('computeSkillCurrency — classification', () => {
  it('classifies current / drifted / new and computes counts', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();

    // alpha: scaffold, leave untouched → current
    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'alpha' });

    // beta: scaffold, then user edits a file → drifted
    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'beta' });
    const betaMd = join(ws, 'skills', 'beta', 'SKILL.md');
    writeFileSync(betaMd, readFileSync(betaMd, 'utf-8') + '\n## My local edits\n');

    // gamma: never scaffolded → new (all files missing downstream)

    const report = computeSkillCurrency({ gbrainRoot, targetWorkspace: ws });

    expect(report.counts).toEqual({ new: 1, drifted: 1, current: 1, total: 3 });

    const bySlug = Object.fromEntries(report.skills.map(s => [s.slug, s]));

    expect(bySlug.alpha.status).toBe('current');
    expect(bySlug.alpha.differs).toBe(0);
    expect(bySlug.alpha.missing).toBe(0);
    expect(bySlug.alpha.identical).toBeGreaterThan(0);

    expect(bySlug.beta.status).toBe('drifted');
    expect(bySlug.beta.differs).toBe(1);

    expect(bySlug.gamma.status).toBe('new');
    expect(bySlug.gamma.identical).toBe(0);
    expect(bySlug.gamma.differs).toBe(0);
    expect(bySlug.gamma.missing).toBeGreaterThan(0);
  });

  it('orders skills new-first, then drifted, then current', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();

    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'alpha' }); // current
    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'beta' }); // -> drifted
    const betaMd = join(ws, 'skills', 'beta', 'SKILL.md');
    writeFileSync(betaMd, readFileSync(betaMd, 'utf-8') + '\n## edit\n');
    // gamma untouched -> new

    const report = computeSkillCurrency({ gbrainRoot, targetWorkspace: ws });

    expect(report.skills.map(s => s.status)).toEqual(['new', 'drifted', 'current']);
    expect(report.skills.map(s => s.slug)).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('a partially-installed skill (some files missing) counts as drifted', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();

    // alpha ships two files; scaffold both, then delete one → identical>0, missing>0.
    writeFileSync(join(gbrainRoot, 'skills', 'alpha', 'EXTRA.md'), '# extra\n');
    runScaffold({ gbrainRoot, targetWorkspace: ws, skillSlug: 'alpha' });
    rmSync(join(ws, 'skills', 'alpha', 'EXTRA.md'), { force: true });

    const report = computeSkillCurrency({ gbrainRoot, targetWorkspace: ws });
    const alpha = report.skills.find(s => s.slug === 'alpha')!;
    expect(alpha.status).toBe('drifted');
    expect(alpha.identical).toBeGreaterThan(0);
    expect(alpha.missing).toBeGreaterThan(0);
    expect(alpha.differs).toBe(0);
  });

  it('result round-trips through JSON losslessly', () => {
    const gbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    const report = computeSkillCurrency({ gbrainRoot, targetWorkspace: ws });
    const round = JSON.parse(JSON.stringify(report));
    expect(round.counts).toEqual(report.counts);
    expect(round.skills.length).toBe(report.skills.length);
  });
});
