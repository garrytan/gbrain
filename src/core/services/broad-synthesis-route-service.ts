import type { BrainEngine } from '../engine.ts';
import type {
  BroadSynthesisConflict,
  BroadSynthesisDerivedSuggestion,
  BroadSynthesisEntrypoint,
  BroadSynthesisRoute,
  BroadSynthesisRouteInput,
  BroadSynthesisRouteRead,
  BroadSynthesisRouteResult,
  ContextMapExplanation,
  ContextMapQueryMatch,
  ContextMapReport,
  Page,
} from '../types.ts';
import { getStructuralContextMapExplanation } from './context-map-explain-service.ts';
import { queryStructuralContextMap } from './context-map-query-service.ts';
import { getStructuralContextMapReport } from './context-map-report-service.ts';

const MAX_CANONICAL_SEARCH_QUERIES = 6;

export async function getBroadSynthesisRoute(
  engine: BrainEngine,
  input: BroadSynthesisRouteInput,
): Promise<BroadSynthesisRouteResult> {
  const reportResult = await getStructuralContextMapReport(engine, input);
  if (!reportResult.report) {
    return {
      selection_reason: reportResult.selection_reason,
      candidate_count: reportResult.candidate_count,
      route: null,
    };
  }

  const queryResult = await queryStructuralContextMap(engine, {
    map_id: reportResult.report.map_id,
    query: input.query,
    limit: input.limit,
  });
  const matchedNodes = queryResult.result?.matched_nodes ?? [];
  const focalNodeId = matchedNodes[0]?.node_id ?? null;
  const [canonicalReads, explanation] = await Promise.all([
    loadCanonicalReads(engine, {
      query: input.query,
      scope_id: reportResult.report.scope_id,
      limit: input.limit,
      matchedNodes,
    }),
    focalNodeId
      ? getStructuralContextMapExplanation(engine, {
        map_id: reportResult.report.map_id,
        node_id: focalNodeId,
      }).then((result) => result.explanation)
      : Promise.resolve(null),
  ]);

  return {
    selection_reason: reportResult.selection_reason,
    candidate_count: reportResult.candidate_count,
    route: buildBroadSynthesisRoute({
      report: reportResult.report,
      query: input.query,
      matchedNodes,
      explanation,
      canonicalReads,
    }),
  };
}

async function loadCanonicalReads(
  engine: BrainEngine,
  input: { query: string; scope_id: string; limit?: number; matchedNodes: ContextMapQueryMatch[] },
): Promise<BroadSynthesisRouteRead[]> {
  const limit = input.limit ?? 5;
  const candidates = await searchCanonicalCandidates(engine, input.query, limit);
  const reads: BroadSynthesisRouteRead[] = [];
  const seen = new Set<string>();

  for (const slug of canonicalCandidateSlugs(candidates, input.matchedNodes)) {
    if (seen.has(slug)) continue;
    seen.add(slug);

    const page = await engine.getPage(slug);
    if (!isNonEmptyCanonicalPage(page)) continue;
    if (page.type !== 'concept') continue;
    if (!isCanonicalEntityMatch(page, input.query)) continue;

    const [manifest] = await engine.listNoteManifestEntries({
      scope_id: input.scope_id,
      slug: page.slug,
      limit: 1,
    });
    if (!manifest) continue;

    reads.push({
      node_id: `page:${page.slug}`,
      node_kind: 'page',
      label: page.title,
      page_slug: page.slug,
      path: manifest.path,
    });
    if (reads.length >= limit) break;
  }

  return reads;
}

async function searchCanonicalCandidates(
  engine: BrainEngine,
  query: string,
  limit: number,
): Promise<string[]> {
  const results = await Promise.all(
    canonicalSearchQueries(query).map((searchQuery) =>
      engine.searchKeyword(searchQuery, {
        type: 'concept',
        limit,
      })),
  );
  return results.flat().map((candidate) => candidate.slug);
}

function canonicalSearchQueries(query: string): string[] {
  const trimmedQuery = query.trim();
  const normalizedQuery = normalizeEntityKey(query);
  const baseQueries = [
    trimmedQuery,
    normalizedQuery !== trimmedQuery.toLowerCase() ? normalizedQuery : '',
  ];
  const tokenQueries = normalizedQuery
    .split(' ')
    .filter((token) => token.length > 1);
  return [...new Set([...baseQueries, ...tokenQueries].filter((candidate) => candidate.trim().length > 0))]
    .slice(0, MAX_CANONICAL_SEARCH_QUERIES);
}

function canonicalCandidateSlugs(
  searchSlugs: string[],
  matchedNodes: ContextMapQueryMatch[],
): string[] {
  return [
    ...searchSlugs,
    ...matchedNodes
      .filter((node) => node.node_kind === 'page')
      .map((node) => node.page_slug),
  ];
}

