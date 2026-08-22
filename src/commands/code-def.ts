/**
 * gbrain code-def <symbol>
 *
 * v0.19.0 Layer 7 — look up the definition site(s) of a named symbol
 * (function, class, type, interface, enum) across every code page the
 * brain has indexed.
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

export interface CodeDefResult {
  slug: string;
  file: string | null;
  language: string | null;
  symbol_type: string | null;
  start_line: number | null;
  end_line: number | null;
  snippet: string;
}

// v0.41 D2: SQL DDL targets (table/view/index/procedure/schema/database/
// trigger) are first-class definitions in the SQL sense. The chunker's
// normalizeSymbolType maps create_table → 'table' etc, so adding the SQL
// kinds here is what makes `gbrain code-def users` work against SQL.
// Method-level + member definitions. normalizeSymbolType only canonicalizes
// some node types; the rest fall through `type.replace(/_/g, ' ')`, so
// tree-sitter's method_declaration → 'method declaration', struct_specifier →
// 'struct specifier', protocol_declaration → 'protocol declaration', etc.
// Without these, code-def is blind to every method, constructor, field, C
// struct, and Swift protocol — which is most of an OO codebase. The plain
// 'struct' entry above never matched for the same reason (C emits the
// 'struct specifier' fallback form).
export const DEF_TYPES = [
  'function', 'class', 'interface', 'type', 'enum', 'struct', 'trait', 'module', 'contract',
  'table', 'view', 'index', 'procedure', 'schema', 'database', 'trigger',
  'method declaration', 'method definition', 'constructor declaration',
  'field declaration', 'field definition', 'struct specifier', 'protocol declaration',
  // Dart: normalizeSymbolType has no rule for these four, so they arrive as
  // the node type with underscores replaced. class_definition/enum_declaration/
  // type_alias/function_signature already normalize into the list above.
  'mixin declaration', 'extension declaration',
  'getter signature', 'setter signature',
  // #3789 residual audit — every remaining definition-shaped fallthrough of
  // normalizeSymbolType across TOP_LEVEL_TYPES + NESTED_EMIT_CONFIG. Without
  // these, symbols the chunker HAS indexed are invisible to code-def (Java
  // records, C#/Kotlin properties, Rust structs/traits, Go type declarations,
  // Solidity contracts — the bare 'contract'/'trait'/'struct' entries above
  // are never produced by normalizeSymbolType, only these fallthrough forms).
  'property declaration', 'record declaration',            // C#/Kotlin, Java
  'struct declaration', 'object declaration',              // C#/Swift, Kotlin
  'namespace declaration', 'file scoped namespace declaration', // C#
  'trait declaration',                                     // PHP
  'trait definition', 'object definition',                 // Scala
  'contract declaration', 'modifier definition', 'event definition', // Solidity
  'namespace definition', 'template declaration', 'declaration', 'preproc def', // C/C++
  'type declaration', 'const declaration', 'var declaration', // Go
  'struct item', 'trait item', 'impl item', 'mod item',    // Rust
  'type item', 'const item', 'static item',                // Rust
  'lexical declaration', 'variable declaration',           // TS/JS top-level const/let/var
  'local declaration',                                     // Lua
];

export async function findCodeDef(
  engine: BrainEngine,
  symbol: string,
  opts: { limit?: number; language?: string } = {},
): Promise<CodeDefResult[]> {
  const limit = opts.limit ?? 20;
  const params: unknown[] = [symbol, limit];
  let whereLang = '';
  if (opts.language) {
    params.splice(1, 0, opts.language);
    whereLang = 'AND cc.language = $2';
  }
  // Deterministic ordering: exact type matches first (functions before
  // export_statement wrappers), then page slug, then line number.
  const rows = await engine.executeRaw<{
    slug: string; file: string | null; language: string | null;
    symbol_type: string | null; start_line: number | null; end_line: number | null;
    chunk_text: string;
  }>(
    `SELECT p.slug, (p.frontmatter->>'file') AS file, cc.language, cc.symbol_type,
            cc.start_line, cc.end_line, cc.chunk_text
     FROM content_chunks cc
     JOIN pages p ON p.id = cc.page_id
     WHERE cc.symbol_name = $1
       ${whereLang}
       AND p.page_kind = 'code'
       AND cc.symbol_type IN ('${DEF_TYPES.join("','")}', 'export statement')
     ORDER BY
       CASE cc.symbol_type
         WHEN 'function' THEN 1 WHEN 'class' THEN 2 WHEN 'interface' THEN 3
         WHEN 'type' THEN 4 WHEN 'enum' THEN 5 WHEN 'struct' THEN 6
         ELSE 7
       END,
       p.slug, cc.start_line
     LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    slug: r.slug,
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
  opts: { language?: string } = {},
): Promise<string[]> {
  const params: unknown[] = [symbol];
  let whereLang = '';
  if (opts.language) {
    params.push(opts.language);
    whereLang = `AND cc.language = $${params.length}`;
  }
  const rows = await engine.executeRaw<{ symbol_type: string | null }>(
    `SELECT DISTINCT cc.symbol_type
     FROM content_chunks cc
     JOIN pages p ON p.id = cc.page_id
     WHERE cc.symbol_name = $1
       ${whereLang}
       AND p.page_kind = 'code'
     ORDER BY cc.symbol_type
     LIMIT 20`,
    params,
  );
  const allow = new Set([...DEF_TYPES, 'export statement']);
  return rows
    .map((r) => r.symbol_type)
    .filter((t): t is string => t != null && !allow.has(t));
}

function parseFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function shouldEmitJson(args: string[]): boolean {
  if (args.includes('--json')) return true;
  if (args.includes('--no-json')) return false;
  // Auto-detect: non-TTY stdout means an agent is piping us — default to JSON.
  return !process.stdout.isTTY;
}

export async function runCodeDef(engine: BrainEngine, args: string[]): Promise<void> {
  const symbol = args.find((a) => !a.startsWith('--') && args.indexOf(a) > 0);
  // args[0] is the symbol when invoked as `gbrain code-def <symbol>`
  const positional = args.filter((a) => !a.startsWith('--'));
  const sym = positional[0];
  if (!sym) {
    const err = errorFor({
      class: 'UsageError',
      code: 'code_def_requires_symbol',
      message: 'code-def requires a symbol name',
      hint: 'gbrain code-def <symbol> [--lang <language>] [--json]',
    });
    if (shouldEmitJson(args)) {
      console.log(JSON.stringify({ error: err.envelope }));
    } else {
      console.error(err.message);
    }
    process.exit(2);
  }
  const limit = parseInt(parseFlag(args, '--limit') || '20', 10);
  const language = parseFlag(args, '--lang');
  try {
    const results = await findCodeDef(engine, sym, { limit, language });
    // code-def is brain-wide (not source-scoped); readiness is 'symbol' grain.
    const readiness = await resolveCodeReadiness(engine, { kind: 'symbol', count: results.length });
    // #3789: a count:0 that was filtered by the DEF_TYPES allowlist must not
    // read as a bare ready:true / "symbol does not exist". Probe the distinct
    // symbol types the name DOES have and surface the filtered ones.
    let filteredTypes: string[] = [];
    if (results.length === 0) {
      try {
        filteredTypes = await probeFilteredSymbolTypes(engine, sym, { language });
      } catch {
        // Supplementary signal — never fail the command on the probe.
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
        count: results.length,
        status: readiness.status,
        ready: readiness.ready,
        ...(filteredTypes.length > 0
          ? { filtered_symbol_types: filteredTypes, hint: filteredHint }
          : {}),
        results,
      }, null, 2));
    } else {
      if (results.length === 0) {
        console.log(`No definitions found for "${sym}"`);
        if (filteredHint) console.log(filteredHint);
        const hint = readinessHint(readiness);
        if (hint) console.log(hint);
      } else {
        console.log(`Found ${results.length} definition(s) for "${sym}":`);
        for (const r of results) {
          const loc = r.start_line != null ? `:${r.start_line}` : '';
          console.log(`  ${r.file || r.slug}${loc}  (${r.symbol_type})`);
        }
      }
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
