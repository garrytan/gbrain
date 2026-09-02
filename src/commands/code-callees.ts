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
import { resolveCliCodeScope, positionalArgs, parseFlag } from './code-scope.ts';
import { resolveCodeReadiness, readinessHint } from '../core/code-graph-readiness.ts';

function shouldEmitJson(args: string[]): boolean {
  if (args.includes('--json')) return true;
  if (args.includes('--no-json')) return false;
  return !process.stdout.isTTY;
}

export async function runCodeCallees(engine: BrainEngine, args: string[]): Promise<void> {
  const positional = positionalArgs(args);
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
  const { allSources, sourceId, scope, envelopeSourceId } = await resolveCliCodeScope(engine, {
    sourceId: parseFlag(args, '--source'),
    allSources: args.includes('--all-sources'),
    jsonMode: shouldEmitJson(args),
    command: 'code-callees',
  });

  try {
    const edges = await engine.getCalleesOf(sym, {
      limit,
      allSources,
      sourceId: sourceId ?? undefined,
    });

    // Call-graph readiness ('edge' grain): distinguishes "graph not built / still
    // indexing" from "genuinely no callees" when count === 0.
    // remote: false — direct CLI invocation is the trusted local caller, so
    // the #3707 out_of_scope brain-wide rerun stays available (#4352 gate).
    const readiness = await resolveCodeReadiness(engine, {
      kind: 'edge', count: edges.length, sourceId: sourceId ?? undefined, allSources, remote: false,
    });

    if (shouldEmitJson(args)) {
      const out: Record<string, unknown> = {
        symbol: sym, source_id: envelopeSourceId, scope, count: edges.length,
        status: readiness.status, ready: readiness.ready, callees: edges,
      };
      // #3707: see code-callers.ts — scope problem vs never-built.
      if (readiness.scoped_source_id) out.scoped_source_id = readiness.scoped_source_id;
      if (edges.length === 0 && !allSources && sourceId) {
        out.hint = readiness.status === 'out_of_scope'
          ? (readinessHint(readiness) ?? `No callees in source '${sourceId}'.`)
          : `No callees in source '${sourceId}'. Try --all-sources to search every source.`;
      }
      console.log(JSON.stringify(out, null, 2));
    } else if (edges.length === 0) {
      if (!allSources && sourceId) {
        console.log(`No callees found for "${sym}" in source '${sourceId}'. Try --all-sources to search every source.`);
      } else {
        console.log(`No callees found for "${sym}".`);
      }
      const hint = readinessHint(readiness);
      if (hint) console.log(hint);
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
