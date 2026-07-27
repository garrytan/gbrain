import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  autoDetectSkillsDir,
  autoDetectSkillsDirReadOnly,
  findRepoRoot,
  AUTO_DETECT_HINT,
  AUTO_DETECT_HINT_READ_ONLY,
} from '../src/core/repo-root.ts';

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

  it('auto-detect: cwd has ./skills directory → cwd_walk_up tier (v0.33)', () => {
    // Behavior unchanged from pre-v0.33 except for the reported source
    // — cwd_walk_up fires first now that the broader tier exists.
    // cwd_skills (resolver-gated) is functionally subsumed.
    const cwd = scratch();
    seedSkillsDir(join(cwd, 'skills'));
    const found = autoDetectSkillsDir(cwd, {});
    expect(found.dir).toBe(join(cwd, 'skills'));
    expect(found.source).toBe('cwd_walk_up');
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

  it('D-CX-4 + v0.33: walk-up from nested finds the repo skills/ via cwd_walk_up', () => {
    // Pre-v0.33: this returned source='repo_root' via findRepoRoot's
    // isGbrainRepoRoot gate. v0.33 added a broader cwd_walk_up tier
    // ahead of repo_root — same dir matched, different source name.
    // Behavior preserved; source label changed.
    const root = scratch();
    seedRepo(root);
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const found = autoDetectSkillsDir(nested, {});
    expect(found.dir).toBe(join(root, 'skills'));
    expect(found.source).toBe('cwd_walk_up');
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

  // -----------------------------------------------------------------------
  // v0.31.7 #128 adaptation: tier-0 GBRAIN_SKILLS_DIR + read-only
  // install-path fallback. Locked in eng-review D3 + D5.
  // -----------------------------------------------------------------------

  it('v0.31.7 D3-1: tier-0 $GBRAIN_SKILLS_DIR valid path returns env_explicit source', () => {
    const cwd = scratch();
    const explicit = scratch();
    seedSkillsDir(explicit);
    const found = autoDetectSkillsDir(cwd, { GBRAIN_SKILLS_DIR: explicit });
    expect(found.dir).toBe(explicit);
    expect(found.source).toBe('env_explicit');
  });

  it('v0.31.7 D3-2: tier-0 invalid path falls through to lower tiers', () => {
    // GBRAIN_SKILLS_DIR points to a directory with no resolver file. Must
    // not crash; must continue to the next tier (OPENCLAW_WORKSPACE here).
    const cwd = scratch();
    const invalid = scratch(); // no RESOLVER.md / AGENTS.md inside
    const workspace = scratch();
    seedSkillsDir(join(workspace, 'skills'));
    const found = autoDetectSkillsDir(cwd, {
      GBRAIN_SKILLS_DIR: invalid,
      OPENCLAW_WORKSPACE: workspace,
    });
    expect(found.dir).toBe(join(workspace, 'skills'));
    expect(found.source).toBe('openclaw_workspace_env');
  });

  it('v0.31.7 D3-3: tier-0 wins over $OPENCLAW_WORKSPACE precedence', () => {
    // Both env vars set. Tier-0 (explicit operator override) MUST win.
    const cwd = scratch();
    const explicit = scratch();
    seedSkillsDir(explicit);
    const workspace = scratch();
    seedSkillsDir(join(workspace, 'skills'));
    const found = autoDetectSkillsDir(cwd, {
      GBRAIN_SKILLS_DIR: explicit,
      OPENCLAW_WORKSPACE: workspace,
    });
    expect(found.dir).toBe(explicit);
    expect(found.source).toBe('env_explicit');
  });

  it('v0.31.7 D3-4: autoDetectSkillsDirReadOnly install-path walk finds bundled skills', () => {
    // When primary detection returns null (no env, no openclaw, no repo
    // root walk-up, no ./skills), the read-only variant walks up from
    // import.meta.url (the gbrain module's install path) and finds the
    // bundled skills/. This test runs from a tempdir cwd with no env vars
    // set; the only path that can succeed is the install-path fallback.
    const cwd = scratch();
    const found = autoDetectSkillsDirReadOnly(cwd, {});
    // We're inside the gbrain repo when running the test, so the install
    // path resolves to the repo's skills dir.
    expect(found.dir).not.toBeNull();
    expect(found.source).toBe('install_path');
    expect(found.dir).toMatch(/\/skills$/);
  });

  it('v0.31.7 D3-5: autoDetectSkillsDirReadOnly returns same primary detection on success', () => {
    // When primary detection succeeds, the read-only variant must return
    // the SAME result — no behavior drift, install-path is fallback only.
    const cwd = scratch();
    const workspace = scratch();
    seedSkillsDir(join(workspace, 'skills'));
    const env = { OPENCLAW_WORKSPACE: workspace };
    const primary = autoDetectSkillsDir(cwd, env);
    const readOnly = autoDetectSkillsDirReadOnly(cwd, env);
    expect(readOnly.dir).toBe(primary.dir);
    expect(readOnly.source).toBe(primary.source);
    // Specifically NOT install_path — primary succeeded so fallback never fires.
    expect(readOnly.source).toBe('openclaw_workspace_env');
  });

  it('v0.31.7 D3-6: AUTO_DETECT_HINT documents tier-0 GBRAIN_SKILLS_DIR', () => {
    // Hint string is what users see when auto-detect fails — must list the
    // tier-0 explicit override so they know to set it.
    expect(AUTO_DETECT_HINT).toContain('$GBRAIN_SKILLS_DIR');
    expect(AUTO_DETECT_HINT).toContain('explicit operator override');
  });

  it('v0.31.7 D3-7: AUTO_DETECT_HINT_READ_ONLY adds install-path tier', () => {
    // Read-only hint must mention the install-path fallback so doctor's
    // user can understand what gbrain found and where.
    expect(AUTO_DETECT_HINT_READ_ONLY).toContain('install path');
    expect(AUTO_DETECT_HINT_READ_ONLY).toContain('read-only');
    // And must include everything from the base hint.
    expect(AUTO_DETECT_HINT_READ_ONLY).toContain('$GBRAIN_SKILLS_DIR');
    expect(AUTO_DETECT_HINT_READ_ONLY).toContain('$OPENCLAW_WORKSPACE');
  });

  // ─── v0.33 cwd_walk_up tier (D3) ──────────────────────────────
  // Non-OpenClaw hosts (any agent repo with a bare skills/ dir) own
  // their skills/ directly. The new tier resolves these without
  // requiring a resolver file or gbrain-shape `src/cli.ts`.

  it('v0.33 cwd_walk_up: cwd has skills/ but no resolver, no src/cli.ts (bare-skills-dir shape)', () => {
    const agentRepo = scratch();
    mkdirSync(join(agentRepo, 'skills'));
    // Intentionally: no RESOLVER.md / AGENTS.md, no src/cli.ts.
    const found = autoDetectSkillsDir(agentRepo, {});
    expect(found.dir).toBe(join(agentRepo, 'skills'));
    expect(found.source).toBe('cwd_walk_up');
  });

  it('v0.33 cwd_walk_up: walks up from nested cwd to first ancestor with skills/', () => {
    const agentRepo = scratch();
    mkdirSync(join(agentRepo, 'skills'));
    const nested = join(agentRepo, 'src', 'commands');
    mkdirSync(nested, { recursive: true });
    const found = autoDetectSkillsDir(nested, {});
    expect(found.dir).toBe(join(agentRepo, 'skills'));
    expect(found.source).toBe('cwd_walk_up');
  });

  it('R5 regression: $OPENCLAW_WORKSPACE still wins when both env and cwd-skills exist', () => {
    // Pre-v0.33 R5: explicit env beats implicit cwd. The new cwd_walk_up
    // tier MUST NOT regress this — explicit operator intent always wins.
    const agentRepo = scratch();
    mkdirSync(join(agentRepo, 'skills'));
    const openclawWs = scratch();
    mkdirSync(join(openclawWs, 'skills'));
    writeFileSync(join(openclawWs, 'skills', 'AGENTS.md'), '# agents\n');

    const found = autoDetectSkillsDir(agentRepo, { OPENCLAW_WORKSPACE: openclawWs });
    expect(found.dir).toBe(join(openclawWs, 'skills'));
    expect(found.source).toBe('openclaw_workspace_env');
  });

  it('v0.33 cwd_walk_up: no skills/ anywhere up to root → returns null', () => {
    const empty = scratch();
    const nested = join(empty, 'deep', 'nested', 'dir');
    mkdirSync(nested, { recursive: true });
    const found = autoDetectSkillsDir(nested, {});
    expect(found.dir).toBeNull();
    expect(found.source).toBeNull();
  });

  it('v0.31.7 D5 regression guard: autoDetectSkillsDir does NOT install-path-fallback', () => {
    // CRITICAL: this test pins the read-path/write-path split. The shared
    // autoDetectSkillsDir is used by write-path callers (skillpack install,
    // skillify scaffold, post-install-advisory). If a future edit adds the
    // install-path fallback to the SHARED function, those write-path
    // callers running from `~` would silently retarget the bundled gbrain
    // repo's skills/ instead of the user's actual workspace — a quiet
    // data-flow regression. This test asserts the shared function returns
    // null (not an install_path source) when no env or repo-root signal
    // is present, even though the install-path fallback would succeed.
    const cwd = scratch(); // empty tempdir; no resolver anywhere up
    const found = autoDetectSkillsDir(cwd, {});
    // Either null (no skills dir found) or repo_root if test runs inside
    // the gbrain repo. In either case, NEVER 'install_path' on the shared
    // function — that variant is reserved for autoDetectSkillsDirReadOnly.
    expect(found.source).not.toBe('install_path');
  });
});
