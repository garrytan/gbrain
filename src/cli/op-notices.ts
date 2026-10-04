/**
 * CLI notice channel for shared ops run by the local CLI (agent operator
 * contract v1, A6 + F8). Op handlers emit through `ctx.emitNotice`; the CLI
 * renders after the result: `--json` object results carry them under
 * `notices` (array results stay bare, notices go to stderr), human output
 * gets stderr lines on a TTY and an `[AGENT]` block otherwise (stdout is data).
 * One op per CLI process, so module state is safe.
 */
import { cliRenderContext, renderNotice, type Notice } from '../core/agent-output.ts';
import { renderCliNotices } from '../core/agent-markers.ts';
import { isInteractive } from '../core/interaction.ts';
import { processNoticeLedger, mutedNoticeCodes } from '../core/notice-ledger.ts';

let pending: Notice[] = [];

export function captureOpNotice(n: Notice): void {
  pending.push(n);
}

/** Drain the captured notices into the result (`--json` objects) and/or a stderr string. */
export function applyCliOpNotices(result: unknown, json: boolean): { result: unknown; stderr?: string } {
  const captured = pending;
  pending = [];
  if (captured.length === 0) return { result };
  let admitted = captured;
  try { admitted = processNoticeLedger().admit(captured, { transport: 'cli' }, mutedNoticeCodes()); } catch { /* fail-open */ }
  const rendered = admitted.map(n => renderNotice(n, cliRenderContext()));
  if (rendered.length === 0) return { result };
  const isObject = typeof result === 'object' && result !== null && !Array.isArray(result);
  if (json && isObject) return { result: { ...(result as Record<string, unknown>), notices: rendered } };
  const out = renderCliNotices(rendered, { json: false, tty: isInteractive(), stdoutIsData: true });
  return { result, stderr: out.stderr };
}
