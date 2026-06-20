import { createHash } from 'crypto';
import type { BrainEngine, LinkBatchInput } from './engine.ts';

export const DERIVED_PATH_SOURCE = 'derived-path';
export const STRUCTURE_PREFIX = '__gbrain';
export const MAX_STRUCTURAL_CHILDREN = 64;

interface PageRow {
  source_id: string;
  slug: string;
  title: string;
  source_path: string | null;
  frontmatter: Record<string, unknown> | string | null;
}

interface StructuralPage {
  sourceId: string;
  slug: string;
  title: string;
  kind: 'global' | 'source' | 'directory' | 'bucket';
  representedPath: string;
}

interface Edge {
  fromSource: string;
  fromSlug: string;
  toSource: string;
  toSlug: string;
}

export interface StructureReconcileOptions {
  sourceId?: string;
  sourceIds?: string[];
  dryRun?: boolean;
}

export interface StructureReconcileResult {
  dry_run: boolean;
  sources: string[];
  authored_pages: number;
  structural_pages_planned: number;
  structural_pages_written: number;
  edges_planned: number;
  edges_written: number;
  retired_pages: number;
  max_degree: number;
  provenance: typeof DERIVED_PATH_SOURCE;
}

function parsedFrontmatter(value: PageRow['frontmatter']): Record<string, unknown> {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function nodeKey(sourceId: string, slug: string): string {
  return `${sourceId}\0${slug}`;
}

function slugDirectory(slug: string): string {
  const index = slug.lastIndexOf('/');
  return index < 0 ? '' : slug.slice(0, index);
}

function directorySlug(path: string): string {
  const label = path.split('/').filter(Boolean).at(-1) ?? 'root';
  const safe = label.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'dir';
  return `${STRUCTURE_PREFIX}/dir/${shortHash(path)}-${safe}`;
}

function bucketSlug(parentKey: string, prefix: string): string {
  return `${STRUCTURE_PREFIX}/bucket/${shortHash(parentKey)}-${prefix || 'other'}`;
}

function structuralContent(page: StructuralPage): string {
  const subject = page.kind === 'global'
    ? 'all registered knowledge sources'
    : page.kind === 'source'
      ? `the ${page.sourceId} source`
      : `the ${page.representedPath || 'root'} path in ${page.sourceId}`;
  return `# ${page.title}\n\nDeterministic structural index for ${subject}. ` +
    `Relationships are reconciled from source paths and stamped with ${DERIVED_PATH_SOURCE} provenance.`;
}

function buildPlan(rows: PageRow[], includeGlobal = true): {
  sources: string[];
  pages: StructuralPage[];
  edges: Edge[];
  maxDegree: number;
} {
  const authored = rows.filter(row => {
    const fm = parsedFrontmatter(row.frontmatter);
    return fm.generated_by !== DERIVED_PATH_SOURCE && !row.slug.startsWith(`${STRUCTURE_PREFIX}/`);
  });
  const sources = [...new Set(authored.map(row => row.source_id))].sort();
  const structural = new Map<string, StructuralPage>();
  const rawEdges: Edge[] = [];

  const global: StructuralPage = {
    sourceId: 'default', slug: `${STRUCTURE_PREFIX}/structure`, title: 'Global Brain',
    kind: 'global', representedPath: '',
  };
  if (includeGlobal) structural.set(nodeKey(global.sourceId, global.slug), global);

  for (const sourceId of sources) {
    const sourceRoot: StructuralPage = {
      sourceId, slug: `${STRUCTURE_PREFIX}/source`, title: `Source: ${sourceId}`,
      kind: 'source', representedPath: '',
    };
    structural.set(nodeKey(sourceRoot.sourceId, sourceRoot.slug), sourceRoot);
    if (includeGlobal) {
      rawEdges.push({
        fromSource: global.sourceId, fromSlug: global.slug,
        toSource: sourceId, toSlug: sourceRoot.slug,
      });
    }

    const sourceRows = authored.filter(row => row.source_id === sourceId);
    const existingIndexes = new Map<string, string>();
    for (const row of sourceRows) {
      const base = row.slug.split('/').at(-1)?.toLowerCase();
      if (base === 'readme' || base === 'index' || base === '_index') {
        existingIndexes.set(slugDirectory(row.slug), row.slug);
      }
    }

    const directories = new Set<string>();
    for (const row of sourceRows) {
      const parts = slugDirectory(row.slug).split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) directories.add(parts.slice(0, i).join('/'));
    }

    const directoryNode = new Map<string, string>();
    for (const directory of [...directories].sort()) {
      const existing = existingIndexes.get(directory);
      if (existing) {
        directoryNode.set(directory, existing);
      } else {
        const page: StructuralPage = {
          sourceId,
          slug: directorySlug(`${sourceId}/${directory}`),
          title: directory.split('/').at(-1) ?? sourceId,
          kind: 'directory',
          representedPath: directory,
        };
        structural.set(nodeKey(page.sourceId, page.slug), page);
        directoryNode.set(directory, page.slug);
      }
    }

    for (const directory of [...directories].sort()) {
      const parentDirectory = slugDirectory(directory);
      const parentSlug = parentDirectory
        ? directoryNode.get(parentDirectory)!
        : sourceRoot.slug;
      const childSlug = directoryNode.get(directory)!;
      if (parentSlug !== childSlug) {
        rawEdges.push({ fromSource: sourceId, fromSlug: parentSlug, toSource: sourceId, toSlug: childSlug });
      }
    }

    for (const row of sourceRows) {
      const directory = slugDirectory(row.slug);
      const indexForDirectory = existingIndexes.get(directory);
      if (indexForDirectory === row.slug) {
        if (!directory) {
          rawEdges.push({
            fromSource: sourceId,
            fromSlug: sourceRoot.slug,
            toSource: sourceId,
            toSlug: row.slug,
          });
        }
        continue;
      }
      rawEdges.push({
        fromSource: sourceId,
        fromSlug: directory ? directoryNode.get(directory)! : sourceRoot.slug,
        toSource: sourceId,
        toSlug: row.slug,
      });
    }
  }

  let edges = rawEdges;
  for (let depth = 1; depth <= 12; depth++) {
    const byParent = new Map<string, Edge[]>();
    for (const edge of edges) {
      const key = nodeKey(edge.fromSource, edge.fromSlug);
      const list = byParent.get(key) ?? [];
      list.push(edge);
      byParent.set(key, list);
    }
    const overfull = [...byParent.entries()].filter(([, children]) => children.length > MAX_STRUCTURAL_CHILDREN);
    if (overfull.length === 0) break;
    const replacing = new Set(overfull.map(([key]) => key));
    const next = edges.filter(edge => !replacing.has(nodeKey(edge.fromSource, edge.fromSlug)));
    for (const [parentKey, children] of overfull) {
      const [parentSource, parentSlug] = parentKey.split('\0');
      const buckets = new Map<string, Edge[]>();
      for (const child of children) {
        const hash = createHash('sha256').update(nodeKey(child.toSource, child.toSlug)).digest('hex');
        const prefix = hash.slice(0, depth);
        const list = buckets.get(prefix) ?? [];
        list.push(child);
        buckets.set(prefix, list);
      }
      for (const [prefix, bucketChildren] of buckets) {
        const page: StructuralPage = {
          sourceId: parentSource,
          slug: bucketSlug(parentKey, prefix),
          title: `Entries ${prefix.toUpperCase()}`,
          kind: 'bucket',
          representedPath: `${parentSlug}#${prefix}`,
        };
        structural.set(nodeKey(page.sourceId, page.slug), page);
        next.push({ fromSource: parentSource, fromSlug: parentSlug, toSource: parentSource, toSlug: page.slug });
        for (const child of bucketChildren) {
          next.push({ ...child, fromSource: parentSource, fromSlug: page.slug });
        }
      }
    }
    edges = next;
  }

  const deduped = new Map<string, Edge>();
  for (const edge of edges) {
    if (nodeKey(edge.fromSource, edge.fromSlug) === nodeKey(edge.toSource, edge.toSlug)) continue;
    deduped.set(`${nodeKey(edge.fromSource, edge.fromSlug)}>${nodeKey(edge.toSource, edge.toSlug)}`, edge);
  }
  edges = [...deduped.values()];
  const degree = new Map<string, number>();
  for (const edge of edges) {
    const key = nodeKey(edge.fromSource, edge.fromSlug);
    degree.set(key, (degree.get(key) ?? 0) + 1);
  }
  return {
    sources,
    pages: [...structural.values()],
    edges,
    maxDegree: Math.max(0, ...degree.values()),
  };
}

