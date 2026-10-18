/**
 * The thin client's paged whole-page read (`printPagedPage`) spools the windows
 * to a temp file until the copy verifies, then prints them one at a time.
 *
 * 1. Protects: a 64 MiB page prints byte for byte with the heap (after
 *    Bun.gc(true)) under 16 MiB above the baseline at every sampled write, so
 *    a 128 or 256 MiB page prints in bounded memory; a copy whose sha256 does
 *    not verify prints nothing; the spool is a 0600 file in os.tmpdir(),
 *    removed after a print and after a refusal.
 * 2. Fails when: the read keeps every window in memory until the hash
 *    verifies (the whole page is held when the first window prints), prints
 *    a window before the hash verifies, or leaves the spool behind.
 * 3. Existing coverage: large-page-roundtrip.test.ts and segmented-get-cli.test.ts
 *    check the printed bytes and the sha256 refusal over a real get_page; neither
 *    measures memory.
 * 4. No production seam: the host is a synthetic get_page; pagedReadWork is the
 *    module's own work counter. No database, so no engine arms.
 */
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pagedReadWork, printPagedPage, REMOTE_PAGE_WINDOW_BYTES } from '../../src/cli/page-render.ts';
import { withEnv } from '../helpers/with-env.ts';

const MiB = 1024 * 1024;
const PAGE_BYTES = 64 * MiB;
const WINDOWS = PAGE_BYTES / REMOTE_PAGE_WINDOW_BYTES;
const HEAP_SLACK = 16 * MiB;

const spoolDir = mkdtempSync(join(tmpdir(), 'gbrain-paged-spool-'));
afterAll(() => rmSync(spoolDir, { recursive: true, force: true }));

/** Window `i` of the synthetic page: REMOTE_PAGE_WINDOW_BYTES of ASCII lines that name the window. */
function windowText(i: number): string {
  const line = `window ${String(i).padStart(4, '0')} of the large example page, bob-example talks about the widget plan\n`;
  return line.repeat(Math.ceil(REMOTE_PAGE_WINDOW_BYTES / line.length)).slice(0, REMOTE_PAGE_WINDOW_BYTES);
}

const pageSha = (() => {
  const hash = createHash('sha256');
  for (let i = 0; i < WINDOWS; i++) hash.update(windowText(i));
  return hash.digest('hex');
})();

/** A get_page host serving the synthetic page in markdown windows; `sha256` is what it reports. */
function host(sha256 = pageSha) {
  return async (p: Record<string, unknown>) => {
    const i = p.cursor === undefined ? 0 : Number(p.cursor);
    return { slug: p.slug, revision: 'rev-1', size: { total_bytes: PAGE_BYTES, sha256 },
      window: { byte_start: i * REMOTE_PAGE_WINDOW_BYTES, text: windowText(i) }, ...(i + 1 < WINDOWS ? { next_cursor: String(i + 1) } : {}) };
  };
}

function heapUsed(): number {
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
}

test('a 64 MiB page prints window by window with the heap bounded by a window, not the page', () => withEnv({ TMPDIR: spoolDir }, async () => {
  pagedReadWork.spooled = pagedReadWork.replayed = 0;
  const hash = createHash('sha256');
  let writes = 0, bytes = 0, peak = 0, spoolMode = -1;
  const baseline = heapUsed();
  await printPagedPage(host(), { slug: 'logs/spool-example' }, async text => {
    const [spool] = writes === 0 ? readdirSync(spoolDir) : [];
    if (spool) spoolMode = statSync(join(spoolDir, spool)).mode & 0o777;
    if (writes % 16 === 0) peak = Math.max(peak, heapUsed() - baseline);
    hash.update(text);
    bytes += Buffer.byteLength(text);
    writes++;
  });
  console.log(JSON.stringify({ peakHeapMiB: +(peak / MiB).toFixed(1), writes }));
  expect(peak).toBeLessThan(HEAP_SLACK);
  expect(bytes).toBe(PAGE_BYTES);
  expect(hash.digest('hex')).toBe(pageSha);
  expect(writes).toBe(WINDOWS);
  expect(spoolMode).toBe(0o600);
  expect(pagedReadWork).toEqual({ spooled: WINDOWS, replayed: WINDOWS });
  expect(readdirSync(spoolDir)).toEqual([]);
}), 120_000);

test('a copy whose sha256 does not verify prints nothing and leaves no spool behind', () => withEnv({ TMPDIR: spoolDir }, async () => {
  const writes: string[] = [];
  await expect(printPagedPage(host('0'.repeat(64)), { slug: 'logs/spool-example' }, async text => { writes.push(text); })).rejects.toThrow(/does not match/);
  expect(writes).toEqual([]);
  expect(readdirSync(spoolDir)).toEqual([]);
}), 120_000);
