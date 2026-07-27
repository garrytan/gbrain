/**
 * Auto-sized default for the worker RSS watchdog cap (issue #1678).
 *
 * The pre-v0.42.5.0 default was a flat 2048MB — absurdly low for any brain
 * doing embeddings (working set ~10GB), so the watchdog drained legit work on
 * every heavy cycle and produced a silent ~400×/24h respawn loop. The watchdog
 * is LEAK detection, not a container-OOM metric, so the default should be
 * generous: comfortably above a real embed working set, capped so a 126GB box
 * doesn't set a uselessly-high bar.
 *
 * THE LOAD-BEARING NUANCE (Codex #5): plain `os.totalmem()` reports HOST RAM.
 * In a container / cgroup / launchd-memory-limited service it can report 64GB
 * while the process's real ceiling is 4GB. If we auto-sized to 0.5×64GB=16GB
 * the watchdog would NEVER fire and the kernel OOM-killer would SIGKILL the
 * worker at 4GB — straight back to the opaque death this whole fix exists to
 * prevent. So the basis is `min(cgroupLimit, totalmem)`: the watchdog cap MUST
 * sit below the real memory ceiling so the graceful drain (distinct exit code,
 * loud log) beats the kernel's silent kill.
 *
 * Formula: `clamp(round(0.5 × basisMB), 4096, 16384)`.
 *   8GB box  → 4096  (floor)
 *   16GB box → 8192
 *   32GB box → 16384 (ceil)
 *   126GB box→ 16384 (ceil)
 *   4GB cgroup on a 126GB host → 2048 (0.5×4096) — below the 4GB ceiling so
 *     the drain beats the OOM-killer. (Below the 4096 floor, so floored... see
 *     note: the floor is intentionally NOT applied when it would exceed the
 *     basis — a cap above the real ceiling is the bug. See `clampToBasis`.)
 *
 * Explicit `--max-rss` always overrides this (including `--max-rss 0` to
 * disable the watchdog entirely).
 */

import { totalmem } from 'os';
import { readFileSync } from 'fs';

const MB = 1024 * 1024;
export const RSS_DEFAULT_FLOOR_MB = 4096;
export const RSS_DEFAULT_CEIL_MB = 16384;
export const RSS_DEFAULT_FRACTION = 0.5;

export interface ResolvedMaxRss {
  /** The resolved cap in MB. */
  mb: number;
  /** Where the memory basis came from. */
  source: 'cgroup-limited' | 'host';
  /** The basis (min of cgroup limit and host RAM) in MB, for the startup log. */
  basisMb: number;
}

/**
 * Read the cgroup memory limit in bytes, or null when no enforced limit is
 * visible (macOS, bare metal, cgroup "max"/unlimited sentinel, or unreadable).
 *
 * cgroup v2: `/sys/fs/cgroup/memory.max` — literal `max` means unlimited.
 * cgroup v1: `/sys/fs/cgroup/memory/memory.limit_in_bytes` — unlimited is a
 *   huge sentinel (~PAGE_COUNTER_MAX); `Math.min(limit, totalmem)` downstream
 *   naturally collapses that to totalmem, so we don't special-case it here.
 *
 * `readFile` is injectable for hermetic tests.
 */
export function readCgroupMemLimitBytes(
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): number | null {
  // cgroup v2
  try {
    const raw = readFile('/sys/fs/cgroup/memory.max').trim();
    if (raw && raw !== 'max') {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    } else if (raw === 'max') {
      return null;
    }
  } catch {
    /* not cgroup v2 / unreadable */
  }
  // cgroup v1
  try {
    const raw = readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes').trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* not cgroup v1 / unreadable */
  }
  return null;
}

export interface ResolveMaxRssOpts {
  /** Override host RAM (bytes). Tests inject; production uses os.totalmem(). */
  totalMemBytes?: number;
  /**
   * Override the cgroup limit (bytes), or `null` for "no cgroup limit". When
   * omitted, the real cgroup files are probed. Tests inject to stay hermetic.
   */
  cgroupLimitBytes?: number | null;
}

/**
 * Resolve the auto-sized watchdog cap with provenance. Use this when you want
 * to log where the number came from; `resolveDefaultMaxRssMb` is the thin
 * number-only wrapper.
 */
export function describeDefaultMaxRss(opts: ResolveMaxRssOpts = {}): ResolvedMaxRss {
  const totalMemBytes = opts.totalMemBytes ?? totalmem();
  const cgroup =
    opts.cgroupLimitBytes !== undefined ? opts.cgroupLimitBytes : readCgroupMemLimitBytes();

  // Basis = the smaller of host RAM and any enforced cgroup limit. A cgroup
  // "unlimited" sentinel (huge number) loses the min to totalmem, so it reads
  // as 'host'.
  const cgroupLimited = cgroup !== null && cgroup < totalMemBytes;
  const basisBytes = cgroupLimited ? (cgroup as number) : totalMemBytes;
  const basisMb = Math.round(basisBytes / MB);

  // 0.5×basis is always strictly below the real ceiling — that's the base.
  let mb = Math.min(Math.round(basisMb * RSS_DEFAULT_FRACTION), RSS_DEFAULT_CEIL_MB);
  // Apply the floor ONLY when it stays below the basis. On a tiny cgroup (e.g.
  // 4GB) the 4096 floor would equal/exceed the real ceiling and place the cap
  // AT or above the limit — defeating "drain before OOM-kill". When the floor
  // can't fit under the ceiling, the 0.5×basis value stands (safely below).
  if (RSS_DEFAULT_FLOOR_MB < basisMb) {
    mb = Math.max(mb, RSS_DEFAULT_FLOOR_MB);
  }
  // Final invariant: the cap must be strictly below the real memory ceiling so
  // the graceful drain always beats the kernel OOM-killer.
  if (mb >= basisMb) mb = Math.max(1, Math.floor(basisMb * RSS_DEFAULT_FRACTION));

  return { mb, source: cgroupLimited ? 'cgroup-limited' : 'host', basisMb };
}

/**
 * The auto-sized default watchdog cap in MB. Replaces the flat `?? 2048` at
 * every production spawn site (jobs work, jobs supervisor, autopilot). Explicit
 * `--max-rss` always wins over this.
 */
export function resolveDefaultMaxRssMb(opts: ResolveMaxRssOpts = {}): number {
  return describeDefaultMaxRss(opts).mb;
}
