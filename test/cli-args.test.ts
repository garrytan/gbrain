import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseOpArgs } from '../src/cli.ts';
import { operationsByName } from '../src/core/operations.ts';

let tmpRoot: string | null = null;

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

describe('parseOpArgs', () => {
  test('--no-<boolean> maps to false without consuming the next flag', () => {
    const params = parseOpArgs(operationsByName.query, [
      'freshEmbedSourceScope code source',
      '--limit',
      '8',
      '--no-expand',
      '--source-id',
      'gstack-code-repo-0e4763c9',
    ]);

    expect(params).toEqual({
      query: 'freshEmbedSourceScope code source',
      limit: 8,
      expand: false,
      source_id: 'gstack-code-repo-0e4763c9',
    });
  });

  test('--file populates stdin-backed content params without leaking file to the op', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'gbrain-cli-args-'));
    const input = join(tmpRoot, 'page.md');
    writeFileSync(input, '---\ntype: note\n---\n\nfrom file\n');

    const params = parseOpArgs(operationsByName.put_page, [
      'wiki/windows-file-input',
      '--file',
      input,
    ]);

    expect(params).toEqual({
      slug: 'wiki/windows-file-input',
      content: '---\ntype: note\n---\n\nfrom file\n',
    });
  });

  test('--input-file is accepted as an alias for stdin-backed content params', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'gbrain-cli-args-'));
    const input = join(tmpRoot, 'page.md');
    writeFileSync(input, '---\ntype: note\n---\n\nfrom input-file\n');

    const params = parseOpArgs(operationsByName.put_page, [
      'wiki/windows-input-file',
      '--input-file',
      input,
    ]);

    expect(params).toEqual({
      slug: 'wiki/windows-input-file',
      content: '---\ntype: note\n---\n\nfrom input-file\n',
    });
  });
});

