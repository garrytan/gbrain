import { describe, expect, test } from 'bun:test';
import { mkdtempSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inspectAutopilotLock } from '../src/commands/autopilot.ts';

describe('inspectAutopilotLock', () => {
  test('fresh lock with a live pid stays authoritative', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-live-'));
    const lockPath = join(dir, 'autopilot.lock');
    writeFileSync(lockPath, '4242');

    const state = inspectAutopilotLock(lockPath, Date.now(), (pid) => pid === 4242);

    expect(state).toEqual({
      exists: true,
      pid: 4242,
      running: true,
      fresh: true,
    });
  });

  test('fresh lock with a dead pid does not block takeover', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-dead-'));
    const lockPath = join(dir, 'autopilot.lock');
    writeFileSync(lockPath, '84228');

    const state = inspectAutopilotLock(lockPath, Date.now(), () => false);

    expect(state).toEqual({
      exists: true,
      pid: 84228,
      running: false,
      fresh: true,
    });
  });

  test('old lock stays stale even if the pid probe would say alive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-old-'));
    const lockPath = join(dir, 'autopilot.lock');
    writeFileSync(lockPath, '777');

    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(lockPath, elevenMinutesAgo, elevenMinutesAgo);

    const state = inspectAutopilotLock(lockPath, Date.now(), () => true);

    expect(state).toEqual({
      exists: true,
      pid: 777,
      running: true,
      fresh: false,
    });
  });

  test('invalid lock contents fall back to non-running takeover', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-bad-'));
    const lockPath = join(dir, 'autopilot.lock');
    writeFileSync(lockPath, 'not-a-pid');

    const state = inspectAutopilotLock(lockPath, Date.now(), () => true);

    expect(state).toEqual({
      exists: true,
      pid: null,
      running: false,
      fresh: true,
    });
  });
});
