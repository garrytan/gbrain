// src/core/office/sidecar-manage.ts
//
// Operational helpers for the Docling sidecar: locate its package + venv, run
// one-time setup (venv + pip install), and auto-start a detached uvicorn so the
// CLI never makes the user run the server by hand. Best-effort throughout — a
// management hiccup must never crash an import.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sidecarHealthy } from './sidecar-client.ts';

/** Absolute path to the sidecar package (sidecar/docling-service), resolved
 *  relative to this module (src/core/office → up 3 → repo root). */
export function sidecarDir(): string {
  const officeDir = dirname(fileURLToPath(import.meta.url)); // .../src/core/office
  return join(officeDir, '..', '..', '..', 'sidecar', 'docling-service');
}

/** Path to the venv python created by setup-docling. */
export function venvPython(): string {
  const dir = sidecarDir();
  return process.platform === 'win32'
    ? join(dir, '.venv', 'Scripts', 'python.exe')
    : join(dir, '.venv', 'bin', 'python');
}

function portFromUrl(url: string, fallback = 8765): number {
  try {
    const p = new URL(url).port;
    return p ? parseInt(p, 10) : fallback;
  } catch {
    return fallback;
  }
}

function run(cmd: string, args: string[], cwd: string, onLog: (l: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout?.on('data', (b: Buffer) => onLog(b.toString().trimEnd()));
    c.stderr?.on('data', (b: Buffer) => onLog(b.toString().trimEnd()));
    c.on('error', (e) => { onLog(String(e)); resolve(false); });
    c.on('exit', (code) => resolve(code === 0));
  });
}

/** One-time setup: create the venv + install Docling. Streams output via onLog. */
export async function setupDocling(onLog: (l: string) => void = () => {}): Promise<{ ok: boolean; message: string }> {
  const dir = sidecarDir();
  if (!existsSync(join(dir, 'requirements.txt'))) {
    return { ok: false, message: `Docling sidecar package not found at ${dir}` };
  }
  const base = process.platform === 'win32' ? 'python' : 'python3';
  onLog('Creating venv (.venv) …');
  if (!(await run(base, ['-m', 'venv', '.venv'], dir, onLog))) {
    return { ok: false, message: 'venv creation failed (is Python 3.10+ installed?)' };
  }
  onLog('Installing Docling + deps (several GB on first run) …');
  if (!(await run(venvPython(), ['-m', 'pip', 'install', '-r', 'requirements.txt'], dir, onLog))) {
    return { ok: false, message: 'pip install failed' };
  }
  return { ok: true, message: `Docling installed in ${join(dir, '.venv')}` };
}

/**
 * Ensure a healthy sidecar is up. If one is already serving, no-op. Otherwise
 * spawn a DETACHED uvicorn that survives this CLI process — so subsequent
 * imports reuse the warm (model-loaded) server — and wait until /health is ok.
 * Best-effort: returns false (caller surfaces a clear error) if it can't start.
 */
/**
 * In-process memo of failed start attempts, per sidecar URL. A sidecar that
 * persistently refuses to come up (broken venv deps, port conflict) must not
 * cost every office file in a bulk import its own spawn + health-poll wait:
 * within the cooldown, ensureSidecarUp fails fast right after the health
 * probe. The health probe always runs first, so a sidecar that recovers (or
 * is started by hand) wins immediately and clears the memo.
 */
const START_COOLDOWN_MS = 5 * 60_000;
const startFailureAt = new Map<string, number>();

/** Test seam: forget recorded start failures. */
export function _resetSidecarStartCooldownForTest(): void {
  startFailureAt.clear();
}

export async function ensureSidecarUp(
  opts: {
    url: string;
    python?: string | null;
    env?: Record<string, string>;
    waitMs?: number;
    /** 0 disables the failed-start cooldown (explicit `gbrain ingest start`). */
    startCooldownMs?: number;
  },
  onLog: (l: string) => void = () => {},
): Promise<boolean> {
  if (await sidecarHealthy(opts.url, 3_000)) {
    startFailureAt.delete(opts.url);
    return true;
  }

  const py = opts.python || venvPython();
  if (!existsSync(py)) {
    onLog(`Docling venv not found (${py}). Run: gbrain ingest setup-docling`);
    return false;
  }

  const cooldownMs = opts.startCooldownMs ?? START_COOLDOWN_MS;
  const failedAt = startFailureAt.get(opts.url);
  if (failedAt !== undefined) {
    const leftMs = failedAt + cooldownMs - Date.now();
    if (leftMs > 0) {
      onLog(
        `Docling sidecar start failed ${Math.round((Date.now() - failedAt) / 1000)}s ago; ` +
        `not retrying for ${Math.ceil(leftMs / 1000)}s. Run: gbrain ingest start (or setup-docling)`,
      );
      return false;
    }
    startFailureAt.delete(opts.url);
  }

  const port = portFromUrl(opts.url);
  onLog(`starting Docling sidecar on :${port} (first start loads ML models, may take a minute) …`);
  const child = spawn(
    py,
    ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port), '--workers', '1'],
    { cwd: sidecarDir(), detached: true, stdio: 'ignore', env: { ...process.env, ...(opts.env ?? {}) } },
  );
  // A spawn failure (EACCES, broken interpreter) emits 'error'; with no
  // listener that is an unhandled event that crashes the importing process —
  // the exact hiccup this module promises never to crash on. Record it and
  // short-circuit the health poll instead of waiting out the deadline.
  let spawnError: string | null = null;
  child.on('error', (e) => { spawnError = String(e); });
  child.unref(); // survive CLI exit; the warm server is reused by later imports

  const deadline = Date.now() + (opts.waitMs ?? 180_000);
  while (Date.now() < deadline) {
    if (spawnError) {
      startFailureAt.set(opts.url, Date.now());
      onLog(`Docling sidecar spawn failed: ${spawnError}. Run: gbrain ingest setup-docling`);
      return false;
    }
    if (await sidecarHealthy(opts.url, 3_000)) {
      startFailureAt.delete(opts.url);
      return true;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  startFailureAt.set(opts.url, Date.now());
  onLog('Docling sidecar did not become healthy in time.');
  return false;
}
