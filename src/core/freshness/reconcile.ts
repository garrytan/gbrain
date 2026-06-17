import type { FreshnessMeta } from './types.ts';

export interface ReconcileFinding {
  severity: 'info' | 'warning' | 'error';
  category: string;
  slug?: string;
  message: string;
  suggestion?: string;
}

export interface ReconcileReport {
  timestamp: string;
  findings: ReconcileFinding[];
}

export interface ReconcilePage {
  slug: string;
  tags?: string[];
}

export interface ReconcileGraph {
  getRelatedEntities(slug: string): Promise<Array<{ slug: string; relation_type: string; direction: 'outgoing' | 'incoming' }>>;
}

export interface ReconcileLink {
  from_slug: string;
  to_slug: string;
}

export async function runReconcileCheck(
  pages: ReconcilePage[],
  graph: ReconcileGraph,
  links: ReconcileLink[],
): Promise<ReconcileReport> {
  const findings: ReconcileFinding[] = [];
  const slugSet = new Set(pages.map(p => p.slug));

  for (const page of pages) {
    const related = await graph.getRelatedEntities(page.slug);

    if (related.length === 0) {
      findings.push({
        severity: 'info',
        category: 'orphan_page',
        slug: page.slug,
        message: `Page "${page.slug}" has no incoming or outgoing links`,
        suggestion: 'Consider adding relations to connect this page to the knowledge graph',
      });
    }
  }

  for (const link of links) {
    if (!slugSet.has(link.to_slug)) {
      findings.push({
        severity: 'warning',
        category: 'dangling_link',
        slug: link.from_slug,
        message: `Link from "${link.from_slug}" to "${link.to_slug}" points to a non-existent page`,
        suggestion: `Create a page with slug "${link.to_slug}" or remove the link`,
      });
    }
  }

  for (const page of pages) {
    const tags = page.tags ?? [];
    const seen = new Set<string>();
    const duplicates = new Set<string>();

    for (const tag of tags) {
      if (seen.has(tag)) {
        duplicates.add(tag);
      }
      seen.add(tag);
    }

    if (duplicates.size > 0) {
      findings.push({
        severity: 'info',
        category: 'duplicate_tag',
        slug: page.slug,
        message: `Page "${page.slug}" has duplicate tag(s): ${[...duplicates].join(', ')}`,
        suggestion: 'Remove duplicate tag entries',
      });
    }
  }

  return {
    timestamp: new Date().toISOString(),
    findings,
  };
}
