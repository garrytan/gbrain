/**
 * GBrain Radar — snapshot exporter.
 *
 * Builds a full, atomic snapshot of a brain by reading the GBrain ENGINE only
 * (D5: never re-walks/re-parses the Markdown vault). One pass:
 *   listPages -> per-page (getTags, getLinks) -> headings -> global edge set ->
 *   graph + inlink/outlink counts -> privacy filter -> validate -> atomic swap.
 *
 * See docs/designs/RADAR_SNAPSHOT_EXPORT.md and ./types.ts for the contract.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, renameSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { createHash, randomBytes } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import type { Page, Link, PageFilters } from '../types.ts';
import { serializeMarkdown } from '../markdown.ts';
import { VERSION } from '../../version.ts';
import {
  SCHEMA_VERSION,
  EXPORTER_VERSION,
  type SnapshotModel,
  type RadarExportOpts,
  type PageHeading,
  type PageIndexEntry,
  type PageDetail,
  type PageLinkRef,
  type GraphNode,
  type GraphEdge,
  type SearchDoc,
  type TreeNode,
  type SnapshotSource,
  type SnapshotValidation,
  type RadarManifest,
} from './types.ts';

/** Thrown when a hard referential-integrity check fails; the swap is refused. */
export class RadarValidationError extends Error {
  constructor(public readonly failures: string[]) {
    super(`radar snapshot validation failed:\n  - ${failures.join('\n  - ')}`);
    this.name = 'RadarValidationError';
  }
}

