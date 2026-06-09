import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { appendImportManifestRecord } from '../src/commands/import.ts';

let tmp: string | null = null;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('import manifest records', () => {
  test('appends jsonl records and creates parent directories', () => {
    tmp = mkdtempSync(join(tmpdir(), 'gbrain-import-manifest-'));
    const manifest = join(tmp, 'logs', 'manifest.jsonl');

    appendImportManifestRecord(manifest, {
      path: 'docs/a.md',
      source_id: 'documents',
      status: 'imported',
      slug: 'docs/a',
      chunks: 3,
      duration_ms: 42,
    });
    appendImportManifestRecord(manifest, {
      path: 'docs/b.md',
      source_id: 'documents',
      status: 'skipped',
      error: 'unchanged',
      duration_ms: 7,
    });

    expect(existsSync(manifest)).toBe(true);
    const rows = readFileSync(manifest, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toEqual([
      {
        path: 'docs/a.md',
        source_id: 'documents',
        status: 'imported',
        slug: 'docs/a',
        chunks: 3,
        duration_ms: 42,
      },
      {
        path: 'docs/b.md',
        source_id: 'documents',
        status: 'skipped',
        error: 'unchanged',
        duration_ms: 7,
      },
    ]);
  });
});
