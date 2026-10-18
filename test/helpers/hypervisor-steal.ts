/**
 * Hypervisor steal guard for timing tests.
 *
 * On guest kernels without CONFIG_PARAVIRT_TIME_ACCOUNTING (Ubuntu's generic
 * kernels, the GitHub and Ubicloud runners included), vCPU time the host
 * steals is billed to whichever thread was current, so both wall time and
 * thread CPU time of a window grow with it. A window across which the VM-wide
 * steal counter moved is an invalid reading, not slower code: measure it again.
 * Same mechanism as test/progress.test.ts (#6644).
 */
import { readFileSync } from 'node:fs';

/** VM-wide steal in USER_HZ ticks (field 8 of /proc/stat's aggregate cpu line), or null where there is no /proc/stat. */
export function stealTicks(readStat: () => string = () => readFileSync('/proc/stat', 'utf8')): number | null {
  try {
    const fields = (readStat().split('\n')[0] ?? '').trim().split(/\s+/);
    if (fields[0] !== 'cpu' || fields.length <= 8) return null;
    const ticks = Number(fields[8]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

/**
 * Runs `measure` until steal did not advance across it, at most `attempts` times, and returns the last
 * reading with the steal ticks seen per attempt (null: unknown). A slowdown in the code itself has no
 * steal, so its first reading is the one kept.
 */
export async function measureWithoutSteal<T>(measure: () => Promise<T>, attempts = 5,
  steal: () => number | null = stealTicks): Promise<{ value: T; steal: Array<number | null> }> {
  const seen: Array<number | null> = [];
  for (;;) {
    const before = steal();
    const value = await measure();
    const after = steal();
    const delta = before === null || after === null ? null : after - before;
    seen.push(delta);
    if (delta === null || delta === 0 || seen.length >= attempts) return { value, steal: seen };
  }
}
