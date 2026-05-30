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
import { resolveScopedSourceOrThrow, SourceResolutionError } from '../core/sources-ops.ts';
import { formatSoleNonDefaultNudge } from '../core/source-resolver.ts';

/** A bad/invalid `.gbrain-source` pin or GBRAIN_SOURCE value surfaces from
 * `resolveSourceWithTier`'s `assertSourceExists` as a plain Error with one of
 * these message prefixes. Mirrors dream.ts:isResolverUserError so we surface a
 * clean usage error instead of an uncaught stack. */
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

  // When neither --source nor --all-sources is set, resolve through the full
  // source-resolution chain (honors the .gbrain-source pin, env, local_path,
  // brain_default, sole_non_default). Only a no-signal multi-source brain
  // still errors as multiple_sources_ambiguous.
  if (!allSources && !sourceId) {
    try {
      const resolved = await resolveScopedSourceOrThrow(engine);
      sourceId = resolved.source_id;
      // Nudge only when we auto-routed to the sole non-default source (the one
      // tier with no explicit user signal). Matches sync/import behavior.
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
      // Bad/invalid pin (.gbrain-source or GBRAIN_SOURCE points at a missing
      // source) → clean usage error, not an uncaught stack.
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
    const edges = await engine.getCallersOf(sym, {
      limit,
      allSources,
      sourceId: sourceId ?? undefined,
    });

    const scope = allSources ? 'all' : 'single';
    const envelopeSourceId = allSources ? null : (sourceId ?? null);

    if (shouldEmitJson(args)) {
      const out: Record<string, unknown> = {
        symbol: sym, source_id: envelopeSourceId, scope, count: edges.length, callers: edges,
      };
      if (edges.length === 0 && !allSources && sourceId) {
        out.hint = `No callers in source '${sourceId}'. Try --all-sources to search every source.`;
      }
      console.log(JSON.stringify(out, null, 2));
    } else if (edges.length === 0) {
      if (!allSources && sourceId) {
        console.log(`No callers found for "${sym}" in source '${sourceId}'. Try --all-sources to search every source.`);
      } else {
        console.log(`No callers found for "${sym}".`);
      }
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
