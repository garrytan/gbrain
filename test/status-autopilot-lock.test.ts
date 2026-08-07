import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildAutopilotStatus } from '../src/commands/status.ts';

let tmp: string;
let lockPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-status-autopilot-lock-'));
  lockPath = join(tmp, 'autopilot.lock');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('buildAutopilotStatus', () => {
  test('reports a reused foreign PID lock as stale, not running', () => {
    writeFileSync(lockPath, '1234');
    const status = buildAutopilotStatus(lockPath, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => '/sbin/launchd',
    });

    expect(status).toEqual({
      installed: true,
      lockfile_present: true,
      pid: 1234,
      running: false,
    });
  });

  test('reports a live gbrain autopilot process as running', () => {
    writeFileSync(lockPath, '1234');
    const status = buildAutopilotStatus(lockPath, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => 'gbrain autopilot --repo repo',
    });

    expect(status.running).toBe(true);
    expect(status.pid).toBe(1234);
  });
});
