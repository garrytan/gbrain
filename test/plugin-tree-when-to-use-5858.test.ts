/**
 * #5858: Claude Code lists a skill by name, description and `when_to_use`
 * only, so the plugin lanes carry `when_to_use` built from each skill's
 * `triggers:` (within the 1,536-character listing cap). Source skills under
 * skills/ stay unchanged; the committed plugin trees are generated.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FAILSAFE_SCHEMA, load } from 'js-yaml';

const ROOT = resolve(import.meta.dir, '..');
function frontmatter(path: string): Record<string, unknown> | null {
  const match = readFileSync(path, 'utf8').match(/^---\n([\s\S]*?)\n---/);
  return match ? load(match[1], { schema: FAILSAFE_SCHEMA }) as Record<string, unknown> : null;
}
function skillFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => join(dir, entry.name, 'SKILL.md')).filter(path => existsSync(path));
}

describe('plugin lanes carry when_to_use (#5858)', () => {
  const lanes = [join(ROOT, 'plugin', 'skills'), ...readdirSync(join(ROOT, 'plugin-variants')).map(variant => join(ROOT, 'plugin-variants', variant, 'skills'))]
    .filter(dir => existsSync(dir));
  for (const lane of lanes) {
    test(`${lane.slice(ROOT.length + 1)}: every skill with triggers has a bounded when_to_use`, () => {
      const withTriggers = skillFiles(lane).map(path => ({ path, fm: frontmatter(path) }))
        .filter(({ fm }) => Array.isArray(fm?.triggers) && (fm!.triggers as unknown[]).length > 0);
      expect(withTriggers.length).toBeGreaterThan(0);
      for (const { path, fm } of withTriggers) {
        expect(typeof fm!.when_to_use, path).toBe('string');
        expect(String(fm!.when_to_use)).toContain(String((fm!.triggers as string[])[0]).trim());
        expect(String(fm!.description ?? '').length + String(fm!.when_to_use).length, path).toBeLessThanOrEqual(1536);
      }
    });
  }

  test('source skills stay free of generated when_to_use', () => {
    for (const path of skillFiles(join(ROOT, 'skills'))) expect(frontmatter(path)?.when_to_use, path).toBeUndefined();
  });
});
