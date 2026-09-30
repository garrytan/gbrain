import type { BrainEngine } from '../engine.ts';

export interface CompanyBrainEvidence {
  ownership: { status: 'not_applicable' } | { status: 'verified'; page: string; owner: string; citations: string[] };
  supersession: { status: 'not_applicable' } | { status: 'verified'; newer: string; older: string; citations: string[] };
  page: { title: string; citation: string } | null;
}

export async function readCompanyBrainEvidence(engine: BrainEngine, sourceId: string): Promise<CompanyBrainEvidence> {
  const [owner] = await engine.executeRaw<{ from_slug: string; from_title: string; to_slug: string; to_title: string }>(
    `SELECT f.slug AS from_slug,f.title AS from_title,t.slug AS to_slug,t.title AS to_title
     FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
     WHERE f.source_id=$1 AND t.source_id=$1 AND f.deleted_at IS NULL AND t.deleted_at IS NULL
       AND l.link_type='owned_by' AND l.link_source IN ('frontmatter','markdown')
       AND (l.origin_page_id=f.id OR (l.origin_page_id IS NULL AND l.link_source='markdown'))
     ORDER BY CASE WHEN f.type='customer' THEN 0 ELSE 1 END,f.slug,t.slug LIMIT 1`, [sourceId]);
  const [decision] = await engine.executeRaw<{ from_slug: string; from_title: string; to_slug: string; to_title: string }>(
    `SELECT f.slug AS from_slug,f.title AS from_title,t.slug AS to_slug,t.title AS to_title
     FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
     WHERE f.source_id=$1 AND t.source_id=$1 AND f.deleted_at IS NULL AND t.deleted_at IS NULL
       AND f.type='decision' AND t.type='decision' AND l.link_type='supersedes'
       AND l.link_source IN ('frontmatter','markdown')
       AND (l.origin_page_id=f.id OR (l.origin_page_id IS NULL AND l.link_source='markdown'))
     ORDER BY f.slug,t.slug LIMIT 1`, [sourceId]);
  const [page] = await engine.executeRaw<{ slug: string; title: string }>(
    'SELECT slug,title FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug LIMIT 1', [sourceId]);
  const cite = (slug: string) => `${sourceId}::${slug}`;
  return {
    ownership: owner ? { status: 'verified', page: owner.from_title, owner: owner.to_title,
      citations: [cite(owner.from_slug), cite(owner.to_slug)] } : { status: 'not_applicable' },
    supersession: decision ? { status: 'verified', newer: decision.from_title, older: decision.to_title,
      citations: [cite(decision.from_slug), cite(decision.to_slug)] } : { status: 'not_applicable' },
    page: page ? { title: page.title, citation: cite(page.slug) } : null,
  };
}