/** Result returned by exportSnapshot for the CLI summary. */
export interface RadarExportResult {
  snapshot_id: string;
  previous_snapshot_id: string | null;
  current_dir: string;
  previous_dir: string | null;
  manifest: RadarManifest;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Stable, source-scoped page identity used across every snapshot file. */
export function pageKey(sourceId: string, slug: string): string {
  return `${sourceId}::${slug}`;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Parse ATX headings (`# .. ######`) from a Markdown body, skipping fenced
 * code blocks so a `# comment` inside a fence doesn't register as a heading.
 */
export function extractHeadings(body: string): PageHeading[] {
  const out: PageHeading[] = [];
  if (!body) return out;
  let inFence = false;
  let fenceMarker = '';
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trimStart();
    const fence = trimmed.match(/^(```+|~~~+)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (m) out.push({ level: m[1].length, text: m[2].trim() });
  }
  return out;
}

/** Frontmatter-derived classification (best-effort — core has no canonical column). */
export function classifyPage(frontmatter: Record<string, unknown>): {
  isPrivate: boolean;
  scope: string | null;
  privacy: string | null;
  status: string | null;
  authority: string | null;
} {
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null;
  const privacy = str(frontmatter['privacy']);
  const scope = str(frontmatter['scope']);
  const visibility = str(frontmatter['visibility']);
  const status = str(frontmatter['status']);
  const authority = str(frontmatter['authority']);
  const secret = frontmatter['secret'] === true;
  const publicFalse = frontmatter['public'] === false;
  const PRIVATE = new Set(['private', 'secret']);
  const isPrivate =
    (privacy ? PRIVATE.has(privacy.toLowerCase()) : false) ||
    (scope ? PRIVATE.has(scope.toLowerCase()) : false) ||
    (visibility ? visibility.toLowerCase() === 'private' : false) ||
    secret ||
    publicFalse;
  return { isPrivate, scope, privacy: privacy ?? (secret ? 'secret' : null), status, authority };
}

/**
 * Map a slug to a SAFE relative file path for the per-page JSON file. Drops
 * empty/'.'/'..' segments (no path traversal), preserves the folder shape, and
 * appends `.json`. Falls back to a hash when a slug sanitizes to nothing.
 */
export function safeSlugPath(sourceId: string, slug: string): string {
  const segs = slug
    .split('/')
    .map((s) => s.trim())
    // Keep slug-friendly chars (incl. hyphens); replace anything path-unsafe.
    .map((s) => s.replace(/[^a-zA-Z0-9._@+-]/g, '_'))
    .filter((s) => s.length > 0 && s !== '.' && s !== '..');
  let rel = segs.join('/');
  if (!rel) rel = `_${sha256(`${sourceId}::${slug}`).slice(0, 16)}`;
  // Disambiguate identical slugs across sources by prefixing the source dir
  // for non-default sources (keeps the common single-source case clean).
  const prefix = sourceId === 'default' ? '' : `${sourceId.replace(/[^a-zA-Z0-9._-]/g, '_')}/`;
  return `${prefix}${rel}.json`;
}

function pageContentHash(page: Page): string {
  return page.content_hash && page.content_hash.length > 0
    ? page.content_hash
    : sha256(page.compiled_truth ?? '');
}

function isoOrNull(d: Date | null | undefined): string | null {
  if (!d) return null;
  try {
    return d instanceof Date ? d.toISOString() : new Date(d as unknown as string).toISOString();
  } catch {
    return null;
  }
}

function topFolder(slug: string): string | null {
  const idx = slug.indexOf('/');
  return idx > 0 ? slug.slice(0, idx) : null;
}

/** Build the lean frontmatter text blob for the search index (D8). */
function frontmatterText(frontmatter: Record<string, unknown>): string {
  const KEYS = ['title', 'name', 'subtitle', 'tagline', 'aliases', 'summary', 'description', 'tags'];
  const parts: string[] = [];
  for (const k of KEYS) {
    const v = frontmatter[k];
    if (v == null) continue;
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === 'string').join(' '));
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Sortable, unique snapshot id derived from the timestamp + a short random suffix. */
function makeSnapshotId(generatedAtIso: string): string {
  const compact = generatedAtIso.replace(/[-:]/g, '').replace(/\.\d+/, '');
  const suffix = randomBytes(4).toString('hex');
  return `${compact}-${suffix}`;
}

// ---------------------------------------------------------------------------
// buildSnapshot
// ---------------------------------------------------------------------------

interface IncludedPage {
  page: Page;
  key: string;
  pagePath: string;
  tags: string[];
  outlinks: Link[];
  headings: PageHeading[];
  contentHash: string;
  isPrivate: boolean;
  scope: string | null;
  privacy: string | null;
  status: string | null;
  authority: string | null;
}

/**
 * Read the brain via the engine and assemble the full in-memory snapshot model.
 * Privacy filtering, edge resolution, and counts all happen here. No disk
 * writes — see writeSnapshot / exportSnapshot for I/O.
 */
export async function buildSnapshot(
  engine: BrainEngine,
  opts: RadarExportOpts,
  hooks?: {
    /** Called once total page count is known. */
    onStart?: (total: number) => void;
    /** Called after each page is processed. */
    onTick?: () => void;
  },
): Promise<SnapshotModel> {
  const brainId = process.env.GBRAIN_BRAIN_ID || 'host';
  const generatedAt = new Date().toISOString();
  const snapshotId = makeSnapshotId(generatedAt);
  const recentLimit = opts.recentLimit ?? 100;

  // Source descriptors (for names). Best-effort — empty on engines/states
  // without the sources table populated.
  const sourceNames = new Map<string, string | null>();
  try {
    const srcs = await engine.listAllSources({ includeArchived: true });
    for (const s of srcs) sourceNames.set(s.id, s.name ?? null);
  } catch {
    /* sources table optional; names degrade to null */
  }

  // Pull pages (engine-only). Deterministic order for a stable content_hash.
  const filters: PageFilters = { limit: 1_000_000, sort: 'slug' };
  if (opts.sourceId) filters.sourceId = opts.sourceId;
  let pages = await engine.listPages(filters);
  pages = [...pages].sort((a, b) =>
    a.source_id === b.source_id
      ? a.slug < b.slug
        ? -1
        : a.slug > b.slug
          ? 1
          : 0
      : a.source_id < b.source_id
        ? -1
        : 1,
  );

  const warnings: string[] = [];
  let privateExcluded = 0;

  // First pass: classify + per-page engine reads, applying privacy filter.
  const included: IncludedPage[] = [];
  const total = opts.maxPages ? Math.min(opts.maxPages, pages.length) : pages.length;
  hooks?.onStart?.(total);
  let processed = 0;
  for (const page of pages) {
    if (opts.maxPages && processed >= opts.maxPages) break;
    processed++;
    const cls = classifyPage(page.frontmatter ?? {});
    if (cls.isPrivate && !opts.includePrivate) {
      privateExcluded++;
      hooks?.onTick?.();
      continue;
    }
    const tags = await engine.getTags(page.slug, { sourceId: page.source_id });
    const outlinks = await engine.getLinks(page.slug, { sourceId: page.source_id });
    const headings = extractHeadings(page.compiled_truth ?? '');
    included.push({
      page,
      key: pageKey(page.source_id, page.slug),
      pagePath: `pages/${safeSlugPath(page.source_id, page.slug)}`,
      tags,
      outlinks,
      headings,
      contentHash: pageContentHash(page),
      isPrivate: cls.isPrivate,
      scope: cls.scope,
      privacy: cls.privacy,
      status: cls.status,
      authority: cls.authority,
    });
    hooks?.onTick?.();
  }

  // Build resolution indices over the INCLUDED set.
  const bySourceSlug = new Map<string, IncludedPage>(); // "src::slug" -> page
  const slugToKeys = new Map<string, string[]>(); // slug -> [keys]
  for (const ip of included) {
    bySourceSlug.set(ip.key, ip);
    const arr = slugToKeys.get(ip.page.slug) ?? [];
    arr.push(ip.key);
    slugToKeys.set(ip.page.slug, arr);
  }

  const resolveTarget = (fromSource: string, toSlug: string): string | null => {
    const sameSource = pageKey(fromSource, toSlug);
    if (bySourceSlug.has(sameSource)) return sameSource;
    const keys = slugToKeys.get(toSlug);
    if (keys && keys.length === 1) return keys[0];
    return null; // ambiguous across sources, or not in scope -> dangling
  };

  // Second pass: edges, inlink accumulation, backlinks.
  const edges: GraphEdge[] = [];
  const inlinkSources = new Map<string, Set<string>>(); // to_key -> set(from_key) (distinct)
  const backlinksByKey = new Map<string, PageLinkRef[]>();
  let edgesResolved = 0;
  let edgesDangling = 0;

  for (const ip of included) {
    for (const link of ip.outlinks) {
      const toKey = resolveTarget(ip.page.source_id, link.to_slug);
      const resolved = toKey !== null;
      if (resolved) {
        edgesResolved++;
        const set = inlinkSources.get(toKey as string) ?? new Set<string>();
        set.add(ip.key);
        inlinkSources.set(toKey as string, set);
        const bl = backlinksByKey.get(toKey as string) ?? [];
        bl.push({
          page_key: ip.key,
          slug: ip.page.slug,
          link_type: link.link_type,
          link_source: link.link_source ?? null,
          resolved: true,
        });
        backlinksByKey.set(toKey as string, bl);
      } else {
        edgesDangling++;
      }
      edges.push({
        from_key: ip.key,
        to_key: toKey,
        from_slug: ip.page.slug,
        to_slug: link.to_slug,
        link_type: link.link_type,
        link_source: link.link_source ?? null,
        resolved,
      });
    }
  }

  // Assemble per-page detail + index + search + graph nodes.
  const pageDetails: PageDetail[] = [];
  const indexEntries: PageIndexEntry[] = [];
  const searchDocs: SearchDoc[] = [];
  const graphNodes: GraphNode[] = [];
  const allTags = new Set<string>();
  const sourcePageCounts = new Map<string, number>();

  for (const ip of included) {
    const { page } = ip;
    const inlinks = inlinkSources.get(ip.key)?.size ?? 0;
    const outlinks = ip.outlinks.length;
    const timeline = page.timeline && page.timeline.trim() ? page.timeline : null;
    const markdown = serializeMarkdown(
      page.frontmatter ?? {},
      page.compiled_truth ?? '',
      page.timeline ?? '',
      { type: page.type, title: page.title, tags: ip.tags },
    );
    for (const t of ip.tags) allTags.add(t);
    sourcePageCounts.set(page.source_id, (sourcePageCounts.get(page.source_id) ?? 0) + 1);

    const outlinkRefs: PageLinkRef[] = ip.outlinks.map((link) => {
      const toKey = resolveTarget(page.source_id, link.to_slug);
      return {
        page_key: toKey,
        slug: link.to_slug,
        link_type: link.link_type,
        link_source: link.link_source ?? null,
        resolved: toKey !== null,
      };
    });
    const backlinkRefs = backlinksByKey.get(ip.key) ?? [];

    const sourcePath =
      typeof (page as unknown as { source_path?: unknown }).source_path === 'string'
        ? ((page as unknown as { source_path?: string }).source_path ?? null)
        : null;

    pageDetails.push({
      page_key: ip.key,
      brain_id: brainId,
      source_id: page.source_id,
      slug: page.slug,
      title: page.title,
      type: page.type,
      source_path: sourcePath,
      markdown,
      body: page.compiled_truth ?? '',
      timeline,
      frontmatter: page.frontmatter ?? {},
      headings: ip.headings,
      tags: ip.tags,
      outlinks: outlinkRefs,
      backlinks: backlinkRefs,
      created_at: isoOrNull(page.created_at),
      updated_at: isoOrNull(page.updated_at),
      effective_date: isoOrNull(page.effective_date),
      content_hash: ip.contentHash,
      flags: { private: ip.isPrivate },
      warnings: [],
    });

    indexEntries.push({
      page_key: ip.key,
      brain_id: brainId,
      source_id: page.source_id,
      slug: page.slug,
      title: page.title,
      page_path: ip.pagePath,
      source_path: sourcePath,
      folder: topFolder(page.slug),
      type: page.type,
      status: ip.status,
      scope: ip.scope,
      privacy: ip.privacy,
      authority: ip.authority,
      tags: ip.tags,
      created_at: isoOrNull(page.created_at),
      updated_at: isoOrNull(page.updated_at),
      effective_date: isoOrNull(page.effective_date),
      content_hash: ip.contentHash,
      headings_count: ip.headings.length,
      inlinks_count: inlinks,
      outlinks_count: outlinks,
      flags: {
        private: ip.isPrivate,
        has_timeline: timeline !== null,
        orphan: inlinks === 0 && outlinks === 0,
      },
    });

    searchDocs.push({
      page_key: ip.key,
      slug: page.slug,
      source_id: page.source_id,
      title: page.title,
      path: sourcePath ?? page.slug,
      folder: topFolder(page.slug),
      type: page.type,
      tags: ip.tags,
      headings: ip.headings.map((h) => h.text),
      frontmatter_text: frontmatterText(page.frontmatter ?? {}),
    });

    graphNodes.push({
      page_key: ip.key,
      slug: page.slug,
      source_id: page.source_id,
      title: page.title,
      type: page.type,
      inlinks,
      outlinks,
    });
  }

  // Recent view: effective_date ?? updated_at, desc.
  const recentPages = [...included]
    .map((ip) => ({
      ip,
      date: isoOrNull(ip.page.effective_date) ?? isoOrNull(ip.page.updated_at),
    }))
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')) // asc
    .reverse() // desc
    .slice(0, recentLimit)
    .map(({ ip, date }) => ({
      page_key: ip.key,
      slug: ip.page.slug,
      title: ip.page.title,
      type: ip.page.type,
      date,
    }));

  // Folder tree from slugs.
  const treeRoot = buildTree(
    included.map((ip) => ({ key: ip.key, slug: ip.page.slug, title: ip.page.title })),
  );

  // Manifest content fingerprint over included pages (incremental-ready, D3).
  const fingerprintHash = createHash('sha256');
  for (const ip of [...included].sort((a, b) => a.key.localeCompare(b.key))) {
    fingerprintHash.update(`${ip.key}:${ip.contentHash}\n`);
  }
  const contentHash = fingerprintHash.digest('hex');

  // Source descriptors actually represented in the snapshot.
  const sources: SnapshotSource[] = [...sourcePageCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([source_id, page_count]) => ({
      source_id,
      name: sourceNames.get(source_id) ?? null,
      page_count,
    }));
  const sourceIds = sources.map((s) => s.source_id);

  if (edgesDangling > 0) {
    warnings.push(
      `${edgesDangling} link(s) point to pages not in scope (out-of-source, deleted, ` +
        `excluded, or never created) — emitted as dangling edges (to_key=null).`,
    );
  }
  if (included.length === 0) {
    warnings.push('snapshot is empty — no pages matched the requested scope.');
  }

  const validation: SnapshotValidation = { status: 'pass', checks: [] };

  const model: SnapshotModel = {
    manifest: {
      schema_version: SCHEMA_VERSION,
      snapshot_id: snapshotId,
      generated_at: generatedAt,
      mode: 'full',
      previous_snapshot_id: null, // filled by exportSnapshot from the prior current/
      content_hash: contentHash,
      generator: {
        gbrain_version: VERSION,
        exporter_version: EXPORTER_VERSION,
        engine: engine.kind,
      },
      brain_id: brainId,
      source_ids: sourceIds,
      sources,
      requested: {
        scope: opts.scope,
        source_id: opts.sourceId,
        include_private: opts.includePrivate,
      },
      counts: {
        pages: included.length,
        edges: edges.length,
        edges_resolved: edgesResolved,
        edges_dangling: edgesDangling,
        search_docs: searchDocs.length,
        private_excluded: privateExcluded,
        tags: allTags.size,
      },
      files: {
        manifest: 'manifest.json',
        tree: 'tree.json',
        pages_index: 'pages-index.json',
        graph: 'graph.json',
        search_index: 'search-index.json',
        views_recent: 'views/recent.json',
        pages_dir: 'pages',
      },
      warnings,
      validation,
    },
    tree: { schema_version: SCHEMA_VERSION, snapshot_id: snapshotId, root: treeRoot },
    pagesIndex: { schema_version: SCHEMA_VERSION, snapshot_id: snapshotId, pages: indexEntries },
    graph: { schema_version: SCHEMA_VERSION, snapshot_id: snapshotId, nodes: graphNodes, edges },
    searchIndex: { schema_version: SCHEMA_VERSION, snapshot_id: snapshotId, docs: searchDocs },
    recent: {
      schema_version: SCHEMA_VERSION,
      snapshot_id: snapshotId,
      generated_at: generatedAt,
      pages: recentPages,
    },
    pages: pageDetails,
  };

  return model;
}

/** Build the nested folder tree from a flat page list. */
function buildTree(pages: Array<{ key: string; slug: string; title: string }>): TreeNode {
  const root: TreeNode = { name: '', path: '', folders: [], pages: [] };
  const folderIndex = new Map<string, TreeNode>();
  folderIndex.set('', root);

  const getFolder = (path: string): TreeNode => {
    const existing = folderIndex.get(path);
    if (existing) return existing;
    const segs = path.split('/');
    const name = segs[segs.length - 1];
    const parentPath = segs.slice(0, -1).join('/');
    const parent = getFolder(parentPath);
    const node: TreeNode = { name, path, folders: [], pages: [] };
    parent.folders.push(node);
    folderIndex.set(path, node);
    return node;
  };

  for (const p of [...pages].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const segs = p.slug.split('/');
    const folderPath = segs.slice(0, -1).join('/');
    const folder = getFolder(folderPath);
    folder.pages.push({ page_key: p.key, slug: p.slug, title: p.title });
  }

  const sortNode = (n: TreeNode): void => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name));
    n.pages.sort((a, b) => a.slug.localeCompare(b.slug));
    n.folders.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

// ---------------------------------------------------------------------------
// Validation (referential integrity — hard failures refuse the swap)
// ---------------------------------------------------------------------------

/**
 * Validate referential integrity of the in-memory model. Mutates
 * `model.manifest.validation` + appends warnings. Returns the list of HARD
 * failures; a non-empty list means the snapshot must NOT be swapped in.
 */
export function validateSnapshot(model: SnapshotModel): string[] {
  const checks: SnapshotValidation['checks'] = [];
  const failures: string[] = [];

  const indexKeys = new Set(model.pagesIndex.pages.map((p) => p.page_key));
  const detailKeys = new Set(model.pages.map((p) => p.page_key));

  // 1. pages-index <-> per-page detail are 1:1.
  const indexHasDetail = model.pagesIndex.pages.every((p) => detailKeys.has(p.page_key));
  const detailHasIndex = model.pages.every((p) => indexKeys.has(p.page_key));
  const oneToOne = indexHasDetail && detailHasIndex && indexKeys.size === detailKeys.size;
  checks.push({
    name: 'pages_index_detail_1to1',
    ok: oneToOne,
    detail: oneToOne ? undefined : `index=${indexKeys.size} detail=${detailKeys.size}`,
  });
  if (!oneToOne) failures.push('pages-index and per-page detail are not 1:1');

  // 2. Every graph node is in the index.
  const nodesInIndex = model.graph.nodes.every((n) => indexKeys.has(n.page_key));
  checks.push({ name: 'graph_nodes_in_index', ok: nodesInIndex });
  if (!nodesInIndex) failures.push('graph contains a node not present in pages-index');

  // 3. Every edge endpoint that is "resolved" is in the index; from_key always.
  let badEdge: string | null = null;
  for (const e of model.graph.edges) {
    if (!indexKeys.has(e.from_key)) {
      badEdge = `from_key ${e.from_key} missing from index`;
      break;
    }
    if (e.resolved && (e.to_key === null || !indexKeys.has(e.to_key))) {
      badEdge = `resolved edge to ${e.to_slug} has no valid to_key`;
      break;
    }
    if (!e.resolved && e.to_key !== null) {
      badEdge = `dangling edge to ${e.to_slug} unexpectedly has a to_key`;
      break;
    }
  }
  checks.push({ name: 'graph_edges_consistent', ok: badEdge === null, detail: badEdge ?? undefined });
  if (badEdge) failures.push(`graph edge integrity: ${badEdge}`);

  // 4. Every search doc is in the index.
  const searchInIndex = model.searchIndex.docs.every((d) => indexKeys.has(d.page_key));
  checks.push({ name: 'search_docs_in_index', ok: searchInIndex });
  if (!searchInIndex) failures.push('search-index contains a doc not present in pages-index');

  // 5. Counts in manifest match the materialized arrays.
  const m = model.manifest.counts;
  const countsOk =
    m.pages === model.pagesIndex.pages.length &&
    m.edges === model.graph.edges.length &&
    m.search_docs === model.searchIndex.docs.length;
  checks.push({
    name: 'manifest_counts_match',
    ok: countsOk,
    detail: countsOk
      ? undefined
      : `pages ${m.pages}/${model.pagesIndex.pages.length} edges ${m.edges}/${model.graph.edges.length} search ${m.search_docs}/${model.searchIndex.docs.length}`,
  });
  if (!countsOk) failures.push('manifest counts disagree with materialized arrays');

  // 6. Recent references only known pages (soft — surfaced as warnings).
  const recentUnknown = model.recent.pages.filter((p) => !indexKeys.has(p.page_key)).length;
  checks.push({ name: 'recent_in_index', ok: recentUnknown === 0 });
  if (recentUnknown > 0)
    model.manifest.warnings.push(`recent view references ${recentUnknown} unknown page(s)`);

  model.manifest.validation = {
    status: model.manifest.warnings.length > 0 ? 'warn' : 'pass',
    checks,
  };
  // When there are hard failures we never write the manifest (export throws),
  // so 'warn' here only ever ships alongside soft warnings.
  return failures;
}

// ---------------------------------------------------------------------------
// Disk I/O + atomic swap
// ---------------------------------------------------------------------------

function writeJson(path: string, obj: unknown, pretty: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, pretty ? 2 : undefined) + '\n');
}

/** Write the entire snapshot model into `targetDir`. */
export function writeSnapshot(targetDir: string, model: SnapshotModel, pretty: boolean): void {
  mkdirSync(targetDir, { recursive: true });
  writeJson(join(targetDir, model.manifest.files.tree), model.tree, pretty);
  writeJson(join(targetDir, model.manifest.files.pages_index), model.pagesIndex, pretty);
  writeJson(join(targetDir, model.manifest.files.graph), model.graph, pretty);
  writeJson(join(targetDir, model.manifest.files.search_index), model.searchIndex, pretty);
  writeJson(join(targetDir, model.manifest.files.views_recent), model.recent, pretty);
  for (const page of model.pages) {
    const entry = model.pagesIndex.pages.find((e) => e.page_key === page.page_key);
    const rel = entry?.page_path ?? `pages/${safeSlugPath(page.source_id, page.slug)}`;
    writeJson(join(targetDir, rel), page, pretty);
  }
  // Manifest LAST so its presence signals a fully-written snapshot.
  writeJson(join(targetDir, model.manifest.files.manifest), model.manifest, pretty);
}

/** Verify every file the manifest promises actually exists on disk in `dir`. */
export function verifyWritten(dir: string, model: SnapshotModel): string[] {
  const missing: string[] = [];
  const f = model.manifest.files;
  for (const rel of [f.manifest, f.tree, f.pages_index, f.graph, f.search_index, f.views_recent]) {
    if (!existsSync(join(dir, rel))) missing.push(rel);
  }
  for (const entry of model.pagesIndex.pages) {
    if (!existsSync(join(dir, entry.page_path))) missing.push(entry.page_path);
  }
  return missing;
}

/** Read the snapshot_id from an existing current/ manifest, or null. */
function readPreviousSnapshotId(currentDir: string): string | null {
  try {
    const raw = readFileSync(join(currentDir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as { snapshot_id?: unknown };
    return typeof parsed.snapshot_id === 'string' ? parsed.snapshot_id : null;
  } catch {
    return null;
  }
}

/**
 * Full atomic export: build -> validate -> write tmp -> verify on disk -> swap
 * `current/` (preserving the prior as `previous/`).
 */
export async function exportSnapshot(
  engine: BrainEngine,
  opts: RadarExportOpts,
  hooks?: { onStart?: (total: number) => void; onTick?: () => void },
): Promise<RadarExportResult> {
  const snapDir = join(opts.out, 'snapshot');
  const currentDir = join(snapDir, 'current');
  const previousDir = join(snapDir, 'previous');

  const model = await buildSnapshot(engine, opts, hooks);

  // Link this snapshot to the one it replaces (incremental-ready, D3).
  const prevId = existsSync(currentDir) ? readPreviousSnapshotId(currentDir) : null;
  model.manifest.previous_snapshot_id = prevId;

  const failures = validateSnapshot(model);
  if (failures.length > 0) throw new RadarValidationError(failures);

  const tmpDir = join(snapDir, `.tmp-${model.manifest.snapshot_id}`);
  mkdirSync(snapDir, { recursive: true });
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });

  try {
    writeSnapshot(tmpDir, model, opts.pretty);
    const missing = verifyWritten(tmpDir, model);
    if (missing.length > 0) {
      throw new RadarValidationError([
        `post-write verification failed; ${missing.length} promised file(s) missing: ${missing
          .slice(0, 5)
          .join(', ')}${missing.length > 5 ? ' …' : ''}`,
      ]);
    }

    // Atomic swap (all within snapDir -> same filesystem).
    if (existsSync(currentDir)) {
      if (existsSync(previousDir)) rmSync(previousDir, { recursive: true, force: true });
      renameSync(currentDir, previousDir);
    }
    renameSync(tmpDir, currentDir);
  } catch (e) {
    // Never leave a half-written tmp dir behind.
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }

  return {
    snapshot_id: model.manifest.snapshot_id,
    previous_snapshot_id: prevId,
    current_dir: currentDir,
    previous_dir: existsSync(previousDir) ? previousDir : null,
    manifest: model.manifest,
  };
}
