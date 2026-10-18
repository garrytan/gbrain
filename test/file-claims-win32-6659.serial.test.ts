/**
 * #6659: on a Windows host the file-claim census (every coordinated
 * `delete_page` and reconcile runs it) bound a POSIX-only name its SQL never
 * referenced, and Postgres/PGLite refuse an untyped unreferenced bind with
 * 42P18. This drives the real `findLiveFileClaimants` under `process.platform
 * = 'win32'` (serial: it swaps a process global) and asserts it still finds a
 * page recording the same file.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { findLiveFileClaimants } from '../src/core/persistence/file-claims.ts';
import { dropOriginIndex } from './helpers/origin-index.ts';

let engine: PGLiteEngine;
let root: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-6659-')));
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes', 'shared.md'), '---\ntype: note\ntitle: Shared\n---\nShared body.\n');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('win-6659','win-6659',$1,'{}')", [root]);
  for (const slug of ['notes/shared', 'notes/shared-twin']) {
    await importFromContent(engine, slug, '---\ntype: note\ntitle: Shared\n---\nShared body.\n',
      { sourceId: 'win-6659', sourcePath: slug === 'notes/shared' ? 'notes/shared.md' : undefined, noEmbed: true });
  }
  // No writer records a held origin on a second page any more (#6948): the twin's origin is set as a brain written
  // before that guard, whose pages_live_origin_key index is pending, holds it.
  await dropOriginIndex(engine);
  await engine.executeRaw("UPDATE pages SET source_path='notes/shared.md' WHERE source_id='win-6659' AND slug='notes/shared-twin'");
}, 120_000);

afterAll(async () => {
  await engine?.disconnect();
  rmSync(root, { recursive: true, force: true });
});

for (const platform of ['linux', 'win32'] as const) {
  test(`the file-claim census finds a page recording the same file on ${platform}`, async () => {
    const [target] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='win-6659' AND slug='notes/shared'");
    const path = join(root, 'notes', 'shared.md');
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
      const claimants = await findLiveFileClaimants(engine, {
        sourceId: 'win-6659', slug: 'notes/shared', pageId: Number(target!.id), root, mode: 'source-root',
        path, canonicalPath: realpathSync(path), recordedUri: null,
      });
      expect(claimants.map(c => c.slug)).toEqual(['notes/shared-twin']);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });
}
