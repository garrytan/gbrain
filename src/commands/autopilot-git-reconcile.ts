/**
 * Autopilot's reconcile: each daemon tick runs `gbrain sources git-reconcile` over the sources whose sync is on, in this
 * process, so it works on every engine (a PGLite daemon holds the data directory, and a child could not open it). It
 * never blocks the daemon's event loop, its lease renewals or its heartbeat: Git reads and fetches are bounded async
 * children, and every pull and publish (synchronous Git work) runs in a bounded `gbrain git commit-push` child, a managed
 * checkout's through `gbrain sources refresh`. A failure is logged and the tick goes on; the next tick retries.
 */
import type { BrainEngine } from '../core/engine.ts';
import { reconcileSources } from './sources-git-reconcile.ts';

export interface AutopilotReconcileOutcome { ok: boolean; lines: string[] }

export async function autopilotReconcile(engine: BrainEngine, opts: { childTimeoutMs?: number } = {}): Promise<AutopilotReconcileOutcome> {
  try {
    const results = await reconcileSources(engine, { waitMs: 0, ...(opts.childTimeoutMs ? { childTimeoutMs: opts.childTimeoutMs } : {}) });
    const lines = results.filter(r => r.status !== 'in_sync' && r.status !== 'no_repo' && r.status !== 'no_upstream')
      .map(r => `${r.sources.join(', ') || r.root}: ${r.status}${r.error ? ` ${r.error.code}: ${r.error.message}` : r.reason ? ` (${r.reason})` : ''}`);
    return { ok: !results.some(r => r.status === 'needs_user' || r.status === 'failed'), lines };
  } catch (error) {
    return { ok: false, lines: [`sources git-reconcile failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
