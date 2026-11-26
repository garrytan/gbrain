import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getStorageStatus } from '../src/commands/storage.ts';

let engine: PGLiteEngine;
let tmp: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-status-never-filed-'));
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(tmp, { recursive: true, force: true });
});

describe('storage status never-filed derived pages (#10400)', () => {
  test('a synthesized concept without a recorded file is not "missing"; a lost recorded file still is', async () => {
    writeFileSync(join(tmp, 'gbrain.yml'), 'storage:\n  db_only: [concepts/, atoms/]\n');
    await engine.putPage('concepts/never-filed', { type: 'concept', title: 'C', compiled_truth: '', timeline: '' });
    await engine.putPage('atoms/lost', { type: 'concept', title: 'A', compiled_truth: '', timeline: '', source_path: 'atoms/2026-11-10/lost.md' } as any);
    await engine.executeRaw(`UPDATE pages SET source_path = 'atoms/2026-11-10/lost.md' WHERE slug = 'atoms/lost'`);
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [tmp]);

    const status = await getStorageStatus(engine, tmp);
    const slugs = status.missingFiles.map(m => m.slug).sort();
    expect(slugs).toEqual(['atoms/lost']);
  });
});
