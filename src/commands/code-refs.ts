/**
 * gbrain code-refs <symbol>
 *
 * v0.19.0 Layer 7 — find all usage sites of a named symbol across the
 * brain's code pages. The DX "magical moment" for v0.19.0: an agent
 * asks "what uses BrainEngine" and gets back a JSON array of
 * {file, line, snippet} tuples in one CLI call.
 *
 * Implementation: bypasses the standard searchKeyword path (which uses
 * DISTINCT ON (slug) to collapse to one result per page — wrong for
 * code-refs where a single file typically has many usage sites). Uses
 * a direct ILIKE scan over content_chunks + JOIN pages, returning every
 * matching chunk.
 *
 * Scope: simple substring match. Word-boundary precision is a follow-up
 * (would require either tsvector or regex). For v0.19.0 the heuristic
 * is good enough: symbol names are distinctive by design, and noisy
 * matches (e.g. 'foo' matching 'food') are rare in well-written code.
 */

import type { BrainEngine } from '../core/engine.ts';
import { errorFor, serializeError } from '../core/errors.ts';

export interface CodeRefResult {
  slug: string;
  file: string | null;
  language: string | null;
  symbol_name: string | null;
  symbol_type: string | null;
  start_line: number | null;
  end_line: number | null;
  snippet: string;
}

export async function findCodeRefs(
  engine: BrainEngine,
  symbol: string,
  opts: { limit?: number; language?: string } = {},
): Promise<CodeRefResult[]> {
  const limit = opts.limit ?? 50;
  const params: unknown[] = [`%${symbol}%`];
  let whereLang = '';
  if (opts.language) {
    params.push(opts.language);
    whereLang = `AND cc.language = $${params.length}`;
  }
  params.push(limit);
  const rows = await engine.executeRaw<{
    slug: string; file: string | null; language: string | null;
    symbol_name: string | null; symbol_type: string | null;
    start_line: number | null; end_line: number | null;
    chunk_text: string;
  }>(
    `SELECT p.slug, (p.frontmatter->>'file') AS file, cc.language,
            cc.symbol_name, cc.symbol_type, cc.start_line, cc.end_line,
            cc.chunk_text
     FROM content_chunks cc
     JOIN pages p ON p.id = cc.page_id
     WHERE p.page_kind = 'code'
       AND cc.chunk_text ILIKE $1
       ${whereLang}
     ORDER BY p.slug, cc.start_line NULLS LAST
     LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    slug: r.slug,
    file: r.file,
    language: r.language,
    symbol_name: r.symbol_name,
    symbol_type: r.symbol_type,
    start_line: r.start_line,
    end_line: r.end_line,
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
  return !process.stdout.isTTY;
}

export async function runCodeRefs(engine: BrainEngine, args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith('--'));
  const sym = positional[0];
  if (!sym) {
    const err = errorFor({
      class: 'UsageError',
      code: 'code_refs_requires_symbol',
      message: 'code-refs requires a symbol name',
      hint: 'gbrain code-refs <symbol> [--lang <language>] [--json]',
    });
    if (shouldEmitJson(args)) {
      console.log(JSON.stringify({ error: err.envelope }));
    } else {
      console.error(err.message);
    }
    process.exit(2);
  }
  const limit = parseInt(parseFlag(args, '--limit') || '50', 10);
  const language = parseFlag(args, '--lang');
  try {
    const results = await findCodeRefs(engine, sym, { limit, language });
    if (shouldEmitJson(args)) {
      console.log(JSON.stringify({ symbol: sym, count: results.length, results }, null, 2));
    } else {
      if (results.length === 0) {
        console.log(`No references found for "${sym}"`);
      } else {
        console.log(`Found ${results.length} reference(s) to "${sym}":`);
        for (const r of results) {
          const loc = r.start_line != null ? `:${r.start_line}` : '';
          const sig = r.symbol_name ? ` in ${r.symbol_name}` : '';
          console.log(`  ${r.file || r.slug}${loc}${sig}`);
        }
      }
    }
  } catch (e: unknown) {
    const env = serializeError(e);
    if (shouldEmitJson(args)) {
      console.log(JSON.stringify({ error: env }));
    } else {
      console.error(`code-refs failed: ${env.message}`);
    }
    process.exit(1);
  }
}
