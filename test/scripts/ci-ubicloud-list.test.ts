/**
 * scripts/ci-ubicloud.ts --list — the remote gate's test inventory.
 *
 * Protects: the file list gstack-pregate clear --run checks full-ci runs
 * against (scripts/pregate-remote-gate.sh --list, docs/ci-event-parity.md#remote-gate-reuse).
 * Fails when: --list stops printing exactly the files the gate's lanes run
 * (the same dry-run discovery), prints anything else on stdout, needs a key or
 * an owner, exits 0 with nothing to list, or the keyed-only E2E files the gate
 * leaves out drift from the files e2e.yml's keyed Tier 2 job runs; or a gate file
 * that GitHub runs outside the receipt lanes (the reconciliation crash suites)
 * loses its receipt, so no full-ci run could cover it.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { KEYED_E2E } from '../../scripts/ci-ubicloud.ts';
import { readArmsList } from '../../scripts/postgres-unit-arms.ts';

const root = join(import.meta.dir, '../..');
const env = { ...process.env, UBICLOUD_API_KEY: undefined, UBICLOUD_API_TOKEN: undefined, UBI_OWNER: undefined, UBI_LEFT_FILE: undefined };
const list = (...args: string[]) => spawnSync('bun', ['scripts/ci-ubicloud.ts', ...args, '--list'], { cwd: root, encoding: 'utf8', env });
const dry = (script: string, flag = '--dry-run-list') => spawnSync('bash', [`scripts/${script}`, flag], { cwd: root, encoding: 'utf8' }).stdout.split(/\s+/).filter(Boolean);
type Job = { steps?: Array<{ run?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string> }> };
const workflow = (name: string) => load(readFileSync(join(root, '.github/workflows', name), 'utf8')) as { jobs: Record<string, Job> };
const testFiles = (job: Job) => (job.steps ?? []).flatMap(s => s.run?.match(/test\/\S+\.test\.ts/g) ?? []);

describe('ci-ubicloud.ts --list', () => {
  test('prints the files of every lane, sorted and once each, with no key, owner or VM', () => {
    const r = list();
    expect(r.status, r.stderr).toBe(0);
    const expected = new Set([
      ...dry('run-unit-shard.sh'), ...dry('run-serial-tests.sh'), ...dry('run-serial-tests.sh', '--dry-run-list-exclusive'),
      ...dry('run-slow-tests.sh'), ...dry('run-slow-tests.sh', '--dry-run-list-exclusive'),
      ...readArmsList(root).files, ...dry('run-e2e.sh').filter(f => !KEYED_E2E.includes(f)),
    ]);
    expect(r.stdout).toBe([...expected].sort().join('\n') + '\n');
    expect(r.stdout).not.toContain('UBICLOUD:');
    expect(r.stdout.split('\n').filter(Boolean).every(f => /^(test|evals)\/.+\.test\.ts$/.test(f))).toBe(true);
  });

  test('a selection with no test lane exits 1 with an empty list', () => {
    const r = list('--lanes', 'gitleaks,verify');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('the gate runs no test file on this tree (lanes: gitleaks,verify)');
  });

  test('the gate leaves out exactly the keyed-only files that e2e.yml runs only in its keyed Tier 2 job', () => {
    expect(testFiles(workflow('e2e.yml').jobs.tier2!).sort()).toEqual([...KEYED_E2E].sort());
    const e2e = list('--lanes', 'e2e');
    expect(e2e.status, e2e.stderr).toBe(0);
    for (const file of KEYED_E2E) {
      expect(dry('run-e2e.sh')).toContain(file);
      expect(e2e.stdout.split('\n')).not.toContain(file);
    }
  });

  test('the reconciliation crash suites run with receipts, so the Test run manifest lists them', () => {
    const job = workflow('persistence-validation.yml').jobs.reconciliation!;
    const runs = job.steps!.filter(s => /reconcile-crash/.test(s.run ?? ''));
    expect(runs.length).toBe(1);
    const lines = runs[0]!.run!.split('\n').filter(l => /reconcile-crash/.test(l));
    expect(lines.length).toBe(2);
    for (const line of lines) expect(line).toMatch(/bash scripts\/run-with-receipt\.sh reconciliation (postgres|pglite)-bun-\$\{\{ matrix\.bun \}\} -- bun --no-env-file test /);
    expect(runs[0]!.env!.GBRAIN_TEST_RECEIPT_DIR).toBe('${{ runner.temp }}/receipts');
    const upload = job.steps!.find(s => s.uses?.startsWith('actions/upload-artifact@') && s.with?.name?.startsWith('receipts-'))!;
    expect(upload.with!.path).toBe('${{ runner.temp }}/receipts');
    const gate = list().stdout.split('\n').filter(f => f.includes('reconcile-crash'));
    expect(gate.length).toBeGreaterThan(0);
    for (const file of gate) expect(lines.some(l => l.includes(file) || (file.endsWith('.slow.test.ts') && l.includes('test/reconcile-crash-*.slow.test.ts')))).toBe(true);
  });
});
