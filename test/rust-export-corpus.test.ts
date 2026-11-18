/**
 * The bake-off corpus exporter (rust/scripts/export-corpus.ts) on a brain that holds a segmented page.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the export finishes, writes the manifest, keeps every inline page and skips and counts each segmented
 *    page (`skipped_pages_segmented`), whose body is never one string.
 *  - Regression: the exporter read `compiled_truth` of a segmented page, whose getter throws page_body_segmented,
 *    outside its catch and after it opened the output files: the export exited 1 with no manifest.
 *  - Why existing coverage misses it: nothing ran the exporter; rust/bench/baseline/roundtrip-check.ts only reads
 *    a corpus it is given.
 *  - Seam: none. A real on-disk PGLite brain and the script run as a subprocess.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import { flipInput, manifestRow, pageMeta, segmentText, stagingInput } from './helpers/page-body-fixtures.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-export-corpus-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('export-corpus', () => {
  test('a segmented page is skipped and counted, and the export still writes its manifest', async () => {
    const dbPath = join(root, 'brain');
    const config = { engine: 'pglite' as const, database_path: dbPath };
    const engine = await createEngine(config);
    await engine.connect(config);
    try {
      await engine.initSchema();
      await engine.putPage('notes/inline', { type: 'note', title: 'Inline', compiled_truth: 'an inline body', timeline: '' });
      const { id: pageId } = await engine.createSegmentedPageShell('notes/big', pageMeta('Big page'), { sourceId: 'default' });
      const texts = [segmentText('# Intro\nfirst segment\n'), segmentText('## End\nsecond segment\n')];
      const occurrences = await engine.allocateBodyOccurrenceIds(texts.length);
      const staging = stagingInput({ slug: 'notes/big', pageId, mode: 'create' });
      await engine.transaction(async (tx) => {
        await tx.openBodyStaging(staging);
        await tx.stageSegmentTexts('default', texts, { stagingId: staging.id });
        let byteStart = 0;
        await tx.stageManifestRows(texts.map((text, seq) => {
          const row = manifestRow({ pageId, occurrenceId: occurrences[seq]!, genFrom: 1, seq, text, byteStart, stagingId: staging.id });
          byteStart += text.body.byteLength;
          return row;
        }));
      });
      await engine.transaction(async (tx) => {
        await tx.flipBodyGeneration(flipInput(pageId, 0, staging.id, texts));
        await tx.setBodyStagingState(staging.id, 'committed');
      });
      expect((await engine.getPage('notes/big'))?.body_storage).toBe('segmented');
    } finally {
      await engine.disconnect();
    }

    const out = join(root, 'corpus');
    const run = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'rust', 'scripts', 'export-corpus.ts'), '--out', out, '--pglite-dir', dbPath],
      { stdout: 'pipe', stderr: 'pipe' });
    expect({ exit: run.exitCode, stderr: run.exitCode === 0 ? '' : run.stderr.toString() }).toEqual({ exit: 0, stderr: '' });
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect({ pages: manifest.pages, segmented: manifest.skipped_pages_segmented, unreadable: manifest.skipped_pages_unreadable })
      .toEqual({ pages: 1, segmented: 1, unreadable: 0 });
    const pages = readFileSync(join(out, 'pages.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(pages.map((p) => p.slug)).toEqual(['notes/inline']);
  }, 60_000);
});
