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
 * Uses the content_chunks.symbol_name column (v0.19.0 migration v26), then
 * falls back to definition-like chunk text for older/federated indexes that
 * predate complete symbol metadata.
 */

import type { BrainEngine } from '../core/engine.ts';
import { errorFor, serializeError } from '../core/errors.ts';

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
const DEF_TYPES = [
  'function', 'class', 'interface', 'type', 'enum', 'struct', 'trait', 'module', 'contract',
  'table', 'view', 'index', 'procedure', 'schema', 'database', 'trigger',
];

const IDENT = String.raw`[A-Za-z_$][A-Za-z0-9_$]*`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function definitionLikeFragments(symbol: string): string[] {
  return [
    `function ${symbol}`,
    `def ${symbol}(`,
    `class ${symbol}`,
    `interface ${symbol}`,
    `type ${symbol}`,
    `enum ${symbol}`,
    `struct ${symbol}`,
    `trait ${symbol}`,
    `module ${symbol}`,
    `contract ${symbol}`,
    `create table ${symbol}`,
    `create view ${symbol}`,
    `create index ${symbol}`,
    `create function ${symbol}`,
    `create procedure ${symbol}`,
    `create schema ${symbol}`,
    `create database ${symbol}`,
    `create trigger ${symbol}`,
  ];
}

