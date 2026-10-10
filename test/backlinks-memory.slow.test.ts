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
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHILD = new URL('./helpers/backlinks-rss-child.ts', import.meta.url).pathname;
const SIZES_MIB = [48, 192, 384];
const roots: string[] = [];
afterAll(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function measure(mib: number): { gaps: number; delta_peak_mb: number; heap_retained_mb: number } {
  const root = mkdtempSync(join(tmpdir(), `gbrain-backlinks-rss-${mib}-`));
  roots.push(root);
  const r = Bun.spawnSync(['bun', CHILD, root, String(mib)], { stdout: 'pipe', stderr: 'pipe', timeout: 600_000 });
  if (r.exitCode !== 0) throw new Error(`child failed (${r.exitCode}): ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString().trim().split('\n').at(-1)!);
}

describe('findBacklinkGaps RSS slope', () => {
  test('up to 384 MiB of non-target markdown the RSS delta stays under 150 MB, the heap keeps under 48 MB, and the delta does not follow the corpus', () => {
    const runs = SIZES_MIB.map(mib => ({ mib, ...measure(mib) }));
    for (const r of runs) {
      expect(r.gaps).toBe(r.mib);
      // Before the fix the RSS delta was ~3x the corpus (48 MiB → +193 MB, 384 MiB → +1470 MB) and the heap kept every body.
      expect(r.delta_peak_mb).toBeLessThan(150);
      expect(r.heap_retained_mb).toBeLessThan(48);
    }
    const largest = runs.at(-1)!;
    const smallest = runs[0]!;
    expect(largest.delta_peak_mb).toBeLessThan(smallest.delta_peak_mb * 2 + 64);
  }, 900_000);
});
