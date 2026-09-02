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
 * Source resolution: when --source is omitted AND --all-sources is NOT set,
 * resolve through the full source-resolution chain via
 * `resolveScopedSourceOrThrow` (flag → env → .gbrain-source dotfile →
 * local_path → brain_default → sole_non_default), matching `gbrain sources
 * current`. A `.gbrain-source` pin selects the source; only a no-signal
 * multi-source brain still fails with `multiple_sources_ambiguous`. (Pre-
 * v0.41.30 this called `resolveDefaultSource` directly, which ignored the pin
 * and errored on every multi-source brain — Codex finding #7's source-scoped
 * default is preserved; the pin is now honored on top of it.) `--all-sources`
 * searches globally and overrides any pin.
 *
 * Output: non-TTY → JSON envelope (carries `source_id` + `scope`). TTY → human
 * table. Follows the code-def / code-refs pattern.
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

export async function runCodeCallers(engine: BrainEngine, args: string[]): Promise<void> {
  const positional = positionalArgs(args);
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
  const { allSources, sourceId, scope, envelopeSourceId } = await resolveCliCodeScope(engine, {
    sourceId: parseFlag(args, '--source'),
    allSources: args.includes('--all-sources'),
    jsonMode: shouldEmitJson(args),
    command: 'code-callers',
  });

  try {
    const edges = await engine.getCallersOf(sym, {
      limit,
      allSources,
      sourceId: sourceId ?? undefined,
    });

    // Call-graph readiness ('edge' grain): distinguishes "graph not built / still
    // indexing" from "genuinely no callers" when count === 0.
    // remote: false — direct CLI invocation is the trusted local caller, so
    // the #3707 out_of_scope brain-wide rerun stays available (#4352 gate).
    const readiness = await resolveCodeReadiness(engine, {
      kind: 'edge', count: edges.length, sourceId: sourceId ?? undefined, allSources, remote: false,
    });

    if (shouldEmitJson(args)) {
      const out: Record<string, unknown> = {
        symbol: sym, source_id: envelopeSourceId, scope, count: edges.length,
        status: readiness.status, ready: readiness.ready, callers: edges,
      };
      // #3707: out_of_scope names the empty scope so "grant/scope problem" is
      // distinguishable from "graph never built" in machine output.
      if (readiness.scoped_source_id) out.scoped_source_id = readiness.scoped_source_id;
      if (edges.length === 0 && !allSources && sourceId) {
        out.hint = readiness.status === 'out_of_scope'
          ? (readinessHint(readiness) ?? `No callers in source '${sourceId}'.`)
          : `No callers in source '${sourceId}'. Try --all-sources to search every source.`;
      }
      console.log(JSON.stringify(out, null, 2));
    } else if (edges.length === 0) {
      if (!allSources && sourceId) {
        console.log(`No callers found for "${sym}" in source '${sourceId}'. Try --all-sources to search every source.`);
      } else {
        console.log(`No callers found for "${sym}".`);
      }
      const hint = readinessHint(readiness);
      if (hint) console.log(hint);
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
