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
 *
 * The in-repository guard (the export holds private page text):
 *  - Contract: the exporter writes into a git working tree only with --allow-in-repo; when it cannot tell whether
 *    the output is inside one (git missing, a failed probe), it refuses too.
 *  - Regression: every git probe error read as "outside a repository", so an inherited invalid GIT_DIR or a
 *    missing git let the export write private text into a working tree.
 *  - Seam: none. A real git repository, the script run as a subprocess with the environment changed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import { flipInput, manifestRow, pageMeta, segmentText, stagingInput } from './helpers/page-body-fixtures.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-export-corpus-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const script = join(import.meta.dir, '..', 'rust', 'scripts', 'export-corpus.ts');

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
    const run = Bun.spawnSync(['bun', script, '--out', out, '--pglite-dir', dbPath],
      { stdout: 'pipe', stderr: 'pipe' });
    expect({ exit: run.exitCode, stderr: run.exitCode === 0 ? '' : run.stderr.toString() }).toEqual({ exit: 0, stderr: '' });
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect({ pages: manifest.pages, segmented: manifest.skipped_pages_segmented, unreadable: manifest.skipped_pages_unreadable })
      .toEqual({ pages: 1, segmented: 1, unreadable: 0 });
    const pages = readFileSync(join(out, 'pages.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(pages.map((p) => p.slug)).toEqual(['notes/inline']);
  }, 60_000);

  describe('the in-repository guard', () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync(['git', 'init', '-q', repo]);
    const out = join(repo, 'corpus');
    const exportInto = (env: Record<string, string | undefined>) => Bun.spawnSync(
      [process.execPath, script, '--out', out, '--pglite-dir', join(root, 'guard-brain')],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });

    test('an inherited invalid GIT_DIR does not let the export into a working tree', () => {
      const run = exportInto({ GIT_DIR: join(root, 'no-such-git-dir') });
      expect({ exit: run.exitCode, refused: run.stderr.toString().includes('refusing to write private brain text') })
        .toEqual({ exit: 2, refused: true });
      expect(existsSync(join(out, 'pages.jsonl'))).toBe(false);
    });

    test('without git on PATH the export refuses rather than guess', () => {
      const run = exportInto({ PATH: join(root, 'empty-bin') });
      expect({ exit: run.exitCode, refused: run.stderr.toString().includes('could not tell whether') })
        .toEqual({ exit: 2, refused: true });
      expect(existsSync(join(out, 'pages.jsonl'))).toBe(false);
    });

    // A stand-in git that exits 128 with the given stderr: a test cannot hand a directory to another owner, so this
    // is the seam that gives the guard the messages real git prints for unsafe ownership or in another language.
    const fakeBin = join(root, 'fake-git-bin');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'git'), '#!/bin/sh\nprintf \'%s\\n\' "$FAKE_GIT_STDERR" >&2\nexit 128\n');
    chmodSync(join(fakeBin, 'git'), 0o755);
    const exportWithFakeGit = (target: string, stderr: string) => Bun.spawnSync(
      [process.execPath, script, '--out', target, '--pglite-dir', join(root, 'guard-brain')],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: fakeBin, FAKE_GIT_STDERR: stderr } });

    test('an unsafe-ownership answer whose path names "not a git repository" still refuses', () => {
      const repoAtOddPath = join(root, 'not a git repository', 'repo');
      mkdirSync(repoAtOddPath, { recursive: true });
      const target = join(repoAtOddPath, 'corpus');
      const run = exportWithFakeGit(target, `fatal: detected dubious ownership in repository at '${repoAtOddPath}'`);
      expect({ exit: run.exitCode, refused: run.stderr.toString().includes('could not tell whether') })
        .toEqual({ exit: 2, refused: true });
      expect(existsSync(join(target, 'pages.jsonl'))).toBe(false);
    });

    test('a git answer in another language refuses rather than guess', () => {
      const target = join(root, 'localized', 'corpus');
      const run = exportWithFakeGit(target, 'fatal: Kein Git-Repository (oder irgendeines der Elternverzeichnisse): .git');
      expect({ exit: run.exitCode, refused: run.stderr.toString().includes('could not tell whether') })
        .toEqual({ exit: 2, refused: true });
      expect(existsSync(join(target, 'pages.jsonl'))).toBe(false);
    });
  });
});
