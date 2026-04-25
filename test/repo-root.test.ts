import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { autoDetectSkillsDir, findRepoRoot } from '../src/core/repo-root.ts';

describe('findRepoRoot', () => {
  const created: string[] = [];
  afterEach(() => {
    while (created.length) {
      const p = created.pop()!;
      try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'repo-root-'));
    created.push(dir);
    return dir;
  }

  function seedRepo(dir: string): void {
    mkdirSync(join(dir, 'skills'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'RESOLVER.md'), '# RESOLVER\n');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'cli.ts'), '// gbrain marker\n');
  }

  function seedSkillsDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'RESOLVER.md'), '# RESOLVER\n');
  }

  it('finds skills/RESOLVER.md in the passed startDir on first iteration', () => {
    const root = scratch();
    seedRepo(root);
    expect(findRepoRoot(root)).toBe(root);
  });

  it('walks up N directories to find the repo root', () => {
    const root = scratch();
    seedRepo(root);
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(findRepoRoot(nested)).toBe(root);
  });

  it('returns null when no skills/RESOLVER.md exists up to filesystem root', () => {
    const empty = scratch();
    // Deliberately no seedRepo — empty dir; walk terminates at filesystem root.
    expect(findRepoRoot(empty)).toBeNull();
  });

  it('default arg uses process.cwd() (behavioral parity with prior doctor-private impl)', () => {
    // The default arg must match calling with an explicit process.cwd().
    // Don't assert on the path contents — it varies between local checkouts
    // and CI runners. What matters is parity: no-arg === cwd-arg.
    expect(findRepoRoot()).toBe(findRepoRoot(process.cwd()));
  });

  it('auto-detect: falls back to $OPENCLAW_WORKSPACE/skills when repo root is absent', () => {
    const cwd = scratch();
    const workspace = scratch();
    seedSkillsDir(join(workspace, 'skills'));
    const found = autoDetectSkillsDir(cwd, { OPENCLAW_WORKSPACE: workspace });
    expect(found.dir).toBe(join(workspace, 'skills'));
    expect(found.source).toBe('openclaw_workspace_env');
  });

  it('auto-detect: falls back to ~/.openclaw/workspace/skills when env var is not set', () => {
    const cwd = scratch();
    const home = scratch();
    seedSkillsDir(join(home, '.openclaw', 'workspace', 'skills'));
    const found = autoDetectSkillsDir(cwd, { HOME: home });
    expect(found.dir).toBe(join(home, '.openclaw', 'workspace', 'skills'));
    expect(found.source).toBe('openclaw_workspace_home');
  });

  it('auto-detect: falls back to ./skills as final candidate', () => {
    const cwd = scratch();
    seedSkillsDir(join(cwd, 'skills'));
    const found = autoDetectSkillsDir(cwd, {});
    expect(found.dir).toBe(join(cwd, 'skills'));
    expect(found.source).toBe('cwd_skills');
  });

  it('D-CX-4: $OPENCLAW_WORKSPACE wins over repo-root walk when explicitly set', () => {
    // Prior priority (shadow bug): walking up from cwd found gbrain's
    // repo root first and silently ignored the env var. Post-D-CX-4:
    // explicit env wins. Unset env → repo-root walk still wins
    // (tested below).
    const root = scratch();
    seedRepo(root);
    const workspace = scratch();
    seedSkillsDir(join(workspace, 'skills'));
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const found = autoDetectSkillsDir(nested, { OPENCLAW_WORKSPACE: workspace });
    expect(found.dir).toBe(join(workspace, 'skills'));
    expect(found.source).toBe('openclaw_workspace_env');
  });

  it('D-CX-4: repo-root walk still wins when OPENCLAW_WORKSPACE is NOT set', () => {
    const root = scratch();
    seedRepo(root);
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const found = autoDetectSkillsDir(nested, {});
    expect(found.dir).toBe(join(root, 'skills'));
    expect(found.source).toBe('repo_root');
  });

  it('W1: AGENTS.md at skills dir is accepted (OpenClaw skills-subdir variant)', () => {
    const workspace = scratch();
    const skillsDir = join(workspace, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    // seed AGENTS.md (no RESOLVER.md)
    require('fs').writeFileSync(
      join(skillsDir, 'AGENTS.md'),
      '# AGENTS\n\n| Trigger | Skill |\n|---|---|\n',
    );
    const found = autoDetectSkillsDir(scratch(), { OPENCLAW_WORKSPACE: workspace });
    expect(found.dir).toBe(skillsDir);
    expect(found.source).toBe('openclaw_workspace_env');
  });

  it('W1: AGENTS.md at workspace root (OpenClaw-native layout)', () => {
    // The reference OpenClaw deployment places AGENTS.md at
    // workspace/AGENTS.md, with skills in workspace/skills/. Auto-detect
    // must find the skills dir and flag this as the workspace-root variant.
    const workspace = scratch();
    const skillsDir = join(workspace, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    require('fs').writeFileSync(
      join(workspace, 'AGENTS.md'),
      '# AGENTS\n\n| Trigger | Skill |\n|---|---|\n',
    );
    const found = autoDetectSkillsDir(scratch(), { OPENCLAW_WORKSPACE: workspace });
    expect(found.dir).toBe(skillsDir);
    expect(found.source).toBe('openclaw_workspace_env_root');
  });

  it('W1: both RESOLVER.md and AGENTS.md present — RESOLVER.md wins', () => {
    // Policy: when both exist at the same location, gbrain-native wins.
    const workspace = scratch();
    const skillsDir = join(workspace, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    require('fs').writeFileSync(
      join(skillsDir, 'RESOLVER.md'),
      '# RESOLVER\n\n| Trigger | Skill |\n|---|---|\n',
    );
    require('fs').writeFileSync(
      join(skillsDir, 'AGENTS.md'),
      '# AGENTS\n\n| Trigger | Skill |\n|---|---|\n',
    );
    const found = autoDetectSkillsDir(scratch(), { OPENCLAW_WORKSPACE: workspace });
    expect(found.dir).toBe(skillsDir);
    // Source is still `env` — the distinction is which file was found,
    // and RESOLVER.md takes precedence inside resolveWorkspaceSkillsDir.
    expect(found.source).toBe('openclaw_workspace_env');
  });
});
