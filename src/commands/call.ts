import type { BrainEngine } from '../core/engine.ts';
import { handleToolCall } from '../mcp/server.ts';
import { resolveSourceWithTier, localFederatedSourceIds } from '../core/source-resolver.ts';
import { bigintToStringReplacer } from '../core/utils.ts';
import { writeStdoutFinal } from '../core/cli-force-exit.ts';

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
  engine: BrainEngine,
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
  // Resolve through the canonical 6-tier chain. resolveSourceWithTier()
  // throws if an explicit/env/dotfile id refers to a non-registered source.
  // #3874: mirror cli.ts's makeContext — when the source resolved via a
  // NON-explicit tier, unqualified search-shaped reads span every
  // `config.federated = true` source (#2561 parity). Without this,
  // `gbrain call query ...` silently saw a narrower brain than
  // `gbrain query ...`.
  const resolved = await resolveSourceWithTier(engine, explicitSource);
  const sourceId = resolved.source_id;
  const localFederated = await localFederatedSourceIds(engine, resolved.source_id, resolved.tier);
  const result = await handleToolCall(engine, tool, params, {
    sourceId,
    ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
  });
  // `gbrain call` bypasses cli.ts's op-output normalizer entirely, so this
  // exit needs its own bigint-safe replacer — any op returning an int8 column
  // (BIGSERIAL id) would otherwise crash plain JSON.stringify (#2450).
  // Awaited delivery (#3423): a >64KiB payload piped to a slow reader loses
  // its tail to the exit grace under queued stdout writes.
  await out(JSON.stringify(result, bigintToStringReplacer, 2) + '\n');
}
