/**
 * gbrain code-callees <symbol>
 *
 * v0.20.0 Cathedral II Layer 10 (C5) — "what does this symbol call?"
 * Forward view of the A1 call graph. Matches `from_symbol_qualified`
 * in both code_edges_chunk + code_edges_symbol.
 *
 * Output: same JSON-on-non-TTY convention as code-callers / code-def /
 * code-refs.
 */

import type { BrainEngine } from '../core/engine.ts';
import { errorFor, serializeError } from '../core/errors.ts';

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
      hint: 'gbrain code-callees <symbol> [--all-sources] [--limit N] [--json]',
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
  const sourceId = parseFlag(args, '--source');

  try {
    const edges = await engine.getCalleesOf(sym, {
      limit,
      allSources: allSources || !sourceId,
      sourceId: sourceId ?? undefined,
    });

    if (shouldEmitJson(args)) {
      console.log(JSON.stringify({ symbol: sym, count: edges.length, callees: edges }, null, 2));
    } else if (edges.length === 0) {
      console.log(`No callees found for "${sym}".`);
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
