/**
 * CLI notice channel for shared ops run by the local CLI (agent operator
 * contract v1, A6 + F8). Op handlers emit through `ctx.emitNotice`; the CLI
 * renders after the result: `--json` object results carry them under
 * `notices` (array results stay bare, notices go to stderr), human output
 * gets stderr lines on a TTY and an `[AGENT]` block otherwise (stdout is data).
 * One op per CLI process, so module state is safe.
 *
 * #7165: an escalating coverage notice, and the `projection_pending` part of
 * search/query's `Retrieval incomplete:` line, show once per
 * COVERAGE_NOTICE_WINDOW_MS across CLI calls under GBRAIN_HOME (per brain),
 * until the count worsens or a new source or kind appears.
 */
import { createHash } from 'node:crypto';
import { cliRenderContext, renderAction, renderNotice, type Action, type Notice } from '../core/agent-output.ts';
import { renderCliNotices } from '../core/agent-markers.ts';
import { isInteractive } from '../core/interaction.ts';
import { admitAcrossCliCalls, processNoticeLedger, mutedNoticeCodes } from '../core/notice-ledger.ts';
import { takeChatFallbackHopNotices } from '../core/ai/fallback-hop-queue.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { loadConfig } from '../core/config.ts';
import type { RetrievalCoverage } from '../core/search/retrieval-coverage.ts';

let pending: Notice[] = [];

export function captureOpNotice(n: Notice): void {
  pending.push(n);
}

/** #6696 (A4): a local write's output carries the capacity notices (60 s snapshot, hourly per scope); a failed read adds none. */
export async function captureCapacityNotices(engine: import('../core/engine.ts').BrainEngine): Promise<void> {
  const { capacityNotices, CAPACITY_READ_WAIT_MS } = await import('../core/persistence/capacity-snapshot.ts');
  for (const notice of await capacityNotices(engine, { throttle: true, deadlineAt: Date.now() + CAPACITY_READ_WAIT_MS }).catch(() => [])) pending.push(notice);
}

/**
 * #7171: a degraded search/query (a keyword or vector arm that failed or timed out) names itself on the CLI the way
 * MCP's dispatch already does, so a lost arm is never read as "no matches". Lazy: only search and query load it.
 */
export function captureRetrievalNotices(
  op: string, result: unknown, retrieval: Record<string, unknown> | null, params: Record<string, unknown>,
  config: import('../core/config.ts').GBrainConfig | null | undefined,
): void {
  if (op !== 'search' && op !== 'query') return;
  const { recallInteropNotices } = require('../core/interop-notices.ts') as typeof import('../core/interop-notices.ts');
  pending.push(...recallInteropNotices(op, result, { retrieval: retrieval ?? {} }, params, { config, transport: 'cli' }));
}

/**
 * #7192: `search|query --explain-target … --json` prints `{ results, explain_target }` so the diagnosis and its cause
 * reach stdout (a bare array has nowhere to put them); a local run's fix renders as a command (next + argv).
 * Without the flag, or when the run recorded no diagnosis, the rows stay a bare array.
 */
export function withExplainTargetJson(params: Record<string, unknown>, meta: Record<string, unknown> | null | undefined, doc: unknown): unknown {
  const diag = params.explain_target ? meta?.explain_target as (Record<string, unknown> & { fix?: Action }) | undefined : undefined;
  if (!diag || typeof diag !== 'object') return doc;
  const { fix, ...rest } = diag;
  const explain_target = fix && typeof fix === 'object' && 'why' in fix ? { ...rest, fix: renderAction(fix, cliRenderContext()) } : rest;
  return Array.isArray(doc) ? { results: doc, explain_target } : { ...(doc as Record<string, unknown>), explain_target };
}

/** Drain the captured notices into the result (`--json` objects) and/or a stderr string. */
export function applyCliOpNotices(result: unknown, json: boolean): { result: unknown; stderr?: string } {
  const captured = [...pending, ...takeChatFallbackHopNotices()];
  pending = [];
  if (captured.length === 0) return { result };
  let admitted = captured;
  try { admitted = processNoticeLedger().admit(captured, { transport: 'cli' }, mutedNoticeCodes()); } catch { /* fail-open */ }
  admitted = admitted.filter(n => !n.escalation || admitAcrossCliCalls(`${cliBrainKey()}|${n.code}|${n.escalation.key}`, n.escalation.level));
  const rendered = admitted.map(n => renderNotice(n, cliRenderContext()));
  if (rendered.length === 0) return { result };
  const isObject = typeof result === 'object' && result !== null && !Array.isArray(result);
  if (json && isObject) return { result: { ...(result as Record<string, unknown>), notices: rendered } };
  const out = renderCliNotices(rendered, { json: false, tty: isInteractive(), stdoutIsData: true });
  return { result, stderr: out.stderr };
}

/** The brain this CLI call reads: its id plus a hash of its database location (never the location itself). */
function cliBrainKey(): string {
  let location = '';
  try { const cfg = loadConfig(); location = cfg?.database_url ?? cfg?.database_path ?? ''; } catch { /* unreadable config: one key for the home */ }
  return `${getCliOptions().brain ?? process.env.GBRAIN_BRAIN_ID ?? 'host'}-${createHash('sha256').update(location).digest('hex').slice(0, 12)}`;
}

const INCOMPLETE_STAGES: ReadonlySet<string> = new Set(['vector_candidates_incomplete', 'projection_pending', 'projection_status_unknown']);

/**
 * search/query's `Retrieval incomplete:` line, '' when no stage applies. With the
 * call's `coverage`, `projection_pending` is left out when no pending page could
 * match the query or the same pending count already showed within the window, and
 * otherwise the line says how many could.
 */
export function retrievalIncompleteLine(meta: Record<string, unknown> | null | undefined): string {
  const coverage = meta?.coverage as RetrievalCoverage | undefined;
  const total = coverage?.pending_projection, could = coverage?.could_affect?.pending_projection;
  const counted = typeof total === 'number' && typeof could === 'number';
  const stages = (Array.isArray(meta?.degraded) ? [...new Set((meta.degraded as Array<{ stage?: string }>).map(d => d?.stage))] : [])
    .filter((s): s is string => typeof s === 'string' && INCOMPLETE_STAGES.has(s))
    .filter(s => s !== 'projection_pending' || !counted || (could > 0 && admitAcrossCliCalls(`${cliBrainKey()}|projection_pending`, total)));
  if (!stages.length) return '';
  const scoped = counted && stages.includes('projection_pending') ? ` ${could} of ${total}${coverage?.capped ? '+' : ''} pending page(s) could match this query.` : '';
  return `Retrieval incomplete: ${stages.join(', ')}.${scoped}\n`;
}
