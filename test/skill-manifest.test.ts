/**
 * Tests for src/core/skill-manifest.ts — unified manifest loader.
 *
 * Covers the derive-from-walk path (F-ENG-1 / D-CX-1..4). When
 * manifest.json is absent, walking skillsDir MUST produce a sensible
 * synthetic manifest so reachability checks don't silently pass on
 * OpenClaw deployments that don't ship manifest.json.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { loadOrDeriveManifest } from '../src/core/skill-manifest.ts';

const created: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skill-manifest-'));
  created.push(dir);
  return dir;
}

function writeSkill(skillsDir: string, name: string, frontmatterName?: string): void {
  const skillDir = join(skillsDir, name);
  mkdirSync(skillDir, { recursive: true });
  const fm = frontmatterName !== undefined
    ? `---\nname: ${frontmatterName}\ndescription: test\n---\n`
    : ''; // no frontmatter
  writeFileSync(join(skillDir, 'SKILL.md'), `${fm}\n# ${name}\n`);
}

function writeManifest(skillsDir: string, json: unknown): void {
  writeFileSync(join(skillsDir, 'manifest.json'), JSON.stringify(json, null, 2));
}

describe('loadOrDeriveManifest', () => {
  afterEach(() => {
    while (created.length) {
      const d = created.pop();
      if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  });

  it('uses manifest.json verbatim when present and valid', () => {
    const dir = scratch();
    writeSkill(dir, 'query');
    writeSkill(dir, 'ingest');
    writeManifest(dir, {
      skills: [
        { name: 'query', path: 'query/SKILL.md' },
        { name: 'ingest', path: 'ingest/SKILL.md' },
      ],
    });
    const r = loadOrDeriveManifest(dir);
    expect(r.derived).toBe(false);
    expect(r.skills.length).toBe(2);
    expect(r.skills.map(s => s.name).sort()).toEqual(['ingest', 'query']);
  });

  it('derives from SKILL.md walk when manifest.json is missing (F-ENG-1)', () => {
    const dir = scratch();
    writeSkill(dir, 'query', 'query');
    writeSkill(dir, 'ingest', 'ingest');
    // No manifest.json — this is the OpenClaw-deployment scenario.
    const r = loadOrDeriveManifest(dir);
    expect(r.derived).toBe(true);
    expect(r.skills.length).toBe(2);
    expect(r.skills.map(s => s.name).sort()).toEqual(['ingest', 'query']);
    expect(r.skills.every(s => s.path.endsWith('/SKILL.md'))).toBe(true);
  });

  it('falls back to dirname when SKILL.md has no name: frontmatter', () => {
    const dir = scratch();
    writeSkill(dir, 'prose-only-skill'); // no frontmatter
    const r = loadOrDeriveManifest(dir);
    expect(r.derived).toBe(true);
    expect(r.skills.length).toBe(1);
    expect(r.skills[0].name).toBe('prose-only-skill');
  });

  it('uses frontmatter name when it differs from dirname', () => {
    const dir = scratch();
    writeSkill(dir, 'weird-dir-name', 'canonical-skill-name');
    const r = loadOrDeriveManifest(dir);
    expect(r.derived).toBe(true);
    expect(r.skills[0].name).toBe('canonical-skill-name');
    expect(r.skills[0].path).toBe('weird-dir-name/SKILL.md');
  });

  it('skips underscore-prefixed dirs (conventions, rule files)', () => {
    const dir = scratch();
    writeSkill(dir, 'query');
    writeSkill(dir, '_conventions');
    writeSkill(dir, '_brain-rules');
    const r = loadOrDeriveManifest(dir);
    expect(r.skills.map(s => s.name)).toEqual(['query']);
  });

  it('skips dot-prefixed dirs', () => {
    const dir = scratch();
    writeSkill(dir, 'query');
    writeSkill(dir, '.git');
    const r = loadOrDeriveManifest(dir);
    expect(r.skills.map(s => s.name)).toEqual(['query']);
  });

  it('derives when manifest.json is malformed (invalid JSON)', () => {
    const dir = scratch();
    writeSkill(dir, 'query', 'query');
    writeFileSync(join(dir, 'manifest.json'), '{ not valid json');
    const r = loadOrDeriveManifest(dir);
    expect(r.derived).toBe(true);
    expect(r.skills.map(s => s.name)).toEqual(['query']);
  });

  it('derives when manifest.json has a wrong shape (skills as object)', () => {
    const dir = scratch();
    writeSkill(dir, 'query', 'query');
    writeManifest(dir, { skills: { bad: 'shape' } });
    const r = loadOrDeriveManifest(dir);
    expect(r.derived).toBe(true);
    expect(r.skills.map(s => s.name)).toEqual(['query']);
  });

  it('honors explicit empty skills array as a valid declaration', () => {
    // An empty array is "no skills" declared intentionally, not
    // malformed. Distinct from missing manifest.json (→ derive).
    const dir = scratch();
    writeSkill(dir, 'query', 'query'); // present on disk...
    writeManifest(dir, { skills: [] }); // ...but manifest says zero.
    const r = loadOrDeriveManifest(dir);
    expect(r.derived).toBe(false);
    expect(r.skills.length).toBe(0);
  });

  it('derives when manifest.json entry lacks required keys', () => {
    const dir = scratch();
    writeSkill(dir, 'query', 'query');
    // First entry missing 'path' → invalid shape → fall through to derive.
    writeManifest(dir, { skills: [{ name: 'query' }] });
    const r = loadOrDeriveManifest(dir);
    expect(r.derived).toBe(true);
  });

  it('handles empty skillsDir cleanly', () => {
    const dir = scratch();
    const r = loadOrDeriveManifest(dir);
    expect(r.derived).toBe(true);
    expect(r.skills.length).toBe(0);
  });

  it('handles non-existent skillsDir cleanly', () => {
    const r = loadOrDeriveManifest('/tmp/does-not-exist-skill-manifest-test');
    expect(r.derived).toBe(true);
    expect(r.skills.length).toBe(0);
  });

  it('sorts derived skills alphabetically by name', () => {
    const dir = scratch();
    writeSkill(dir, 'zebra', 'zebra');
    writeSkill(dir, 'apple', 'apple');
    writeSkill(dir, 'mango', 'mango');
    const r = loadOrDeriveManifest(dir);
    expect(r.skills.map(s => s.name)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('treats dirs without SKILL.md as not-a-skill', () => {
    const dir = scratch();
    writeSkill(dir, 'query', 'query');
    mkdirSync(join(dir, 'no-skill-here'), { recursive: true });
    writeFileSync(join(dir, 'no-skill-here', 'README.md'), '# not a skill');
    const r = loadOrDeriveManifest(dir);
    expect(r.skills.map(s => s.name)).toEqual(['query']);
  });
});
