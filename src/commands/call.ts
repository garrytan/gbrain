import type { BrainEngine } from '../core/engine.ts';
import { handleToolCall } from '../mcp/server.ts';
import { resolveSourceWithTier, localFederatedSourceIds } from '../core/source-resolver.ts';
import { bigintToStringReplacer } from '../core/utils.ts';
import { loadConfig } from '../core/config.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { currentCliWriteWait } from '../core/persistence/write-wait.ts';
import { maybeDelegateLocalOperation } from '../core/persistence/local-client.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';
import { exitCodeForCode } from '../core/error-catalogue.ts';
import { localCallErrorEnvelope } from '../mcp/dispatch.ts';
import { setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { OperationError } from '../core/ops/contract.ts';
import { isWriteErrorCode } from '../core/persistence/types.ts';

/**
 * Write-path failures (a receipt, a write_error, a write refusal code, the
 * persistence transport) keep their frozen receipt document and exit verdict;
 * every other op failure is the v1 envelope (fix, docs_cmd, class).
 */
function writePathFailure(error: unknown): boolean {
  return !(error instanceof OperationError) || error.writeRequest !== undefined || error.writeError !== undefined || isWriteErrorCode(error.code);
}

/**
 * `gbrain call <tool> <json>` — trusted local op-dispatch surface.
 *
 * v0.31.8 (D22): grammar accepts an optional `--source <id>` flag before the
 * tool name. The flag is the highest-priority tier in resolveSourceId()'s
 * 6-tier chain (--source > GBRAIN_SOURCE > .gbrain-source dotfile > path-match
 * > brain default > 'default'). Without --source, the chain still resolves —
 * env / dotfile / path-match all work.
 */
export async function runCall(
  engine: BrainEngine | (() => Promise<BrainEngine>),
  args: string[],
  // Test seam — production always uses the awaited-delivery writer (#3423).
  out: (payload: string) => Promise<void> = writeStdoutFinal,
) {
  // Parse --source <id> from anywhere in args (must come before tool/json
  // tokens to keep the existing `gbrain call <tool> <json>` shape readable,
  // but the parser is positional-tolerant for ergonomics).
  let explicitSource: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        console.error('--source requires an id (e.g. --source jarvis-memory)');
        process.exit(1);
      }
      explicitSource = next;
      i++;
      continue;
    }
    if (a.startsWith('--source=')) {
      explicitSource = a.slice('--source='.length);
      continue;
    }
    rest.push(a);
  }

  const tool = rest[0];
  const jsonStr = rest[1];

  if (!tool) {
    console.error("Usage: gbrain call [--source <id>] <tool> '<json>'");
    process.exit(1);
  }

  const params = jsonStr ? JSON.parse(jsonStr) : {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Tool parameters must be a JSON object.');
  // Parse and submit before acquiring PGLite. Keep the generated request ID
  // on the direct path as well, and never reconnect after ambiguous delivery.
  const wireParams = { ...params };
  try {
    const cli = getCliOptions();
    const delegated = await maybeDelegateLocalOperation(tool, wireParams, loadConfig(), {
      brain: cli.brain, source: explicitSource, timeoutMs: cli.timeoutMs ?? undefined,
    });
    if (wireParams.request_id !== undefined) params.request_id = wireParams.request_id;
    if (delegated.handled) {
      await out(JSON.stringify(delegated.result, bigintToStringReplacer, 2) + '\n');
      return;
    }
  } catch (error) {
    if (await reportPersistenceCliError(error, true, out)) return usageVerdict(error);
    throw error;
  }
  try {
  const connected = typeof engine === 'function' ? await engine() : engine;
  // Resolve through the canonical 6-tier chain. resolveSourceWithTier()
  // throws if an explicit/env/dotfile id refers to a non-registered source.
  // #3874: mirror cli.ts's makeContext — when the source resolved via a
  // NON-explicit tier, unqualified search-shaped reads span every
  // `config.federated = true` source (#2561 parity). Without this,
  // `gbrain call query ...` silently saw a narrower brain than
  // `gbrain query ...`.
  const resolved = await resolveSourceWithTier(connected, explicitSource);
  const sourceId = resolved.source_id;
  const localFederated = await localFederatedSourceIds(connected, resolved.source_id, resolved.tier);
  const result = await handleToolCall(connected, tool, params, {
    sourceId, writeWaitMs: currentCliWriteWait().waitMs,
    ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
  });
  // `gbrain call` bypasses cli.ts's op-output normalizer entirely, so this
  // exit needs its own bigint-safe replacer — any op returning an int8 column
  // (BIGSERIAL id) would otherwise crash plain JSON.stringify (#2450).
  // Awaited delivery (#3423): a >64KiB payload piped to a slow reader loses
  // its tail to the exit grace under queued stdout writes.
  await out(JSON.stringify(result, bigintToStringReplacer, 2) + '\n');
  } catch (error) {
    if (writePathFailure(error) && await reportPersistenceCliError(error, true, out)) return usageVerdict(error);
    await failCall(tool, error, out);
  }
}

/**
 * A3 on `gbrain call`: a caller mistake refused before any write was admitted
 * (no receipt) is invalid input, exit 2, even when the write lane rendered it.
 */
function usageVerdict(error: unknown): void {
  if (error instanceof OperationError && error.code === 'invalid_params' && error.writeRequest === undefined) setCliExitVerdict(2);
}

/**
 * Agent contract v1 (A1): `gbrain call` is a JSON surface, so a failure is
 * the same envelope an MCP caller gets, on stdout, with the registry's exit.
 */
async function failCall(tool: string, error: unknown, out: (text: string) => Promise<void>): Promise<void> {
  const envelope = localCallErrorEnvelope(tool, error);
  await out(JSON.stringify(envelope, null, 2) + '\n');
  console.error(`Error [${envelope.code}]: ${envelope.message}`);
  setCliExitVerdict(exitCodeForCode(envelope.code));
}
