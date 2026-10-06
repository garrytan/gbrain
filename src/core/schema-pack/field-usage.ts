/**
 * Field usage per page type, inferred from the pages themselves: which
 * frontmatter keys, fact-line categories and relation-line types each type
 * actually uses. A field on every sampled page of a type is reported as
 * required, one on at least a quarter of them as optional; rarer fields are
 * listed with their share only. This gives typed pages a schema without
 * designing an ontology first. Read-only; zero LLM calls.
 */
import type { BrainEngine } from '../engine.ts';
import { parseLineGrammar } from '../line-grammar.ts';

export const REQUIRED_SHARE = 1;
export const OPTIONAL_SHARE = 0.25;
const DEFAULT_SAMPLE_PER_TYPE = 500;
const MAX_TYPES = 50;

export interface FieldShare { name: string; pages: number; share: number }

export interface TypeFieldUsage {
  type: string;
  pages: number;
  sampled: number;
  required: string[];
  optional: string[];
  frontmatter: FieldShare[];
  fact_categories: FieldShare[];
  relation_types: FieldShare[];
}

// Identity and write-provenance keys gbrain stamps itself are not schema fields.
const IGNORED_KEYS = new Set(['title', 'type', 'slug', 'ingested_at', 'ingested_via', 'source_kind', 'source_uri']);

function shares(counts: Map<string, number>, sampled: number): FieldShare[] {
  return [...counts].map(([name, pages]) => ({ name, pages, share: Math.round((pages / sampled) * 1000) / 1000 }))
    .sort((a, b) => b.pages - a.pages || a.name.localeCompare(b.name));
}

/** Field usage for the most common page types in a source (or the brain). */
export async function runFieldUsage(engine: Pick<BrainEngine, 'executeRaw'>, opts: { sourceId?: string; samplePerType?: number } = {}): Promise<TypeFieldUsage[]> {
  const sample = opts.samplePerType ?? DEFAULT_SAMPLE_PER_TYPE;
  const scope = opts.sourceId ? 'AND source_id = $1' : '';
  const params = opts.sourceId ? [opts.sourceId] : [];
  const types = await engine.executeRaw<{ type: string; pages: number }>(`SELECT type, count(*)::int AS pages FROM pages
    WHERE deleted_at IS NULL AND coalesce(type, '') <> '' ${scope} GROUP BY type ORDER BY count(*) DESC, type LIMIT ${MAX_TYPES}`, params);
  const result: TypeFieldUsage[] = [];
  for (const { type, pages } of types) {
    const rows = await engine.executeRaw<{ frontmatter: Record<string, unknown> | string | null; compiled_truth: string | null }>(
      `SELECT frontmatter, compiled_truth FROM pages WHERE deleted_at IS NULL AND type = $${params.length + 1} ${scope}
        ORDER BY id LIMIT ${Math.max(1, Math.floor(sample))}`, [...params, type]);
    const keys = new Map<string, number>(); const categories = new Map<string, number>(); const relations = new Map<string, number>();
    const bump = (map: Map<string, number>, names: Iterable<string>) => { for (const name of new Set(names)) map.set(name, (map.get(name) ?? 0) + 1); };
    for (const row of rows) {
      const fm = typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) as Record<string, unknown> : row.frontmatter ?? {};
      bump(keys, Object.keys(fm).filter(key => !IGNORED_KEYS.has(key) && fm[key] !== null && fm[key] !== ''));
      const grammar = parseLineGrammar(row.compiled_truth ?? '');
      bump(categories, grammar.facts.map(f => f.category.toLowerCase()));
      bump(relations, grammar.relations.map(r => r.type));
    }
    const sampled = rows.length;
    const frontmatter = shares(keys, sampled);
    const fact_categories = shares(categories, sampled);
    const relation_types = shares(relations, sampled);
    const all = [...frontmatter.map(f => ({ ...f, name: f.name })), ...fact_categories.map(f => ({ ...f, name: `[${f.name}]` })),
      ...relation_types.map(f => ({ ...f, name: `${f.name} ->` }))];
    result.push({ type, pages, sampled,
      required: all.filter(f => f.share >= REQUIRED_SHARE).map(f => f.name),
      optional: all.filter(f => f.share < REQUIRED_SHARE && f.share >= OPTIONAL_SHARE).map(f => f.name),
      frontmatter, fact_categories, relation_types });
  }
  return result;
}
