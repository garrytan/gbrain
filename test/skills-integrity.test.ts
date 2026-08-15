import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SKILLS_MANIFEST_FILENAME,
  computeSkillsManifest,
  renderSkillsManifest,
  verifySkillsManifest,
} from '../src/core/skills-integrity.ts';

describe('skills-integrity', () => {
  const created: string[] = [];
  afterEach(() => {
    while (created.length) {
      const p = created.pop()!;
      try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'skills-integrity-'));
    created.push(dir);
    writeFileSync(join(dir, 'RESOLVER.md'), '# RESOLVER\n');
    mkdirSync(join(dir, 'query'), { recursive: true });
    writeFileSync(join(dir, 'query', 'SKILL.md'), '# query skill\n');
    return dir;
  }

  it('clean tree verifies clean', () => {
    const dir = fixture();
    const manifest = computeSkillsManifest(dir);
    expect(Object.keys(manifest).sort()).toEqual(['RESOLVER.md', 'query/SKILL.md']);
    expect(verifySkillsManifest(dir, manifest)).toEqual({ modified: [], missing: [], extra: [] });
  });

  it('detects a modified file', () => {
    const dir = fixture();
    const manifest = computeSkillsManifest(dir);
    writeFileSync(join(dir, 'query', 'SKILL.md'), '# tampered\n');
    const drift = verifySkillsManifest(dir, manifest);
    expect(drift.modified).toEqual(['query/SKILL.md']);
    expect(drift.missing).toEqual([]);
    expect(drift.extra).toEqual([]);
  });

  it('detects a missing file', () => {
    const dir = fixture();
    const manifest = computeSkillsManifest(dir);
    rmSync(join(dir, 'query', 'SKILL.md'));
    const drift = verifySkillsManifest(dir, manifest);
    expect(drift.missing).toEqual(['query/SKILL.md']);
    expect(drift.modified).toEqual([]);
    expect(drift.extra).toEqual([]);
  });

  it('detects an extra file', () => {
    const dir = fixture();
    const manifest = computeSkillsManifest(dir);
    writeFileSync(join(dir, 'query', 'notes.md'), 'injected\n');
    const drift = verifySkillsManifest(dir, manifest);
    expect(drift.extra).toEqual(['query/notes.md']);
    expect(drift.modified).toEqual([]);
    expect(drift.missing).toEqual([]);
  });

  it('excludes the manifest file from its own hash set', () => {
    const dir = fixture();
    writeFileSync(join(dir, SKILLS_MANIFEST_FILENAME), '{}\n');
    const manifest = computeSkillsManifest(dir);
    expect(Object.keys(manifest)).not.toContain(SKILLS_MANIFEST_FILENAME);
    expect(verifySkillsManifest(dir, manifest)).toEqual({ modified: [], missing: [], extra: [] });
  });

  it('renders deterministic sorted JSON with a trailing newline', () => {
    const dir = fixture();
    const rendered = renderSkillsManifest(dir);
    expect(rendered.endsWith('}\n')).toBe(true);
    expect(rendered).toBe(renderSkillsManifest(dir));
    expect(Object.keys(JSON.parse(rendered))).toEqual(['RESOLVER.md', 'query/SKILL.md']);
  });
});
