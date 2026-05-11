import type { BrainEngine } from '../engine.ts';

export function extractPutPageSlugFromToolInput(input: unknown): string | null {
  let value = input;
  for (let i = 0; i < 3; i++) {
    if (typeof value !== 'string') break;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const slug = (value as { slug?: unknown }).slug;
    return typeof slug === 'string' && slug.length > 0 ? slug : null;
  }
  return null;
}

export async function collectChildPutPageSlugs(
  engine: BrainEngine,
  childIds: number[],
): Promise<string[]> {
  if (childIds.length === 0) return [];
  const rows = await engine.executeRaw<{ input: unknown }>(
    `SELECT input
       FROM subagent_tool_executions
      WHERE job_id = ANY($1::int[])
        AND tool_name = 'brain_put_page'
        AND status = 'complete'
      ORDER BY id`,
    [childIds],
  );

  const slugs = new Set<string>();
  for (const row of rows) {
    const slug = extractPutPageSlugFromToolInput(row.input);
    if (slug) slugs.add(slug);
  }
  return Array.from(slugs).sort();
}
