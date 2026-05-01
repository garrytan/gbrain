/**
 * Tests for `gbrain routing-eval` CLI surface — specifically --llm
 * placeholder behavior.
 *
 * v0.19 ships the structural layer only. The --llm flag is accepted
 * as a placeholder for a future LLM tie-break layer. This test file
 * locks in the contract:
 *
 *   1. Passing --llm emits a stderr notice ("placeholder" / "structural
 *      layer only"). Regardless of --json.
 *   2. Passing --llm does NOT alter exit code (0 on clean, 1 on issues,
 *      same as without --llm).
 *   3. Passing --llm --json emits valid structural JSON on stdout with
 *      the warning on stderr only (no stderr-to-stdout bleed).
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const REPO_ROOT = resolve(import.meta.dir, '..');

function makeFixture(created: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'routing-eval-cli-'));
  created.push(root);
  const skillsDir = join(root, 'skills');
  mkdirSync(skillsDir, { recursive: true });

  // Minimal resolver: one skill with a trigger phrase.
  const resolver = [
    '# Resolver',
    '',
    '| Trigger | Skill |',
    '|---------|-------|',
    '| "build the foo" | `skills/foo-builder/SKILL.md` |',
    '',
  ].join('\n');
  writeFileSync(join(skillsDir, 'RESOLVER.md'), resolver);

  // One skill + one routing fixture that maps to it.
  const skillDir = join(skillsDir, 'foo-builder');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: foo-builder\n---\n\nBuilds foos.\n',
  );
  writeFileSync(
    join(skillDir, 'routing-eval.jsonl'),
    JSON.stringify({ intent: 'build the foo now please', expected_skill: 'foo-builder' }) + '\n',
  );

  // Manifest referencing the skill.
  writeFileSync(
    join(skillsDir, 'manifest.json'),
    JSON.stringify({ skills: [{ name: 'foo-builder', path: 'foo-builder/SKILL.md' }] }, null, 2),
  );

  return skillsDir;
}

const WARNING_NEEDLE = 'placeholder';

describe('gbrain routing-eval CLI — --llm placeholder behavior', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const d of created) try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    created.length = 0;
  });

  it('--llm emits a stderr notice and exits 0 on clean fixtures', () => {
    const skillsDir = makeFixture(created);
    const proc = spawnSync('bun', [CLI, 'routing-eval', '--skills-dir', skillsDir, '--llm'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(proc.status).toBe(0);
    expect(proc.stderr).toContain(WARNING_NEEDLE);
    // Human-mode stdout still shows the structural results header.
    expect(proc.stdout).toContain('routing-eval');
  });

  it('--llm --json emits warning on stderr AND valid structural JSON on stdout (no bleed)', () => {
    const skillsDir = makeFixture(created);
    const proc = spawnSync('bun', [CLI, 'routing-eval', '--skills-dir', skillsDir, '--llm', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(proc.status).toBe(0);
    expect(proc.stderr).toContain(WARNING_NEEDLE);
    // stdout must be clean JSON — no warning text bleed.
    expect(proc.stdout).not.toContain(WARNING_NEEDLE);
    const envelope = JSON.parse(proc.stdout); // throws if bleed corrupted it
    expect(envelope.ok).toBe(true);
    expect(envelope.skillsDir).toBe(skillsDir);
    expect(envelope.report).not.toBeNull();
  });

  it('WITHOUT --llm, no placeholder warning on stderr (regression guard)', () => {
    const skillsDir = makeFixture(created);
    const proc = spawnSync('bun', [CLI, 'routing-eval', '--skills-dir', skillsDir], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(proc.status).toBe(0);
    expect(proc.stderr).not.toContain(WARNING_NEEDLE);
  });

  it('--llm does NOT alter exit code when fixtures have issues (still 1, not 2)', () => {
    const created2: string[] = [];
    const root = mkdtempSync(join(tmpdir(), 'routing-eval-cli-fail-'));
    created2.push(root);
    created.push(root);
    const skillsDir = join(root, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    // Resolver with no row pointing at the expected skill → miss.
    writeFileSync(join(skillsDir, 'RESOLVER.md'), '# Resolver\n\n| Trigger | Skill |\n|---|---|\n');
    const skillDir = join(skillsDir, 'bar-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: bar-skill\n---\n');
    writeFileSync(
      join(skillDir, 'routing-eval.jsonl'),
      JSON.stringify({ intent: 'do bar now', expected_skill: 'bar-skill' }) + '\n',
    );
    writeFileSync(
      join(skillsDir, 'manifest.json'),
      JSON.stringify({ skills: [{ name: 'bar-skill', path: 'bar-skill/SKILL.md' }] }, null, 2),
    );
    const proc = spawnSync('bun', [CLI, 'routing-eval', '--skills-dir', skillsDir, '--llm'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain(WARNING_NEEDLE);
  });
});
