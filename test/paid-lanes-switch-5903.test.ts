/**
 * #5903: the repository variable GBRAIN_PAID_LANES='0' switches every paid CI
 * lane off (tier2 in e2e.yml, the hermes door paid leg and the OpenCode
 * credentialed lane in heavy-tests.yml), and e2e-status accepts a skipped
 * tier2 only when exactly that variable authorized it ([R21]).
 *
 * The aggregate step reads every job result from env, so this test runs the
 * step's real script under bash with each result combination.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

const ROOT = join(import.meta.dir, '..');
const E2E = readFileSync(join(ROOT, '.github/workflows/e2e.yml'), 'utf8');
const HEAVY = readFileSync(join(ROOT, '.github/workflows/heavy-tests.yml'), 'utf8');

type Step = { name?: string; id?: string; env?: Record<string, string>; run?: string; if?: string };
type Job = { if?: string; needs?: string[]; steps: Step[]; strategy?: { matrix?: Record<string, string> } };
const e2eJobs = (load(E2E) as { jobs: Record<string, Job> }).jobs;
const heavyJobs = (load(HEAVY) as { jobs: Record<string, Job> }).jobs;

const aggregate = e2eJobs['e2e-status'].steps.find((s) => s.name === 'Aggregate result');
if (!aggregate?.run || !aggregate.env) throw new Error('e2e-status has no "Aggregate result" step with env + run');

const GREEN = {
  JSONB: 'success',
  TIER1: 'success',
  BACKEND_MATRIX: 'success',
  TIER2: 'success',
  PREPARE: 'success',
  SELECTED: 'success',
  FULL_UNIT: 'success',
  FULL_SERIAL: 'success',
  FULL_SLOW: 'success',
  FULL_E2E: 'success',
  FULL_CORPUS: 'false',
  EVENT: 'pull_request',
  GBRAIN_PAID_LANES: '',
};

function runAggregate(overrides: Partial<typeof GREEN>) {
  const dir = mkdtempSync(join(tmpdir(), 'paid-lanes-5903-'));
  const summary = join(dir, 'summary.md');
  try {
    const proc = spawnSync('bash', ['-e', '-c', aggregate!.run!], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...GREEN, ...overrides, GITHUB_STEP_SUMMARY: summary },
      encoding: 'utf8',
    });
    let summaryText = '';
    try {
      summaryText = readFileSync(summary, 'utf8');
    } catch {}
    return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr, summary: summaryText };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('#5903 GBRAIN_PAID_LANES switches every paid lane off', () => {
  test('tier2 is gated on the variable and e2e-status reads it from env', () => {
    expect(e2eJobs.tier2.if).toBe("format('{0}', vars.GBRAIN_PAID_LANES) != '0'");
    expect(aggregate!.env!.GBRAIN_PAID_LANES).toBe('${{ vars.GBRAIN_PAID_LANES }}');
    expect(aggregate!.env!.TIER2).toBe('${{ needs.tier2.result }}');
    expect(e2eJobs['e2e-status'].needs).toContain('tier2');
  });

  test('hermes paidgate honours the variable before the secret check', () => {
    const gate = heavyJobs['hermes-door'].steps.find((s) => s.id === 'paidgate');
    expect(gate?.env?.GBRAIN_PAID_LANES).toBe('${{ vars.GBRAIN_PAID_LANES }}');
    const run = gate!.run!;
    const switchOff = run.indexOf('if [ "${GBRAIN_PAID_LANES:-}" = "0" ]; then');
    const secretCheck = run.indexOf('if [ -z "$ANTHROPIC_API_KEY" ]; then');
    expect(switchOff).toBeGreaterThan(-1);
    expect(switchOff).toBeLessThan(secretCheck);
    expect(run.slice(switchOff, secretCheck)).toContain('echo "paid=false" >> "$GITHUB_OUTPUT"');
    expect(run.slice(switchOff, secretCheck)).toContain('exit 0');
  });

  test("hermes paidgate with the variable at '0' is a visible skip even with the secret set", () => {
    const hermes = heavyJobs['hermes-door'] as Job & { env: Record<string, string> };
    const gate = hermes.steps.find((s) => s.id === 'paidgate')!;
    const home = mkdtempSync(join(tmpdir(), 'paid-lanes-5903-hermes-'));
    try {
      const bin = join(home, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'hermes'), `#!/bin/sh\necho 'Hermes Agent v${hermes.env.HERMES_VERSION} (2026.8.3)'\n`, { mode: 0o755 });
      const output = join(home, 'output');
      const summary = join(home, 'summary');
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', gate.run!], {
        env: {
          PATH: `${bin}:${process.env.PATH}`, ...hermes.env, ANTHROPIC_API_KEY: 'set', GBRAIN_PAID_LANES: '0',
          GITHUB_EVENT_NAME: 'schedule', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
        },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, 'utf8')).toContain('paid=false');
      expect(result.stderr).toContain("paid lanes disabled by the repository variable GBRAIN_PAID_LANES='0'");
      expect(readFileSync(summary, 'utf8')).toContain('paid leg skipped (paid lanes disabled)');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('OpenCode credentialed lane stays keyless-only when the variable is 0', () => {
    const lane = heavyJobs['opencode-door'].strategy?.matrix?.lane ?? '';
    expect(lane).toContain("format('{0}', vars.GBRAIN_PAID_LANES) != '0' && '[\"keyless\",\"credentialed\"]'");
  });
});

describe('#5903 e2e-status accepts a skipped tier2 only under GBRAIN_PAID_LANES=0', () => {
  test('all green passes', () => {
    expect(runAggregate({}).status).toBe(0);
  });

  test('tier2 skipped with the variable unset fails', () => {
    const r = runAggregate({ TIER2: 'skipped' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('gated e2e job did not succeed (got skipped)');
  });

  test("tier2 skipped with the variable at '1' or 'false' fails", () => {
    expect(runAggregate({ TIER2: 'skipped', GBRAIN_PAID_LANES: '1' }).status).toBe(1);
    expect(runAggregate({ TIER2: 'skipped', GBRAIN_PAID_LANES: 'false' }).status).toBe(1);
  });

  test("tier2 skipped with the variable at '0' passes and says it is not coverage", () => {
    const r = runAggregate({ TIER2: 'skipped', GBRAIN_PAID_LANES: '0' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("paid lanes disabled by the repository variable GBRAIN_PAID_LANES='0'");
    expect(r.stdout).toContain('✓ all required e2e jobs succeeded');
    expect(r.summary).toContain('not green coverage of Tier 2');
  });

  test("the variable at '0' does not excuse a failed or cancelled tier2", () => {
    expect(runAggregate({ TIER2: 'failure', GBRAIN_PAID_LANES: '0' }).status).toBe(1);
    expect(runAggregate({ TIER2: 'cancelled', GBRAIN_PAID_LANES: '0' }).status).toBe(1);
  });

  test("the variable at '0' does not excuse any other skipped lane", () => {
    for (const key of ['JSONB', 'TIER1', 'BACKEND_MATRIX', 'PREPARE', 'SELECTED'] as const) {
      const r = runAggregate({ [key]: 'skipped', GBRAIN_PAID_LANES: '0' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('got skipped');
    }
  });

  test('full-corpus jobs are still required when FULL_CORPUS=true', () => {
    expect(runAggregate({ FULL_CORPUS: 'true' }).status).toBe(0);
    const r = runAggregate({ FULL_CORPUS: 'true', FULL_SLOW: 'skipped', GBRAIN_PAID_LANES: '0' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('full-corpus job did not succeed (got skipped)');
  });
});
