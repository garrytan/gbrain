/**
 * Guard tests for scripts/check-bootstrap-tag.sh [C1 = D6-A] and
 * scripts/check-bootstrap-templates.sh [D4/D5/A1 + privacy], plus the
 * release-mechanics workflow pins (latest-stable advance, publish-template
 * gating) and the verify-dispatcher wiring.
 *
 * Both guards accept GBRAIN_BOOTSTRAP_GUARD_ROOT so every failure mode is
 * exercised against throwaway fixture trees (the no-tracked-symlinks-guard
 * precedent) — the real repo is only asserted green.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const TAG_GUARD = join(ROOT, 'scripts/check-bootstrap-tag.sh');
const TPL_GUARD = join(ROOT, 'scripts/check-bootstrap-templates.sh');

// The banned fork name must never appear literally in a test file
// (scripts/check-privacy.sh + scripts/check-test-real-names.sh scan test/**),
// so fixtures construct it at runtime.
const BANNED_FORK_NAME = ['winter', 'mute'].join('');

function runGuard(script: string, fixtureRoot: string): { status: number | null; out: string } {
  const r = spawnSync('bash', [script], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, GBRAIN_BOOTSTRAP_GUARD_ROOT: fixtureRoot },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-bootstrap-guard-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function withFixture(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = makeFixture(files);
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BANK_JSON = JSON.stringify({
  version: 1,
  maxQuestions: 12,
  interviewKeys: ['AGENT_NAME'],
  consentKeys: ['HOOKS_CONSENT', 'MCP_SCOPE'],
  questions: {
    AGENT_NAME: { maxLength: 64 },
    HOOKS_CONSENT: { consent: true, maxLength: 8 },
    // Section (e) pins the harness-scoping prefix + interview phase on this
    // question — every "clean" fixture must carry a compliant MCP_SCOPE entry.
    MCP_SCOPE: {
      consent: true,
      phase: 'interview',
      question: '(Claude Code only. Codex has no scope flag.) Register for this folder or the whole machine?',
      maxLength: 8,
    },
    UNUSED_OPTIONAL: { maxLength: 8 },
  },
});

// Minimal runbook that satisfies the section (e) counter-signal pins; fixtures
// exercising OTHER failure modes include it so they fail only for their own
// reason.
const RUNBOOK_PINS = 'Claude Code only\nDo NOT offer an MCP scope choice\n';

describe('check-bootstrap-tag.sh', () => {
  test('exists and is executable', () => {
    expect(existsSync(TAG_GUARD)).toBe(true);
    expect((statSync(TAG_GUARD).mode & 0o100) !== 0).toBe(true);
  });

  test('passes on this repo', () => {
    const r = runGuard(TAG_GUARD, ROOT);
    expect(r.status).toBe(0);
    expect(r.out).toContain('check-bootstrap-tag: ok');
  });

  test('skips with exit 0 when both entry docs are absent', () => {
    withFixture({ VERSION: '1.2.3.4\n' }, (dir) => {
      const r = runGuard(TAG_GUARD, dir);
      expect(r.status).toBe(0);
      expect(r.out).toContain('SKIP');
      expect(r.out).toContain('check-bootstrap-tag: ok');
    });
  });

  test('accepts sanctioned refs + matching runbook stamp', () => {
    withFixture(
      {
        VERSION: '1.2.3.4\n',
        'README.md':
          'Fetch https://raw.githubusercontent.com/garrytan/gbrain/latest-stable/BOOTSTRAP_FOR_AGENTS.md\n' +
          'Install: `bun install -g github:garrytan/gbrain#latest-stable`\n',
        'BOOTSTRAP_FOR_AGENTS.md':
          '<!-- gbrain-runbook-stamp: 1.2.3.4 -->\n# Runbook\n' +
          'Fetched from https://raw.githubusercontent.com/garrytan/gbrain/latest-stable/BOOTSTRAP_FOR_AGENTS.md\n',
      },
      (dir) => {
        const r = runGuard(TAG_GUARD, dir);
        expect(r.status).toBe(0);
        expect(r.out).toContain('check-bootstrap-tag: ok');
      },
    );
  });

  test('fails on a v-prefixed raw pin', () => {
    withFixture(
      {
        VERSION: '1.2.3.4\n',
        'README.md':
          'Fetch https://raw.githubusercontent.com/garrytan/gbrain/v0.42.0.0/BOOTSTRAP_FOR_AGENTS.md\n',
      },
      (dir) => {
        const r = runGuard(TAG_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain("unsanctioned ref 'v0.42.0.0'");
      },
    );
  });

  test('fails on a branch-ref install pin (#master)', () => {
    withFixture(
      {
        VERSION: '1.2.3.4\n',
        'README.md': 'Install: `bun install -g github:garrytan/gbrain#master`\n',
      },
      (dir) => {
        const r = runGuard(TAG_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain("'#master'");
      },
    );
  });

  test('tolerates the pre-bootstrap INSTALL_FOR_AGENTS.md master path (carve-out)', () => {
    withFixture(
      {
        VERSION: '1.2.3.4\n',
        'README.md':
          'OpenClaw path: https://raw.githubusercontent.com/garrytan/gbrain/master/INSTALL_FOR_AGENTS.md\n',
      },
      (dir) => {
        expect(runGuard(TAG_GUARD, dir).status).toBe(0);
      },
    );
  });

  test('fails when the runbook stamp mismatches VERSION', () => {
    withFixture(
      {
        VERSION: '1.2.3.4\n',
        'BOOTSTRAP_FOR_AGENTS.md': '<!-- gbrain-runbook-stamp: 9.9.9.9 -->\n# Runbook\n',
      },
      (dir) => {
        const r = runGuard(TAG_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain("stamp '9.9.9.9' != VERSION '1.2.3.4'");
      },
    );
  });

  test('fails when the runbook is missing its stamp line entirely', () => {
    withFixture(
      {
        VERSION: '1.2.3.4\n',
        'BOOTSTRAP_FOR_AGENTS.md': '# Runbook without a stamp\n',
      },
      (dir) => {
        const r = runGuard(TAG_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain('missing its');
      },
    );
  });
});

describe('check-bootstrap-templates.sh', () => {
  test('exists and is executable', () => {
    expect(existsSync(TPL_GUARD)).toBe(true);
    expect((statSync(TPL_GUARD).mode & 0o100) !== 0).toBe(true);
  });

  test('passes on this repo', () => {
    const r = runGuard(TPL_GUARD, ROOT);
    expect(r.status).toBe(0);
    expect(r.out).toContain('check-bootstrap-templates: ok');
  });

  test('skips with exit 0 when templates/bootstrap is absent', () => {
    withFixture({ VERSION: '1.2.3.4\n' }, (dir) => {
      const r = runGuard(TPL_GUARD, dir);
      expect(r.status).toBe(0);
      expect(r.out).toContain('SKIP');
    });
  });

  test('accepts a clean bijection and warns (only) on unused non-consent keys', () => {
    withFixture(
      {
        'templates/bootstrap/questions.json': BANK_JSON,
        'templates/bootstrap/SOUL.md.template':
          '# {{AGENT_NAME}}\nRepo: {{GITHUB_REPO_URL}}\n',
      },
      (dir) => {
        const r = runGuard(TPL_GUARD, dir);
        expect(r.status).toBe(0);
        expect(r.out).toContain('WARN');
        expect(r.out).toContain('UNUSED_OPTIONAL');
        // Consent keys are exempt from the usage warning.
        expect(r.out).not.toContain('HOOKS_CONSENT');
      },
    );
  });

  test('fails on a token with no bank or DERIVED_TOKENS entry', () => {
    withFixture(
      {
        'templates/bootstrap/questions.json': BANK_JSON,
        'templates/bootstrap/SOUL.md.template': '# {{AGENT_NAME}} {{NOT_IN_BANK}}\n',
      },
      (dir) => {
        const r = runGuard(TPL_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain('NOT_IN_BANK');
      },
    );
  });

  test('fails on a malformed question bank', () => {
    withFixture(
      {
        'templates/bootstrap/questions.json': '{ not json',
        'templates/bootstrap/SOUL.md.template': '# {{AGENT_NAME}}\n',
      },
      (dir) => {
        const r = runGuard(TPL_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain('could not parse');
      },
    );
  });

  test('fails when a template carries the banned fork name (placeholder-only assertion)', () => {
    withFixture(
      {
        'templates/bootstrap/questions.json': BANK_JSON,
        'templates/bootstrap/SOUL.md.template': `# {{AGENT_NAME}}, successor to ${BANNED_FORK_NAME}\n`,
      },
      (dir) => {
        const r = runGuard(TPL_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain('banned term');
      },
    );
  });

  test('checks runbook Phase: names against the TS phase list when both exist [D5]', () => {
    withFixture(
      {
        'templates/bootstrap/questions.json': BANK_JSON,
        'templates/bootstrap/SOUL.md.template': '# {{AGENT_NAME}}\n',
        'BOOTSTRAP_FOR_AGENTS.md':
          `<!-- gbrain-runbook-stamp: 1.2.3.4 -->\n${RUNBOOK_PINS}Phase: preflight\nPhase: not_a_phase\n`,
        'src/core/bootstrap/status.ts': "export const PHASES = ['preflight', 'interview'] as const;\n",
      },
      (dir) => {
        const r = runGuard(TPL_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain("phase 'not_a_phase'");
        expect(r.out).not.toContain("phase 'preflight'");
      },
    );
  });

  test('(e) clean: runbook counter-signals + compliant MCP_SCOPE prefix pass', () => {
    withFixture(
      {
        'templates/bootstrap/questions.json': BANK_JSON,
        'templates/bootstrap/SOUL.md.template': '# {{AGENT_NAME}}\n',
        'BOOTSTRAP_FOR_AGENTS.md': `<!-- gbrain-runbook-stamp: 1.2.3.4 -->\n${RUNBOOK_PINS}`,
      },
      (dir) => {
        const r = runGuard(TPL_GUARD, dir);
        expect(r.status).toBe(0);
        expect(r.out).toContain('check-bootstrap-templates: ok');
      },
    );
  });

  test('(e) fails when the runbook loses the Codex do-not-offer counter-signal', () => {
    withFixture(
      {
        'templates/bootstrap/questions.json': BANK_JSON,
        'templates/bootstrap/SOUL.md.template': '# {{AGENT_NAME}}\n',
        'BOOTSTRAP_FOR_AGENTS.md':
          '<!-- gbrain-runbook-stamp: 1.2.3.4 -->\nClaude Code only\n(counter-signal deleted)\n',
      },
      (dir) => {
        const r = runGuard(TPL_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain('Codex counter-signal');
      },
    );
  });

  test("(e) fails when the runbook loses the 'Claude Code only' consent scoping", () => {
    withFixture(
      {
        'templates/bootstrap/questions.json': BANK_JSON,
        'templates/bootstrap/SOUL.md.template': '# {{AGENT_NAME}}\n',
        'BOOTSTRAP_FOR_AGENTS.md':
          '<!-- gbrain-runbook-stamp: 1.2.3.4 -->\nDo NOT offer an MCP scope choice\n',
      },
      (dir) => {
        const r = runGuard(TPL_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain("'Claude Code only'");
      },
    );
  });

  test('(e) fails when the questions object vanishes (valid JSON that silently passes §a)', () => {
    withFixture(
      {
        'templates/bootstrap/questions.json': '{"version":1,"maxQuestions":12,"interviewKeys":[],"consentKeys":[]}',
        'templates/bootstrap/SOUL.md.template': '# plain\n',
        'BOOTSTRAP_FOR_AGENTS.md': `<!-- gbrain-runbook-stamp: 1.2.3.4 -->\n${RUNBOOK_PINS}`,
      },
      (dir) => {
        const r = runGuard(TPL_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain("must start with '(Claude Code only'");
      },
    );
  });

  test('(e) fails when the MCP_SCOPE entry vanishes from the bank', () => {
    const bankNoEntry = JSON.stringify({
      version: 1,
      maxQuestions: 12,
      interviewKeys: ['AGENT_NAME'],
      consentKeys: ['HOOKS_CONSENT'],
      questions: {
        AGENT_NAME: { maxLength: 64 },
        HOOKS_CONSENT: { consent: true, maxLength: 8 },
      },
    });
    withFixture(
      {
        'templates/bootstrap/questions.json': bankNoEntry,
        'templates/bootstrap/SOUL.md.template': '# {{AGENT_NAME}}\n',
        'BOOTSTRAP_FOR_AGENTS.md': `<!-- gbrain-runbook-stamp: 1.2.3.4 -->\n${RUNBOOK_PINS}`,
      },
      (dir) => {
        const r = runGuard(TPL_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain("must start with '(Claude Code only'");
      },
    );
  });

  test('(e) fails when MCP_SCOPE.phase reverts to wire (schema-vs-runbook contradiction)', () => {
    const bankWirePhase = JSON.stringify({
      version: 1,
      maxQuestions: 12,
      interviewKeys: ['AGENT_NAME'],
      consentKeys: ['HOOKS_CONSENT', 'MCP_SCOPE'],
      questions: {
        AGENT_NAME: { maxLength: 64 },
        HOOKS_CONSENT: { consent: true, maxLength: 8 },
        MCP_SCOPE: {
          consent: true,
          phase: 'wire',
          question: '(Claude Code only. Codex has no scope flag.) Register for this folder or the whole machine?',
          maxLength: 8,
        },
      },
    });
    withFixture(
      {
        'templates/bootstrap/questions.json': bankWirePhase,
        'templates/bootstrap/SOUL.md.template': '# {{AGENT_NAME}}\n',
        'BOOTSTRAP_FOR_AGENTS.md': `<!-- gbrain-runbook-stamp: 1.2.3.4 -->\n${RUNBOOK_PINS}`,
      },
      (dir) => {
        const r = runGuard(TPL_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain("MCP_SCOPE.phase must be 'interview'");
      },
    );
  });

  test('(e) fails when MCP_SCOPE.question loses its harness prefix (or the entry vanishes)', () => {
    const bankNoPrefix = JSON.stringify({
      version: 1,
      maxQuestions: 12,
      interviewKeys: ['AGENT_NAME'],
      consentKeys: ['HOOKS_CONSENT', 'MCP_SCOPE'],
      questions: {
        AGENT_NAME: { maxLength: 64 },
        HOOKS_CONSENT: { consent: true, maxLength: 8 },
        MCP_SCOPE: { consent: true, phase: 'interview', question: 'Register for this folder or the whole machine?', maxLength: 8 },
      },
    });
    withFixture(
      {
        'templates/bootstrap/questions.json': bankNoPrefix,
        'templates/bootstrap/SOUL.md.template': '# {{AGENT_NAME}}\n',
        'BOOTSTRAP_FOR_AGENTS.md': `<!-- gbrain-runbook-stamp: 1.2.3.4 -->\n${RUNBOOK_PINS}`,
      },
      (dir) => {
        const r = runGuard(TPL_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain("must start with '(Claude Code only'");
      },
    );
  });
});

describe('verify + workflow wiring', () => {
  test('both guards are registered in the verify dispatcher', () => {
    const r = spawnSync('bash', [join(ROOT, 'scripts/run-verify-parallel.sh'), '--dry-list'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    const checks = new Set(r.stdout.trim().split('\n'));
    expect(checks).toContain('check:bootstrap-tag');
    expect(checks).toContain('check:bootstrap-templates');
  });

  test('package.json carries both check scripts', () => {
    const pkg = require(join(ROOT, 'package.json'));
    expect(pkg.scripts['check:bootstrap-tag']).toContain('check-bootstrap-tag.sh');
    expect(pkg.scripts['check:bootstrap-templates']).toContain('check-bootstrap-templates.sh');
  });

  test('ci-cache-hash re-admits the bootstrap entry docs [C2]', () => {
    const script = require('node:fs').readFileSync(join(ROOT, 'scripts/ci-cache-hash.sh'), 'utf8');
    expect(script).toContain("'README\\.md$'");
    expect(script).toContain("'BOOTSTRAP_FOR_AGENTS\\.md$'");
  });

  test('release.yml advances latest-stable only as the final release step [C1]', () => {
    const wf = require('node:fs').readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    expect(wf).toContain('git push origin "+${GITHUB_SHA}:refs/tags/latest-stable"');
    // The advance comes AFTER the release publish step in the same job.
    expect(wf.indexOf('refs/tags/latest-stable')).toBeGreaterThan(wf.indexOf('Create release'));
  });

  test('release.yml publish-template job gates on TEMPLATE_REPO_PAT via env indirection', () => {
    const wf = require('node:fs').readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    expect(wf).toContain('publish-template:');
    expect(wf).toContain('TEMPLATE_REPO_PAT: ${{ secrets.TEMPLATE_REPO_PAT }}');
    // Secrets must never appear in an `if:` expression (unreadable there).
    for (const line of wf.split('\n')) {
      if (line.trimStart().startsWith('if:')) {
        expect(line).not.toContain('secrets.');
      }
    }
    // The byte-diff gate against the vendored tree [A1].
    expect(wf).toContain('diff -r /tmp/template-tree templates/bootstrap/template-repo');
  });

  test('heavy-tests.yml carries the bootstrap Docker e2e placeholder [A7]', () => {
    const wf = require('node:fs').readFileSync(
      join(ROOT, '.github/workflows/heavy-tests.yml'),
      'utf8',
    );
    expect(wf).toContain('tests/docker/bootstrap-e2e.sh');
  });
});
