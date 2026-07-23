import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseOpArgs } from '../src/cli.ts';
import { operationsByName } from '../src/core/operations.ts';

describe('parseOpArgs', () => {
  // #380: `gbrain put SLUG --file PATH` reads content from the file instead
  // of silently swallowing the flag and creating an empty page.
  test('put --file reads the stdin param (content) from a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-put-file-'));
    try {
      const pagePath = join(dir, 'page.md');
      writeFileSync(pagePath, '# From file\n\nBody loaded from --file.\n');
      const params = parseOpArgs(operationsByName.put_page, ['concepts/from-file', '--file', pagePath]);
      expect(params.slug).toBe('concepts/from-file');
      expect(params.content).toBe('# From file\n\nBody loaded from --file.\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #380 regression guard: undeclared-but-honored flags must keep passing
  // through when unknown flags become hard errors (--source is read by
  // makeContext; --json by the output seam; --dry-run by ctx.dryRun).
  test('pass-through allowlist flags survive on ops that do not declare them', () => {
    const params = parseOpArgs(operationsByName.get_page, [
      'people/alice-example', '--source', 'wiki', '--json', '--dry-run',
    ]);
    expect(params).toEqual({
      slug: 'people/alice-example',
      source: 'wiki',
      json: true,
      dry_run: true,
    });
  });

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
});

