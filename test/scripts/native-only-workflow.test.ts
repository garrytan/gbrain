import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { load } from 'js-yaml';

type Job = { if?: string; name?: string; needs?: string[]; uses?: string; steps?: Array<{ name: string; run?: string }> };
const workflow = load(readFileSync(join(import.meta.dir, '../../.github/workflows/test.yml'), 'utf8')) as {
  on: { workflow_dispatch: { inputs: Record<string, { type: string; default: boolean | string }> } };
  concurrency: { group: string; 'cancel-in-progress': boolean }; jobs: Record<string, Job>;
};
type Diagnostic = { race_hunt?: boolean; stress_files?: string; stress_base?: string };
function context(event: string, flag?: boolean, diagnostic: Diagnostic = {}) {
  // Dispatch inputs carry their declared defaults; other events have no inputs.
  const inputs = event === 'workflow_dispatch' ? { native_only: flag, race_hunt: false, stress_files: '', stress_base: '', stress_head: '', ...diagnostic } : {};
  return { format: (f: string, ...a: unknown[]) => f.replace(/\{(\d+)\}/g, (_, i) => String(a[Number(i)])), github: { workflow: 'Test', event_name: event, ref: 'refs/heads/example', run_id: '77', event: { pull_request: event === 'pull_request' ? { number: 123 } : {} } },
    inputs, always: () => true };
}
function evaluate(expression: string, event: string, flag?: boolean, diagnostic?: Diagnostic): unknown {
  return runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), context(event, flag, diagnostic), { timeout: 100 });
}
function template(value: string, event: string, flag?: boolean, diagnostic?: Diagnostic): string {
  return value.replace(/\$\{\{(.*?)\}\}/g, (_, expression) => String(evaluate(expression.trim(), event, flag, diagnostic)));
}

describe('native-only CI remains separate from full validation', () => {
  test('only an explicit manual boolean skips full jobs; default and PR/push gates stay required', () => {
    expect(workflow.on.workflow_dispatch.inputs.native_only).toMatchObject({ type: 'boolean', default: false });
    expect(workflow.jobs['native-locks'].uses).toBe('./.github/workflows/native-locks.yml');
    expect(workflow.jobs.changes.if).toBeUndefined();
    expect(workflow.jobs['native-locks'].needs).toEqual(['changes']);
    const ownModes = new Set(['native-locks', 'changes', 'stress-changed-tests', 'race-hunt']);
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (ownModes.has(name)) continue;
      expect(job.if).toBeDefined();
      const nativeStatus = name === 'native-only-status';
      for (const event of ['push', 'pull_request', 'workflow_dispatch']) {
        for (const flag of [undefined, false, true]) {
          const nativeOnly = event === 'workflow_dispatch' && flag === true;
          expect(Boolean(evaluate(job.if!, event, flag)), `${name}/${event}/${flag}`).toBe(nativeStatus ? nativeOnly : !nativeOnly);
        }
      }
    }
    // native-locks runs in every full or native-only run and skips only in a diagnostic dispatch.
    for (const event of ['push', 'pull_request', 'schedule']) expect(Boolean(evaluate(workflow.jobs['native-locks'].if!, event))).toBe(true);
    expect(Boolean(evaluate(workflow.jobs['native-locks'].if!, 'workflow_dispatch', true))).toBe(true);
    expect(workflow.jobs['test-status'].needs).toContain('native-locks');
    expect(workflow.jobs['test-status'].needs).toContain('persistence-validation');
  });

  test('a diagnostic dispatch (race_hunt or stress inputs) runs only its lane and never emits test-status', () => {
    for (const input of ['race_hunt', 'stress_files', 'stress_base'] as const) {
      expect(workflow.on.workflow_dispatch.inputs[input]).toBeDefined();
      const diagnostic: Diagnostic = input === 'race_hunt' ? { race_hunt: true } : { [input]: input === 'stress_files' ? 'test/a.test.ts' : 'origin/master' };
      for (const [name, job] of Object.entries(workflow.jobs)) {
        if (name === 'changes') continue;
        const runs = Boolean(evaluate(job.if!, 'workflow_dispatch', false, diagnostic));
        const expected = name === 'stress-changed-tests' || (name === 'race-hunt' && input === 'race_hunt');
        expect(runs, `${name} under ${input}`).toBe(expected);
      }
      expect(template(workflow.jobs['test-status'].name!, 'workflow_dispatch', false, diagnostic)).toBe('full-suite-not-run');
      expect(template(workflow.concurrency.group, 'workflow_dispatch', false, diagnostic)).toBe('Test-refs/heads/example-diagnostic-77');
    }
    // Outside dispatch the gate always runs (and decides "not a PR event" itself); the race hunt runs only on schedule.
    for (const event of ['push', 'pull_request', 'merge_group', 'schedule']) {
      expect(Boolean(evaluate(workflow.jobs['stress-changed-tests'].if!, event))).toBe(true);
      expect(Boolean(evaluate(workflow.jobs['race-hunt'].if!, event))).toBe(event === 'schedule');
    }
    expect(workflow.jobs['test-status'].needs).toContain('stress-changed-tests');
    expect(workflow.jobs['test-status'].needs).not.toContain('race-hunt');
  });

  test('a native retry cannot cancel a full run or emit its required aggregate check name', () => {
    const full = template(workflow.concurrency.group, 'workflow_dispatch', false);
    expect(full).toBe('Test-refs/heads/example');
    const native = template(workflow.concurrency.group, 'workflow_dispatch', true);
    expect(native).not.toBe(full);
    expect(native).toBe('Test-refs/heads/example-native-only');
    expect(template(workflow.concurrency.group, 'pull_request', true)).toBe('Test-123');
    expect(template(workflow.concurrency.group, 'push', true)).toBe(full);
    expect(workflow.concurrency['cancel-in-progress']).toBe(true);
    expect(template(workflow.jobs['test-status'].name!, 'workflow_dispatch', false)).toBe('test-status');
    expect(template(workflow.jobs['test-status'].name!, 'workflow_dispatch', true)).not.toBe('test-status');
    expect(workflow.jobs['native-only-status'].needs).toEqual(['native-locks']);
  });

  test.each(['success', 'failure', 'cancelled', 'skipped'])('%s produces an honest native-only scope artifact and result', result => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-native-scope-'));
    try {
      const steps = workflow.jobs['native-only-status'].steps!;
      const record = steps.find(step => step.name === 'Record validation scope')!.run!;
      const env = { PATH: process.env.PATH, GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '12345',
        GITHUB_STEP_SUMMARY: join(root, 'summary.md'), NATIVE_RESULT: result };
      const written = spawnSync('bash', ['-c', record], { cwd: root, env, encoding: 'utf8' });
      expect(written.status, written.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(root, 'native-only-scope.json'), 'utf8'))).toEqual({
        scope: 'native-only', full_ci: false, head: 'a'.repeat(40), run_id: '12345', native_result: result,
      });
      expect(readFileSync(join(root, 'summary.md'), 'utf8')).toContain('full Test suite was not run');
      const gate = steps.find(step => step.name === 'Require native success')!.run!;
      const gated = spawnSync('bash', ['-c', gate], { cwd: root, env, encoding: 'utf8' });
      expect(gated.status).toBe(result === 'success' ? 0 : 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
