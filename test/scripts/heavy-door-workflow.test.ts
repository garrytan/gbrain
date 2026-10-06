import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';

type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
type Job = { name: string; env: Record<string, string>; strategy?: { 'fail-fast': boolean; matrix: { lane: string } }; steps: Step[] };
const root = join(import.meta.dir, '../..');
const workflow = load(readFileSync(join(root, '.github/workflows/heavy-tests.yml'), 'utf8')) as {
  on: { workflow_dispatch: { inputs: Record<string, { default: boolean }> } };
  jobs: Record<string, Job>;
};
const hermes = workflow.jobs['hermes-door'];
const opencode = workflow.jobs['opencode-door'];

describe('heavy door supply chain and coverage gates', () => {
  test('isolated sync logs are retained in heavy artifacts', () => {
    const steps = workflow.jobs.heavy.steps;
    expect(steps.find(step => step.name === 'Run heavy tests')?.env?.GBRAIN_HEAVY_LOG_DIR)
      .toBe('${{ runner.temp }}/gbrain-heavy-logs');
    expect(steps.find(step => step.name === 'Stage heavy-test logs into workspace')?.run)
      .toContain('cp -r "$RUNNER_TEMP/gbrain-heavy-logs"/. heavy-artifacts/');
  });

  test('Hermes fetches the reviewed immutable installer and verifies it before execution', () => {
    const install = hermes.steps.find(step => step.name === 'Install hermes (pinned installer digest)')!.run!;
    expect(install).toContain('https://raw.githubusercontent.com/NousResearch/hermes-agent/95d42656021a22f20201c618a67da07a618d16f3/scripts/install.sh');
    expect(hermes.env.HERMES_INSTALL_SHA256).toBe('5854b15670b51a8daae8f59ddfa917062de9f74be261eb73b4b8d719710f8968');
    expect(install.indexOf('sha256sum -c -')).toBeLessThan(install.indexOf('bash hermes-install.sh'));
    expect(install).toContain('--commit "$HERMES_GIT_COMMIT"');
    expect(install).toContain('actual_commit');
    const home = mkdtempSync(join(tmpdir(), 'gbrain-hermes-digest-test-'));
    try {
      writeFileSync(join(home, 'hermes-install.sh'), 'unreviewed generic installer fixture\n');
      const verification = install.slice(install.indexOf('if ! echo'), install.indexOf('for attempt'));
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', verification], {
        cwd: home, env: { PATH: process.env.PATH, ...hermes.env }, encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('installer digest drift');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('OpenCode defaults to keyless and explicitly requests a separate credentialed lane', () => {
    expect(workflow.on.workflow_dispatch.inputs.run_opencode_paid.default).toBe(false);
    expect(opencode.strategy?.matrix.lane).toBe('${{ fromJSON((inputs.run_opencode_paid || vars.GBRAIN_OPENCODE_PAID_E2E == \'1\') && \'["keyless","credentialed"]\' || \'["keyless"]\') }}');
    expect(opencode.strategy?.['fail-fast']).toBe(false);
    expect(opencode.env.ANTHROPIC_API_KEY).toBeUndefined();
    const keyless = opencode.steps.find(step => step.name?.startsWith('Run opencode door tests (keyless'))!;
    expect(keyless.if).toBe("matrix.lane == 'keyless'");
    expect(keyless.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(keyless.run).toContain('[ "$pass_count" != "5" ]');
    const paid = opencode.steps.find(step => step.name === 'Run opencode door tests (credentialed tier only)')!;
    expect(paid.if).toBe("steps.paidgate.outputs.paid == 'true'");
    expect(paid.env?.GBRAIN_REAL_OPENCODE_PAID_E2E).toBe('1');
    expect(paid.run).toContain("--test-name-pattern 'paid tier'");
    expect(paid.run).toContain('[ "$pass_count" != "1" ]');
    expect(opencode.steps.find(step => step.name === 'Upload opencode door evidence')?.with?.name).toContain('${{ matrix.lane }}');
  });

  test('requested OpenCode credentialed coverage fails honestly for absent or blank credentials', () => {
    const gate = opencode.steps.find(step => step.id === 'paidgate')!;
    expect(gate.if).toBe("matrix.lane == 'credentialed'");
    for (const key of [undefined, '', ' \t\n']) {
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', gate.run!], {
        env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: key }, encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('No paid turn ran');
      expect(result.stdout).not.toContain('paid=true');
    }
  });

  test('Docker bootstrap e2e has no existence guard that could turn a missing script green', () => {
    const step = workflow.jobs.heavy.steps.find(s => s.name === 'Bootstrap offline Docker e2e')!;
    expect(step.run!.trim()).toBe('bash tests/docker/bootstrap-e2e.sh');
  });

  test('the Claude plugin door reports even when the Codex door failed', () => {
    const claude = workflow.jobs['plugin-doors'].steps.find(s => s.name?.startsWith('Claude plugin door'))!;
    expect(claude.if).toBe('${{ !cancelled() }}');
  });

  test('Hermes with an empty ANTHROPIC_API_KEY is a visible, tracked skip on a scheduled run', () => {
    const gate = hermes.steps.find(step => step.id === 'paidgate')!;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-hermes-gate-test-'));
    try {
      const bin = join(home, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'hermes'), `#!/bin/sh\necho 'Hermes Agent v${hermes.env.HERMES_VERSION} (2026.8.3)'\n`, { mode: 0o755 });
      const output = join(home, 'output');
      const summary = join(home, 'summary');
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', gate.run!], {
        env: {
          PATH: `${bin}:${process.env.PATH}`, ...hermes.env, ANTHROPIC_API_KEY: '',
          GITHUB_EVENT_NAME: 'schedule', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
        },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, 'utf8')).toContain('paid=false');
      expect(result.stderr).toContain('Fix (owner-only): gh secret set ANTHROPIC_API_KEY');
      expect(readFileSync(summary, 'utf8')).toContain('known-skipped');
      expect(hermes.steps.find(step => step.name === 'Run hermes door tests')!.if).toBe("steps.paidgate.outputs.paid == 'true'");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('real-agent e2e without provider secrets warns that 0 live tests ran and names the fix', () => {
    const job = workflow.jobs['real-agent-e2e'];
    const gate = job.steps.find(step => step.id === 'keys')!;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-real-agent-gate-test-'));
    try {
      const output = join(home, 'output');
      const summary = join(home, 'summary');
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', gate.run!], {
        env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'set', OPENAI_API_KEY: '', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, 'utf8')).toContain('keyed=false');
      expect(result.stderr).toContain('::warning::Real-agent door e2e executed 0 live claude/codex tests');
      expect(result.stderr).toContain('gh secret set OPENAI_API_KEY');
      expect(result.stderr).toContain('gh workflow run heavy-tests.yml');
      expect(result.stderr).toContain('real-agent-e2e');
      expect(readFileSync(summary, 'utf8')).toContain('0 live tests executed');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    const run = job.steps.find(step => step.name === 'Run real-agent door tests')!;
    expect(run.env?.GBRAIN_TEST_KEEP_PROVIDER_KEYS).toContain("'1'");
    expect(run.env?.CODEX_API_KEY).toContain('secrets.OPENAI_API_KEY');
    expect(run.run).toContain("'bootstrap real Claude Code door' 'bootstrap real-codex door'");
  });
});
