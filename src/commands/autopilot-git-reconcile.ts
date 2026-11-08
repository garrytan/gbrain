/**
 * Autopilot's reconcile: each daemon tick runs `gbrain sources git-reconcile --json` in a bounded child, so every source
 * checkout on this host converges on its upstream without anyone calling it. The publish inside is synchronous (fetches,
 * pushes and lock waits block for minutes); in a child it never stalls the daemon's event loop, its lease renewals or its
 * heartbeat. A failure is logged and the tick goes on: the next tick retries, and a refusal that needs the user (a
 * conflict, a secret, a rewritten upstream) is reported the same way `gbrain sources git-reconcile` reports it.
 */
import { execFileBounded } from '../core/bounded-child-exec.ts';
import { CHILD_ENV, resolveChildCliInvocation } from '../core/minions/job-isolation.ts';

export const AUTOPILOT_RECONCILE_TIMEOUT_MS = 900_000;

export interface AutopilotReconcileOutcome { ok: boolean; exit: number | null; lines: string[] }

export async function reconcileGitInChild(timeoutMs = AUTOPILOT_RECONCILE_TIMEOUT_MS): Promise<AutopilotReconcileOutcome> {
  const cli = resolveChildCliInvocation(process.env, process.execPath, process.argv[1], () => null);
  if (!cli) return { ok: false, exit: null, lines: [`could not locate the gbrain CLI to reconcile Git checkouts; set ${CHILD_ENV.childCliOverride} to its path`] };
  const child = await execFileBounded(cli.cmd, [...cli.argsPrefix, 'sources', 'git-reconcile', '--json', '--wait', '60'],
    { timeout: timeoutMs, termGraceMs: 10_000, maxBuffer: 4 * 1024 * 1024, env: process.env });
  const exit = child.error ? (typeof child.error.code === 'number' ? child.error.code : null) : 0;
  let doc: { results?: Array<{ sources?: string[]; root?: string; status?: string; error?: { code?: string; message?: string } }> } | null = null;
  try { doc = JSON.parse(String(child.stdout).trim()); } catch { /* reported below */ }
  if (!doc?.results) return { ok: false, exit, lines: [`sources git-reconcile ${exit === null ? 'did not finish' : `exited ${exit}`}: ${String(child.stderr).trim().slice(0, 300) || 'no output'}`] };
  const lines = doc.results.filter(r => r.status !== 'in_sync' && r.status !== 'no_repo' && r.status !== 'no_upstream')
    .map(r => `${(r.sources ?? []).join(', ') || r.root}: ${r.status}${r.error ? ` ${r.error.code}: ${r.error.message}` : ''}`);
  return { ok: exit === 0, exit, lines };
}
