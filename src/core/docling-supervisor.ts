// src/core/docling-supervisor.ts
//
// Supervises the Docling sidecar (docs/proposals/office-ingest.md §12, D8):
// spawn uvicorn, poll /health, restart with jittered backoff on crash, and
// shut down cleanly. If a healthy sidecar is already serving (e.g. user-run),
// `ensureUp` is a no-op — never double-spawns.
//
// The spawn lifecycle is exercised live; `restartBackoffMs` is pure + unit-tested.

import { spawn, type ChildProcess } from 'node:child_process';
import { sidecarHealthy } from './office/sidecar-client.ts';

export interface DoclingSupervisorOpts {
  /** Sidecar base URL (e.g. http://127.0.0.1:8765). */
  url: string;
  /** Path to the venv python that has Docling installed. */
  python: string;
  /** Working dir = the sidecar package (sidecar/docling-service). */
  cwd: string;
  /** Port for uvicorn to bind. */
  port: number;
  /** Max crash-restarts before giving up (default 5). */
  maxRestarts?: number;
  onLog?: (line: string) => void;
}

/** Exponential backoff with jitter, capped. Returns a delay in [exp/2, exp]. Pure. */
export function restartBackoffMs(attempt: number, baseMs = 500, capMs = 30_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

export class DoclingSupervisor {
  private child: ChildProcess | null = null;
  private restarts = 0;
  private stopping = false;

  constructor(private readonly opts: DoclingSupervisorOpts) {}

  /**
   * Ensure a healthy sidecar is up. If one is already serving, returns true
   * without spawning. Otherwise spawns uvicorn and waits until /health is ok
   * (or the timeout elapses).
   */
  async ensureUp(timeoutMs = 120_000): Promise<boolean> {
    if (await sidecarHealthy(this.opts.url, 3_000)) return true;
    this.spawn();
    return this.waitHealthy(timeoutMs);
  }

  private spawn(): void {
    if (this.child && !this.child.killed) return;
    const args = [
      '-m', 'uvicorn', 'app:app',
      '--host', '127.0.0.1',
      '--port', String(this.opts.port),
      '--workers', '1',
    ];
    const child = spawn(this.opts.python, args, {
      cwd: this.opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    const log = (b: Buffer): void => this.opts.onLog?.(b.toString().trimEnd());
    child.stdout?.on('data', log);
    child.stderr?.on('data', log);
    child.on('exit', (code) => {
      this.child = null;
      if (this.stopping) return;
      const max = this.opts.maxRestarts ?? 5;
      if (this.restarts >= max) {
        this.opts.onLog?.(`[docling] giving up after ${max} restarts (last exit ${code})`);
        return;
      }
      const delay = restartBackoffMs(this.restarts++);
      this.opts.onLog?.(`[docling] sidecar exited (${code}); restart #${this.restarts} in ${delay}ms`);
      const t = setTimeout(() => {
        if (!this.stopping) this.spawn();
      }, delay);
      (t as { unref?: () => void }).unref?.();
    });
  }

  private async waitHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.stopping) {
      if (await sidecarHealthy(this.opts.url, 3_000)) return true;
      await new Promise((r) => setTimeout(r, 1_500));
    }
    return false;
  }

  /** Stop the supervised process. No-op for an externally-run sidecar. */
  stop(): void {
    this.stopping = true;
    this.child?.kill();
    this.child = null;
  }
}
