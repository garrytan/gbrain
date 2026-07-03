/**
 * Pins the Memvelope envelope importer contract: deterministic markdown output,
 * provenance frontmatter, citation-bearing bodies, and loud collision handling.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT_PATH = join(import.meta.dir, '..', 'scripts', 'envelope-to-gbrain.mjs');
const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'memvelope', 'sample.mve.json');
const TEMP_DIRS: string[] = [];

afterAll(() => {
  for (const dir of TEMP_DIRS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'envelope-to-gbrain-'));
  TEMP_DIRS.push(dir);
  return dir;
}

async function runImporter(envelopePath: string, outDir = tempDir()) {
  // The script is plain Node-compatible ESM; Bun can execute it directly in CI
  // without requiring a separate node toolchain.
  const proc = Bun.spawn([process.execPath, SCRIPT_PATH, envelopePath, outDir], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: proc.exitCode, stdout, stderr, outDir };
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
}

function readOnlyMarkdown(dir: string): string {
  const files = markdownFiles(dir);
  expect(files).toHaveLength(1);
  return readFileSync(join(dir, files[0]), 'utf8');
}

describe('envelope-to-gbrain importer', () => {
  test('sample envelope writes exactly one markdown page and reports count', async () => {
    const result = await runImporter(FIXTURE_PATH);

    expect(result.exitCode).toBe(0);
    expect(markdownFiles(result.outDir)).toHaveLength(1);
    expect(result.stdout).toContain('wrote 1 markdown page(s)');
  });

  test('filename is keyed by conversation id with date prefix', async () => {
    const result = await runImporter(FIXTURE_PATH);

    expect(result.exitCode).toBe(0);
    expect(markdownFiles(result.outDir)).toEqual(['2025-11-02-c-3f9a2b.md']);
  });

  test('frontmatter carries conversation provenance fields', async () => {
    const result = await runImporter(FIXTURE_PATH);
    const page = readOnlyMarkdown(result.outDir);

    expect(result.exitCode).toBe(0);
    expect(page).toContain('type: conversation');
    expect(page).toContain('title: "Onboarding Checklist Draft"');
    expect(page).toContain('date: 2025-11-02');
    expect(page).toContain('source: chatgpt');
    expect(page).toContain('memvelope_conversation_id: "c-3f9a2b"');
    expect(page).toContain('origin: memvelope/envelope-v0');
  });

  test('body carries role labels and message-id citations', async () => {
    const result = await runImporter(FIXTURE_PATH);
    const page = readOnlyMarkdown(result.outDir);

    expect(result.exitCode).toBe(0);
    expect(page).toContain('· m1');
    expect(page).toContain('· m4');
    expect(page).toContain('**Me**');
    expect(page).toContain('**Assistant**');
  });

  test('output is deterministic across repeated runs', async () => {
    const first = await runImporter(FIXTURE_PATH);
    const second = await runImporter(FIXTURE_PATH);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(readOnlyMarkdown(first.outDir)).toBe(readOnlyMarkdown(second.outDir));
  });

  test('duplicate conversation ids warn and report distinct files written', async () => {
    const inputDir = tempDir();
    const envelopePath = join(inputDir, 'duplicate.mve.json');
    writeFileSync(envelopePath, JSON.stringify({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt' },
      conversations: [
        {
          id: 'c-repeat',
          title: 'First repeated id',
          created_at: '2025-11-02T14:22:51.000Z',
          messages: [{ id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'alice-example noted the first checklist draft.' }],
        },
        {
          id: 'c-repeat',
          title: 'Second repeated id',
          created_at: '2025-11-02T15:22:51.000Z',
          messages: [{ id: 'm2', role: 'assistant', ts: '2025-11-02T15:22:51.000Z', text: 'Assistant noted the repeated id collision.' }],
        },
      ],
    }));

    const result = await runImporter(envelopePath);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('warning: filename collision on "2025-11-02-c-repeat.md"');
    expect(result.stdout).toContain('wrote 1 markdown page(s)');
    expect(markdownFiles(result.outDir)).toHaveLength(1);
  });

  test('missing or foreign format is rejected', async () => {
    const inputDir = tempDir();
    const envelopePath = join(inputDir, 'not-envelope.json');
    writeFileSync(envelopePath, JSON.stringify({ conversations: [] }));

    const result = await runImporter(envelopePath);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('envelope-v0');
  });

  test('missing conversation id uses positional fallback filename', async () => {
    const inputDir = tempDir();
    const envelopePath = join(inputDir, 'missing-id.mve.json');
    writeFileSync(envelopePath, JSON.stringify({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt' },
      conversations: [
        {
          title: 'Missing id example',
          created_at: '2025-11-02T14:22:51.000Z',
          messages: [{ id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'alice-example asked for a fallback filename.' }],
        },
      ],
    }));

    const result = await runImporter(envelopePath);

    expect(result.exitCode).toBe(0);
    expect(markdownFiles(result.outDir)).toEqual(['2025-11-02-conv-1.md']);
  });
});
