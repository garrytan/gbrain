/**
 * #4831: `gbrain skillpack sync` registers exactly the skills it scaffolded in
 * an existing workspace skills/manifest.json (append-only, user entries and
 * order untouched), so check-resolvable no longer reports each one as an
 * orphan trigger. A workspace without a manifest keeps deriving from the walk.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { registerManifestEntries } from '../src/core/skill-manifest.ts';

const REPO = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function gbrain(args: string[], home: string) {
  return spawnSync(process.execPath, ['run', join(REPO, 'src/cli.ts'), ...args], { cwd: REPO, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, GBRAIN_HOME: home, HOME: home } });
}

describe('skillpack sync registers what it scaffolded (#4831)', () => {
  test('appends scaffolded skills to an existing manifest and leaves user entries first and unchanged', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'gbrain-4831-ws-')), home = mkdtempSync(join(tmpdir(), 'gbrain-4831-home-'));
    dirs.push(workspace, home);
    mkdirSync(join(workspace, 'skills', 'my-own'), { recursive: true });
    writeFileSync(join(workspace, 'skills', 'my-own', 'SKILL.md'), '---\nname: my-own\ndescription: A user skill\n---\nBody\n');
    writeFileSync(join(workspace, 'skills', 'manifest.json'), JSON.stringify({ skills: [{ name: 'my-own', path: 'my-own/SKILL.md' }], custom: 'kept' }, null, 2));

    const sync = gbrain(['skillpack', 'sync', '--workspace', workspace, '--json'], home);
    expect(sync.status, sync.stderr).toBe(0);
    const out = JSON.parse(sync.stdout) as { scaffolded: string[]; registered: string[] };
    expect(out.scaffolded.length).toBeGreaterThan(10);
    expect(out.registered.sort()).toEqual([...out.scaffolded].sort());

    const manifest = JSON.parse(readFileSync(join(workspace, 'skills', 'manifest.json'), 'utf8')) as { skills: Array<{ name: string; path: string }>; custom: string };
    expect(manifest.custom).toBe('kept');
    expect(manifest.skills[0]).toEqual({ name: 'my-own', path: 'my-own/SKILL.md' });
    for (const slug of out.scaffolded) {
      expect(manifest.skills.some(entry => entry.path === `${slug}/SKILL.md`)).toBe(true);
      expect(existsSync(join(workspace, 'skills', slug, 'SKILL.md'))).toBe(true);
    }

    const again = JSON.parse(gbrain(['skillpack', 'sync', '--workspace', workspace, '--json'], home).stdout) as { registered: string[] };
    expect(again.registered).toEqual([]);

    const check = gbrain(['check-resolvable', '--skills-dir', join(workspace, 'skills'), '--json'], home);
    const report = JSON.parse(check.stdout) as { report: { issues: Array<{ type: string; skill?: string }> } };
    expect(Array.isArray(report.report.issues)).toBe(true);
    expect(report.report.issues.filter(issue => issue.type === 'orphan_trigger')).toEqual([]);
  }, 300_000);
});

describe('registerManifestEntries refuses slugs that are not one path segment', () => {
  test('separators, .. and empty slugs throw before anything is read or written', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'gbrain-4831-slug-'));
    dirs.push(workspace);
    mkdirSync(join(workspace, 'skills'), { recursive: true });
    const manifest = JSON.stringify({ skills: [] }, null, 2);
    writeFileSync(join(workspace, 'skills', 'manifest.json'), manifest);
    for (const bad of ['../escape', 'a/b', 'a\\b', '..', '.', '']) {
      expect(() => registerManifestEntries(join(workspace, 'skills'), [bad])).toThrow('refusing to register skill slug');
    }
    expect(readFileSync(join(workspace, 'skills', 'manifest.json'), 'utf8')).toBe(manifest);
  });
});
