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
      question: '(Claude Code and opencode. Codex has no scope flag.) Register for this folder or the whole machine?',
      maxLength: 8,
    },
    UNUSED_OPTIONAL: { maxLength: 8 },
  },
});

// Minimal runbook that satisfies the section (e) counter-signal pins; fixtures
// exercising OTHER failure modes include it so they fail only for their own
// reason.
const RUNBOOK_PINS = 'Claude Code and opencode\nDo NOT offer an MCP scope choice\nNO trust prompt\n';

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
          '<!-- gbrain-runbook-stamp: 1.2.3.4 -->\nClaude Code and opencode\nNO trust prompt\n(counter-signal deleted)\n',
      },
      (dir) => {
        const r = runGuard(TPL_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain('Codex counter-signal');
      },
    );
  });

  test("(e) fails when the runbook loses the 'Claude Code and opencode' consent scoping", () => {
    withFixture(
      {
        'templates/bootstrap/questions.json': BANK_JSON,
        'templates/bootstrap/SOUL.md.template': '# {{AGENT_NAME}}\n',
        'BOOTSTRAP_FOR_AGENTS.md':
          '<!-- gbrain-runbook-stamp: 1.2.3.4 -->\nDo NOT offer an MCP scope choice\nNO trust prompt\n',
      },
      (dir) => {
        const r = runGuard(TPL_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain("'Claude Code and opencode'");
      },
    );
  });

  test("(e) fails when the runbook loses the opencode 'no trust prompt' rationale", () => {
    withFixture(
      {
        'templates/bootstrap/questions.json': BANK_JSON,
        'templates/bootstrap/SOUL.md.template': '# {{AGENT_NAME}}\n',
        'BOOTSTRAP_FOR_AGENTS.md':
          '<!-- gbrain-runbook-stamp: 1.2.3.4 -->\nClaude Code and opencode\nDo NOT offer an MCP scope choice\n',
      },
      (dir) => {
        const r = runGuard(TPL_GUARD, dir);
        expect(r.status).toBe(1);
        expect(r.out).toContain('spawn-gate rationale');
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
        expect(r.out).toContain("must start with '(Claude Code and opencode'");
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
        expect(r.out).toContain("must start with '(Claude Code and opencode'");
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
          question: '(Claude Code and opencode. Codex has no scope flag.) Register for this folder or the whole machine?',
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
        expect(r.out).toContain("must start with '(Claude Code and opencode'");
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

// ── check-grok-pin.sh ────────────────────────────────────────────────────────

const GROK_PIN_GUARD = join(ROOT, 'scripts/check-grok-pin.sh');

function runGrokPinGuard(fixtureRoot: string): { status: number | null; out: string } {
  const r = spawnSync('bash', [GROK_PIN_GUARD], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, GBRAIN_GROK_PIN_GUARD_ROOT: fixtureRoot },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const GROK_PIN_STAMPS_NPM = [
  '<!-- grok-pin: distribution_kind=npm -->',
  '<!-- grok-pin: npm_package=@example/grok -->',
  '<!-- grok-pin: npm_version=1.0.4 -->',
  '<!-- grok-pin: npm_integrity=sha512-AAA= -->',
  '<!-- grok-pin: grok_version=1.0.4 -->',
  '<!-- grok-pin: installer_sha256=abc123 -->',
].join('\n');

function grokDoorWorkflow(envLines: string[]): string {
  return [
    'jobs:',
    '  other-job:',
    '    steps: []',
    '  grok-door:',
    '    env:',
    ...envLines.map((l) => `      ${l}`),
    '    steps: []',
    '  trailing-job:',
    '    env:',
    '      GROK_VERSION: "9.9.9"', // outside the grok-door block — must be ignored
    '    steps: []',
    '',
  ].join('\n');
}

const GROK_NPM_ENV_OK = [
  'GROK_VERSION: "1.0.4"',
  'GROK_NPM_PACKAGE: "@example/grok"',
  'GROK_NPM_INTEGRITY: "sha512-AAA="',
];

describe('check-grok-pin.sh', () => {
  test('ok: npm mode with matching workflow pins (anchored to the grok-door block)', () => {
    withFixture({
      'docs/mcp/GROK-CLI-PIN.md': `# pin\n${GROK_PIN_STAMPS_NPM}\n`,
      '.github/workflows/heavy-tests.yml': grokDoorWorkflow(GROK_NPM_ENV_OK),
    }, (dir) => {
      const r = runGrokPinGuard(dir);
      expect(r.out).toContain('check-grok-pin: ok');
      expect(r.status).toBe(0);
    });
  });

  test('SKIP-graceful pre-landing; FAIL-closed once the door job exists without the pin doc', () => {
    // Door job present + pin doc MISSING = the gate's source of truth was
    // deleted — that must fail, not skip (post-landing fail-closed rule).
    withFixture({
      '.github/workflows/heavy-tests.yml': grokDoorWorkflow(GROK_NPM_ENV_OK),
    }, (dir) => {
      const r = runGrokPinGuard(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('pin doc is the gate');
    });
    // No door job yet: pin doc alone is fine to skip (pre-landing posture).
    withFixture({
      'docs/mcp/GROK-CLI-PIN.md': `# pin\n${GROK_PIN_STAMPS_NPM}\n`,
      '.github/workflows/heavy-tests.yml': 'jobs:\n  other-job:\n    steps: []\n',
    }, (dir) => {
      const r = runGrokPinGuard(dir);
      expect(r.out).toContain('SKIP');
      expect(r.status).toBe(0);
    });
  });

  test('FAIL: npm_version stamp disagreeing with grok_version can never pass green', () => {
    const stamps = GROK_PIN_STAMPS_NPM.replace(
      '<!-- grok-pin: npm_version=1.0.4 -->',
      '<!-- grok-pin: npm_version=1.0.5 -->',
    );
    withFixture({
      'docs/mcp/GROK-CLI-PIN.md': `# pin\n${stamps}\n`,
      '.github/workflows/heavy-tests.yml': grokDoorWorkflow(GROK_NPM_ENV_OK),
    }, (dir) => {
      const r = runGrokPinGuard(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('npm_version stamp');
    });
  });

  test('single-quoted workflow env values are not read as drift', () => {
    withFixture({
      'docs/mcp/GROK-CLI-PIN.md': `# pin\n${GROK_PIN_STAMPS_NPM}\n`,
      '.github/workflows/heavy-tests.yml': grokDoorWorkflow([
        "GROK_VERSION: '1.0.4'",
        "GROK_NPM_PACKAGE: '@example/grok'",
        "GROK_NPM_INTEGRITY: 'sha512-AAA='",
      ]),
    }, (dir) => {
      const r = runGrokPinGuard(dir);
      expect(r.out).toContain('check-grok-pin: ok');
      expect(r.status).toBe(0);
    });
  });

  test('FAIL: workflow GROK_VERSION drifts from the grok_version stamp', () => {
    withFixture({
      'docs/mcp/GROK-CLI-PIN.md': `# pin\n${GROK_PIN_STAMPS_NPM}\n`,
      '.github/workflows/heavy-tests.yml': grokDoorWorkflow([
        'GROK_VERSION: "1.0.5"',
        'GROK_NPM_PACKAGE: "@example/grok"',
        'GROK_NPM_INTEGRITY: "sha512-AAA="',
      ]),
    }, (dir) => {
      const r = runGrokPinGuard(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('GROK_VERSION drift');
    });
  });

  test('FAIL: npm mode with a missing workflow integrity pin', () => {
    withFixture({
      'docs/mcp/GROK-CLI-PIN.md': `# pin\n${GROK_PIN_STAMPS_NPM}\n`,
      '.github/workflows/heavy-tests.yml': grokDoorWorkflow([
        'GROK_VERSION: "1.0.4"',
        'GROK_NPM_PACKAGE: "@example/grok"',
      ]),
    }, (dir) => {
      const r = runGrokPinGuard(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('missing GROK_NPM_INTEGRITY');
    });
  });

  test('FAIL: mode exclusivity — npm mode must not also pin GROK_INSTALL_SHA256 in the workflow', () => {
    withFixture({
      'docs/mcp/GROK-CLI-PIN.md': `# pin\n${GROK_PIN_STAMPS_NPM}\n`,
      '.github/workflows/heavy-tests.yml': grokDoorWorkflow([
        ...GROK_NPM_ENV_OK,
        'GROK_INSTALL_SHA256: "abc123"',
      ]),
    }, (dir) => {
      const r = runGrokPinGuard(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('mode exclusivity');
    });
  });

  test('FAIL: duplicate stamps in the pin doc', () => {
    withFixture({
      'docs/mcp/GROK-CLI-PIN.md': `# pin\n${GROK_PIN_STAMPS_NPM}\n<!-- grok-pin: grok_version=1.0.5 -->\n`,
      '.github/workflows/heavy-tests.yml': grokDoorWorkflow(GROK_NPM_ENV_OK),
    }, (dir) => {
      const r = runGrokPinGuard(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('duplicate grok-pin stamp');
    });
  });

  test('installer mode: matching sha passes; npm-integrity co-pin fails exclusivity', () => {
    const installerStamps = [
      '<!-- grok-pin: distribution_kind=installer -->',
      '<!-- grok-pin: grok_version=1.0.4 -->',
      '<!-- grok-pin: installer_sha256=abc123 -->',
    ].join('\n');
    withFixture({
      'docs/mcp/GROK-CLI-PIN.md': `# pin\n${installerStamps}\n`,
      '.github/workflows/heavy-tests.yml': grokDoorWorkflow([
        'GROK_VERSION: "1.0.4"',
        'GROK_INSTALL_SHA256: "abc123"',
      ]),
    }, (dir) => {
      const r = runGrokPinGuard(dir);
      expect(r.out).toContain('check-grok-pin: ok (installer mode');
      expect(r.status).toBe(0);
    });
    withFixture({
      'docs/mcp/GROK-CLI-PIN.md': `# pin\n${installerStamps}\n`,
      '.github/workflows/heavy-tests.yml': grokDoorWorkflow([
        'GROK_VERSION: "1.0.4"',
        'GROK_INSTALL_SHA256: "abc123"',
        'GROK_NPM_INTEGRITY: "sha512-AAA="',
      ]),
    }, (dir) => {
      const r = runGrokPinGuard(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('mode exclusivity');
    });
  });

  test('verify wiring: run-verify-parallel CHECKS + package.json both carry check:grok-pin', () => {
    const verify = require('node:fs').readFileSync(join(ROOT, 'scripts/run-verify-parallel.sh'), 'utf-8');
    expect(verify).toContain('"check:grok-pin"');
    const pkg = require('node:fs').readFileSync(join(ROOT, 'package.json'), 'utf-8');
    expect(pkg).toContain('"check:grok-pin": "bash scripts/check-grok-pin.sh"');
  });
});

// ── check-opencode-pin.sh ────────────────────────────────────────────────────

const OPENCODE_PIN_GUARD = join(ROOT, 'scripts/check-opencode-pin.sh');

function runOpencodePinGuard(fixtureRoot: string): { status: number | null; out: string } {
  const r = spawnSync('bash', [OPENCODE_PIN_GUARD], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, GBRAIN_OPENCODE_PIN_GUARD_ROOT: fixtureRoot },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const OPENCODE_PIN_STAMPS_NPM = [
  '<!-- opencode-pin: distribution_kind=npm -->',
  '<!-- opencode-pin: npm_package=opencode-ai -->',
  '<!-- opencode-pin: npm_version=1.18.18 -->',
  '<!-- opencode-pin: npm_integrity=sha512-BBB= -->',
  '<!-- opencode-pin: opencode_version=1.18.18 -->',
].join('\n');

function opencodeDoorWorkflow(envLines: string[]): string {
  return [
    'jobs:',
    '  other-job:',
    '    steps: []',
    '  opencode-door:',
    '    env:',
    ...envLines.map((l) => `      ${l}`),
    '    steps: []',
    '  opencode-door-canary:',
    '    env:',
    '      GBRAIN_REAL_OPENCODE_E2E: "1"', // deliberately UNPINNED — must not satisfy the check
    '    steps: []',
    '',
  ].join('\n');
}

const OPENCODE_NPM_ENV_OK = [
  'OPENCODE_VERSION: "1.18.18"',
  'OPENCODE_NPM_PACKAGE: "opencode-ai"',
  'OPENCODE_NPM_INTEGRITY: "sha512-BBB="',
];

describe('check-opencode-pin.sh', () => {
  test('ok: npm mode with matching workflow pins (anchored to the opencode-door block, canary leg ignored)', () => {
    withFixture({
      'docs/mcp/OPENCODE-CLI-PIN.md': `# pin\n${OPENCODE_PIN_STAMPS_NPM}\n`,
      '.github/workflows/heavy-tests.yml': opencodeDoorWorkflow(OPENCODE_NPM_ENV_OK),
    }, (dir) => {
      const r = runOpencodePinGuard(dir);
      expect(r.out).toContain('check-opencode-pin: ok');
      expect(r.status).toBe(0);
    });
  });

  test('SKIP-graceful pre-landing; FAIL-closed once the door job exists without the pin doc', () => {
    withFixture({
      '.github/workflows/heavy-tests.yml': opencodeDoorWorkflow(OPENCODE_NPM_ENV_OK),
    }, (dir) => {
      const r = runOpencodePinGuard(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('pin doc is the gate');
    });
    withFixture({
      'docs/mcp/OPENCODE-CLI-PIN.md': `# pin\n${OPENCODE_PIN_STAMPS_NPM}\n`,
      '.github/workflows/heavy-tests.yml': 'jobs:\n  other-job:\n    steps: []\n',
    }, (dir) => {
      const r = runOpencodePinGuard(dir);
      expect(r.out).toContain('SKIP');
      expect(r.status).toBe(0);
    });
  });

  test('FAIL: workflow OPENCODE_VERSION drifts from the opencode_version stamp', () => {
    withFixture({
      'docs/mcp/OPENCODE-CLI-PIN.md': `# pin\n${OPENCODE_PIN_STAMPS_NPM}\n`,
      '.github/workflows/heavy-tests.yml': opencodeDoorWorkflow([
        'OPENCODE_VERSION: "1.18.19"',
        'OPENCODE_NPM_PACKAGE: "opencode-ai"',
        'OPENCODE_NPM_INTEGRITY: "sha512-BBB="',
      ]),
    }, (dir) => {
      const r = runOpencodePinGuard(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('OPENCODE_VERSION drift');
    });
  });

  test('FAIL: npm_version stamp disagreeing with opencode_version can never pass green', () => {
    const stamps = OPENCODE_PIN_STAMPS_NPM.replace(
      '<!-- opencode-pin: npm_version=1.18.18 -->',
      '<!-- opencode-pin: npm_version=1.18.19 -->',
    );
    withFixture({
      'docs/mcp/OPENCODE-CLI-PIN.md': `# pin\n${stamps}\n`,
      '.github/workflows/heavy-tests.yml': opencodeDoorWorkflow(OPENCODE_NPM_ENV_OK),
    }, (dir) => {
      const r = runOpencodePinGuard(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('npm_version stamp');
    });
  });

  test('FAIL: linux platform-integrity stamps must match the job env (missing AND drifted)', () => {
    const stampsWithLinux = [
      OPENCODE_PIN_STAMPS_NPM,
      '<!-- opencode-pin: npm_linux_x64_integrity=sha512-X64= -->',
      '<!-- opencode-pin: npm_linux_arm64_integrity=sha512-ARM= -->',
    ].join('\n');
    // Missing from the job env → fail.
    withFixture({
      'docs/mcp/OPENCODE-CLI-PIN.md': `# pin\n${stampsWithLinux}\n`,
      '.github/workflows/heavy-tests.yml': opencodeDoorWorkflow(OPENCODE_NPM_ENV_OK),
    }, (dir) => {
      const r = runOpencodePinGuard(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('OPENCODE_NPM_LINUX_X64_INTEGRITY');
    });
    // Present but drifted → fail.
    withFixture({
      'docs/mcp/OPENCODE-CLI-PIN.md': `# pin\n${stampsWithLinux}\n`,
      '.github/workflows/heavy-tests.yml': opencodeDoorWorkflow([
        ...OPENCODE_NPM_ENV_OK,
        'OPENCODE_NPM_LINUX_X64_INTEGRITY: "sha512-X64="',
        'OPENCODE_NPM_LINUX_ARM64_INTEGRITY: "sha512-DRIFT="',
      ]),
    }, (dir) => {
      const r = runOpencodePinGuard(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('drift');
    });
    // Both matching → ok.
    withFixture({
      'docs/mcp/OPENCODE-CLI-PIN.md': `# pin\n${stampsWithLinux}\n`,
      '.github/workflows/heavy-tests.yml': opencodeDoorWorkflow([
        ...OPENCODE_NPM_ENV_OK,
        'OPENCODE_NPM_LINUX_X64_INTEGRITY: "sha512-X64="',
        'OPENCODE_NPM_LINUX_ARM64_INTEGRITY: "sha512-ARM="',
      ]),
    }, (dir) => {
      const r = runOpencodePinGuard(dir);
      expect(r.out).toContain('check-opencode-pin: ok');
      expect(r.status).toBe(0);
    });
  });

  test('FAIL: a second OPENCODE_VERSION copy elsewhere in the workflow disagreeing with the stamp', () => {
    // The real workflow carries a second OPENCODE_VERSION in the
    // real-agent-e2e job — every copy must move with the stamp.
    const workflow = [
      'jobs:',
      '  real-agent-e2e:',
      '    env:',
      '      OPENCODE_VERSION: "1.18.19"', // drifted second copy
      '    steps: []',
      '  opencode-door:',
      '    env:',
      ...OPENCODE_NPM_ENV_OK.map((l) => `      ${l}`),
      '    steps: []',
      '',
    ].join('\n');
    withFixture({
      'docs/mcp/OPENCODE-CLI-PIN.md': `# pin\n${OPENCODE_PIN_STAMPS_NPM}\n`,
      '.github/workflows/heavy-tests.yml': workflow,
    }, (dir) => {
      const r = runOpencodePinGuard(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('every copy in the workflow moves with the stamp');
    });
  });
});

// ── check-pin-doc-privacy.sh ─────────────────────────────────────────────────

const PIN_PRIVACY_GUARD = join(ROOT, 'scripts/check-pin-doc-privacy.sh');

function runPinPrivacyGuard(fixtureRoot: string): { status: number | null; out: string } {
  const r = spawnSync('bash', [PIN_PRIVACY_GUARD], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, GBRAIN_PIN_PRIVACY_GUARD_ROOT: fixtureRoot },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('check-pin-doc-privacy.sh', () => {
  test('ok: placeholder-disciplined pin doc (tmp paths, sha512 pins, example.com emails)', () => {
    withFixture({
      'docs/mcp/FAKE-CLI-PIN.md': [
        '# fake pin',
        '<!-- fake-pin: npm_integrity=sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA== -->',
        'Config lands at `<tmp>/.config/fake/config.json`; auth at `~/.local/share/fake/auth.json`.',
        'Support: docs@example.com; probe url https://fake.invalid/mcp.',
      ].join('\n'),
    }, (dir) => {
      const r = runPinPrivacyGuard(dir);
      expect(r.out).toContain('check-pin-doc-privacy: ok');
      expect(r.status).toBe(0);
    });
  });

  test('SKIP-graceful when no pin docs exist', () => {
    withFixture({ 'docs/mcp/OTHER.md': '# not a pin doc\n' }, (dir) => {
      const r = runPinPrivacyGuard(dir);
      expect(r.out).toContain('SKIP');
      expect(r.status).toBe(0);
    });
  });

  test('FAIL: operator home path in a verbatim transcript', () => {
    withFixture({
      'docs/mcp/FAKE-CLI-PIN.md': 'observed: wrote /Users/alicesmith/.config/fake/config.json\n',
    }, (dir) => {
      const r = runPinPrivacyGuard(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('operator home path');
    });
  });

  test('FAIL: key-shaped material outside a sha512 integrity line', () => {
    withFixture({
      'docs/mcp/FAKE-CLI-PIN.md': `observed header: Bearer sk-${'a'.repeat(24)}\n`,
    }, (dir) => {
      const r = runPinPrivacyGuard(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('key-shaped material');
    });
  });

  test('FAIL: a real-looking email address; example.com/invalid domains stay fine', () => {
    withFixture({
      'docs/mcp/FAKE-CLI-PIN.md': 'signed in as operator@realmail.com\n',
    }, (dir) => {
      const r = runPinPrivacyGuard(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('email');
    });
  });
});
