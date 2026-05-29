import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkPgliteBackupRetention } from '../src/commands/doctor.ts';

let scratch: string;

beforeEach(() => {
  scratch = join(tmpdir(), `gbrain-pglite-retention-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('pglite_backup_retention doctor check', () => {
  test('ok when there are no backup dirs', () => {
    mkdirSync(join(scratch, 'brain.pglite'));
    const check = checkPgliteBackupRetention(scratch);
    expect(check.status).toBe('ok');
    expect(check.message).toMatch(/No extra PGLite backup dirs/);
  });

  test('warns on known-bad recovery dirs but does not delete them', () => {
    mkdirSync(join(scratch, 'brain.pglite'));
    mkdirSync(join(scratch, 'brain.pglite.corrupt-20260528223051'));
    mkdirSync(join(scratch, 'brain.pglite.bad-dim-20260528224517'));

    const check = checkPgliteBackupRetention(scratch);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('known-bad PGLite recovery dir');
    expect(check.message).toContain('brain.pglite.corrupt-20260528223051');
    expect(check.message).toContain('brain.pglite.bad-dim-20260528224517');
  });
});
