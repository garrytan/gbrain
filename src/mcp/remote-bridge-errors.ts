/**
 * What the thin-client stdio bridge (remote-bridge.ts) says when it cannot
 * relay: transport failures on `tools/call` become one v1 `isError`
 * envelope, and on `tools/list` a JSON-RPC error whose `data` is the same
 * envelope. Host results never pass through here; they are relayed
 * byte-identical. Rules every builder keeps:
 *   - a per-reason fix (exhaustive over RemoteMcpErrorReason) that never names
 *     `gbrain remote doctor` (it needs admin scope) and never suggests adding
 *     a scope to this client;
 *   - a mutation keeps its write identity (`request_id`, `submission_status`)
 *     and gets the reconciliation it allows before any replay;
 *   - every string is stripped of URL userinfo, query and fragment.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { buildEnvelope, toolErrorResult, type Action, type RenderContext, type ToolResultShape } from '../core/agent-output.ts';
import type { OperationMeta } from '../core/ops/contract.ts';
import { isPersistenceIpcMutation } from '../core/persistence/ipc.ts';
import type { RemoteMcpError } from '../core/remote-mcp-error.ts';
import { stripUrlSecrets, stripUrlSecretsDeep } from '../core/url-redact.ts';
import { VERSION } from '../version.ts';

export const BRIDGE_LOG_PREFIX = '[gbrain-bridge]';
const DOCS = 'docs/architecture/thin-client.md#stdio-bridge';
const DOCTOR: string[] = ['gbrain', 'doctor', '--json'];

/** Bounded retry for a read or an unsent call: at most this many tries, this far apart. */
export const BRIDGE_RETRY = { tries: 3, delay_s: 2 } as const;

/** An endpoint as a label: origin and path, never userinfo, query or fragment. */
export function endpointLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return stripUrlSecrets(url);
  }
}

interface ReasonFix { code: string; why: string; suggestion: string; fix?: Action; retryable: boolean; recovery: string }

const action = (a: Omit<Action, 'consent' | 'requires_exclusive'>): Action => ({ consent: [], requires_exclusive: false, ...a });

