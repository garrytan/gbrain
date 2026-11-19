/**
 * The per-instance marker a status-only `foresights serve --http` writes while it
 * cannot open its brain: `GBRAIN_HOME/serve-http-status-<port>.json`. It holds
 * the detailed reason the unauthenticated HTTP responses never state, so
 * readiness, doctor and `foresights mcp expose` on the host can say why the
 * shared server answers 503 and give the reason's fix.
 *
 * Live means: the PID is alive and `since` is after the last boot (config
 * plane, no network); doctor additionally asks `/health` for a 503 carrying
 * this marker's `instance_nonce` within 500 ms, and deletes dead markers. A
 * process removes only its own marker (matched by nonce).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { gbrainPath } from './config.ts';

export interface HttpStatusMarker {
  pid: number;
  instance_nonce: string;
  brain_id: string;
  bind: string;
  port: number;
  /** The detailed status reason (host-local only). */
  reason: string;
  /** ISO time status mode was entered or last changed reason. */
  since: string;
}

const MARKER_RE = /^serve-http-status-(\d+)\.json$/;
export const STATUS_MARKER_PROBE_MS = 500;

export function statusMarkerPath(port: number): string {
  return gbrainPath(`serve-http-status-${port}.json`);
}

export function writeStatusMarker(m: HttpStatusMarker): void {
  const path = statusMarkerPath(m.port);
  mkdirSync(gbrainPath(), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function parseMarker(path: string): HttpStatusMarker | null {
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as Partial<HttpStatusMarker>;
    if (typeof m.pid !== 'number' || typeof m.port !== 'number' || typeof m.instance_nonce !== 'string' || typeof m.since !== 'string') return null;
    return { pid: m.pid, instance_nonce: m.instance_nonce, brain_id: String(m.brain_id ?? ''), bind: String(m.bind ?? '127.0.0.1'), port: m.port, reason: String(m.reason ?? ''), since: m.since };
  } catch {
    return null;
  }
}

/** Remove this instance's marker; another instance's marker on the same port is left alone. */
export function removeStatusMarker(port: number, nonce: string): void {
  const path = statusMarkerPath(port);
  if (parseMarker(path)?.instance_nonce !== nonce) return;
  try { rmSync(path, { force: true }); } catch { /* already gone */ }
}

/** Every marker file under GBRAIN_HOME, live or not. */
export function readStatusMarkers(): HttpStatusMarker[] {
  const dir = gbrainPath();
  if (!existsSync(dir)) return [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter(n => MARKER_RE.test(n)).map(n => parseMarker(gbrainPath(n))).filter((m): m is HttpStatusMarker => m !== null);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Config-plane liveness: the PID is alive and the marker was written after the last boot. */
export function statusMarkerLive(m: HttpStatusMarker, now = Date.now()): boolean {
  const since = Date.parse(m.since);
  return Number.isFinite(since) && since >= now - uptime() * 1000 && pidAlive(m.pid);
}

export function liveStatusMarkers(): HttpStatusMarker[] {
  return readStatusMarkers().filter(m => statusMarkerLive(m));
}

/** The marker for one port when it is live (`foresights mcp expose` reads its own port). */
export function liveStatusMarkerFor(port: number): HttpStatusMarker | null {
  const m = parseMarker(statusMarkerPath(port));
  return m && statusMarkerLive(m) ? m : null;
}

/** Probed tier: `/health` answers 503 with this marker's instance nonce within 500 ms. */
export async function statusMarkerAnswers(m: HttpStatusMarker, timeoutMs = STATUS_MARKER_PROBE_MS): Promise<boolean> {
  const host = m.bind === '0.0.0.0' || m.bind === '' ? '127.0.0.1' : m.bind === '::' ? '[::1]' : m.bind.includes(':') ? `[${m.bind}]` : m.bind;
  try {
    const res = await fetch(`http://${host}:${m.port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 503) { await res.body?.cancel().catch(() => {}); return false; }
    const body = await res.json() as { instance?: unknown };
    return body.instance === m.instance_nonce;
  } catch {
    return false;
  }
}

/**
 * Doctor's view: live markers whose server answers as that instance. A marker
 * whose PID is gone (or predates the last boot) is deleted.
 */
export async function verifiedStatusMarkers(): Promise<HttpStatusMarker[]> {
  const out: HttpStatusMarker[] = [];
  for (const m of readStatusMarkers()) {
    if (!statusMarkerLive(m)) {
      try { rmSync(statusMarkerPath(m.port), { force: true }); } catch { /* best-effort */ }
      continue;
    }
    if (await statusMarkerAnswers(m)) out.push(m);
  }
  return out;
}
