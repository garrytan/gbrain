/**
 * Operation replay for shadow replay (docs/guides/shadow-replay.md): runs a recorded CLI or MCP operation again on
 * one arm and returns what each surface prints. CLI JSON is `formatResult(..., { json: true })` of the normalized
 * result, CLI text (markdown for page reads) is `formatResult` without `--json`, and MCP is the whole tool result
 * from `dispatchToolCall` (content and isError). A read renders every surface; a write runs once, on the surface it
 * came in on. CLI notices, guest lines, paging and stderr are not compared.
 *
 * Not replayed as operations (their engine calls replay on their own instead): calls with a bound caller (an HTTP
 * credential, --as, an enforced member), admin and agent operations, and operations that take a file path.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { EngineConfig } from '../core/types.ts';
import { decodeValue } from './codec.ts';
import type { OpCall } from './op-hook.ts';
import { jsonView, type Outcome } from './replay.ts';

const PATH_PARAM = /^(path|file|filename|dir|directory|root|local_path|file_path)$/;

/** Why an operation is not replayed as one, or null when it is. */
export async function opSkipReason(call: OpCall): Promise<string | null> {
  if (call.bound_caller) return 'bound_caller';
  const { operations } = await import('../core/operations.ts');
  const op = operations.find(o => o.name === call.op);
  if (!op) return 'unknown_op';
  if (op.scope !== 'read' && op.scope !== 'write') return 'scope';
  if (Object.keys(op.params ?? {}).some(k => PATH_PARAM.test(k))) return 'file_effect';
  return null;
}

function parsed(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function errCode(e: unknown): string {
  const c = (e as { code?: unknown })?.code;
  return typeof c === 'string' ? c : 'error';
}

const CAPABILITY_CODES = new Set(['engine_capability_missing', 'raw_sql_missing']);

/**
 * The compared form of an MCP tool result: the whole result, byte for byte, except a typed "this engine cannot do it
 * yet" refusal, which reads as the same refused outcome a thrown error gives (so it counts as capability_missing).
 */
export function mcpOutcome(r: { isError?: boolean; content?: Array<{ type: string; text?: string }> }): Outcome {
  const content = (r.content ?? []).map(c => (c.type === 'text' ? { type: 'text', text: parsed(c.text ?? '') } : jsonView(c)));
  const code = r.isError ? (content[0] as { text?: { code?: unknown } } | undefined)?.text?.code : undefined;
  if (typeof code === 'string' && CAPABILITY_CODES.has(code)) return { ok: false, code };
  return { ok: true, value: { isError: r.isError ?? false, content } };
}

/** Renders one recorded operation on `engine`; each entry is one surface's output. */
export async function renderOperation(engine: BrainEngine, call: OpCall, config: EngineConfig): Promise<Array<{ member: string; out: Outcome }>> {
  const [{ operations }, { dispatchToolCall, buildOperationContext }, { formatResult, normalizeLocalResult }] = await Promise.all([
    import('../core/operations.ts'), import('../mcp/dispatch.ts'), import('../cli/main.ts')]);
  const op = operations.find(o => o.name === call.op)!;
  const params = (decodeValue(call.params ?? {}) ?? {}) as Record<string, unknown>;
  const read = op.mutating === false || op.scope === 'read';
  const scope = { sourceId: call.source_id, ...(call.federated_source_ids ? { localFederatedSourceIds: call.federated_source_ids } : {}), config: config as never };
  const outs: Array<{ member: string; out: Outcome }> = [];
  if (call.surface === 'mcp' || read) {
    try {
      outs.push({ member: `op:${call.op}:mcp`, out: mcpOutcome(await dispatchToolCall(engine, call.op, params, { remote: call.remote, transport: call.transport as never, ...scope })) });
    } catch (e) { outs.push({ member: `op:${call.op}:mcp`, out: { ok: false, code: errCode(e) } }); }
  }
  if (call.surface === 'cli' || read) {
    try {
      const ctx = buildOperationContext(engine, params, { remote: false, ...scope });
      const result = normalizeLocalResult(await op.handler(ctx, params));
      outs.push({ member: `op:${call.op}:cli_json`, out: { ok: true, value: parsed(formatResult(op.name, result, { ...params, json: true })) } });
      outs.push({ member: `op:${call.op}:cli_text`, out: { ok: true, value: formatResult(op.name, result, { ...params, json: false }) } });
    } catch (e) { outs.push({ member: `op:${call.op}:cli`, out: { ok: false, code: errCode(e) } }); }
  }
  return outs;
}