export function inferDefinitionTypeFromText(text: string, symbol: string): string | null {
  const s = escapeRegExp(symbol);
  const checks: Array<[RegExp, string]> = [
    [new RegExp(String.raw`\b(?:export\s+)?(?:async\s+)?function\s+${s}\b`, 'i'), 'function'],
    [new RegExp(String.raw`\b(?:async\s+)?def\s+${s}\s*\(`, 'i'), 'function'],
    [new RegExp(String.raw`\bclass\s+${s}\b`, 'i'), 'class'],
    [new RegExp(String.raw`\binterface\s+${s}\b`, 'i'), 'interface'],
    [new RegExp(String.raw`\btype\s+${s}\b`, 'i'), 'type'],
    [new RegExp(String.raw`\benum\s+${s}\b`, 'i'), 'enum'],
    [new RegExp(String.raw`\bstruct\s+${s}\b`, 'i'), 'struct'],
    [new RegExp(String.raw`\btrait\s+${s}\b`, 'i'), 'trait'],
    [new RegExp(String.raw`\bmodule\s+${s}\b`, 'i'), 'module'],
    [new RegExp(String.raw`\bcontract\s+${s}\b`, 'i'), 'contract'],
    [new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?table\s+(?:if\s+not\s+exists\s+)?["\`]?${s}\b`, 'i'), 'table'],
    [new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?view\s+["\`]?${s}\b`, 'i'), 'view'],
    [new RegExp(String.raw`\bcreate\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?["\`]?${s}\b`, 'i'), 'index'],
    [new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+["\`]?${s}\b`, 'i'), 'function'],
    [new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?procedure\s+["\`]?${s}\b`, 'i'), 'procedure'],
    [new RegExp(String.raw`\bcreate\s+schema\s+(?:if\s+not\s+exists\s+)?["\`]?${s}\b`, 'i'), 'schema'],
    [new RegExp(String.raw`\bcreate\s+database\s+["\`]?${s}\b`, 'i'), 'database'],
    [new RegExp(String.raw`\bcreate\s+trigger\s+["\`]?${s}\b`, 'i'), 'trigger'],
  ];
  return checks.find(([re]) => re.test(text))?.[1] ?? null;
}

export function extractDefinitionLikeSymbol(text: string): { symbol: string; symbol_type: string | null } | null {
  const checks: Array<[RegExp, string]> = [
    [new RegExp(String.raw`\b(?:export\s+)?(?:async\s+)?function\s+(${IDENT})\b`, 'i'), 'function'],
    [new RegExp(String.raw`\b(?:async\s+)?def\s+(${IDENT})\s*\(`, 'i'), 'function'],
    [new RegExp(String.raw`\bclass\s+(${IDENT})\b`, 'i'), 'class'],
    [new RegExp(String.raw`\binterface\s+(${IDENT})\b`, 'i'), 'interface'],
    [new RegExp(String.raw`\btype\s+(${IDENT})\b`, 'i'), 'type'],
    [new RegExp(String.raw`\benum\s+(${IDENT})\b`, 'i'), 'enum'],
    [new RegExp(String.raw`\bstruct\s+(${IDENT})\b`, 'i'), 'struct'],
    [new RegExp(String.raw`\btrait\s+(${IDENT})\b`, 'i'), 'trait'],
    [new RegExp(String.raw`\bmodule\s+(${IDENT})\b`, 'i'), 'module'],
    [new RegExp(String.raw`\bcontract\s+(${IDENT})\b`, 'i'), 'contract'],
    [new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?table\s+(?:if\s+not\s+exists\s+)?["\`]?(${IDENT})\b`, 'i'), 'table'],
    [new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?view\s+["\`]?(${IDENT})\b`, 'i'), 'view'],
    [new RegExp(String.raw`\bcreate\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?["\`]?(${IDENT})\b`, 'i'), 'index'],
    [new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+["\`]?(${IDENT})\b`, 'i'), 'function'],
    [new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?procedure\s+["\`]?(${IDENT})\b`, 'i'), 'procedure'],
    [new RegExp(String.raw`\bcreate\s+schema\s+(?:if\s+not\s+exists\s+)?["\`]?(${IDENT})\b`, 'i'), 'schema'],
    [new RegExp(String.raw`\bcreate\s+database\s+["\`]?(${IDENT})\b`, 'i'), 'database'],
    [new RegExp(String.raw`\bcreate\s+trigger\s+["\`]?(${IDENT})\b`, 'i'), 'trigger'],
  ];
  for (const [re, symbol_type] of checks) {
    const match = text.match(re);
    if (match?.[1]) return { symbol: match[1], symbol_type };
  }
  return null;
}

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
       AND (cc.symbol_type IS NULL OR cc.symbol_type IN ('${DEF_TYPES.join("','")}', 'export statement'))
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
  if (rows.length > 0) {
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

  const fallbackParams: unknown[] = [limit];
  let fallbackWhereLang = '';
  if (opts.language) {
    fallbackParams.push(opts.language);
    fallbackWhereLang = `AND cc.language = $${fallbackParams.length}`;
  }
  const clauses = definitionLikeFragments(symbol).map((fragment) => {
    fallbackParams.push(fragment.toLowerCase());
    return `POSITION($${fallbackParams.length} IN LOWER(cc.chunk_text)) > 0`;
  });
  const fallbackRows = await engine.executeRaw<{
    slug: string; file: string | null; language: string | null;
    symbol_type: string | null; start_line: number | null; end_line: number | null;
    chunk_text: string; chunk_index: number;
  }>(
    `SELECT p.slug, (p.frontmatter->>'file') AS file, cc.language, cc.symbol_type,
            cc.start_line, cc.end_line, cc.chunk_text, cc.chunk_index
     FROM content_chunks cc
     JOIN pages p ON p.id = cc.page_id
     WHERE p.page_kind = 'code'
       ${fallbackWhereLang}
       AND (${clauses.join(' OR ')})
     ORDER BY p.slug, cc.start_line NULLS LAST, cc.chunk_index
     LIMIT $1`,
    fallbackParams,
  );

  return fallbackRows.map((r) => ({
    slug: r.slug,
    file: r.file,
    language: r.language,
    symbol_type: r.symbol_type ?? inferDefinitionTypeFromText(r.chunk_text, symbol),
    start_line: r.start_line,
    end_line: r.end_line,
    // First 500 chars of chunk — enough for a preview without flooding output.
    snippet: r.chunk_text.slice(0, 500),
  }));
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
    if (shouldEmitJson(args)) {
      console.log(JSON.stringify({ symbol: sym, count: results.length, results }, null, 2));
    } else {
      if (results.length === 0) {
        console.log(`No definitions found for "${sym}"`);
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
