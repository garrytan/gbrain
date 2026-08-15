/**
 * test/e2e/workspace-generic-compat.test.ts — generic-workspace compat gate.
 *
 * Pins gbrain's DOCUMENTED CONTRACT for the INSTALL_FOR_AGENTS.md
 * "any repo with a workspace" flow: the cwd_walk_up detection tier
 * (src/core/repo-root.ts tier 1b), scaffold additivity
 * (src/core/skillpack/scaffold.ts contracts 1–3), and check-resolvable
 * against a root AGENTS.md with no manifest.json. Hermes is the
 * motivating consumer of this flow; the real Hermes-behavior proof is
 * the Phase B door test (test/e2e/install-real-hermes.serial.test.ts),
 * not this file — this one runs everywhere, PGLite/no-DB, ungated.
 *
 * Fixture: `test/fixtures/generic-agents-workspace/` — AGENTS.md at
 * workspace root, two skills below, deliberately nothing
 * OpenClaw-specific. Structural template: openclaw-reference-compat.test.ts.
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { checkResolvable } from '../../src/core/check-resolvable.ts';
import { autoDetectSkillsDir } from '../../src/core/repo-root.ts';
import { runScaffold } from '../../src/core/skillpack/scaffold.ts';
import { findGbrainRoot } from '../../src/core/skillpack/bundle.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'generic-agents-workspace');
const SKILLS_DIR = join(FIXTURE, 'skills');
const REPO = join(import.meta.dir, '..', '..');
const CLI = join(REPO, 'src', 'cli.ts');

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const d = created.pop();
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe('generic agent-workspace compat (INSTALL_FOR_AGENTS.md flow)', () => {
  it('fixture shape: root AGENTS.md, skills/ below, no manifest.json', () => {
    expect(existsSync(FIXTURE)).toBe(true);
    expect(existsSync(join(FIXTURE, 'AGENTS.md'))).toBe(true);
    expect(existsSync(SKILLS_DIR)).toBe(true);
    expect(existsSync(join(SKILLS_DIR, 'manifest.json'))).toBe(false);
  });

  it('auto-detects skills dir via the cwd_walk_up tier (no env needed)', () => {
    // IMPORTANT: the replacement env guards against the OPERATOR's
    // GBRAIN_SKILLS_DIR (tier 0) / OPENCLAW_WORKSPACE (tier 1) leaking
    // in from the test runner's environment; the home tier sits BELOW
    // cwd_walk_up in the priority order and could never preempt it.
    const emptyHome = mkdtempSync(join(tmpdir(), 'generic-ws-home-'));
    created.push(emptyHome);
    const detected = autoDetectSkillsDir(FIXTURE, { HOME: emptyHome });
    expect(detected.dir).toBe(SKILLS_DIR);
    expect(detected.source).toBe('cwd_walk_up');
  });

  it('GBRAIN_SKILLS_DIR explicit override wins over cwd_walk_up', () => {
    // Tier 0 requires a resolver file inside the pointed-at dir, so the
    // override target ships its own AGENTS.md. Starting from FIXTURE
    // (which WOULD match cwd_walk_up), the explicit env must win.
    const emptyHome = mkdtempSync(join(tmpdir(), 'generic-ws-home-'));
    created.push(emptyHome);
    const override = mkdtempSync(join(tmpdir(), 'generic-ws-override-'));
    created.push(override);
    writeFileSync(join(override, 'AGENTS.md'), '# AGENTS\n');

    const detected = autoDetectSkillsDir(FIXTURE, {
      GBRAIN_SKILLS_DIR: override,
      HOME: emptyHome,
    });
    expect(detected.dir).toBe(override);
    expect(detected.source).toBe('env_explicit');
  });

  it('checkResolvable accepts root AGENTS.md — all skills reachable, no errors', () => {
    const report = checkResolvable(SKILLS_DIR);
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.summary.total_skills).toBe(2);
    expect(report.summary.reachable).toBe(2);
    expect(report.summary.unreachable).toBe(0);
  });

  it('CLI subprocess: check-resolvable with json + skills-dir flags exits 0, JSON clean', () => {
    const r = spawnSync(
      'bun',
      [CLI, 'check-resolvable', '--json', '--skills-dir', SKILLS_DIR],
      { encoding: 'utf-8', cwd: REPO, maxBuffer: 10 * 1024 * 1024 },
    );
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
    expect(env.report.errors).toEqual([]);
    expect(env.report.summary.total_skills).toBe(2);
  });

  it('scaffold is additive into an AGENTS.md-shell workspace and refuses overwrite on re-run', () => {
    // Fresh workspace with only the AGENTS.md shell — the documented
    // starting state for a generic repo adopting gbrain skills.
    const target = mkdtempSync(join(tmpdir(), 'generic-ws-scaffold-'));
    created.push(target);
    const shell = '# AGENTS\n\n| Trigger | Skill |\n|---------|-------|\n';
    writeFileSync(join(target, 'AGENTS.md'), shell);

    const gbrainRoot = findGbrainRoot();
    expect(gbrainRoot).not.toBeNull();

    const first = runScaffold({
      gbrainRoot: gbrainRoot!,
      targetWorkspace: target,
      skillSlug: 'query',
    });
    expect(first.summary.wroteNew).toBeGreaterThan(0);
    // The skill's SKILL.md lands under skills/query/; every file the
    // scaffold reports as written actually exists; paired sources (from
    // frontmatter, when the skill declares any) are written, not skipped.
    const skillMd = join(target, 'skills', 'query', 'SKILL.md');
    expect(existsSync(skillMd)).toBe(true);
    for (const f of first.files) {
      if (f.outcome === 'wrote_new') expect(existsSync(f.target)).toBe(true);
    }
    expect(first.summary.pairedSourcesWritten).toBe(
      first.files.filter(f => f.outcome === 'wrote_new' && f.pairedSource).length,
    );

    // check-resolvable stays clean after scaffold: the scaffolded skill
    // is reachable via its own frontmatter triggers (scaffold contract 1
    // — no managed-block writes needed).
    const report = checkResolvable(join(target, 'skills'));
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.summary.unreachable).toBe(0);

    // Contract 2 (scaffold.ts header): once a file lands, the user owns
    // it — a re-run must skip every existing file and preserve edits.
    const marker = '\n<!-- user-owned edit: alice-example -->\n';
    appendFileSync(skillMd, marker);
    const second = runScaffold({
      gbrainRoot: gbrainRoot!,
      targetWorkspace: target,
      skillSlug: 'query',
    });
    expect(second.summary.wroteNew).toBe(0);
    expect(second.summary.skippedExisting).toBe(first.summary.wroteNew);
    expect(readFileSync(skillMd, 'utf-8')).toContain(marker.trim());
    // Byproduct check: the host resolver file was never touched.
    expect(readFileSync(join(target, 'AGENTS.md'), 'utf-8')).toBe(shell);
  });
});
