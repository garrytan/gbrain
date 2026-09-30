/**
 * #4910 — doctor `image_assets`: files rows whose metadata stamps a non-git
 * storage lane (`storage: 'supabase' | 's3' | 'local'`) hold bucket keys,
 * not source-relative paths. Doctor must not stat them under the source root
 * and report "missing from disk … restore from git"; it classifies them as
 * storage-backend objects, points at the backend-aware `gbrain files verify`,
 * and keeps detecting genuinely vanished local/git assets.
 *
 * Behavioral test through the master-existing `buildChecks` seam (mirrors
 * test/doctor-image-assets-wsl.test.ts).
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { executeRawJsonb } from '../src/core/sql-query.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildChecks, type Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
let repoRoot: string;

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
  repoRoot = mkdtempSync(join(tmpdir(), 'gbrain-4910-'));
  await engine.setConfig('sync.repo_path', repoRoot);
});

async function insertImage(storagePath: string, hash: string, metadata: Record<string, unknown> | null): Promise<void> {
  if (metadata === null) {
    await engine.executeRaw(
      `INSERT INTO files (source_id, filename, storage_path, mime_type, content_hash)
       VALUES ('default', 'img.png', $1, 'image/png', $2)`,
      [storagePath, hash],
    );
    return;
  }
  await executeRawJsonb(
    engine,
    `INSERT INTO files (source_id, filename, storage_path, mime_type, content_hash, metadata)
     VALUES ('default', 'img.png', $1, 'image/png', $2, $3::jsonb)`,
    [storagePath, hash],
    [metadata],
  );
}

async function imageAssetsCheck(): Promise<Check> {
  const checks = await buildChecks(engine, []);
  const check = checks.find((c) => c.name === 'image_assets');
  expect(check).toBeDefined();
  return check!;
}

describe('doctor image_assets — storage-backend objects (#4910)', () => {
  test('a supabase-lane object key is not reported missing from disk', async () => {
    await insertImage('cloud/example.png', 'h1', { storage: 'supabase' });
    const check = await imageAssetsCheck();
    expect(check.status).toBe('ok');
    expect(check.message).not.toMatch(/missing from disk/);
    expect(check.message).not.toContain('restore from git');
    expect(check.message).toContain('files verify');
  });

  test('only storage-backend objects: says so instead of "0 image(s) all present"', async () => {
    await insertImage('cloud/a.png', 'h2', { storage: 's3' });
    await insertImage('cloud/b.png', 'h3', { storage: 'local' });
    const check = await imageAssetsCheck();
    expect(check.status).toBe('ok');
    expect(check.message).not.toContain('all present on disk');
    expect(check.message).toContain('2 storage-backend object(s)');
  });

  test('backend objects are excluded from the denominator; a vanished unmarked asset still warns', async () => {
    await insertImage('cloud/example.png', 'h4', { storage: 'supabase' });
    await insertImage('images/gone.jpg', 'h5', null);
    const check = await imageAssetsCheck();
    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/1 of 1 image\(s\) missing/);
    expect(check.message).toContain('images/gone.jpg');
    expect(check.message).toContain('1 storage-backend object(s)');
  });

  test('an explicit git-lane row is a local asset and is still checked (regression guard)', async () => {
    await insertImage('assets/tracked-gone.png', 'h6', { storage: 'git' });
    writeFileSync(join(repoRoot, 'here.png'), 'x');
    await insertImage('here.png', 'h7', { storage: 'git' });
    const check = await imageAssetsCheck();
    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/1 of 2 image\(s\) missing/);
    expect(check.message).toContain('assets/tracked-gone.png');
  });
});
