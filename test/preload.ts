/**
 * Process-wide filesystem isolation for every `bun test` invocation.
 *
 * Individual tests still use narrower temp directories when they need to
 * inspect files. This preload is the fail-safe: writers that rely on the
 * default GBRAIN_HOME or GBRAIN_AUDIT_DIR can never reach the operator's real
 * ~/.gbrain tree.
 */

import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { isAbsolute, join, relative, resolve } from 'path';

const realGbrainDir = resolve(homedir(), '.gbrain');
let ownedTestRoot: string | undefined;

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertOutsideRealGbrain(label: string, candidate: string): void {
  const resolved = resolve(candidate);
  if (isWithin(realGbrainDir, resolved)) {
    throw new Error(
      `[test-isolation] refusing ${label}=${resolved}: Bun tests must not write under ${realGbrainDir}`,
    );
  }
}

const configuredHome = process.env.GBRAIN_HOME?.trim();
if (configuredHome) {
  if (!isAbsolute(configuredHome)) {
    throw new Error(`[test-isolation] GBRAIN_HOME must be absolute; got ${configuredHome}`);
  }
  assertOutsideRealGbrain('GBRAIN_HOME target', join(configuredHome, '.gbrain'));
} else {
  ownedTestRoot = mkdtempSync(join(tmpdir(), 'gbrain-bun-test-'));
  process.env.GBRAIN_HOME = ownedTestRoot;
}

const configuredAuditDir = process.env.GBRAIN_AUDIT_DIR?.trim();
if (configuredAuditDir) {
  if (!isAbsolute(configuredAuditDir)) {
    throw new Error(`[test-isolation] GBRAIN_AUDIT_DIR must be absolute; got ${configuredAuditDir}`);
  }
  assertOutsideRealGbrain('GBRAIN_AUDIT_DIR', configuredAuditDir);
} else {
  process.env.GBRAIN_AUDIT_DIR = join(process.env.GBRAIN_HOME!, '.gbrain', 'audit');
}

afterAll(() => {
  if (ownedTestRoot && process.env.GBRAIN_TEST_KEEP_HOME !== '1') {
    rmSync(ownedTestRoot, { recursive: true, force: true });
  }
});
