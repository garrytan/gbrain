/**
 * Tests for src/core/skillify/generator.ts (W4).
 * Mechanical scaffold plan + apply, idempotency (D-CX-7), stub sentinel.
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  applyScaffold,
  planScaffold,
  SkillifyScaffoldError,
  SKILL_NAME_PATTERN,
} from '../src/core/skillify/generator.ts';
import { SKILLIFY_STUB_MARKER } from '../src/core/skillify/templates.ts';

const created: string[] = [];

function scratchRepo(): { root: string; skillsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'skillify-repo-'));
  created.push(root);
  const skillsDir = join(root, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(
    join(skillsDir, 'RESOLVER.md'),
    '# RESOLVER\n\n## Brain operations\n\n| Trigger | Skill |\n|---------|-------|\n| "existing thing" | `skills/existing/SKILL.md` |\n',
  );
  return { root, skillsDir };
}

afterEach(() => {
  while (created.length) {
    const d = created.pop();
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe('SKILL_NAME_PATTERN', () => {
  it('accepts valid kebab-case', () => {
    expect(SKILL_NAME_PATTERN.test('context-now')).toBe(true);
    expect(SKILL_NAME_PATTERN.test('a')).toBe(true);
    expect(SKILL_NAME_PATTERN.test('calendar-recall-v2')).toBe(true);
  });
  it('rejects uppercase, spaces, underscores, leading digits', () => {
    expect(SKILL_NAME_PATTERN.test('ContextNow')).toBe(false);
    expect(SKILL_NAME_PATTERN.test('context now')).toBe(false);
    expect(SKILL_NAME_PATTERN.test('context_now')).toBe(false);
    expect(SKILL_NAME_PATTERN.test('2-skill')).toBe(false);
  });
});

describe('planScaffold', () => {
  it('throws SkillifyScaffoldError on invalid name', () => {
    const { root, skillsDir } = scratchRepo();
    expect(() =>
      planScaffold({
        skillsDir,
        repoRoot: root,
        vars: {
          name: 'Bad Name',
          description: 'x',
          triggers: [],
          writesTo: [],
          writesPages: false,
          mutating: false,
        },
      }),
    ).toThrow(SkillifyScaffoldError);
  });

  it('plans 4 files + resolver append for a new skill', () => {
    const { root, skillsDir } = scratchRepo();
    const plan = planScaffold({
      skillsDir,
      repoRoot: root,
      vars: {
        name: 'hello-world',
        description: 'say hello',
        triggers: ['say hello', 'greet me'],
        writesTo: [],
        writesPages: false,
        mutating: false,
      },
    });
    expect(plan.files.length).toBe(4);
    const paths = plan.files.map(f => f.path);
    expect(paths).toContain(join(skillsDir, 'hello-world', 'SKILL.md'));
    expect(paths).toContain(
      join(skillsDir, 'hello-world', 'scripts', 'hello-world.mjs'),
    );
    expect(paths).toContain(join(skillsDir, 'hello-world', 'routing-eval.jsonl'));
    expect(paths).toContain(join(root, 'test', 'hello-world.test.ts'));
    expect(plan.files.every(f => f.kind === 'new')).toBe(true);
    expect(plan.resolverFile).toBe(join(skillsDir, 'RESOLVER.md'));
    expect(plan.resolverAppend).not.toBeNull();
    expect(plan.resolverAppend!).toContain('`skills/hello-world/SKILL.md`');
  });

  it('SKILL.md includes the SKILLIFY_STUB sentinel', () => {
    const { root, skillsDir } = scratchRepo();
    const plan = planScaffold({
      skillsDir,
      repoRoot: root,
      vars: {
        name: 'foo',
        description: 'foo skill',
        triggers: [],
        writesTo: [],
        writesPages: false,
        mutating: false,
      },
    });
    const skillMd = plan.files.find(f => f.path.endsWith('SKILL.md'))!;
    expect(skillMd.content).toContain(SKILLIFY_STUB_MARKER);
  });

  it('script stub includes the SKILLIFY_STUB sentinel (D-CX-9 gate hook)', () => {
    const { root, skillsDir } = scratchRepo();
    const plan = planScaffold({
      skillsDir,
      repoRoot: root,
      vars: {
        name: 'foo',
        description: 'foo skill',
        triggers: [],
        writesTo: [],
        writesPages: false,
        mutating: false,
      },
    });
    const script = plan.files.find(f => f.path.endsWith('foo.mjs'))!;
    expect(script.content).toContain(SKILLIFY_STUB_MARKER);
  });

  it('refuses to scaffold over an existing file without --force', () => {
    const { root, skillsDir } = scratchRepo();
    mkdirSync(join(skillsDir, 'existing'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'existing', 'SKILL.md'),
      '---\nname: existing\n---\n',
    );
    expect(() =>
      planScaffold({
        skillsDir,
        repoRoot: root,
        vars: {
          name: 'existing',
          description: 'x',
          triggers: [],
          writesTo: [],
          writesPages: false,
          mutating: false,
        },
      }),
    ).toThrow(SkillifyScaffoldError);
  });

  it('--force marks existing files as overwrite', () => {
    const { root, skillsDir } = scratchRepo();
    mkdirSync(join(skillsDir, 'existing'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'existing', 'SKILL.md'),
      '---\nname: existing\n---\n',
    );
    const plan = planScaffold({
      skillsDir,
      repoRoot: root,
      force: true,
      vars: {
        name: 'existing',
        description: 'x',
        triggers: ['foo'],
        writesTo: [],
        writesPages: false,
        mutating: false,
      },
    });
    const skillMd = plan.files.find(f => f.path.endsWith('SKILL.md'))!;
    expect(skillMd.kind).toBe('overwrite');
  });

  it('D-CX-7: resolverAppend is null when row already present (idempotent)', () => {
    const { root, skillsDir } = scratchRepo();
    // Prime the resolver with an existing row for the skill we're about
    // to scaffold. The plan must NOT queue a duplicate append, even
    // when --force regenerates files.
    const resolverPath = join(skillsDir, 'RESOLVER.md');
    const before = readFileSync(resolverPath, 'utf-8');
    writeFileSync(
      resolverPath,
      before +
        '\n## Uncategorized\n\n| Trigger | Skill |\n|---------|-------|\n' +
        '| "do thing" | `skills/demo/SKILL.md` |\n',
    );
    const plan = planScaffold({
      skillsDir,
      repoRoot: root,
      vars: {
        name: 'demo',
        description: 'demo',
        triggers: ['do thing'],
        writesTo: [],
        writesPages: false,
        mutating: false,
      },
    });
    expect(plan.resolverAppend).toBeNull();
  });

  it('handles --triggers omitted by seeding TBD placeholder', () => {
    const { root, skillsDir } = scratchRepo();
    const plan = planScaffold({
      skillsDir,
      repoRoot: root,
      vars: {
        name: 'empty-triggers',
        description: 'test',
        triggers: [],
        writesTo: [],
        writesPages: false,
        mutating: false,
      },
    });
    const skillMd = plan.files.find(f => f.path.endsWith('SKILL.md'))!;
    expect(skillMd.content).toContain('TBD-trigger');
  });

  it('writes_pages + writes_to flow through to frontmatter', () => {
    const { root, skillsDir } = scratchRepo();
    const plan = planScaffold({
      skillsDir,
      repoRoot: root,
      vars: {
        name: 'writer',
        description: 'writer',
        triggers: ['write me'],
        writesTo: ['people/', 'companies/'],
        writesPages: true,
        mutating: true,
      },
    });
    const skillMd = plan.files.find(f => f.path.endsWith('SKILL.md'))!;
    expect(skillMd.content).toContain('writes_pages: true');
    expect(skillMd.content).toContain('- people/');
    expect(skillMd.content).toContain('- companies/');
    expect(skillMd.content).toContain('mutating: true');
  });
});

describe('applyScaffold', () => {
  it('writes all planned files and appends the resolver row', () => {
    const { root, skillsDir } = scratchRepo();
    const plan = planScaffold({
      skillsDir,
      repoRoot: root,
      vars: {
        name: 'hello',
        description: 'hi',
        triggers: ['say hi'],
        writesTo: [],
        writesPages: false,
        mutating: false,
      },
    });
    applyScaffold(plan);
    for (const f of plan.files) {
      expect(existsSync(f.path)).toBe(true);
    }
    const resolver = readFileSync(join(skillsDir, 'RESOLVER.md'), 'utf-8');
    expect(resolver).toContain('`skills/hello/SKILL.md`');
  });

  it('second apply with same name + --force overwrites files but does NOT duplicate resolver row (D-CX-7)', () => {
    const { root, skillsDir } = scratchRepo();

    const firstPlan = planScaffold({
      skillsDir,
      repoRoot: root,
      vars: {
        name: 'idem',
        description: 'first',
        triggers: ['t'],
        writesTo: [],
        writesPages: false,
        mutating: false,
      },
    });
    applyScaffold(firstPlan);

    const secondPlan = planScaffold({
      skillsDir,
      repoRoot: root,
      force: true,
      vars: {
        name: 'idem',
        description: 'second',
        triggers: ['t'],
        writesTo: [],
        writesPages: false,
        mutating: false,
      },
    });
    expect(secondPlan.resolverAppend).toBeNull();
    applyScaffold(secondPlan);

    const resolver = readFileSync(join(skillsDir, 'RESOLVER.md'), 'utf-8');
    const count = (resolver.match(/`skills\/idem\/SKILL\.md`/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('applies against an AGENTS.md-layout workspace (W1 interop)', () => {
    const root = mkdtempSync(join(tmpdir(), 'skillify-openclaw-'));
    created.push(root);
    const skillsDir = join(root, 'workspace', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    // AGENTS.md at workspace root, NOT inside skills/.
    writeFileSync(
      join(root, 'workspace', 'AGENTS.md'),
      '# AGENTS\n\n## Ops\n\n| Trigger | Skill |\n|---------|-------|\n',
    );
    const plan = planScaffold({
      skillsDir,
      repoRoot: root,
      vars: {
        name: 'openclaw-demo',
        description: 'demo',
        triggers: ['do it'],
        writesTo: [],
        writesPages: false,
        mutating: false,
      },
    });
    expect(plan.resolverFile).toBe(join(root, 'workspace', 'AGENTS.md'));
    expect(plan.resolverAppend).not.toBeNull();
    applyScaffold(plan);
    const agents = readFileSync(join(root, 'workspace', 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('`skills/openclaw-demo/SKILL.md`');
  });
});
