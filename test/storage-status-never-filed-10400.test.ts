/**
 * #10400: `gbrain storage status` lists only pages that lost a file they recorded.
 *
 * 1. Protects: a derive-phase page that never recorded a file (a synthesized concept) is database-only by design, so the
 *    "Missing Files (need restore)" list must not send an operator after data that was never lost.
 * 2. Fails when: a never-filed concepts/ page shows up as missing, or a derived page that recorded a file and lost it
 *    stops showing up.
 * 3. Real seams: getStorageStatus over a PGLite brain with a gbrain.yml that declares the derive folders db_only. No git.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getStorageStatus } from '../src/commands/storage.ts';

let engine: PGLiteEngine;
let repo: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  repo = mkdtempSync(join(tmpdir(), 'gbrain-storage-never-filed-'));
  writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_only:\n    - concepts/\n    - atoms/\n');
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [repo]);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(repo, { recursive: true, force: true });
});

describe('storage status and never-filed derived pages (#10400)', () => {
  test('a synthesized concept with no recorded file is not missing; derived pages that recorded a file and lost it are', async () => {
    const page = { type: 'concept' as const, title: 'Example', compiled_truth: 'Body.', timeline: '' };
    await engine.putPage('concepts/never-filed-example', page);
    await engine.putPage('concepts/filed-then-lost', page);
    await engine.putPage('atoms/filed-then-lost', page);
    await engine.executeRaw(`UPDATE pages SET source_path = slug || '.md' WHERE slug IN ('concepts/filed-then-lost', 'atoms/filed-then-lost')`);

    const status = await getStorageStatus(engine, repo);
    expect(status.pagesByTier.db_only).toBe(3);
    expect(status.missingFiles.map(m => m.slug).sort()).toEqual(['atoms/filed-then-lost', 'concepts/filed-then-lost']);
  });

  test('a never-filed concept still reports the restore refusal export would hit on its path', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'gbrain-storage-never-filed-target-'));
    try {
      await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'concepts/%' AND slug <> 'concepts/never-filed-example'`);
      mkdirSync(join(repo, 'concepts'), { recursive: true });
      rmSync(join(repo, 'concepts'), { recursive: true, force: true });
      symlinkSync(elsewhere, join(repo, 'concepts'));
      const status = await getStorageStatus(engine, repo);
      expect(status.missingFiles.map(m => m.slug)).toEqual(['atoms/filed-then-lost']);
      expect(status.warnings.some(w => w.startsWith('concepts/never-filed-example'))).toBe(true);
    } finally {
      rmSync(join(repo, 'concepts'), { force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