export async function reconcileStructure(
  engine: BrainEngine,
  opts: StructureReconcileOptions = {},
): Promise<StructureReconcileResult> {
  const requested = opts.sourceIds?.length ? opts.sourceIds : opts.sourceId ? [opts.sourceId] : undefined;
  const params: unknown[] = [];
  const sourceClause = requested
    ? ` AND source_id = ANY($${params.push(requested)}::text[])`
    : '';
  const rows = await engine.executeRaw<PageRow>(
    `SELECT source_id, slug, COALESCE(title, slug) AS title, source_path, frontmatter
       FROM pages WHERE deleted_at IS NULL${sourceClause}
       ORDER BY source_id, slug`,
    params,
  );
  const plan = buildPlan(rows, !requested);
  const base: StructureReconcileResult = {
    dry_run: !!opts.dryRun,
    sources: plan.sources,
    authored_pages: rows.filter(row => parsedFrontmatter(row.frontmatter).generated_by !== DERIVED_PATH_SOURCE).length,
    structural_pages_planned: plan.pages.length,
    structural_pages_written: 0,
    edges_planned: plan.edges.length,
    edges_written: 0,
    retired_pages: 0,
    max_degree: plan.maxDegree,
    provenance: DERIVED_PATH_SOURCE,
  };
  if (opts.dryRun) return base;

  return engine.transaction(async tx => {
    const plannedKeys = new Set(plan.pages.map(page => nodeKey(page.sourceId, page.slug)));
    let written = 0;
    for (const page of plan.pages) {
      await tx.executeRaw(
        `UPDATE pages SET deleted_at = NULL WHERE source_id = $1 AND slug = $2 AND deleted_at IS NOT NULL`,
        [page.sourceId, page.slug],
      );
      await tx.putPage(page.slug, {
        type: 'note',
        title: page.title,
        compiled_truth: structuralContent(page),
        frontmatter: {
          generated_by: DERIVED_PATH_SOURCE,
          structural_kind: page.kind,
          represented_path: page.representedPath,
          timeline_required: false,
        },
      }, { sourceId: page.sourceId });
      written++;
    }

    if (requested) {
      await tx.executeRaw(
        `DELETE FROM links l USING pages f, pages t
          WHERE l.from_page_id = f.id AND l.to_page_id = t.id
            AND l.link_source = $1
            AND f.source_id = ANY($2::text[])`,
        [DERIVED_PATH_SOURCE, requested],
      );
    } else {
      await tx.executeRaw(`DELETE FROM links WHERE link_source = $1`, [DERIVED_PATH_SOURCE]);
    }

    const linkRows: LinkBatchInput[] = plan.edges.map(edge => ({
      from_slug: edge.fromSlug,
      to_slug: edge.toSlug,
      from_source_id: edge.fromSource,
      to_source_id: edge.toSource,
      link_type: 'contains',
      link_source: DERIVED_PATH_SOURCE,
      context: 'Deterministic source-path containment',
    }));
    let edgesWritten = 0;
    for (let i = 0; i < linkRows.length; i += 500) {
      edgesWritten += await tx.addLinksBatch(linkRows.slice(i, i + 500), { auditSite: 'addLinksBatch' });
    }

    const existingParams: unknown[] = [DERIVED_PATH_SOURCE];
    const existingSourceClause = requested
      ? ` AND source_id = ANY($${existingParams.push(requested)}::text[])`
      : '';
    const existing = await tx.executeRaw<{ source_id: string; slug: string }>(
      `SELECT source_id, slug FROM pages
        WHERE deleted_at IS NULL AND frontmatter->>'generated_by' = $1${existingSourceClause}`,
      existingParams,
    );
    let retired = 0;
    for (const page of existing) {
      if (plannedKeys.has(nodeKey(page.source_id, page.slug))) continue;
      const result = await tx.executeRaw<{ id: number }>(
        `UPDATE pages p SET deleted_at = now()
          WHERE p.source_id = $1 AND p.slug = $2
            AND NOT EXISTS (SELECT 1 FROM links l WHERE (l.from_page_id = p.id OR l.to_page_id = p.id) AND l.link_source <> $3)
            AND NOT EXISTS (SELECT 1 FROM timeline_entries te WHERE te.page_id = p.id)
            AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.page_id = p.id)
          RETURNING p.id`,
        [page.source_id, page.slug, DERIVED_PATH_SOURCE],
      );
      retired += result.length;
    }
    return { ...base, structural_pages_written: written, edges_written: edgesWritten, retired_pages: retired };
  });
}

function globalSlug(): string {
  return `${STRUCTURE_PREFIX}/structure`;
}
