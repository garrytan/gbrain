/**
 * GBRA-218: scripts/check-remote-privacy-reads.ts fails on any read of the
 * remote-privacy hatch (GBRAIN_REMOTE_PRIVATE_PAGES) or opt-out
 * (search.remote_private_pages) outside the resolver, and passes the live tree.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan, scanSource } from '../scripts/check-remote-privacy-reads.ts';

describe('check-remote-privacy-reads', () => {
  test('the live tree reads the hatch and the opt-out only in the resolver', () => {
    expect(scan()).toEqual([]);
  });

  test('every read shape outside the resolver is flagged', () => {
    const reads = [
      "const on = process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1';",
      "const on = process.env['GBRAIN_REMOTE_PRIVATE_PAGES'];",
      'const { GBRAIN_REMOTE_PRIVATE_PAGES } = process.env;',
      "const v = await engine.getConfig('search.remote_private_pages');",
      "await engine.executeRaw(\"SELECT value FROM config WHERE key = 'search.remote_private_pages'\");",
      "await engine.executeRaw(`SELECT value FROM config WHERE key = 'search.remote_private_pages' AND ${'$'}{x}`);",
      "import { REMOTE_PRIVATE_PAGES_KEY } from './private-visibility.ts';\nawait engine.getConfig(REMOTE_PRIVATE_PAGES_KEY);",
      "import { REMOTE_PRIVATE_PAGES_KEY } from './private-visibility.ts';\nawait engine.executeRaw('SELECT value FROM config WHERE key=$1', [REMOTE_PRIVATE_PAGES_KEY]);",
    ];
    for (const source of reads) expect({ source, flagged: scanSource('src/core/x.ts', source).length > 0 }).toEqual({ source, flagged: true });
  });

  test('name lists, imports and prose are not reads', () => {
    const fine = [
      "export const NAMES: readonly string[] = ['GBRAIN_REMOTE_PRIVATE_PAGES', 'GBRAIN_OTHER'];",
      "import { REMOTE_PRIVATE_PAGES_KEY } from './private-visibility.ts';\nexport const KEYS = ['a', REMOTE_PRIVATE_PAGES_KEY];",
      "throw new Error('An operator sets search.remote_private_pages=visible to show private pages.');",
    ];
    for (const source of fine) expect({ source, hits: scanSource('src/core/x.ts', source) }).toEqual({ source, hits: [] });
  });

  test('a fixture tree with a second reader fails, and the resolver itself is exempt', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-privacy-reads-'));
    mkdirSync(join(root, 'src/core/search'), { recursive: true });
    writeFileSync(join(root, 'src/core/search/private-visibility.ts'), "export const on = process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1';");
    expect(scan(root)).toEqual([]);
    writeFileSync(join(root, 'src/core/page-visibility.ts'), "export const on = process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1';");
    expect(scan(root)).toEqual([{ path: 'src/core/page-visibility.ts', line: 1, what: 'reads the env hatch GBRAIN_REMOTE_PRIVATE_PAGES' }]);
  });
});
