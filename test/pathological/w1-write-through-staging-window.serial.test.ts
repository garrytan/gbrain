/**
 * W-1 (GBRA-131, #6982): writePageThrough's expectedFileBytes check covers the staging window.
 * Protects: a caller that compared a checkout file and passes its bytes as expectedFileBytes never replaces an
 * editor save that lands while the new bytes are being staged (written and fsynced) before the rename. The edit
 * survives byte for byte, the call reports skipped: 'file_changed', and no stage file is left behind.
 * Fails when: the comparison runs only before staging, so the rename installs the render over the late edit.
 * Seams: atomicWriteFileSync is wrapped to save the file between staging and its pre-rename verify callback (a
 * module mock, hence serial). PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as atomic from '../../src/core/atomic-write.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const realAtomicWrite = atomic.atomicWriteFileSync;
let duringStaging: ((filePath: string) => void) | null = null;
mock.module('../../src/core/atomic-write.ts', () => ({
  ...atomic,
  atomicWriteFileSync: (filePath: string, content: string | Uint8Array, opts?: Parameters<typeof realAtomicWrite>[2]) =>
    realAtomicWrite(filePath, content, { ...opts, verify: staged => { duringStaging?.(filePath); duringStaging = null; opts?.verify?.(staged); } }),
}));
const { writePageThrough, _resetWriteThroughCacheForTest } = await import('../../src/core/write-through.ts');

const SLUG = 'notes/alice-example';
const LATE_EDIT = 'An editor save that landed while the new render was staged.';

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`W-1 write-through staging window (${backend})`, () => {
    for (const late of [true, false]) {
      test(late ? 'W-1 a save during staging survives and the write reports file_changed'
        : 'W-1 control: with no save during staging the compared file is replaced', async () => {
        const home = mkdtempSync(join(tmpdir(), 'gbrain-w1-'));
        try {
          await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
            _resetWriteThroughCacheForTest();
            const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
            try {
              const root = join(home, 'brain');
              mkdirSync(join(root, 'notes'), { recursive: true });
              await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
              await engine.setConfig('sync.repo_path', root);
              const original = '---\ntitle: Alice example\ntype: note\n---\n\n# Alice example\n\nOriginal synthetic note.\n';
              const file = join(root, `${SLUG}.md`);
              writeFileSync(file, original);
              await importFromContent(engine, SLUG, original, { noEmbed: true, sourceId: 'default', sourcePath: `${SLUG}.md` });
              await importFromContent(engine, SLUG, original.replace('Original synthetic note.', 'Edited in the database.'), { noEmbed: true, sourceId: 'default', sourcePath: `${SLUG}.md` });
              const edited = original.replace('Original synthetic note.', `Original synthetic note.\n\n${LATE_EDIT}`);
              duringStaging = late ? () => writeFileSync(file, edited) : null;
              const result = await writePageThrough(engine, SLUG, { sourceId: 'default', expectedFileBytes: original });
              const after = readFileSync(file, 'utf8');
              if (late) {
                expect({ written: result.written, skipped: result.skipped, kept: after === edited }).toEqual({ written: false, skipped: 'file_changed', kept: true });
              } else {
                expect(result.written).toBe(true);
                expect(after).toContain('Edited in the database.');
              }
              expect(readdirSync(join(root, 'notes')).filter(name => name !== 'alice-example.md')).toEqual([]);
              expect(existsSync(file)).toBe(true);
            } finally { duringStaging = null; await close(); }
          });
        } finally { _resetWriteThroughCacheForTest(); rmSync(home, { recursive: true, force: true }); }
      }, 120_000);
    }
  });
}
