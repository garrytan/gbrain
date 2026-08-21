import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { autoDetectSkillsDirReadOnly } from '../src/core/repo-root.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const REPO_ROOT = resolve(import.meta.dir, '..');

const created: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function writeResolverSkillsDir(skillsDir: string): void {
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, 'RESOLVER.md'), '# Resolver\n');
}

function writeTriggerOnlySkillsDir(skillsDir: string): void {
  mkdirSync(join(skillsDir, 'query'), { recursive: true });
  writeFileSync(
    join(skillsDir, 'query', 'SKILL.md'),
    [
      '---',
      'name: query',
      'triggers:',
      '  - "what do we know"',
      '---',
      '',
      '# Query',
      '',
      'A trigger-only skill.',
      '',
    ].join('\n'),
  );
}

afterEach(() => {
  while (created.length) {
    const dir = created.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('read-only GBRAIN_SKILLS_DIR detection', () => {
  test('honors an explicit trigger-only catalog over cwd fallback', () => {
    const explicit = scratch('explicit-skills-');
    writeTriggerOnlySkillsDir(explicit);
    const host = scratch('host-with-skills-');
    writeResolverSkillsDir(join(host, 'skills'));

    const found = autoDetectSkillsDirReadOnly(host, { GBRAIN_SKILLS_DIR: explicit });

    expect(found.dir).toBe(explicit);
    expect(found.source).toBe('env_explicit');
  });

  test('fails closed on an invalid explicit catalog instead of checking cwd fallback', () => {
    const invalid = scratch('invalid-skills-');
    const host = scratch('host-with-skills-');
    writeResolverSkillsDir(join(host, 'skills'));

    const found = autoDetectSkillsDirReadOnly(host, { GBRAIN_SKILLS_DIR: invalid });

    expect(found.dir).toBeNull();
    expect(found.source).toBe('env_explicit');
  });

  test('check-resolvable --json reports the trigger-only explicit catalog', () => {
    const explicit = scratch('cli-trigger-only-skills-');
    writeTriggerOnlySkillsDir(explicit);

    const res = spawnSync('bun', [CLI, 'check-resolvable', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, GBRAIN_SKILLS_DIR: explicit },
      maxBuffer: 10 * 1024 * 1024,
    });

    const json = JSON.parse(res.stdout);
    expect(res.status).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.skillsDir).toBe(explicit);
  });

  test('check-resolvable --json fails invalid explicit catalog without repo fallback', () => {
    const invalid = scratch('cli-invalid-skills-');

    const res = spawnSync('bun', [CLI, 'check-resolvable', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, GBRAIN_SKILLS_DIR: invalid },
      maxBuffer: 10 * 1024 * 1024,
    });

    const json = JSON.parse(res.stdout);
    expect(res.status).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.error).toBe('no_skills_dir');
    expect(json.skillsDir).toBeNull();
  });
});
