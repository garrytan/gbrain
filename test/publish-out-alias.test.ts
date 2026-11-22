/**
 * gbrain publish wrote its output wherever --out pointed, so an --out that named the page itself through a symlink, a
 * hard link or the same path replaced the page with the published copy, in HTML and --markdown mode alike. It now refuses with invalid_params when --out
 * resolves to the page (same real path, or the same file by device and inode) and writes nothing.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runPublish } from '../src/commands/publish.ts';

const PAGE = '---\ntype: note\nprivate: alice-example\n---\n# A note\n\nThe offsite moved to Friday.\n';
const refused = expect.objectContaining({ code: 'invalid_params' });

let dir = '';
let page = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'publish-out-alias-'));
  page = join(dir, 'page.md');
  writeFileSync(page, PAGE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function publish(args: string[]): Promise<unknown> {
  const log = console.log;
  console.log = () => {};
  try { await runPublish(args); return null; } catch (e) { return e; } finally { console.log = log; }
}

describe('gbrain publish never writes over the page itself', () => {
  test('--out naming the same path is refused and the page is unchanged', async () => {
    expect({ error: await publish([page, '--out', page]), page: readFileSync(page, 'utf8') }).toEqual({ error: refused, page: PAGE });
  });

  test('--out through a symlink to the page is refused and the page is unchanged', async () => {
    const link = join(dir, 'link.html');
    symlinkSync(page, link);
    expect({ error: await publish([page, '--out', link]), page: readFileSync(page, 'utf8') }).toEqual({ error: refused, page: PAGE });
  });

  test('--out through a hard link to the page is refused and the page is unchanged', async () => {
    const hard = join(dir, 'hard.html');
    linkSync(page, hard);
    expect({ error: await publish([page, '--out', hard]), page: readFileSync(page, 'utf8') }).toEqual({ error: refused, page: PAGE });
  });

  test('--out through a symlinked directory to the page is refused and the page is unchanged', async () => {
    const alias = join(dir, 'alias');
    symlinkSync(dir, alias);
    expect({ error: await publish([page, '--out', join(alias, 'page.md')]), page: readFileSync(page, 'utf8') }).toEqual({ error: refused, page: PAGE });
  });

  test('--markdown --out through a symlink to the page is refused and the page is unchanged', async () => {
    const link = join(dir, 'link.md');
    symlinkSync(page, link);
    expect({ error: await publish([page, '--markdown', '--out', link]), page: readFileSync(page, 'utf8') }).toEqual({ error: refused, page: PAGE });
  });

  test('--markdown --out through a hard link to the page is refused and the page is unchanged', async () => {
    const hard = join(dir, 'hard.md');
    linkSync(page, hard);
    expect({ error: await publish([page, '--markdown', '--out', hard]), page: readFileSync(page, 'utf8') }).toEqual({ error: refused, page: PAGE });
  });

  test('a normal --markdown --out still writes the stripped page', async () => {
    const out = join(dir, 'nested', 'page.shared.md');
    expect(await publish([page, '--markdown', '--out', out])).toBeNull();
    expect({ stripped: readFileSync(out, 'utf8').includes('alice-example'), page: readFileSync(page, 'utf8') }).toEqual({ stripped: false, page: PAGE });
  });

  test('a normal --out still writes the published page', async () => {
    const out = join(dir, 'nested', 'page.html');
    expect(await publish([page, '--out', out])).toBeNull();
    expect({ written: readFileSync(out, 'utf8').includes('The offsite moved to Friday.'), page: readFileSync(page, 'utf8') }).toEqual({ written: true, page: PAGE });
  });
});
