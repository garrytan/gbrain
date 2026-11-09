import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSkillFrontmatter } from '../src/core/skill-frontmatter.ts';

const root = resolve(import.meta.dir, '..');
const work = mkdtempSync(join(tmpdir(), 'gbrain-mcp-export-'));
const generate = (...args: string[]) => spawnSync(process.execPath,
  ['run', 'scripts/generate-plugin-tree.ts', ...args], { cwd: root, encoding: 'utf8' });
const read = (dir: string, path: string) => readFileSync(join(work, dir, path), 'utf8');
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile()).map(e => join(e.parentPath, e.name).slice(dir.length + 1)).sort();
}
beforeAll(() => {
  for (const [dir, extra] of [
    ['default', []], ['local', ['--execution-route', 'local-cli']],
    ['remote', ['--execution-route', 'configured-mcp']],
  ] as const) {
    const result = generate('--out', join(work, dir), ...extra);
    expect(result.stderr).not.toContain('Error');
    expect(result.status).toBe(0);
  }
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('configured MCP workflow export', () => {
  test('explicit local route preserves default bytes and the remote route preserves the asset closure', () => {
    const paths = files(join(work, 'default'));
    expect(files(join(work, 'local'))).toEqual(paths);
    expect(files(join(work, 'remote'))).toEqual(paths);
    for (const path of paths) {
      expect(read('local', path)).toBe(read('default', path));
      if (!path.endsWith('/SKILL.md') && path !== 'README.md') {
        expect(read('remote', path)).toBe(read('default', path));
      }
    }
    expect(paths.every(path => path === 'README.md' || path.startsWith('skills/'))).toBe(true);
  });

  test('each remote workflow has the shared route before its original body without changing frontmatter', () => {
    const skills = files(join(work, 'remote')).filter(path => path.endsWith('/SKILL.md'));
    expect(skills.length).toBeGreaterThan(0);
    for (const path of skills) {
      const local = read('default', path);
      const remote = read('remote', path);
      expect(parseSkillFrontmatter(remote)?.raw).toBe(parseSkillFrontmatter(local)?.raw);
      expect(remote).toContain('../conventions/brain-routing.md#configured-mcp-execution-route');
      expect(remote.indexOf('## Execution route: configured MCP')).toBeLessThan(remote.indexOf(local.slice(local.indexOf('\n---', 4) + 4).trim()));
    }
    expect(read('remote', 'skills/conventions/brain-routing.md')).toContain('## Configured MCP execution route');
    const readme = read('remote', 'README.md');
    expect(readme).toContain('--execution-route configured-mcp');
    expect(readme).toContain('already authenticated');
    expect(readme).not.toContain('gbrain init');
    expect(readme).not.toContain('gbrain serve');
    expect(readme).toContain('not a tool-execution security boundary');
  });

  test('invalid route and incompatible persona export refuse before altering existing outputs', () => {
    for (const extra of [
      ['--execution-route', 'unknown'], ['--execution-route'],
      ['--execution-route', 'configured-mcp', '--variants-out', join(work, 'variants')],
    ]) {
      const sentinel = join(work, 'sentinel.txt');
      writeFileSync(sentinel, 'keep existing output');
      const result = generate('--out', work, ...extra);
      expect(result.status).toBe(2);
      expect(readFileSync(sentinel, 'utf8')).toBe('keep existing output');
    }
  });
  test("remote gaps have no CLI fallback and malformed source skills fail", () => {
    const fixture = join(work, "fixture");
    mkdirSync(join(fixture, "skills/alpha"), { recursive: true });
    mkdirSync(join(fixture, "skills/conventions"));
    for (const [path, value] of Object.entries({
      "openclaw.plugin.json": { name: "fixture", version: "0.0.0.0", skills: ["skills/alpha"], shared_deps: [] },
      "skills/manifest.json": { skills: [{ name: "alpha" }] },
      "skills/plugin-lanes.json": { additions: {}, base_exclusions: {}, not_added: {}, starter_gaps: { alpha: ["fixture_missing_op"] } },
    })) writeFileSync(join(fixture, path), JSON.stringify(value));
    writeFileSync(join(fixture, "VERSION"), "0.0.0.0");
    const skill = join(fixture, "skills/alpha/SKILL.md");
    writeFileSync(skill, "---\nname: alpha\ntools: [fixture_missing_op]\n---\n# Fixture\n");
    const run = () => spawnSync(process.execPath, ["run", "scripts/generate-plugin-tree.ts", "--out", join(work, "fixture-out"), "--execution-route", "configured-mcp"], { cwd: root, encoding: "utf8", env: { ...process.env, GBRAIN_PLUGIN_TREE_ROOT: fixture } });
    const fixtureResult = run();
    if (fixtureResult.status !== 0) throw new Error(fixtureResult.stderr);
    expect(fixtureResult.status).toBe(0);
    const output = read("fixture-out", "skills/alpha/SKILL.md");
    expect(output).toContain("fixture_missing_op");
    expect(output).toContain("A missing operation stops that step");
    expect(output).not.toContain("CLI equivalent");
    expect(output).not.toContain("GBRAIN_SURFACE");
    expect(output).not.toContain("request_tools");
    expect(output).not.toContain("gbrain call");
    writeFileSync(skill, "# Missing frontmatter\n");
    writeFileSync(join(fixture, "skills/plugin-lanes.json"), JSON.stringify({ additions: {}, base_exclusions: {}, not_added: {}, starter_gaps: {} }));
    const invalid = run();
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("configured-mcp requires skill frontmatter");
  });

});