/** The per-reason row: what failed, what to do about it, and whether a retry may help. */
function reasonFix(e: RemoteMcpError, opts: { clientId?: string; timeoutMs: number; read: boolean }): ReasonFix {
  const doctor = (why: string) => action({ argv: DOCTOR, actor: 'user', why });
  const retry = `Retry up to ${BRIDGE_RETRY.tries} times, ${BRIDGE_RETRY.delay_s} s apart; if it still fails, run the fix.`;
  switch (e.reason) {
    case 'config':
      return { code: 'config_error', retryable: false, recovery: 'Nothing was sent. Fix the thin-client configuration, then start a new session.',
        why: 'This thin client has no usable remote credential (no remote_mcp config, or no client secret).',
        suggestion: 'Run gbrain init --mcp-only on this machine with the OAuth client the brain host issued, or set GBRAIN_REMOTE_CLIENT_SECRET in the env of this harness entry.',
        fix: action({ argv: ['gbrain', 'init', '--mcp-only'], actor: 'user', why: 'Writes the remote brain address and its OAuth client on this machine.' }) };
    case 'discovery':
    case 'token':
      return { code: 'unavailable', retryable: true, recovery: retry,
        why: `The brain host's OAuth ${e.reason === 'discovery' ? 'discovery' : '/token'} endpoint did not answer usefully.`,
        suggestion: 'Check that the brain host is up and its address is right; gbrain doctor --json on this machine probes it without needing admin scope.',
        fix: doctor('Read-only: probes the remote brain address, OAuth discovery and token mint from this machine.') };
    case 'rate_limited': {
      const wait = e.detail?.retry_after_s;
      return { code: 'rate_limited', retryable: true,
        recovery: `Wait ${wait !== undefined ? `${wait} s` : 'a few minutes'}, then retry the same call once.`,
        why: `The brain host's OAuth /token mint budget is spent (HTTP 429); it clears by itself${wait !== undefined ? ` in ${wait} s` : ''}.`,
        suggestion: 'Wait, then retry the same call. If this repeats, the host operator can raise GBRAIN_OAUTH_TOKEN_RATE_LIMIT_MAX.',
        fix: action({ argv: DOCTOR, actor: 'provider', why: 'After the wait, doctor confirms the token mint works again.', verify: { argv: DOCTOR } }) };
    }
    case 'auth':
    case 'auth_after_refresh': {
      const client = opts.clientId ? `OAuth client ${opts.clientId}` : "this thin client's OAuth client";
      return { code: 'invalid_client', retryable: false, recovery: 'Retrying will not help until the host owner acts.',
        why: `The brain host rejected ${client}: it was revoked, its secret changed, or it expired.`,
        suggestion: `Ask the brain host's owner to check ${client} and, if it was revoked, issue a replacement with the same scopes it had; then run gbrain init --mcp-only here with the new credential.`,
        fix: action({ argv: ['gbrain', 'auth', 'clients'], actor: 'host_admin', why: `Read-only, on the brain host: lists its OAuth clients, so the owner can see whether ${client} is still active.`,
          user_message: `The gbrain brain host no longer accepts ${client}. Can you ask the host's owner to check it and, if it was revoked, register a replacement with the same scopes, then run gbrain init --mcp-only on this machine with it?` }) };
    }
    case 'network': {
      if (e.detail?.kind === 'aborted') {
        return { code: 'cancelled', retryable: false, recovery: 'The caller cancelled this call; nothing to repair.', why: 'The call was cancelled before the host answered.', suggestion: 'Nothing to do; send the call again if it is still wanted.' };
      }
      if (e.detail?.kind === 'timeout') {
        const next = Math.ceil((opts.timeoutMs * 2) / 1000);
        return { code: 'timeout', retryable: opts.read,
          recovery: opts.read ? 'Retry once; a slow call can finish on a second try.' : 'Do not resend blindly: reconcile the write first (see fix).',
          why: `The brain host did not answer within the bridge's ${Math.round(opts.timeoutMs / 1000)} s call timeout.`,
          suggestion: `For slow calls such as think, raise the bridge timeout: add --timeout=${next}s to this harness entry's args (gbrain --timeout=${next}s serve).`,
          fix: action({ argv: ['gbrain', `--timeout=${next}s`, 'serve'], actor: 'user', why: 'The call timeout is a start flag of this bridge; change it in the harness entry and start a new session.' }) };
      }
      return { code: 'unavailable', retryable: true, recovery: retry,
        why: `The brain host could not be reached${e.detail?.status ? ` (HTTP ${e.detail.status})` : ''}.`,
        suggestion: 'Check that the brain host is up and reachable from this machine; gbrain doctor --json probes it without needing admin scope.',
        fix: doctor('Read-only: probes the remote brain address, OAuth discovery and token mint from this machine.') };
    }
    case 'parse':
    case 'tool_error':
      return { code: 'internal_error', retryable: false, recovery: 'Report it; retrying the same exchange gives the same answer.',
        why: 'The brain host answered with something this bridge could not read.', suggestion: 'Report it with the gbrain versions of this machine and the brain host.' };
    default: {
      const unreachable: never = e.reason;
      return unreachable;
    }
  }
}

