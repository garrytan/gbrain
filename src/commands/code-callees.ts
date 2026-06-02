/**
 * gbrain code-callees <symbol>
 *
 * v0.20.0 Cathedral II Layer 10 (C5) — "what does this symbol call?"
 * Forward view of the A1 call graph. Matches `from_symbol_qualified`
 * in both code_edges_chunk + code_edges_symbol.
 *
 * Source resolution: honors the full chain (incl. the `.gbrain-source` pin)
 * via `resolveScopedSourceOrThrow` when --source/--all-sources are omitted.
 * See code-callers.ts for the full rationale. Same behavior here. JSON
 * envelope carries `source_id` + `scope`.
 *
 * Output: same JSON-on-non-TTY convention as code-callers / code-def /
 * code-refs.
 */

import type { BrainEngine } from '../core/engine.ts';
import { errorFor, serializeError } from '../core/errors.ts';
import { resolveScopedSourceOrThrow, SourceResolutionError } from '../core/sources-ops.ts';
import { formatSoleNonDefaultNudge } from '../core/source-resolver.ts';

/** A bad/invalid `.gbrain-source` pin or GBRAIN_SOURCE value surfaces from
 * `resolveSourceWithTier`'s `assertSourceExists` as a plain Error with one of
 * these message prefixes. Mirrors dream.ts:isResolverUserError. */
function isResolverUserError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const m = e.message;
  return (m.startsWith('Source "') && m.includes(' not found.'))
    || m.startsWith('Invalid --source value')
    || m.startsWith('Invalid GBRAIN_SOURCE value');
}

function parseFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function shouldEmitJson(args: string[]): boolean {
  if (args.includes('--json')) return true;
  if (args.includes('--no-json')) return false;
  return !process.stdout.isTTY;
}

export async function runCodeCallees(engine: BrainEngine, args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith('--'));
  const sym = positional[0];
  if (!sym) {
    const err = errorFor({
      class: 'UsageError',
      code: 'code_callees_requires_symbol',
      message: 'code-callees requires a symbol name',
      hint: 'gbrain code-callees <symbol> [--source S | --all-sources] [--limit N] [--json]',
    });
    if (shouldEmitJson(args)) {
      console.log(JSON.stringify({ error: err.envelope }));
    } else {
      console.error(err.message);
    }
    process.exit(2);
  }
  const limit = parseInt(parseFlag(args, '--limit') || '100', 10);
  const allSources = args.includes('--all-sources');
  let sourceId = parseFlag(args, '--source');

  // Full source-resolution chain (honors .gbrain-source pin, env, local_path,
  // brain_default, sole_non_default). Matches code-callers behavior.
  if (!allSources && !sourceId) {
    try {
      const resolved = await resolveScopedSourceOrThrow(engine);
      sourceId = resolved.source_id;
      if (resolved.tier === 'sole_non_default') {
        const nudge = formatSoleNonDefaultNudge(resolved.source_id);
        if (nudge) console.error(nudge);
      }
    } catch (e: unknown) {
      if (e instanceof SourceResolutionError) {
        const env = errorFor({
          class: 'UsageError',
          code: e.code,
          message: e.message,
          hint: 'pass --source <id> for one source, or --all-sources to search every source',
        }).envelope;
        if (shouldEmitJson(args)) {
          console.log(JSON.stringify({ error: env }));
        } else {
          console.error(e.message);
        }
        process.exit(2);
      }
      if (isResolverUserError(e)) {
        const env = errorFor({
          class: 'UsageError',
          code: 'invalid_source_pin',
          message: (e as Error).message,
          hint: 'fix the .gbrain-source pin / GBRAIN_SOURCE value, or pass --source <id> / --all-sources',
        }).envelope;
        if (shouldEmitJson(args)) {
          console.log(JSON.stringify({ error: env }));
        } else {
          console.error((e as Error).message);
        }
        process.exit(2);
      }
      throw e;
    }
  }

  try {
    const edges = await engine.getCalleesOf(sym, {
      limit,
      allSources,
      sourceId: sourceId ?? undefined,
    });

    const scope = allSources ? 'all' : 'single';
    const envelopeSourceId = allSources ? null : (sourceId ?? null);

    if (shouldEmitJson(args)) {
      const out: Record<string, unknown> = {
        symbol: sym, source_id: envelopeSourceId, scope, count: edges.length, callees: edges,
      };
      if (edges.length === 0 && !allSources && sourceId) {
        out.hint = `No callees in source '${sourceId}'. Try --all-sources to search every source.`;
      }
      console.log(JSON.stringify(out, null, 2));
    } else if (edges.length === 0) {
      if (!allSources && sourceId) {
        console.log(`No callees found for "${sym}" in source '${sourceId}'. Try --all-sources to search every source.`);
      } else {
        console.log(`No callees found for "${sym}".`);
      }
    } else {
      console.log(`${edges.length} callee(s) for "${sym}":`);
      for (const e of edges) {
        const res = e.resolved ? 'resolved' : 'unresolved';
        console.log(`  ${e.from_symbol_qualified}  → ${e.to_symbol_qualified}  [${res}]`);
      }
    }
  } catch (e: unknown) {
    const env = serializeError(e);
    if (shouldEmitJson(args)) {
      console.log(JSON.stringify({ error: env }));
    } else {
      console.error(`code-callees failed: ${env.message}`);
    }
    process.exit(1);
  }
}
