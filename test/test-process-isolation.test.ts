import { expect, test } from 'bun:test';
import { homedir } from 'os';
import { isAbsolute, join, relative, resolve } from 'path';
import { configDir } from '../src/core/config.ts';
import { syncFailuresPath } from '../src/core/sync.ts';
import { resolveAuditDir } from '../src/core/minions/backpressure-audit.ts';

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

test('bun test preload keeps every default writer outside the operator gbrain', () => {
  const realGbrainDir = resolve(homedir(), '.gbrain');
  const testConfigDir = resolve(configDir());
  const failuresFile = resolve(syncFailuresPath());
  const auditDir = resolve(resolveAuditDir());

  expect(process.env.GBRAIN_HOME).toBeTruthy();
  expect(process.env.GBRAIN_AUDIT_DIR).toBeTruthy();
  expect(testConfigDir).toBe(resolve(join(process.env.GBRAIN_HOME!, '.gbrain')));
  expect(auditDir).toBe(resolve(process.env.GBRAIN_AUDIT_DIR!));
  expect(isWithin(realGbrainDir, testConfigDir)).toBe(false);
  expect(isWithin(realGbrainDir, failuresFile)).toBe(false);
  expect(isWithin(realGbrainDir, auditDir)).toBe(false);
});
