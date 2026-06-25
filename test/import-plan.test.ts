import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { summarizeImportPlan } from '../src/commands/import.ts';

let tmp: string | null = null;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('import plan summary', () => {
  test('summarizes importable files by extension without embedding', () => {
    tmp = mkdtempSync(join(tmpdir(), 'gbrain-import-plan-'));
    const md = join(tmp, 'a.md');
    const txt = join(tmp, 'b.txt');
    const txt2 = join(tmp, 'c.txt');
    writeFileSync(md, 'hello');
    writeFileSync(txt, 'world!');
    writeFileSync(txt2, 'again');

    const plan = summarizeImportPlan({
      dir: tmp,
      strategy: 'markdown',
      files: [md, txt, txt2],
      workers: 2,
      sourceId: 'documents',
      noEmbed: true,
    });

    expect(plan).toMatchObject({
      status: 'import_plan',
      dir: tmp,
      strategy: 'markdown',
      total_files: 3,
      total_bytes: 16,
      workers: 2,
      source_id: 'documents',
      embedding: 'disabled',
    });
    expect(plan.by_extension).toEqual([
      { extension: '.txt', files: 2, bytes: 11 },
      { extension: '.md', files: 1, bytes: 5 },
    ]);
  });
});
