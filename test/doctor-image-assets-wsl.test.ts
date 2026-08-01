/**
 * #1835 — doctor `image_assets`: Windows drive paths (`D:/…`, `D:\…`) written
 * by a Windows gbrain install must not be reported as "missing from disk"
 * on POSIX hosts that cannot resolve them.
 *
 * Behavioral test through the master-existing `buildChecks` seam — it
 * deliberately imports NOTHING introduced by this fix, so running this file
 * against an unmodified master demonstrates the bug (image_assets WARNs
 * "restore from git" for a drive path that was never lost).
 *
 * Pure translation-logic coverage (WSL /mnt mapping, wsl.conf parsing) lives
 * in test/doctor-asset-paths.test.ts.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildChecks, type Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
let repoRoot: string;

// These assertions describe non-WSL POSIX hosts (macOS, plain Linux — every
// dev box + CI runner here). On real WSL the drive path is translated and
// statted instead; on win32 it stats natively. Skip there.
const onWsl = (() => {
  try {
    return process.platform === 'linux' && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
})();
const skip = onWsl || process.platform === 'win32';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  repoRoot = mkdtempSync(join(tmpdir(), 'gbrain-1835-'));
  await engine.setConfig('sync.repo_path', repoRoot);
});

async function insertImage(storagePath: string, hash: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO files (source_id, filename, storage_path, mime_type, content_hash)
     VALUES ('default', 'img.jpg', $1, 'image/jpeg', $2)`,
    [storagePath, hash],
  );
}

async function imageAssetsCheck(): Promise<Check> {
  const checks = await buildChecks(engine, []);
  const check = checks.find((c) => c.name === 'image_assets');
  expect(check).toBeDefined();
  return check!;
}

describe('doctor image_assets — Windows drive paths on POSIX (#1835)', () => {
  test.skipIf(skip)('D:/ path is skipped with a note, not reported missing', async () => {
    await insertImage('D:/cicada3301/lost9999/img.jpg', 'h1');
    const check = await imageAssetsCheck();
    // Master joins the drive path onto repoRoot and WARNs "missing from
    // disk … restore from git" — a false data-loss report.
    expect(check.status).toBe('ok');
    expect(check.message).toContain('Windows-drive path(s) skipped');
    expect(check.message).not.toContain('restore from git');
  });

  test.skipIf(skip)('backslash D:\\ path is also skipped', async () => {
    await insertImage('D:\\cicada3301\\lost9999\\img.jpg', 'h2');
    const check = await imageAssetsCheck();
    expect(check.status).toBe('ok');
    expect(check.message).toContain('Windows-drive path(s) skipped');
  });

  test.skipIf(skip)('drive path skip does not mask a genuinely vanished asset', async () => {
    await insertImage('D:/cicada3301/lost9999/img.jpg', 'h3');
    await insertImage('assets/really-gone.png', 'h4');
    const check = await imageAssetsCheck();
    expect(check.status).toBe('warn');
    expect(check.message).toContain('assets/really-gone.png');
    // The unresolvable drive path is excluded from the checked denominator.
    expect(check.message).toContain('1 of 1 image(s) missing');
    expect(check.message).toContain('Windows-drive path(s) skipped');
  });

  test('present relative asset still resolves against repoRoot (regression guard)', async () => {
    writeFileSync(join(repoRoot, 'here.png'), 'x');
    await insertImage('here.png', 'h5');
    const check = await imageAssetsCheck();
    expect(check.status).toBe('ok');
    expect(check.message).toContain('all present on disk');
  });
});