function buildBroadSynthesisRoute(input: {
  report: ContextMapReport;
  query: string;
  matchedNodes: ContextMapQueryMatch[];
  explanation: ContextMapExplanation | null;
  canonicalReads: BroadSynthesisRouteRead[];
}): BroadSynthesisRoute {
  const focalNodeId = input.matchedNodes[0]?.node_id ?? null;
  const derivedSuggestions = buildDerivedSuggestions(input.report.map_id, input.matchedNodes);
  const conflicts = buildCanonicalConflicts(input.canonicalReads, derivedSuggestions, input.report.map_id);
  const recommendedReads = dedupeReads([
    ...input.canonicalReads,
    ...(input.explanation?.recommended_reads ?? []),
    ...input.report.recommended_reads,
  ]);

  return {
    route_kind: 'broad_synthesis',
    map_id: input.report.map_id,
    query: input.query,
    status: input.report.status,
    retrieval_route: focalNodeId
      ? [
          'curated_notes',
          'context_map_report',
          'context_map_query',
          'context_map_explain',
          'canonical_follow_through',
        ]
      : [
          'curated_notes',
          'context_map_report',
          'context_map_query',
          'canonical_follow_through',
        ],
    focal_node_id: focalNodeId,
    summary_lines: buildSummaryLines(input.report, input.matchedNodes, focalNodeId),
    matched_nodes: input.matchedNodes,
    entrypoints: buildEntrypoints(input.report, input.canonicalReads),
    canonical_reads: input.canonicalReads,
    derived_suggestions: derivedSuggestions,
    conflicts,
    recommended_reads: recommendedReads,
  };
}

function isNonEmptyCanonicalPage(page: Page | null): page is Page {
  return page !== null && page.compiled_truth.trim().length > 0;
}

function isCanonicalEntityMatch(page: Page, query: string): boolean {
  const normalizedQuery = normalizeEntityKey(query);
  const aliases = [
    page.title,
    page.slug,
    page.slug.split('/').at(-1) ?? page.slug,
  ].map(normalizeEntityKey);

  return aliases.some((alias) =>
    alias === normalizedQuery
    || containsTokenBoundedPhrase(alias, normalizedQuery)
    || containsTokenBoundedPhrase(normalizedQuery, alias));
}

function buildEntrypoints(
  report: ContextMapReport,
  canonicalReads: BroadSynthesisRouteRead[],
): BroadSynthesisEntrypoint[] {
  return [
    ...canonicalReads.map((read) => ({
      source_kind: 'curated_note' as const,
      page_slug: read.page_slug,
      label: read.label,
    })),
    {
      source_kind: 'context_map',
      map_id: report.map_id,
      label: report.title,
    },
  ];
}

function buildDerivedSuggestions(
  mapId: string,
  matchedNodes: ContextMapQueryMatch[],
): BroadSynthesisDerivedSuggestion[] {
  const suggestions: BroadSynthesisDerivedSuggestion[] = [];
  const seen = new Set<string>();

  for (const node of matchedNodes) {
    if (seen.has(node.node_id)) continue;
    seen.add(node.node_id);
    suggestions.push({
      map_id: mapId,
      node_id: node.node_id,
      label: node.label,
      page_slug: node.page_slug,
    });
  }

  return suggestions;
}

function normalizeEntityKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[/_.-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function containsTokenBoundedPhrase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function buildCanonicalConflicts(
  canonicalReads: BroadSynthesisRouteRead[],
  derivedSuggestions: BroadSynthesisDerivedSuggestion[],
  mapId: string,
): BroadSynthesisConflict[] {
  const canonicalByLabel = new Map(canonicalReads.map((read) => [normalizeEntityKey(read.label), read]));
  const canonicalBySlug = new Map(canonicalReads.map((read) => [read.page_slug, read]));
  const conflicts: BroadSynthesisConflict[] = [];

  for (const suggestion of derivedSuggestions) {
    const canonical = canonicalByLabel.get(normalizeEntityKey(suggestion.label)) ?? canonicalBySlug.get(suggestion.page_slug);
    if (!canonical) continue;
    conflicts.push({
      entity_key: normalizeEntityKey(suggestion.label),
      canonical_page_slug: canonical.page_slug,
      derived_map_id: mapId,
      resolution: 'prefer_canonical',
      summary: `Prefer curated note ${canonical.page_slug} over map-derived suggestion ${suggestion.node_id}.`,
    });
  }

  return conflicts;
}

function buildSummaryLines(
  report: ContextMapReport,
  matchedNodes: ContextMapQueryMatch[],
  focalNodeId: string | null,
): string[] {
  const lines = [
    `Context map status is ${report.status}.`,
    `Matched structural nodes available: ${matchedNodes.length}.`,
  ];

  if (focalNodeId) {
    lines.push(`Focal structural node is ${focalNodeId}.`);
  } else {
    lines.push('No structural node matched the route query; fall back to report-driven orientation.');
  }

  lines.push(
    report.status === 'stale'
      ? 'Rebuild the context map before trusting this broad-synthesis route.'
      : 'Open canonical reads before treating this broad-synthesis route as truth.',
  );

  return lines;
}

function dedupeReads(reads: BroadSynthesisRouteRead[]): BroadSynthesisRouteRead[] {
  const deduped: BroadSynthesisRouteRead[] = [];
  const seenPageSlugs = new Set<string>();

  for (const read of reads) {
    if (seenPageSlugs.has(read.page_slug)) continue;
    seenPageSlugs.add(read.page_slug);
    deduped.push(read);
  }

  return deduped;
}
