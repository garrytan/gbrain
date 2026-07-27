/**
 * Unit tests for the shared supervisor PID-file reader (issue #1815, Q4).
 * One regression point now backs `jobs supervisor status`, `jobs stats`, and
 * `gbrain doctor`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readSupervisorPid } from '../src/core/minions/supervisor-pid.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gbrain-suppid-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('readSupervisorPid', () => {
  test('present + alive → running', () => {
    const f = join(dir, 'sup.pid');
    writeFileSync(f, `${process.pid}\n`);
    const r = readSupervisorPid(f);
    expect(r.pid).toBe(process.pid);
    expect(r.running).toBe(true);
  });

  test('present + dead → pid set, not running', () => {
    const f = join(dir, 'sup.pid');
    writeFileSync(f, '2147483600\n');
    const r = readSupervisorPid(f);
    expect(r.pid).toBe(2147483600);
    expect(r.running).toBe(false);
  });

  test('missing file → null, not running', () => {
    const r = readSupervisorPid(join(dir, 'nope.pid'));
    expect(r.pid).toBeNull();
    expect(r.running).toBe(false);
  });

  test('corrupt content → null, not running', () => {
    const f = join(dir, 'sup.pid');
    writeFileSync(f, 'not-a-pid\n');
    const r = readSupervisorPid(f);
    expect(r.pid).toBeNull();
    expect(r.running).toBe(false);
  });
});
