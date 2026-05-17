/**
 * gbrain code-callers <symbol>
 *
 * v0.20.0 Cathedral II Layer 10 (C4) — "who calls this symbol?" Reversed
 * view of the A1 call graph. Matches `to_symbol_qualified` in both
 * code_edges_chunk (resolved) and code_edges_symbol (unresolved short-name
 * capture). Layer 5 captures edges at chunk time; Layer 10 exposes them.
 *
 * Scope decision: by default we only match the caller's source_id so
 * multi-repo brains don't cross-resolve (`Admin::UsersController#render`
 * in repo A ≠ same string in repo B). Pass `--all-sources` to search
 * globally.
 *
 * v0.34 W0b (Codex finding #7): the pre-v0.34 implementation set
 * `allSources: allSources || !sourceId`, which INVERTED the documented
 * default to global whenever --source was omitted. Multi-source brains
 * cross-contaminated structural retrieval despite the docstring claim.
 * Fix: when --source is omitted AND --all-sources is NOT set, resolve to
 * the brain's only source (single-source brains) or fail with a clear
 * error listing valid source ids (multi-source brains).
 *
 * Output: non-TTY → JSON envelope. TTY → human table. Follows the
 * code-def / code-refs pattern.
 */

import type { BrainEngine } from '../core/engine.ts';
import { errorFor, serializeError } from '../core/errors.ts';
import { resolveDefaultSource, SourceResolutionError } from '../core/sources-ops.ts';

function parseFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function shouldEmitJson(args: string[]): boolean {
  if (args.includes('--json')) return true;
  if (args.includes('--no-json')) return false;
  return !process.stdout.isTTY;
}

export async function runCodeCallers(engine: BrainEngine, args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith('--'));
  const sym = positional[0];
  if (!sym) {
    const err = errorFor({
      class: 'UsageError',
      code: 'code_callers_requires_symbol',
      message: 'code-callers requires a symbol name',
      hint: 'gbrain code-callers <symbol> [--source S | --all-sources] [--limit N] [--json]',
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

  // v0.34 W0b: when neither --source nor --all-sources is set, resolve
  // to the brain's only source. Multi-source brains require an explicit
  // choice — no more silent cross-source default.
  if (!allSources && !sourceId) {
    try {
      sourceId = await resolveDefaultSource(engine);
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
      throw e;
    }
  }

  try {
    const edges = await engine.getCallersOf(sym, {
      limit,
      allSources,
      sourceId: sourceId ?? undefined,
    });

    if (shouldEmitJson(args)) {
      console.log(JSON.stringify({ symbol: sym, count: edges.length, callers: edges }, null, 2));
    } else if (edges.length === 0) {
      console.log(`No callers found for "${sym}".`);
    } else {
      console.log(`${edges.length} caller(s) for "${sym}":`);
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
      console.error(`code-callers failed: ${env.message}`);
    }
    process.exit(1);
  }
}
