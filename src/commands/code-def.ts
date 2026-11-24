/**
 * gbrain code-def <symbol>
 *
 * v0.19.0 Layer 7 — look up the definition site(s) of a named symbol
 * (function, class, type, interface, enum) among the brain's code pages.
 *
 * Source-scoped by default (see resolveCliCodeScope), matching code-callers /
 * code-callees: on a multi-source brain the same symbol name in two repos is
 * two different symbols, and a foreign hit's repo-relative `file` is
 * indistinguishable from a local one. `--all-sources` spans every source.
 *
 * Output:
 *   - TTY or --pretty: human-readable list of matches, one per line.
 *   - non-TTY or --json: JSON array the agent consumes.
 *
 * Uses the content_chunks.symbol_name column (v0.19.0 migration v26).
 * No tree-sitter re-parsing needed — the metadata is already there.
 */

import type { BrainEngine } from '../core/engine.ts';
import { errorFor, serializeError } from '../core/errors.ts';
import { resolveCodeReadiness, readinessHint } from '../core/code-graph-readiness.ts';
import { resolveCliCodeScope, positionalArgs, parseFlag, parseCodeLimit } from './code-scope.ts';
import { codeReadFilter, type CodeReadScope } from '../core/code-intel/read-scope.ts';
import { rethrowCapabilityRefusal } from '../core/engine-capability-refusal.ts';

export interface CodeDefResult {
  slug: string;
  source_id: string;
  file: string | null;
  language: string | null;
  symbol_type: string | null;
  start_line: number | null;
  end_line: number | null;
  snippet: string;
}

// #4511: DEF_TYPES moved to src/core/chunkers/def-types.ts — the ONE shared
// list for this lookup allowlist AND the chunker's merge guard (a symbol type
// code-def can resolve must never have its symbol_name erased by
// small-sibling merging). Re-exported here so existing importers keep their
// surface.
import { DEF_TYPES } from '../core/chunkers/def-types.ts';
import { legacyNestedErrorDocument } from '../core/agent-output.ts';

export { DEF_TYPES };

export async function findCodeDef(
  engine: BrainEngine,
  symbol: string,
  opts: { limit?: number; language?: string } & CodeReadScope = {},
): Promise<CodeDefResult[]> {
  // Deterministic ordering: exact type matches first (functions before
  // export_statement wrappers), then page slug, then line number.
  const rows = await engine.findCodeDefinitions(symbol, opts);
  return rows.map((r) => ({
    slug: r.slug,
    source_id: r.source_id,
    file: r.file,
    language: r.language,
    symbol_type: r.symbol_type,
    start_line: r.start_line,
    end_line: r.end_line,
    // First 500 chars of chunk — enough for a preview without flooding output.
    snippet: r.chunk_text.slice(0, 500),
  }));
}

/**
 * #3789 aside — when findCodeDef returns 0 rows, distinguish "symbol does not
 * exist" from "symbol exists but every row's symbol_type is outside the
 * DEF_TYPES allowlist" (a normalizeSymbolType fallthrough gap, or data chunked
 * by an older chunker). Returns the distinct filtered-out symbol types for the
 * name; empty when the symbol genuinely has no named chunks. Runs ONLY on
 * count:0, rides the symbol_name lookup path the result query already uses.
 */
export async function probeFilteredSymbolTypes(
  engine: BrainEngine,
  symbol: string,
  opts: { language?: string } & CodeReadScope = {},
): Promise<string[]> {
  // Scoped with the main lookup: an unscoped probe would claim "the symbol IS
  // indexed, just filtered" on the strength of a different repo's chunks.
  const types = await engine.listSymbolTypesForName(symbol, opts);
  const allow = new Set([...DEF_TYPES, 'export statement']);
  return types.filter((t): t is string => t != null && !allow.has(t));
}

function shouldEmitJson(args: string[]): boolean {
  if (args.includes('--json')) return true;
  if (args.includes('--no-json')) return false;
  // Auto-detect: non-TTY stdout means an agent is piping us — default to JSON.
  return !process.stdout.isTTY;
}

