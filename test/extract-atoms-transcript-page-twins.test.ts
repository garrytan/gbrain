import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let dir: string;
let root: string;
const content = 'A note about keeping extraction tied to its original source.';
const contentHash = createHash('sha256').update(content).digest('hex');

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'extract-twins-'));
  root = join(dir, 'repo');
  mkdirSync(root);
  const sourceAlias = join(dir, 'source-alias');
  symlinkSync(root, sourceAlias, 'dir');
  await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [sourceAlias, 'default']);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function seedPage(sourcePath: string) {
  await engine.putPage('notes/example', {
    type: 'note', title: 'Example', compiled_truth: content,
    timeline: '', frontmatter: {},
  }, { sourceId: 'default' });
  await engine.executeRaw(
    'UPDATE pages SET source_path = $1 WHERE source_id = $2 AND slug = $3',
    [sourcePath, 'default', 'notes/example'],
  );
}

async function extract(filePath: string) {
  let calls = 0;
  const result = await runPhaseExtractAtoms(engine, {
    sourceId: 'default',
    dryRun: true,
    _transcripts: [{ filePath, content, contentHash }],
    // The owner may be outside the current page discovery batch.
    _pages: [],
    _chat: async (): Promise<ChatResult> => {
      calls++;
      return {
        text: '[]', blocks: [{ type: 'text', text: '[]' }], stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
      };
    },
  });
  return { result, calls };
}

test('drops and counts a synced page reached through a symlinked corpus directory', async () => {
  writeFileSync(join(root, 'example.md'), content);
  const corpus = join(dir, 'corpus');
  symlinkSync(root, corpus, 'dir');
  await seedPage('example.md');
  const page = await engine.getPage('notes/example', { sourceId: 'default' });
  expect(page?.content_hash).not.toBe(contentHash);

  const { result, calls } = await extract(join(corpus, 'example.md'));
  expect(calls).toBe(0);
  expect(result.details.transcript_page_twins_skipped).toBe(1);
  expect(result.details.duplicates_skipped).toBe(0);
});

test('keeps a transcript outside the source root even if a page symlink points to it', async () => {
  const outside = join(dir, 'repo-other');
  mkdirSync(outside);
  const file = join(outside, 'example.md');
  writeFileSync(file, content);
  symlinkSync(file, join(root, 'example.md'));
  await seedPage('example.md');
  const { result, calls } = await extract(file);
  expect(calls).toBe(1);
  expect(result.details.transcript_page_twins_skipped).toBe(0);
  expect(result.details.duplicates_skipped).toBe(0);
});

test('keeps a transcript inside the root without a page row', async () => {
  const file = join(root, 'unmapped.md');
  writeFileSync(file, content);
  const { result, calls } = await extract(file);
  expect(calls).toBe(1);
  expect(result.details.transcript_page_twins_skipped).toBe(0);
  expect(result.details.duplicates_skipped).toBe(0);
});


test('keeps a transcript whose twin page has a non-extractable type', async () => {
  const file = join(root, 'example.md');
  writeFileSync(file, content);
  await seedPage('example.md');
  await engine.executeRaw(
    "UPDATE pages SET type = 'concept' WHERE source_id = $1 AND slug = $2",
    ['default', 'notes/example'],
  );
  const { result, calls } = await extract(file);
  expect(calls).toBe(1);
  expect(result.details.transcript_page_twins_skipped).toBe(0);
  expect(result.details.duplicates_skipped).toBe(0);
});
