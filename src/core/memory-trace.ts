/**
 * #7644 / #7596: an opt-in memory trace for long commands (a conversion apply, a sync). With
 * `GBRAIN_MEMORY_TRACE=<seconds>` set (1 to 3600; any other value is off), the command writes one stderr line every that
 * many seconds: its label, the seconds since it started, `process.memoryUsage()` in MB (rss, heap used, external,
 * array buffers), what the caller says it is doing, and under Bun the ten most numerous JavaScriptCore heap object types.
 * It reads nothing from the brain and writes nothing else, so it is safe to turn on for a run that misbehaves on a host.
 */
export const MEMORY_TRACE_ENV = 'GBRAIN_MEMORY_TRACE';
const TOP_TYPES = 10;

/** The trace interval in ms from the environment, or null when the trace is off. */
export function memoryTraceIntervalMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[MEMORY_TRACE_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const seconds = Number(raw);
  return seconds >= 1 && seconds <= 3600 ? seconds * 1000 : null;
}

const mb = (bytes: number) => Math.round(bytes / 1048576);

/** One trace line: memory in MB, the caller's state, and (under Bun) the most numerous heap object types. */
export async function memoryTraceLine(label: string, startedAt: number, state?: Record<string, unknown>): Promise<string> {
  const m = process.memoryUsage();
  let types: Record<string, number> | undefined;
  if (typeof Bun !== 'undefined') {
    try {
      const { heapStats } = await import('bun:jsc');
      types = Object.fromEntries(Object.entries(heapStats().objectTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, TOP_TYPES));
    } catch { /* not every runtime exposes heap statistics */ }
  }
  return `[gbrain memory] ${JSON.stringify({ label, t_s: Math.round((Date.now() - startedAt) / 1000), rss_mb: mb(m.rss), heap_used_mb: mb(m.heapUsed),
    external_mb: mb(m.external), array_buffers_mb: mb(m.arrayBuffers), ...(state ? { state } : {}), ...(types ? { types } : {}) })}`;
}

/** Starts the trace when the environment turns it on; returns the function that stops it (a no-op otherwise). */
export function startMemoryTrace(label: string, state?: () => Record<string, unknown> | undefined, env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = line => { try { process.stderr.write(line + '\n'); } catch { /* stderr gone */ } }): () => void {
  const every = memoryTraceIntervalMs(env);
  if (every === null) return () => undefined;
  const startedAt = Date.now();
  const timer = setInterval(() => { void memoryTraceLine(label, startedAt, state?.()).then(write, () => undefined); }, every);
  timer.unref?.();
  return () => clearInterval(timer);
}
