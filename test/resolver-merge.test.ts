/**
 * Verify: check-resolvable merges entries from all resolver files.
 *
 * The common OpenClaw layout has:
 *   workspace/AGENTS.md       — the real dispatcher (200+ entries)
 *   workspace/skills/RESOLVER.md — thin skillpack-installed subset (~40 entries)
 *
 * Before this fix, RESOLVER.md won by first-match policy, so 160+ skills
 * showed as "unreachable" even though AGENTS.md had routing for them.
 *
 * After: entries from both files are merged (deduped by skillPath).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkResolvable, parseResolverEntries } from '../src/core/check-resolvable.ts';
import { findAllResolverFiles } from '../src/core/resolver-filenames.ts';

// ---------------------------------------------------------------------------
// findAllResolverFiles
// ---------------------------------------------------------------------------

describe('findAllResolverFiles', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'resolver-merge-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty when no resolver files exist', () => {
    expect(findAllResolverFiles(dir)).toEqual([]);
  });

  it('returns RESOLVER.md when only it exists', () => {
    writeFileSync(join(dir, 'RESOLVER.md'), '# test');
    const files = findAllResolverFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toEndWith('RESOLVER.md');
    rmSync(join(dir, 'RESOLVER.md'));
  });

  it('returns AGENTS.md when only it exists', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# test');
    const files = findAllResolverFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toEndWith('AGENTS.md');
    rmSync(join(dir, 'AGENTS.md'));
  });

  it('returns both when both exist (RESOLVER.md first)', () => {
    writeFileSync(join(dir, 'RESOLVER.md'), '# resolver');
    writeFileSync(join(dir, 'AGENTS.md'), '# agents');
    const files = findAllResolverFiles(dir);
    expect(files).toHaveLength(2);
    expect(files[0]).toEndWith('RESOLVER.md');
    expect(files[1]).toEndWith('AGENTS.md');
    rmSync(join(dir, 'RESOLVER.md'));
    rmSync(join(dir, 'AGENTS.md'));
  });
});

// ---------------------------------------------------------------------------
// Merge behavior in checkResolvable
// ---------------------------------------------------------------------------

describe('checkResolvable merges resolver files', () => {
  let workspace: string;
  let skillsDir: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'resolver-merge-e2e-'));
    skillsDir = join(workspace, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    // Create 3 skills on disk
    for (const name of ['alpha', 'beta', 'gamma']) {
      const skillDir = join(skillsDir, name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ntriggers:\n  - "${name} trigger"\n---\n# ${name}\n`);
    }
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('with only skills/RESOLVER.md covering 1 of 3 → 2 unreachable', () => {
    writeFileSync(join(skillsDir, 'RESOLVER.md'), `# Resolver\n\n| Trigger | Skill |\n|---|---|\n| do alpha | \`skills/alpha/SKILL.md\` |\n`);
    const report = checkResolvable(skillsDir);
    expect(report.summary.reachable).toBe(1);
    expect(report.summary.unreachable).toBe(2);
    rmSync(join(skillsDir, 'RESOLVER.md'));
  });

  it('with skills/RESOLVER.md (1 skill) + ../AGENTS.md (2 more) → all 3 reachable', () => {
    // Thin RESOLVER.md in skills dir (e.g. from skillpack)
    writeFileSync(join(skillsDir, 'RESOLVER.md'),
      `# Resolver\n\n| Trigger | Skill |\n|---|---|\n| do alpha | \`skills/alpha/SKILL.md\` |\n`);

    // Rich AGENTS.md at workspace root (OpenClaw convention)
    writeFileSync(join(workspace, 'AGENTS.md'),
      `# AGENTS.md\n\n## Skills\n\n| Trigger | Skill |\n|---|---|\n| do beta | \`skills/beta/SKILL.md\` |\n| do gamma | \`skills/gamma/SKILL.md\` |\n`);

    const report = checkResolvable(skillsDir);
    expect(report.summary.reachable).toBe(3);
    expect(report.summary.unreachable).toBe(0);
    expect(report.ok).toBe(true);

    rmSync(join(skillsDir, 'RESOLVER.md'));
    rmSync(join(workspace, 'AGENTS.md'));
  });

  it('deduplicates overlapping entries (first occurrence wins)', () => {
    // Both files reference alpha
    writeFileSync(join(skillsDir, 'RESOLVER.md'),
      `# Resolver\n\n| Trigger | Skill |\n|---|---|\n| do alpha | \`skills/alpha/SKILL.md\` |\n`);
    writeFileSync(join(workspace, 'AGENTS.md'),
      `# AGENTS\n\n| Trigger | Skill |\n|---|---|\n| alpha thing | \`skills/alpha/SKILL.md\` |\n| do beta | \`skills/beta/SKILL.md\` |\n| do gamma | \`skills/gamma/SKILL.md\` |\n`);

    const report = checkResolvable(skillsDir);
    expect(report.summary.reachable).toBe(3);
    expect(report.summary.unreachable).toBe(0);

    rmSync(join(skillsDir, 'RESOLVER.md'));
    rmSync(join(workspace, 'AGENTS.md'));
  });

  it('AGENTS.md at workspace root works alone (no RESOLVER.md)', () => {
    writeFileSync(join(workspace, 'AGENTS.md'),
      `# AGENTS\n\n| Trigger | Skill |\n|---|---|\n| a | \`skills/alpha/SKILL.md\` |\n| b | \`skills/beta/SKILL.md\` |\n| c | \`skills/gamma/SKILL.md\` |\n`);

    const report = checkResolvable(skillsDir);
    expect(report.summary.reachable).toBe(3);
    expect(report.summary.unreachable).toBe(0);

    rmSync(join(workspace, 'AGENTS.md'));
  });
});
