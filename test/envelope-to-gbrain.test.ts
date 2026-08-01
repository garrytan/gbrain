/**
 * Pins the Memvelope envelope importer contract: deterministic markdown output,
 * provenance frontmatter, citation-bearing bodies, and loud collision handling.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The same parser gbrain uses to ingest frontmatter (src/core/markdown.ts), so
// the injection test asserts against the real consumer rather than a substring.
import { safeLoad as yamlSafeLoad } from 'js-yaml';

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
    expect(page).toContain('date: "2025-11-02"');
    expect(page).toContain('source: "chatgpt"');
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

  test('missing conversation id omits the provenance key rather than emitting a value', async () => {
    const inputDir = tempDir();
    const envelopePath = join(inputDir, 'missing-id-frontmatter.mve.json');
    writeFileSync(envelopePath, JSON.stringify({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt' },
      conversations: [
        {
          title: 'Missing id example',
          created_at: '2025-11-02T14:22:51.000Z',
          messages: [{ id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'alice-example asked about frontmatter.' }],
        },
      ],
    }));

    const result = await runImporter(envelopePath);
    const page = readOnlyMarkdown(result.outDir);

    expect(result.exitCode).toBe(0);
    // Absent means absent: never the literal string `undefined`, and never the
    // positional filename fallback masquerading as a real conversation id.
    expect(page).not.toContain('memvelope_conversation_id');
    expect(page).not.toContain('undefined');
    expect(page).toContain('source: "chatgpt"');
  });

  test('a provider string carrying a newline cannot inject frontmatter keys', async () => {
    const inputDir = tempDir();
    const envelopePath = join(inputDir, 'injecting-provider.mve.json');
    writeFileSync(envelopePath, JSON.stringify({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt\ntype: injected\nowner: attacker' },
      conversations: [
        {
          id: 'c-inject',
          title: 'Injection attempt',
          created_at: '2025-11-02T14:22:51.000Z',
          messages: [{ id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'alice-example sent a hostile provider string.' }],
        },
      ],
    }));

    const result = await runImporter(envelopePath);
    const page = readOnlyMarkdown(result.outDir);
    const frontmatter = page.split('---')[1] ?? '';
    const parsed = yamlSafeLoad(frontmatter) as Record<string, unknown>;

    expect(result.exitCode).toBe(0);
    // The newline is escaped inside a quoted scalar, so the hostile text stays
    // one value instead of becoming keys. Asserted structurally: a substring
    // check cannot tell a real key from the same characters inside a quoted
    // value, and would pass for the wrong reason.
    expect(Object.keys(parsed).sort()).toEqual([
      'date',
      'memvelope_conversation_id',
      'origin',
      'source',
      'title',
      'type',
    ]);
    expect(parsed.type).toBe('conversation');
    expect(parsed.source).toBe('chatgpt\ntype: injected\nowner: attacker');
  });

  // `source` was hardened while `date` — derived from the same third-party
  // envelope, in the line directly above it — was left unquoted. Both halves of
  // the injection surface are pinned now so a future edit can't reopen one.
  test.each([
    ['injects a new key', '1\nowner: z'],
    ['duplicates an existing key', 'x\ntype: a'],
  ])('a created_at that %s cannot alter the frontmatter', async (_label, createdAt) => {
    const inputDir = tempDir();
    const envelopePath = join(inputDir, 'injecting-created-at.mve.json');
    // `date` is created_at.slice(0, 10) — 10 chars is plenty for a newline plus
    // a short key. The duplicate-key case is the nastier of the two: it makes
    // the YAML parse throw, so the page loses every provenance field silently.
    writeFileSync(envelopePath, JSON.stringify({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt' },
      conversations: [
        {
          id: 'c-date',
          title: 'Date injection attempt',
          created_at: createdAt,
          messages: [{ id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'alice-example sent a hostile created_at.' }],
        },
      ],
    }));

    const result = await runImporter(envelopePath);
    const page = readOnlyMarkdown(result.outDir);
    const frontmatter = page.split('---')[1] ?? '';
    const parsed = yamlSafeLoad(frontmatter) as Record<string, unknown>;

    expect(result.exitCode).toBe(0);
    expect(Object.keys(parsed).sort()).toEqual([
      'date',
      'memvelope_conversation_id',
      'origin',
      'source',
      'title',
      'type',
    ]);
    // Still the real values — proves the parse succeeded rather than the
    // frontmatter having been reduced to the injected subset.
    expect(parsed.type).toBe('conversation');
    expect(parsed.date).toBe(createdAt.slice(0, 10));
  });

  // `created_at` also prefixes the FILENAME, and `join(outDir, name)` resolves
  // `../` — so hardening only the frontmatter left the same untrusted value
  // able to write outside the output directory entirely.
  test('a created_at containing path separators cannot write outside outDir', async () => {
    const inputDir = tempDir();
    const parent = tempDir();
    const outDir = join(parent, 'outdir');
    const sibling = join(parent, 'victim');
    mkdirSync(outDir);
    mkdirSync(sibling); // must exist, or the escape fails on ENOENT for the wrong reason

    const envelopePath = join(inputDir, 'traversing-created-at.mve.json');
    writeFileSync(envelopePath, JSON.stringify({
      memvelope: 'envelope-v0',
      meta: { source_provider: 'chatgpt' },
      conversations: [
        {
          id: 'c-trav',
          title: 'Traversal attempt',
          created_at: '../victim/p',
          messages: [{ id: 'm1', role: 'user', ts: '2025-11-02T14:22:51.000Z', text: 'alice-example sent a traversing created_at.' }],
        },
      ],
    }));

    const result = await runImporter(envelopePath, outDir);

    expect(result.exitCode).toBe(0);
    expect(readdirSync(sibling)).toEqual([]);
    expect(markdownFiles(outDir)).toHaveLength(1);
    // Separators are slugged away rather than the write being rejected, so the
    // conversation is still imported — just inside outDir where it belongs.
    expect(markdownFiles(outDir)[0]).not.toContain('/');
  });
});
