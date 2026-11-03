/**
 * GBRA-194: the spring-loaded skill index (the always-loaded half of the
 * resolver) for the real bundled skills.
 *
 * Protects: the per-turn cost of `--skill-loading spring` and the index's
 * promise that every line can be loaded. Every bundled skill keeps a line;
 * trigger phrases are what the line carries; the block names
 * `<launcher> bundled-skill`; the budget is a postcondition, never exceeded;
 * the generated module is fresh and each skill carries every shared file its
 * text (and those files) names.
 * Fails when: a new or longer skill pushes the block past
 * SKILL_INDEX_BUDGET_BYTES, a skill drops out of the index, the renderer
 * returns an over-budget block, or a skill names a shared file
 * `gbrain bundled-skill --asset` would refuse.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { BUNDLED_SKILL_FILES } from '../src/core/skills/bundled-skills.generated.ts';
import { bundledCatalogId, bundledSkills, bundledSkillTriggers } from '../src/core/skills/bundled.ts';
import { renderSkillIndexBlock, SKILL_INDEX_BUDGET_BYTES, SkillIndexTooLarge, skillIndexCatalog } from '../src/core/skills/spring-index.ts';
import { renderBundledSkillsModule } from '../scripts/generate-bundled-skills.ts';
import { loaderAllowRule, renderSkillsBlock, SKILLS_BLOCK_BEGIN, SKILLS_BLOCK_END } from '../src/core/setup/skills-block.ts';
import { checkResolvable } from '../src/core/check-resolvable.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const OPTS = { refresh: 'gbrain setup claude-code --instructions-only', optOut: 'gbrain setup claude-code --instructions-only --skill-loading off' };
const LAUNCHER = '/home/alice-example/.bun/bin/gbrain';
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const entries = (block: string) => block.split('\n').filter(l => l.startsWith('- '));
const SKILLS_DIR = join(import.meta.dir, '..', 'skills');

describe('spring-loaded skill index', () => {
  test('a workspace AGENTS.md carrying the index is not read as resolver rows for workspace skills', () => {
    const ws = mkdtempSync(join(tmpdir(), 'spring-resolver-'));
    try {
      mkdirSync(join(ws, 'skills'));
      writeFileSync(join(ws, 'AGENTS.md'), `# Agent\n\n${SKILLS_BLOCK_BEGIN}\n${renderSkillsBlock('openclaw', LAUNCHER)}\n${SKILLS_BLOCK_END}\n`);
      const report = checkResolvable(join(ws, 'skills'));
      expect(report.issues.filter(i => i.type === 'missing_file' || i.type === 'orphan_trigger')).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('a launcher path with spaces, an apostrophe or shell characters prints as one shell word the index and the loader rule share', () => {
    for (const launcher of ["/home/alice-example/o'brien dir/gbrain", '/opt/a b/$(x)/gbrain', '/opt/semi;colon/gbrain']) {
      const block = renderSkillIndexBlock(bundledSkills('owner'), launcher, OPTS);
      const word = /`(.+) bundled-skill <name>`/.exec(block)![1];
      const echoed = spawnSync('sh', ['-c', `printf %s ${word}`], { encoding: 'utf8' });
      expect(echoed.status).toBe(0);
      expect(echoed.stdout).toBe(launcher);
      expect(loaderAllowRule(launcher)).toBe(`Bash(${word} bundled-skill:*)`);
    }
  });

  for (const audience of ['owner', 'downstream'] as const) {
    test(`${audience}: under budget, every skill on its own line, loads through bundled-skill`, () => {
      const skills = bundledSkills(audience);
      const block = renderSkillIndexBlock(skills, LAUNCHER, OPTS);
      expect(bytes(block)).toBeLessThanOrEqual(SKILL_INDEX_BUDGET_BYTES);
      expect(entries(block).map(l => l.slice(2).split(':')[0])).toEqual(skills.map(s => s.name));
      expect(block).toContain(`\`${LAUNCHER} bundled-skill <name>\``);
      expect(block).toContain(`\`${LAUNCHER} bundled-skill <name> --asset <path>\``);
      expect(skillIndexCatalog(block)).toBe(bundledCatalogId());
    });
  }

  test('every bundled skill has trigger phrases for its line', () => {
    expect(bundledSkills('owner').filter(s => bundledSkillTriggers(s).length === 0).map(s => s.name)).toEqual([]);
  });

  test('the budget is a postcondition: tighter budgets trim the longest lines first and never drop a skill', () => {
    const skills = bundledSkills('owner');
    const full = renderSkillIndexBlock(skills, LAUNCHER, { ...OPTS, budget: Number.MAX_SAFE_INTEGER });
    for (const budget of [bytes(full) - 1, bytes(full) - 400, 4600]) {
      const block = renderSkillIndexBlock(skills, LAUNCHER, { ...OPTS, budget });
      expect(bytes(block)).toBeLessThanOrEqual(budget);
      expect(entries(block)).toHaveLength(skills.length);
    }
    const trimmedOnce = entries(renderSkillIndexBlock(skills, LAUNCHER, { ...OPTS, budget: bytes(full) - 1 }));
    expect(trimmedOnce.filter((l, i) => l !== entries(full)[i])).toHaveLength(1);
  });

  test('an impossible budget or an overlong launcher refuses instead of returning an oversized block', () => {
    const skills = bundledSkills('owner');
    expect(() => renderSkillIndexBlock(skills, LAUNCHER, { ...OPTS, budget: 1024 })).toThrow(SkillIndexTooLarge);
    expect(() => renderSkillIndexBlock(skills, `/${'x'.repeat(5000)}/gbrain`, OPTS)).toThrow(SkillIndexTooLarge);
  });

  test('deterministic and free of quotes that would break the markdown', () => {
    const a = renderSkillIndexBlock(bundledSkills('owner'), LAUNCHER, OPTS);
    expect(renderSkillIndexBlock(bundledSkills('owner'), LAUNCHER, OPTS)).toBe(a);
    expect(entries(a).some(l => /["`]/.test(l))).toBe(false);
  });

  test('the embedded bundled-skills module is fresh and imports no .json as text (a compiled binary hands it back parsed)', () => {
    const mod = readFileSync(join(import.meta.dir, '../src/core/skills/bundled-skills.generated.ts'), 'utf8');
    expect(mod).toBe(renderBundledSkillsModule());
    expect(mod).not.toMatch(/\.json' with \{ type: 'text' \}/);
    for (const [path, text] of Object.entries(BUNDLED_SKILL_FILES)) expect(typeof text, path).toBe('string');
  });

  test('each skill carries every file under skills/ that its files link to, transitively (a linked bundled skill loads by name)', () => {
    const bundledNames = new Set(bundledSkills('owner').map(s => s.name));
    const missing: string[] = [];
    for (const skill of bundledSkills('owner')) {
      const have = new Set([`${skill.name}/SKILL.md`, ...skill.assets]);
      for (const file of have) {
        const text = BUNDLED_SKILL_FILES[file] ?? '';
        for (const m of text.matchAll(/\]\((\.{1,2}\/[^)\s#]+)\)/g)) {
          const target = normalize(join(dirname(file), m[1]));
          if (target.startsWith('..') || !existsSync(join(SKILLS_DIR, target)) || !/\.(md|json)$/.test(target)) continue;
          if (target.endsWith('/SKILL.md') && bundledNames.has(dirname(target))) continue;
          if (!have.has(target)) missing.push(`${file} -> ${target}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('the filing rules JSON reaches every skill that loads the filing rules', () => {
    for (const skill of bundledSkills('owner').filter(s => s.assets.includes('_brain-filing-rules.md'))) {
      expect(skill.assets).toContain('_brain-filing-rules.json');
    }
  });
});
