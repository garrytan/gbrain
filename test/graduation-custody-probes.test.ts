/**
 * #6774: an unavailable local boot-id or pid-namespace probe reads as unknown, never as a match.
 *
 * 1. Protects: markerLiveness returns 'unknown' when the marker recorded a boot id or pid namespace and this
 *    process cannot read its own, so the kernel lock stays the authority; a marker that recorded null keeps
 *    the pid check.
 * 2. Fails when: the comparison is skipped for a null local probe again, so a marker from another host or
 *    container reads 'alive' because a local process happens to have the same pid.
 * 3. test/graduation-custody.test.ts runs with real probes, which are readable on Linux CI, so it never reaches
 *    the null-probe branch.
 * 4. No production seam: the probe is mocked in a child process (test/fixtures/graduation-liveness-probe.ts).
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { IntentMarker } from '../src/core/persistence/engine-graduation.types.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'graduation-liveness-probe.ts');
const target = { id: 'target-id', host: 'db.example.test', port: 5432, database: 'brain', user: 'alice-example' };
/** This test process is alive and is not the child's pid, standing in for an unrelated local process with the recorded pid. */
function marker(identity: Pick<IntentMarker, 'bootId' | 'pidNs'>): IntentMarker {
  return { runId: 'run-6774', state: 'copying', pid: process.pid, processStart: null, target, updatedAt: new Date().toISOString(), ...identity } as IntentMarker;
}
function liveness(missing: 'bootId' | 'pidNs' | 'none', value: IntentMarker): string {
  const child = Bun.spawnSync([process.execPath, FIXTURE, missing, JSON.stringify(value)], { stdout: 'pipe', stderr: 'pipe' });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString();
}

describe('markerLiveness with an unavailable local probe', () => {
  test('a recorded boot id with no local boot id is unknown', () => {
    expect(liveness('bootId', marker({ bootId: 'boot-of-another-host', pidNs: null }))).toBe('unknown');
  });
  test('a recorded pid namespace with no local pid namespace is unknown', () => {
    expect(liveness('pidNs', marker({ bootId: null, pidNs: 'pid:[4026531836]' }))).toBe('unknown');
  });
  test('a marker that recorded neither probe still follows the pid', () => {
    expect(liveness('bootId', marker({ bootId: null, pidNs: null }))).toBe('alive');
    expect(liveness('pidNs', marker({ bootId: null, pidNs: null }))).toBe('alive');
  });
});
