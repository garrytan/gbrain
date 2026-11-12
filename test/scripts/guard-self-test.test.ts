/** Actual shell harness in isolated synthetic repositories: scheduling, lost
 * workers, complete negative coverage, ordered output and scratch ownership. */
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const HARNESS = readFileSync(resolve(import.meta.dir, '../../scripts/guard-self-test.sh'), 'utf8');
let root: string;
function write(path: string, text: string) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'guard-self-test-'));
  write('scripts/guard-self-test.sh', HARNESS);
  // Keep the native completeness globs nonempty without adding self-tests.
  write('scripts/check-unused.mjs', '');
  write('scripts/check-unused.ts', '');
  mkdirSync(join(root, 'scratch'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function guard(name: string, body = '') {
  write(`scripts/${name}`, `#!/usr/bin/env bash
set -u
fixture="\${GBRAIN_GUARD_ROOT##*/}"
printf 'start %s %s\\n' '${name}' "$fixture" >> events
${body}
printf 'end %s %s\\n' '${name}' "$fixture" >> events
case "$fixture" in good) exit 0 ;; *) exit 1 ;; esac
`);
  for (const variant of ['bad', 'good']) mkdirSync(join(root, 'test/fixtures/guards', name, variant), { recursive: true });
}
function manifest(names: string[]) {
  write('scripts/guards-manifest.tsv', names.map(n => `${n}\tscanner\tyes\ttest`).join('\n') + '\ncheck-unused.mjs\tscanner\ttodo\ttest\ncheck-unused.ts\tscanner\ttodo\ttest\n');
}
function run(jobs = '2') {
  return spawnSync('bash', ['scripts/guard-self-test.sh'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, GUARD_SELF_TEST_JOBS: jobs, TMPDIR: join(root, 'scratch') },
  });
}
it('refills a freed slot while the first worker waits; preserves every case and output order', () => {
  // Outcome rendezvous, not an elapsed-time performance assertion: a FIFO
  // wait cannot start c until a stops waiting, so a records a failure.
  guard('check-a.sh', `if [ "$fixture" = bad ]; then
  tries=0
  while [ ! -f c-started ] && [ "$tries" -lt 100 ]; do sleep 0.01; tries=$((tries + 1)); done
  if [ ! -f c-started ]; then exit 0; fi
fi`);
  guard('check-b.sh');
  guard('check-c.sh', 'touch c-started');
  mkdirSync(join(root, 'test/fixtures/guards/check-b.sh/bad-extra'));
  manifest(['check-a.sh', 'check-b.sh', 'check-c.sh']);
  const r = run();
  expect(r.status).toBe(0);
  expect(r.stdout.match(/^ok /gm)).toHaveLength(3);
  expect(r.stdout.indexOf('ok    check-a.sh')).toBeLessThan(r.stdout.indexOf('ok    check-b.sh'));
  const events = readFileSync(join(root, 'events'), 'utf8').trim().split('\n');
  let active = 0, peak = 0;
  for (const event of events) { active += event.startsWith('start ') ? 1 : -1; peak = Math.max(peak, active); }
  expect(active).toBe(0);
  expect(peak).toBeLessThanOrEqual(2);
  for (const [name, cases] of [['check-a.sh', ['bad', 'good']], ['check-b.sh', ['bad', 'bad-extra', 'good']], ['check-c.sh', ['bad', 'good']]] as const) {
    for (const fixture of cases) {
      expect(events.filter(e => e === `start ${name} ${fixture}`)).toHaveLength(1);
      expect(events.filter(e => e === `end ${name} ${fixture}`)).toHaveLength(1);
    }
  }
  expect(readdirSync(join(root, 'scratch'))).toEqual([]);
});
it('propagates a missed negative and false positive while still completing other guards', () => {
  guard('check-noop.sh', 'exit 0');
  guard('check-reject.sh', 'exit 7');
  guard('check-last.sh');
  manifest(['check-noop.sh', 'check-reject.sh', 'check-last.sh']);
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stdout).toContain('did NOT flag the known-bad');
  expect(r.stdout).toContain('flagged the known-good');
  expect(r.stdout).toContain('ok    check-last.sh');
  expect(readdirSync(join(root, 'scratch'))).toEqual([]);
});
it('fails closed when a worker is killed before recording a result, and drains other workers', () => {
  guard('check-crash.sh', 'kill -KILL "$PPID"; exit 1');
  guard('check-last.sh');
  manifest(['check-crash.sh', 'check-last.sh']);
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stdout).toContain('self-test worker exited without completing');
  expect(r.stdout).toContain('ok    check-last.sh');
  expect(readdirSync(join(root, 'scratch'))).toEqual([]);
});
it('retains missing fixture and manifest-completeness failures', () => {
  guard('check-orphan.sh');
  manifest(['check-missing.sh']);
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stdout).toContain('fixtures missing');
  expect(r.stdout).toContain('check-orphan.sh: no row');
});
it('rejects invalid worker limits before starting guards', () => {
  guard('check-a.sh'); manifest(['check-a.sh']);
  for (const jobs of ['0', '-1', 'x', '65', '999999999999999999999']) {
    const r = run(jobs);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('must be an integer from 1 to 64');
  }
  expect(readdirSync(join(root, 'scratch'))).toEqual([]);
});
