/**
 * Wave B (spec 2.2, 3.1): a streamed import's pass 1 collects as it reads, so its garbage does not follow the page.
 *
 * 1. Protects: pass 1 over a file above PAGE_MAX_BYTES (`scanFile`) reads at most COLLECT_EVERY_BYTES plus one read
 *    between two full collections (`streamedImportWork.scanUncollected`), the same at 25 MiB and at 50 MiB.
 * 2. Fails when: pass 1 reads the whole file with no collection, leaving each read's buffer and decoded text to JSC's
 *    own collector, which rarely runs during the pass: a 32 MiB import's peak then sat on ~170 MiB of pass-1 garbage,
 *    and segmented-ingest-memory.slow.test.ts's delta grew with the page (~310 MiB at 32 MiB, ~400 at 48; ~230 at
 *    both with the collection).
 * 3. Existing coverage: segmented-ingest-memory.slow.test.ts measures VmHWM, which moves with whether JSC collected
 *    during the pass; body-scan-memory.test.ts checks what the scanner retains, not the reads' garbage.
 * 4. No production seam: a wrapped engine.getPage, which importScanned calls right after pass 1, stops the import
 *    there. Pass 1 reads only the file, so PGLite alone covers it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { streamedImportWork } from '../../src/core/page-body/streamed-import.ts';
import { conversationPage } from '../helpers/conversation-page.ts';

const MiB = 1024 * 1024;
const BOUND = 4 * MiB + MiB;
const dir = mkdtempSync(join(tmpdir(), 'gbrain-streamed-scan-'));
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('pages.segmented_storage', 'on');
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

async function scanUncollected(bytes: number): Promise<number> {
  const file = join(dir, `page-${bytes}.md`);
  writeFileSync(file, conversationPage(bytes, { seed: 7 }));
  const stop = new Error('stop after pass 1');
  const getPage = engine.getPage;
  engine.getPage = (async () => { throw stop; }) as typeof engine.getPage;
  streamedImportWork.scanUncollected = 0;
  try {
    await importFromFile(engine, file, 'notes/scan-example.md', { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) }).catch(error => {
      if (error !== stop) throw error;
    });
  } finally {
    engine.getPage = getPage;
    rmSync(file, { force: true });
  }
  return streamedImportWork.scanUncollected;
}

test(`pass 1 reads at most ${BOUND / MiB} MiB between collections, whatever the file size`, async () => {
  const small = await scanUncollected(PAGE_MAX_BYTES + MiB);
  const large = await scanUncollected(2 * PAGE_MAX_BYTES + 2 * MiB);
  expect(small).toBeGreaterThan(0);
  expect(small).toBeLessThanOrEqual(BOUND);
  expect(large).toBeLessThanOrEqual(BOUND);
}, 300_000);
