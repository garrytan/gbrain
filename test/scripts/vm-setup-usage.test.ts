/**
 * VM setup scripts document the ubi-runner command that boots them. A VM's name carries a 3-hour default TTL and the
 * reaper destroys it after that, so a documented `ubi-runner.sh run` without `--ttl-hours` ends a longer soak or
 * eval arm mid-run (#8096, #8103). Each script must also parse.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const SCRIPTS = [
  'docs/eval/system-one/runners/ubicloud-setup.sh',
  'scripts/bench/production-soak/vm-setup.sh',
  'scripts/bench/stall-repro-vm-setup.sh',
];

describe('VM setup script usage lines', () => {
  it.each(SCRIPTS)('%s parses and its documented ubi-runner run passes --ttl-hours', (path) => {
    const file = join(ROOT, path);
    const parse = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    expect(parse.status, parse.stderr).toBe(0);
    const usage = readFileSync(file, 'utf8').split('\n').filter(line => line.startsWith('#') && line.includes('ubi-runner.sh run'));
    expect(usage.length).toBeGreaterThan(0);
    for (const line of usage) expect(line).toContain('--ttl-hours');
  });
});
