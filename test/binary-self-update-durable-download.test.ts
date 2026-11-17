/**
 * The self-upgrade download flushes the descriptor it wrote through. A
 * read-only reopen for fsync fails with EPERM on Windows (#5595 class), which
 * aborted every binary self-upgrade there. `simulateReadOnlyFsyncEperm`
 * reproduces the Windows rule on POSIX hosts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultDownload } from '../src/core/binary-self-update.ts';
import { simulateReadOnlyFsyncEperm } from './helpers/win32-flush-semantics.ts';

const dir = mkdtempSync(join(tmpdir(), 'gbrain-selfupdate-download-'));
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('binary self-update download durability', () => {
  test('writes and flushes through a writable descriptor (no read-only fsync)', async () => {
    const bytes = Buffer.from('foresights binary bytes\n');
    globalThis.fetch = (async () => new Response(bytes)) as unknown as typeof fetch;
    const dest = join(dir, 'gbrain.staged');
    const flush = simulateReadOnlyFsyncEperm();
    try {
      await defaultDownload('https://example.invalid/gbrain', dest);
    } finally {
      flush.restore();
    }
    expect(flush.readOnlyFsyncs).toBe(0);
    expect(readFileSync(dest).equals(bytes)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
