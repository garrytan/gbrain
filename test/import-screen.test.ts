/**
 * #5988 Lane A: one content screen decides refusals for every ingestion
 * path, and `isContentRefusal` recognizes exactly the deterministic content
 * refusals (new and pre-upgrade receipts) that no retry can fix.
 *
 * Regressions it catches: a publication path refusing (or accepting) content
 * the screen judged differently, which would leave a held file importable or
 * a screened file blocking a sync; and a transient or capacity refusal being
 * treated as a content refusal, which would silently skip a retryable write.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent, MAX_FILE_SIZE } from '../src/core/import-file.ts';
import { isContentRefusal, screenImportContent, type ImportSanityConfig } from '../src/core/import-screen.ts';
import { managedImportContent, readImportBytes } from '../src/core/persistence/import-prepare.ts';
import { readSyncFile } from '../src/core/persistence/sync-discovery.ts';
import { frontmatterSlugConflictMessage } from '../src/core/persistence/verb-errors.ts';
import { OperationError } from '../src/core/ops/contract.ts';

function mockEngine(): BrainEngine {
  const pages = new Map<string, unknown>();
  const engine: BrainEngine = new Proxy({} as Record<string, unknown>, {
    get(_, prop: string) {
      if (prop === 'getTags') return () => Promise.resolve([]);
      if (prop === 'getPage') return (slug: string) => Promise.resolve(pages.get(slug) ?? null);
      if (prop === 'putPage') return async (slug: string, page: unknown) => { pages.set(slug, page); return page; };
      if (prop === 'transaction') return async (fn: (tx: BrainEngine) => Promise<unknown>) => fn(engine);
      // #6482: the strict mode reader needs one well-formed unmanaged row.
      return (sql?: unknown) => Promise.resolve(prop === 'executeRaw' ? (String(sql).includes('FROM persistence_brain') ? [{ enabled: false }] : []) : null);
    },
  }) as unknown as BrainEngine;
  return engine;
}

const doc = (block: string, body = 'Body text.') => `---\n${block}\n---\n\n${body}\n`;
const CORPUS: Array<[label: string, content: string]> = [
  ['clean', doc('title: Clean\ntype: note')],
  ['issue author line', doc('title: Roundup\nauthor: PYMNTS (citing Reuters / Bloomberg) (original: https://x.com/a)')],
  ['quoted trailing', doc('title: "Quoted" trailing')],
  ['nested quotes', doc('title: "Name "Nick" Last"')],
  ['fold', doc('title: First line\nsecond line\ntype: note')],
  ['duplicate', doc('title: a\ntitle: b')],
  ['duplicate identity', doc('type: note\ntitle: a\ntype: thread')],
  ['unclosed bracket', doc('tags: [a, b\ntype: note')],
  ['bad indentation', doc('tags:\n  - a\n - b')],
  ['swallowed visibility', doc('title: "Hello\nvisibility: private\nsummary: x"')],
  ['pre-quoted visibility', doc('visibility: private # note: x')],
  ['unclosed fence with visibility', '---\ntitle: a\nvisibility: private\n\n# Heading\nbody\n'],
  ['comment value', doc('title: #1 thing')],
  ['crlf recoverable', '---\r\ntitle: Re: hi\r\n---\r\nbody\r\n'],
  ['slug conflict', doc('slug: elsewhere/page\ntitle: a')],
  ['oversize', doc('title: big', 'x'.repeat(MAX_FILE_SIZE + 10))],
];

describe('the screen and every publication path agree', () => {
  for (const [label, content] of CORPUS) {
    test(label, async () => {
      const screened = screenImportContent({ content, path: 'notes/page.md', expectedSlug: 'notes/page' });
      expect(screened.status).not.toBe('published');
      const refusal = screened.status === 'refused' ? screened.refusal : null;

      // importFromContent (put_page, capture, legacy import) checks no slug: the slug is the caller's.
      const contentScreen = screenImportContent({ content, path: 'notes/page.md' });
      const imported = await importFromContent(mockEngine(), 'notes/page', content, { noEmbed: true });
      if (contentScreen.status === 'refused') {
        expect(imported.status).not.toBe('imported');
        expect(imported.error).toBe(contentScreen.refusal.message);
        expect(imported.refusal).toEqual(contentScreen.refusal);
      } else {
        expect(imported.error).toBeUndefined();
        expect(imported.status).toBe('imported');
      }

      let thrown: OperationError | null = null;
      try { managedImportContent('notes/page.md', Buffer.from(content)); } catch (error) { thrown = error as OperationError; }
      if (!refusal) {
        expect(thrown).toBeNull();
        return;
      }
      expect(thrown).toBeInstanceOf(OperationError);
      expect(thrown!.canonical ?? thrown!.code).toBe(refusal.code);
      expect(thrown!.code).toBe('invalid_params');
      expect(thrown!.reason).toBe(refusal.reason);
      if (refusal.code !== 'frontmatter_slug_conflict') expect(thrown!.message).toBe(refusal.message);
      expect(isContentRefusal(thrown!.code, thrown!.message)).toBe(true);
      expect(isContentRefusal(refusal.code, refusal.message)).toBe(true);
    }, 30_000);
  }

  test('the published exemption is checked before any content refusal', () => {
    let asked = false;
    const result = screenImportContent({ content: doc('title: a\nsecond line'), path: 'notes/page.md', published: () => { asked = true; return true; } });
    expect(asked).toBe(true);
    expect(result.status).toBe('published');
  });

  test('a content-sanity reject disposition refuses as content_rejected; quarantine does not', () => {
    const sanity = (junkDisposition: 'reject' | 'quarantine'): ImportSanityConfig => ({ cs: {}, disabled: false, extraLiterals: [], junkDisposition });
    const junk = doc('title: Just a moment...', 'Cloudflare Ray ID: abc123');
    const rejected = screenImportContent({ content: junk, path: 'notes/page.md', sanity: sanity('reject') });
    expect(rejected).toMatchObject({ status: 'refused', refusal: { code: 'content_rejected' } });
    expect(screenImportContent({ content: junk, path: 'notes/page.md', sanity: sanity('quarantine') }).status).toBe('importable');
  });

  test('code files are screened for size only', () => {
    expect(screenImportContent({ content: 'const a: "b" c = 1;\n', path: 'src/a.ts' })).toEqual({ status: 'importable', parsed: null });
    const big = screenImportContent({ content: 'x', byteLength: MAX_FILE_SIZE + 1, path: 'src/a.ts' });
    expect(big).toMatchObject({ status: 'refused', refusal: { code: 'file_too_large', message: `Code file too large (${MAX_FILE_SIZE + 1} bytes)` } });
  });
});

describe('isContentRefusal', () => {
  test('matches the real messages the import paths produce today', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-content-refusal-'));
    try {
      const big = join(dir, 'big.md');
      writeFileSync(big, Buffer.alloc(MAX_FILE_SIZE + 1, 'a'));
      let importRefusal: OperationError | null = null;
      try { readImportBytes(big); } catch (error) { importRefusal = error as OperationError; }
      expect(isContentRefusal(importRefusal!.code, importRefusal!.message)).toBe(true);
      const huge = join(dir, 'huge.md');
      writeFileSync(huge, Buffer.alloc(10 * 1024 ** 2 + 1, 'a'));
      let syncRefusal: OperationError | null = null;
      try { readSyncFile(dir, 'huge.md'); } catch (error) { syncRefusal = error as OperationError; }
      expect(syncRefusal!.code).toBe('request_too_large');
      expect(isContentRefusal(syncRefusal!.code, syncRefusal!.message)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(isContentRefusal('invalid_params', frontmatterSlugConflictMessage('books/a/ch01.md', 'books/other', 'books/a/ch01'))).toBe(true);
  });

  test('matches the strings older gbrain versions stored', () => {
    for (const message of [
      'Invalid YAML frontmatter: Malformed YAML frontmatter at line 3. Quote scalar values that contain ": " or fix the frontmatter block.',
      'Invalid YAML frontmatter: YAML parse failed: incomplete explicit mapping pair; a key node is missed at line 3, column 54. Quote scalar values that contain ": " or fix the frontmatter block.',
      'Invalid YAML frontmatter at line 3 in notes/a.md.',
      'Invalid YAML frontmatter at line 3, column 7. Quote scalar values or fix the frontmatter block.',
      'The frontmatter slug "books/other-chapter" in books/fairml/ch01.md conflicts with its path, which expects slug "books/fairml/ch01". Remove `slug:` or make it match the path.',
      'Frontmatter slug "my-friend-mike" does not match path-derived slug "2008-03-20-my-friend-mike".',
      'Content too large (6000000 bytes, max 5000000). Split the content into smaller files or remove large embedded assets.',
      'File too large (8432105 bytes)',
      'File too large (max 5000000 bytes).',
      'Code file too large (8000000 bytes)',
    ]) expect(isContentRefusal('invalid_params', message)).toBe(true);
    expect(isContentRefusal('request_too_large', 'Sync file exceeds the bounded import size.')).toBe(true);
    expect(isContentRefusal('storage_error', 'Publication failed (PAGE_JUNK_PATTERN). Inspect owner diagnostics.')).toBe(true);
  });

  test('never matches capacity, cursor-size, transient or unrelated refusals', () => {
    for (const [code, message] of [
      ['request_too_large', 'Sync discovery exceeds the bounded cursor size.'],
      ['request_too_large', 'The approved selection exceeds source policy capacity; narrow the selection.'],
      ['request_too_large', 'Markdown exceeds the import file limit; split it into smaller files.'],
      ['invalid_params', 'Unsupported internal sync intent.'],
      ['invalid_params', 'The sync file could not be prepared.'],
      ['source_changed', 'Newer working-tree bytes and the current page disagree with this pinned Git import.'],
      ['revision_conflict', 'The page changed during sync preparation.'],
      ['storage_error', 'Publication failed. Inspect owner diagnostics.'],
      ['storage_error', 'Publication failed (57014). Inspect owner diagnostics.'],
      ['queue_capacity', 'The persistence listener is at capacity; retry shortly.'],
      ['database_error', 'Invalid YAML frontmatter: x'],
      ['page_identity_changed', 'The imported path no longer names the accepted page.'],
      [null, 'Invalid YAML frontmatter: x'],
    ] as Array<[string | null, string]>) expect(isContentRefusal(code, message)).toBe(false);
  });
});