/** What a lost acknowledgment allows before any replay, by what the operation is. */
function writeIdentity(e: RemoteMcpError, name: string, op: OperationMeta | undefined): Partial<ReasonFix> & { extra: Record<string, unknown> } | null {
  const status = e.detail?.submission_status;
  const mutating = op ? op.mutating === true : true;
  if (!mutating || !status) return null;
  const requestId = e.detail?.request_id;
  const extra: Record<string, unknown> = { submission_status: status, ...(requestId ? { request_id: requestId } : {}) };
  if (status === 'not_sent') return { extra: { ...extra, side_effects: 'none' }, retryable: true, recovery: 'Nothing reached the brain host, so resending the same call is safe.' };
  if (requestId && isPersistenceIpcMutation(name)) {
    return { code: 'write_outcome_unknown', retryable: false, extra: { ...extra, detail: 'delivery_unknown' },
      why: `${name} reached the brain host, but its answer was lost, so whether the write was accepted is unknown.`,
      recovery: `Retry the same call with the same request_id (${requestId}), or check get_write_request first; do not generate a new ID.`,
      fix: action({ mcp: { tool: 'get_write_request', arguments: { request_id: requestId } }, argv: ['gbrain', 'write-request', '--', requestId], actor: 'agent',
        why: 'Read-only: the receipt says whether the write committed; a resend with the same request_id returns that receipt instead of writing twice.' }) };
  }
  if (op && op.idempotent !== false) {
    return { extra, retryable: true, recovery: `${name} is idempotent, so resending the same call once gives one effect.` };
  }
  if (name.startsWith('submit_')) {
    return { code: 'write_outcome_unknown', retryable: false, extra,
      why: `${name} reached the brain host, but its answer was lost, so whether the job was queued is unknown.`,
      recovery: 'Check list_jobs for the job before submitting it again; a resend can queue it twice.',
      fix: action({ mcp: { tool: 'list_jobs', arguments: {} }, argv: ['gbrain', 'jobs', 'list'], actor: 'agent', why: 'Read-only: shows whether the job was queued.' }) };
  }
  return { code: 'write_outcome_unknown', retryable: false, extra,
    why: `${name} reached the brain host, but its answer was lost${op ? '' : ' (this gbrain does not know that tool, so its effects are unknown)'}; whether it took effect is unknown.`,
    recovery: 'Do not resend: ask the brain host owner whether it took effect first.',
    fix: action({ argv: DOCTOR, actor: 'host_admin', why: 'The brain host can tell whether the call took effect; this client cannot.',
      user_message: `A ${name} call to the gbrain brain host lost its answer, so it is unknown whether it took effect. Can you check on the brain host before it is sent again?` }) };
}

export interface BridgeErrorContext { render: RenderContext; mcpUrl: string; clientId?: string; timeoutMs: number }

function envelope(e: RemoteMcpError, row: ReasonFix, extra: Record<string, unknown>, ctx: BridgeErrorContext, message: string): Record<string, unknown> {
  const env = buildEnvelope({ error: row.code, code: row.code, reason: e.reason, message, why: row.why, suggestion: row.suggestion, ...(row.fix ? { fix: row.fix } : {}),
    docs: DOCS, retryable: row.retryable }, ctx.render);
  return stripUrlSecretsDeep({ ...env, ...extra, recovery: row.recovery, mcp_url: endpointLabel(ctx.mcpUrl),
    ...(e.detail?.status ? { status: e.detail.status } : {}), ...(e.detail?.retry_after_s !== undefined ? { retry_after_s: e.detail.retry_after_s } : {}) });
}

/** A `tools/call` transport failure as the v1 `isError` result the agent reads. */
export function bridgeCallFailure(e: RemoteMcpError, name: string, op: OperationMeta | undefined, ctx: BridgeErrorContext): ToolResultShape {
  const row = reasonFix(e, { clientId: ctx.clientId, timeoutMs: ctx.timeoutMs, read: op ? op.mutating !== true : false });
  const identity = writeIdentity(e, name, op);
  const merged: ReasonFix = identity ? { ...row, ...Object.fromEntries(Object.entries(identity).filter(([k]) => k !== 'extra')) } as ReasonFix : row;
  const message = `gbrain bridge could not relay ${name} to ${endpointLabel(ctx.mcpUrl)}: ${e.message}`;
  return toolErrorResult(envelope(e, merged, { stage: 'call', tool: name, ...(identity?.extra ?? {}) }, ctx, message) as never);
}