export async function runCodeDef(engine: BrainEngine, args: string[]): Promise<void> {
  const positional = positionalArgs(args);
  const sym = positional[0];
  if (!sym) {
    const err = errorFor({
      class: 'UsageError',
      code: 'code_def_requires_symbol',
      message: 'code-def requires a symbol name',
      hint: 'gbrain code-def <symbol> [--source S | --all-sources] [--lang <language>] [--json]',
    });
    if (shouldEmitJson(args)) {
      console.log(JSON.stringify(legacyNestedErrorDocument(err.envelope, ['gbrain', 'code-def', '--help'])));
    } else {
      console.error(err.message);
    }
    process.exit(2);
  }
  const limit = parseCodeLimit(args, 'code-def', 20, shouldEmitJson(args));
  const language = parseFlag(args, '--lang');
  // Outside the try, matching code-callers / code-callees: the helper signals
  // usage failures with process.exit(2), and a surrounding catch would
  // reclassify them as a generic exit-1 failure.
  const { allSources, sourceId, scope, envelopeSourceId } = await resolveCliCodeScope(engine, {
    sourceId: parseFlag(args, '--source'),
    allSources: args.includes('--all-sources'),
    jsonMode: shouldEmitJson(args),
    command: 'code-def',
  });
  try {
    const results = await findCodeDef(engine, sym, { limit, language, sourceId, allSources });
    // Readiness is 'symbol' grain, scoped to the same source as the lookup.
    // remote: false — direct CLI invocation is the trusted local caller, so the
    // out_of_scope brain-wide rerun stays available.
    const readiness = await resolveCodeReadiness(engine, {
      kind: 'symbol', count: results.length, sourceId, allSources, remote: false,
    });
    const readinessMessage = readinessHint(readiness);
    // #3789: a count:0 that was filtered by the DEF_TYPES allowlist must not
    // read as a bare ready:true / "symbol does not exist". Probe the distinct
    // symbol types the name DOES have and surface the filtered ones.
    let filteredTypes: string[] = [];
    if (results.length === 0) {
      try {
        filteredTypes = await probeFilteredSymbolTypes(engine, sym, { language, sourceId, allSources });
      } catch (err) {
        // Supplementary signal — never fail the command on the probe, except
        // an engine that cannot answer it: that must not read as "no types".
        rethrowCapabilityRefusal(err);
      }
    }
    const filteredHint = filteredTypes.length > 0
      ? `Symbol "${sym}" IS indexed, but only with symbol type(s) outside the definition allowlist: ` +
        `${filteredTypes.join(', ')}. Likely a DEF_TYPES gap or pre-upgrade chunk data — ` +
        'try `gbrain code-refs` for these sites, and consider re-syncing the source.'
      : null;
    if (shouldEmitJson(args)) {
      console.log(JSON.stringify({
        symbol: sym,
        source_id: envelopeSourceId,
        scope,
        count: results.length,
        status: readiness.status,
        ready: readiness.ready,
        ...(readinessMessage || filteredHint ? { hint: [readinessMessage, filteredHint].filter(Boolean).join(' ') } : {}),
        ...(readiness.scoped_source_id ? { scoped_source_id: readiness.scoped_source_id } : {}),
        ...(filteredTypes.length > 0
          ? { filtered_symbol_types: filteredTypes }
          : {}),
        results,
      }, null, 2));
    } else {
      if (results.length === 0) {
        console.log(!allSources && sourceId
          ? `No definitions found for "${sym}" in source '${sourceId}'.${!['projection_pending', 'unknown'].includes(readiness.status) ? ' Try --all-sources to search every source.' : ''}`
          : `No definitions found for "${sym}"`);
        if (filteredHint) console.log(filteredHint);
      } else {
        console.log(`Found ${results.length} definition(s) for "${sym}":`);
        for (const r of results) {
          const loc = r.start_line != null ? `:${r.start_line}` : '';
          console.log(`  ${r.file || r.slug}${loc}  (${r.symbol_type})`);
        }
      }
      if (readinessMessage) console.log(readinessMessage);
    }
  } catch (e: unknown) {
    const env = serializeError(e);
    if (shouldEmitJson(args)) {
      console.log(JSON.stringify({ error: env }));
    } else {
      console.error(`code-def failed: ${env.message}`);
    }
    process.exit(1);
  }
}
