/**
 * GBRA-377 PR A: the skill resolver stays engine-free.
 *
 * 1. Protects: the turn path (src/core/skills/resolver/index.ts) loads only
 *    its own leaf modules, the CJK ranges, the version and js-yaml, both
 *    statically and after a bundled build and a turn (dynamic imports); the
 *    CLI module loads no engine, database driver, operations table or AI
 *    gateway. So a resolve works on a thin client, a brainless install and
 *    while `gbrain serve` holds the PGLite lock.
 * 2. Fails when: a resolver module imports skill-catalog.ts, operations.ts,
 *    an engine or a provider, statically or dynamically.
 * 3. Seam: none. A child process loads each entry into a fresh registry
 *    (pattern: test/cold-read-module-graph.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');

function loadedBy(script: string): string[] {
  const r = Bun.spawnSync([process.execPath, '-e', `${script}; console.log(JSON.stringify(Object.keys(require.cache)));`], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return (JSON.parse(r.stdout.toString().trim().split('\n').pop()!) as string[]).map(f => f.slice(REPO_ROOT.length + 1)).sort();
}

const LEAF = new Set(['src/core/cjk.ts', 'src/core/fs-durable.ts', 'src/version.ts', 'package.json', 'src/core/skill-description.ts', 'src/core/data-frontmatter.ts', 'src/core/effective-date.ts', 'node_modules/js-yaml/dist/js-yaml.mjs']);
const BUNDLED = new Set(['src/core/skills/bundled.ts', 'src/core/skills/bundled-skills.generated.ts', 'src/core/skill-frontmatter.ts']);
const FORBIDDEN = /^(src\/core\/(operations\.ts|engine\.ts|engine-(factory|open|connect|construct)\.ts|pglite-engine|postgres-engine\.ts|skill-catalog\.ts|ai\/)|node_modules\/(@electric-sql|postgres|openai|@anthropic-ai))/;

describe('the skill resolver module graph', () => {
  test('static: the library loads only its leaf modules', () => {
    const loaded = loadedBy(`await import(${JSON.stringify(join(REPO_ROOT, 'src/core/skills/resolver/index.ts'))})`);
    expect(loaded).toContain('src/core/skills/resolver/resolve.ts');
    expect(loaded.filter(f => !f.startsWith('src/core/skills/resolver/') && !LEAF.has(f))).toEqual([]);
  }, 60_000);

  test('dynamic: a bundled build and a turn add only the bundled-skill reader and its assets', () => {
    const home = mkdtempSync(join(tmpdir(), 'skres-graph-'));
    try {
      const loaded = loadedBy(`const m = await import(${JSON.stringify(join(REPO_ROOT, 'src/core/skills/resolver/index.ts'))}); await m.buildSkillIndex({ catalog: 'gb', bundled: true }, { home: ${JSON.stringify(home)} }); await m.resolveSkills({ message: 'daily briefing' }, { home: ${JSON.stringify(home)} })`);
      expect(loaded).toContain('src/core/skills/bundled.ts');
      expect(loaded.filter(f => !f.startsWith('src/core/skills/resolver/') && !f.startsWith('skills/') && !LEAF.has(f) && !BUNDLED.has(f))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('the CLI module loads no engine, driver, operations table or provider', () => {
    const loaded = loadedBy(`await import(${JSON.stringify(join(REPO_ROOT, 'src/commands/skill-resolver.ts'))})`);
    expect(loaded).toContain('src/commands/skill-resolver.ts');
    expect(loaded.filter(f => FORBIDDEN.test(f))).toEqual([]);
  }, 60_000);
});
