/**
 * Backlinks scan memory is bounded by the largest file, not the corpus
 * (wave 14 P1.1, #6438, [R22]).
 *
 * Protects: `findBacklinkGaps` on a brain whose non-target pages hold N MiB
 * of markdown keeps its working set at the largest file currently read plus
 * candidate/index metadata. Before the fix every page body was retained
 * (602 MiB of markdown → +2.3 GiB RSS; a 21.7 GiB brain cannot fit), so the
 * RSS delta grew linearly with the corpus. Each measurement runs in its own
 * child process so the parent's heap and other tests cannot skew it.
 * Regression: a map that retains bodies again. No production seam: the
 * child reports process.memoryUsage().rss.
 *
 * The RSS delta is mostly garbage JSC has not collected yet, and JSC sizes
 * that allowance from the machine's RAM (#6494): the same scan that reads
 * +91..152 MB on a 4-core 16 GB builder read +258 MB on a 16-vCPU 64 GB CI
 * VM with nothing retained. The child therefore runs with
 * `BUN_JSC_forceRAMSize` pinned to 512 MiB so every runner sizes the heap the
 * same way, and the 256 MB bound is unchanged. Probes behind that choice (384
 * MiB corpus, this file's child, 4-core 16 GB builder; rerun with
 * `BUN_JSC_forceRAMSize=<bytes> bun test/helpers/backlinks-rss-child.ts <dir> 384`):
 *   64 GiB (68719476736, the CI VM's RAM) → rss +102..283 MB over 17 runs, 2 of them past 256 (272, 283): the CI failure, reproduced.
 *   512 MiB (536870912, pinned here)      → rss +78..137 MB over 5 runs.
 *   a pass1 that keeps every body (the pre-#6438 shape) under the pin → rss +609 MB and heap 385 MB: still fails the RSS, heap and slope bounds.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHILD = new URL('./helpers/backlinks-rss-child.ts', import.meta.url).pathname;
const SIZES_MIB = [48, 192, 384];
const roots: string[] = [];
afterAll(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

/** JSC sizes its heap growth from machine RAM; pin it so the RSS reading means the same thing on every runner (#6494). */
const JSC_RAM_PIN_BYTES = 512 * 1024 * 1024;

function measure(mib: number): { gaps: number; rss_delta_mb: number; heap_retained_mb: number } {
  const root = mkdtempSync(join(tmpdir(), `gbrain-backlinks-rss-${mib}-`));
  roots.push(root);
  const r = Bun.spawnSync(['bun', CHILD, root, String(mib)], { stdout: 'pipe', stderr: 'pipe', timeout: 600_000, env: { ...process.env, BUN_JSC_forceRAMSize: String(JSC_RAM_PIN_BYTES) } });
  if (r.exitCode !== 0) throw new Error(`child failed (${r.exitCode}): ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString().trim().split('\n').at(-1)!);
}

describe('findBacklinkGaps RSS slope', () => {
  test('up to 384 MiB of non-target markdown the RSS delta stays under 256 MB, the heap keeps under 48 MB, and the delta does not follow the corpus', () => {
    const runs = SIZES_MIB.map(mib => ({ mib, ...measure(mib) }));
    console.error(`[backlinks-rss] ${runs.map(r => `${r.mib} MiB: rss +${r.rss_delta_mb} MB, heap ${r.heap_retained_mb} MB`).join('; ')}`);
    for (const r of runs) {
      expect(r.gaps).toBe(r.mib);
      // Before the fix the RSS delta was ~3x the corpus (48 MiB → +193 MB, 384 MiB → +1470 MB) and the heap kept every body.
      // After: +88 MB at 384 MiB on a 4-core builder, +168 MB on a 16-vCPU CI VM (JSC sizes its nursery by the machine), so
      // the absolute bound leaves room for that while staying 5x under the pre-fix number; the slope check below is the property.
      expect(r.rss_delta_mb).toBeLessThan(256);
      expect(r.heap_retained_mb).toBeLessThan(48);
    }
    // The slope is measured on the heap after a forced GC, which is what the scan kept alive; the RSS peak above
    // is what the OOM killer sees but also carries JSC's nursery, which grows with allocation volume (a 2.5x to 5x
    // spread between 48 and 384 MiB with nothing retained), so it holds only the absolute bound. Before the fix the
    // retained heap was the corpus (48 MiB -> 50 MB, 384 MiB -> 390 MB); after, both sizes keep a few MB.
    const largest = runs.at(-1)!;
    const smallest = runs[0]!;
    expect(largest.heap_retained_mb).toBeLessThan(smallest.heap_retained_mb * 2 + 16);
  }, 900_000);
});