/** The stage a `tools/list` failure stopped at. */
function listStage(e: RemoteMcpError): string {
  switch (e.reason) {
    case 'config': return 'config';
    case 'discovery': return 'discovery';
    case 'token': case 'rate_limited': case 'auth': case 'auth_after_refresh': return 'token';
    case 'network': return 'connect';
    case 'parse': case 'tool_error': return 'list';
    default: { const unreachable: never = e.reason; return unreachable; }
  }
}

/** A `tools/list` failure: a JSON-RPC error whose `data` is the v1 envelope plus its stage and bounded recovery, and the same line for stderr. */
export function bridgeListFailure(e: RemoteMcpError, ctx: BridgeErrorContext): { error: McpError; line: string } {
  const row = reasonFix(e, { clientId: ctx.clientId, timeoutMs: ctx.timeoutMs, read: true });
  const stage = listStage(e);
  const recovery = row.retryable ? `Retry tools/list up to ${BRIDGE_RETRY.tries} times, ${BRIDGE_RETRY.delay_s} s apart, then run the fix.` : row.recovery;
  const data = envelope(e, { ...row, recovery }, { stage, side_effects: 'none' }, ctx, e.message);
  const fix = (data.fix as { command?: string } | undefined)?.command;
  const message = stripUrlSecrets(`gbrain bridge could not list tools from ${endpointLabel(ctx.mcpUrl)}: ${row.code} (${e.reason}); ${fix ? `fix: ${fix}` : row.suggestion}`);
  return { error: new McpError(ErrorCode.InternalError, message, data), line: `${BRIDGE_LOG_PREFIX} code=${row.code} reason=${e.reason} stage=${stage} ${message}` };
}

/** Write a redacted compact trace to a 0600 file under the gbrain home and return its id and path (null when it cannot be written). */
export function writeBridgeTrace(home: string, error: unknown, context: Record<string, unknown>): { id: string; path: string | null } {
  const id = randomUUID().slice(0, 8);
  const stack = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  try {
    const dir = join(home, 'bridge-traces');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${id}.txt`);
    writeFileSync(path, stripUrlSecrets(`gbrain ${VERSION} bridge fault ${id}\n${JSON.stringify(context)}\n${stack.split('\n').slice(0, 20).join('\n')}\n`), { mode: 0o600 });
    chmodSync(path, 0o600);
    return { id, path };
  } catch {
    return { id, path: null };
  }
}

/** A throw inside one `tools/call` handler that is not a transport failure: an `internal_error` envelope with a diagnostic id; the bridge keeps serving. */
export function bridgeInternalFailure(name: string, stage: string, trace: { id: string; path: string | null }, render: RenderContext): ToolResultShape {
  const env = buildEnvelope({ error: 'internal_error', code: 'internal_error', message: `gbrain bridge failed inside its own ${stage} step for ${name} (diagnostic ${trace.id}).`,
    why: 'A fault in the bridge on this machine, not in the brain host; nothing was relayed after it.',
    suggestion: `Report it with diagnostic id ${trace.id} and gbrain ${VERSION}${trace.path ? `; the trace is in ${trace.path}` : ''}.`,
    docs: DOCS, retryable: false }, render);
  return toolErrorResult(stripUrlSecretsDeep({ ...env, stage, tool: name, version: VERSION, diagnostic_id: trace.id, ...(trace.path ? { trace_file: trace.path } : {}),
    recovery: 'Report it. A read can be retried; check a write with get_write_request or the host owner before sending it again.' }) as never);
}

/** A bridge-built refusal that never reached the host (surface, _meta shape, audience support). */
export function bridgeRefusal(parts: { code: string; message: string; why: string; suggestion: string; fix?: Action }, render: RenderContext, extra: Record<string, unknown> = {}): ToolResultShape {
  const env = buildEnvelope({ error: parts.code, code: parts.code, message: parts.message, why: parts.why, suggestion: parts.suggestion, ...(parts.fix ? { fix: parts.fix } : {}), docs: DOCS, retryable: false }, render);
  return toolErrorResult(stripUrlSecretsDeep({ ...env, ...extra, side_effects: 'none' }) as never);
}
