/**
 * capture --file over the page ceiling derives the capture slug from a streamed
 * hash (src/cli/commands/append.ts normalizedFileHash); it must equal
 * computeContentHash(normalizeForHash(text)) of the whole file, including
 * across the stream's 64 KiB read boundaries.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizedFileHash } from '../src/cli/commands/append.ts';
import { normalizeForHash } from '../src/core/capture-content.ts';
import { computeContentHash } from '../src/core/ingestion/types.ts';

const READ = 64 * 1024;
/** Text whose byte READ - 1 is `first`'s last byte, so `second` starts the next read. */
const straddle = (first: string, second: string) => 'x'.repeat(READ - Buffer.byteLength(first)) + first + second;

describe('normalizedFileHash', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'gbrain-normalized-hash-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const cases: Array<[string, string]> = [
    ['plain text', '# Title\n\nbody line\n'],
    ['BOM, surrounding whitespace and CRLF', '\uFEFF \r\n\t# Title\r\nline one\r\nline two\r\n\r\n  \n'],
    ['a CRLF split across reads', straddle('line\r', '\nnext line\n')],
    ['a combining mark split across reads', straddle('cafe\n', '\u0301 and e\u0301 more\n')],
    ['a combining mark split across reads mid-line', straddle('cafe', '\u0301 more\n')],
    ['NFKC compatibility characters', 'ﬁle ① Ｆｕｌｌ\nｗｉｄｔｈ\n'],
    ['trailing whitespace across reads', straddle('end', ' '.repeat(10) + '\n\n')],
    ['a whitespace run between text across reads', straddle('a   ', '   b\n')],
  ];
  for (const [name, text] of cases) {
    test(name, async () => {
      const path = join(dir, `${name.replace(/\W+/g, '-')}.md`);
      writeFileSync(path, text);
      expect(await normalizedFileHash(path)).toBe(computeContentHash(normalizeForHash(text)));
    });
  }

  test('whitespace only is null', async () => {
    const path = join(dir, 'blank.md');
    writeFileSync(path, '\uFEFF \r\n\t\n' + ' '.repeat(READ));
    expect(await normalizedFileHash(path)).toBeNull();
  });
});
