import type { BrainEngine } from '../engine.ts';
import type {
  GraphFrontierEdge,
  GraphFrontierInput,
  GraphFrontierNode,
  GraphFrontierResult,
  Link,
  NoteManifestEntry,
  RetrieveContextCandidate,
  RetrieveContextGraphFrontierOptions,
  RetrieveContextInput,
  RetrieveContextOrientation,
  RetrievalSelector,
  ScopeGateDecisionResult,
} from '../types.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';
import { normalizeRetrievalSelector } from './retrieval-selector-service.ts';

export interface RetrieveContextGraphFrontierBuildInput {
  engine: BrainEngine;
  input: RetrieveContextInput;
  query: string;
  limit: number;
  candidates: RetrieveContextCandidate[];
  required_reads: RetrievalSelector[];
  orientation: RetrieveContextOrientation;
  scope_gate?: ScopeGateDecisionResult;
}

export interface RetrieveContextGraphFrontierBuildResult {
  scope_id?: string;
  policy_version?: string;
  seed_node_ids?: string[];
  nodes?: GraphFrontierNode[];
  edges?: GraphFrontierEdge[];
}

export type RetrieveContextGraphFrontierInputBuilder = (
  input: RetrieveContextGraphFrontierBuildInput,
) => Promise<RetrieveContextGraphFrontierBuildResult> | RetrieveContextGraphFrontierBuildResult;

export type RetrieveContextGraphFrontierPlanner = (
  input: GraphFrontierInput,
) => Promise<GraphFrontierResult> | GraphFrontierResult;

export const DEFAULT_GRAPH_FRONTIER_POLICY_VERSION = 'policy:v1';

const LINKED_CANDIDATE_SEED_LIMIT = 5;
const MANIFEST_LOOKUP_BATCH_SIZE = 100;

export async function buildProductionGraphFrontierInput(
  input: RetrieveContextGraphFrontierBuildInput,
): Promise<RetrieveContextGraphFrontierBuildResult> {
  const scopeId = input.required_reads.find((selector) => selector.scope_id)?.scope_id
    ?? (input.scope_gate?.resolved_scope === 'personal' ? 'personal:default' : DEFAULT_NOTE_MANIFEST_SCOPE_ID);
  const policyVersion = DEFAULT_GRAPH_FRONTIER_POLICY_VERSION;
  const seedSlugs = uniqueSlugs(input.candidates
    .map((candidate) => candidate.read_selector.slug ?? candidate.canonical_target.slug)
    .filter((slug): slug is string => Boolean(slug)))
    .slice(0, LINKED_CANDIDATE_SEED_LIMIT);
  if (seedSlugs.length === 0) {
    return { scope_id: scopeId, policy_version: policyVersion, seed_node_ids: [], nodes: [], edges: [] };
  }

  const allSlugs = new Set(seedSlugs);
  const edges: GraphFrontierEdge[] = [];
  let frontier = seedSlugs;
  for (let depth = 0; depth < 2 && frontier.length > 0; depth += 1) {
    const manifests = await loadManifestEntriesBySlug(input.engine, frontier);
    const explicitLinks = await explicitLinkedSlugsBySeed(input.engine, frontier);
    const next = new Set<string>();
    for (const slug of frontier) {
      const manifest = manifests.get(slugLookupKey(slug));
      const explicit = explicitLinks.get(slug);
      const linked = uniqueSlugs([
        ...(manifest?.outgoing_wikilinks ?? []),
        ...(explicit?.outgoing ?? []),
        ...(explicit?.incoming ?? []),
      ]).slice(0, 8);
      for (const target of linked) {
        edges.push(graphFrontierEdge('supports', slug, target, scopeId, policyVersion, `link:${slug}->${target}`));
        if (!allSlugs.has(target)) next.add(target);
        allSlugs.add(target);
      }
      const supersededBy = typeof manifest?.frontmatter.superseded_by === 'string'
        ? manifest.frontmatter.superseded_by.trim()
        : '';
      if (supersededBy) {
        edges.push(graphFrontierEdge('supersedes', slug, supersededBy, scopeId, policyVersion, `supersedes:${slug}->${supersededBy}`));
        if (!allSlugs.has(supersededBy)) next.add(supersededBy);
        allSlugs.add(supersededBy);
      }
    }
    frontier = [...next].slice(0, LINKED_CANDIDATE_SEED_LIMIT * 8);
  }

  const manifests = await loadManifestEntriesBySlug(input.engine, [...allSlugs]);
  const nodes: GraphFrontierNode[] = [...manifests.values()].map((manifest) => ({
    id: graphFrontierNodeId(manifest.slug),
    scope_id: scopeId,
    policy_version: policyVersion,
    selector: normalizeRetrievalSelector({
      kind: 'compiled_truth',
      scope_id: scopeId,
      slug: manifest.slug,
      path: manifest.path,
      freshness: 'unknown',
    }),
  }));
  const existingNodeIds = new Set(nodes.map((node) => node.id));

  return {
    scope_id: scopeId,
    policy_version: policyVersion,
    seed_node_ids: seedSlugs.map(graphFrontierNodeId).filter((id) => existingNodeIds.has(id)),
    nodes,
    edges: dedupeGraphFrontierEdges(edges).filter((edge) =>
      existingNodeIds.has(edge.from_node_id) && existingNodeIds.has(edge.to_node_id)
    ),
  };
}

function graphFrontierNodeId(slug: string): string {
  return `page:${slug}`;
}

function graphFrontierEdge(
  edgeType: GraphFrontierEdge['edge_type'],
  fromSlug: string,
  toSlug: string,
  scopeId: string,
  policyVersion: string,
  idPrefix: string,
): GraphFrontierEdge {
  return {
    id: `${idPrefix}`,
    edge_type: edgeType,
    from_node_id: graphFrontierNodeId(fromSlug),
    to_node_id: graphFrontierNodeId(toSlug),
    scope_id: scopeId,
    policy_version: policyVersion,
  };
}

function dedupeGraphFrontierEdges(edges: GraphFrontierEdge[]): GraphFrontierEdge[] {
  const seen = new Set<string>();
  const result: GraphFrontierEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.edge_type}:${edge.from_node_id}:${edge.to_node_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

async function loadManifestEntriesBySlug(
  engine: BrainEngine,
  slugs: string[],
): Promise<Map<string, NoteManifestEntry>> {
  const unique = uniqueSlugs(slugs);
  if (unique.length === 0) return new Map();

  if (typeof engine.listNoteManifestEntries === 'function') {
    const manifestBySlug = new Map<string, NoteManifestEntry>();
    for (let index = 0; index < unique.length; index += MANIFEST_LOOKUP_BATCH_SIZE) {
      const batchSlugs = unique.slice(index, index + MANIFEST_LOOKUP_BATCH_SIZE);
      const manifests = await engine.listNoteManifestEntries({
        scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
        slugs: batchSlugs,
        limit: batchSlugs.length,
      });
      for (const manifest of manifests) {
        manifestBySlug.set(slugLookupKey(manifest.slug), manifest);
      }
    }
    return manifestBySlug;
  }

  if (typeof engine.getNoteManifestEntry !== 'function') return new Map();
  const entries = await Promise.all(unique.map(async (slug) => [
    slug,
    await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug),
  ] as const));
  return new Map(entries
    .filter((entry): entry is readonly [string, NoteManifestEntry] => entry[1] !== null)
    .map(([slug, manifest]) => [slugLookupKey(slug), manifest]));
}

async function explicitLinkedSlugsBySeed(
  engine: BrainEngine,
  seedSlugs: string[],
): Promise<Map<string, { outgoing: string[]; incoming: string[] }>> {
  const explicitBySeed = new Map<string, { outgoing: string[]; incoming: string[] }>(seedSlugs.map((seedSlug) => [
    seedSlug,
    { outgoing: [], incoming: [] },
  ]));
  if (seedSlugs.length === 0) return explicitBySeed;

  const [outgoingResult, incomingResult] = await Promise.allSettled([
    explicitOutgoingSlugsBySeed(engine, seedSlugs),
    explicitIncomingSlugsBySeed(engine, seedSlugs),
  ]);

  if (outgoingResult.status === 'fulfilled') {
    for (const [seedSlug, outgoing] of outgoingResult.value) {
      const explicit = explicitBySeed.get(seedSlug);
      if (explicit) explicit.outgoing = outgoing;
    }
  }
  if (incomingResult.status === 'fulfilled') {
    for (const [seedSlug, incoming] of incomingResult.value) {
      const explicit = explicitBySeed.get(seedSlug);
      if (explicit) explicit.incoming = incoming;
    }
  }

  return explicitBySeed;
}

async function explicitOutgoingSlugsBySeed(
  engine: BrainEngine,
  seedSlugs: string[],
): Promise<Map<string, string[]>> {
  if (typeof engine.getLinksForSlugs === 'function') {
    try {
      const linksBySeed = await engine.getLinksForSlugs(seedSlugs);
      return mapLinksBySeed(seedSlugs, linksBySeed, (link) => link.to_slug);
    } catch {
      // Optional batch APIs are an optimization; degrade to the per-seed path.
    }
  }
  if (typeof engine.getLinks !== 'function') return new Map();

  return new Map(await Promise.all(seedSlugs.map(async (seedSlug): Promise<[string, string[]]> => {
    try {
      const links = await engine.getLinks(seedSlug);
      return [seedSlug, links.map((link) => link.to_slug)];
    } catch {
      return [seedSlug, []];
    }
  })));
}

async function explicitIncomingSlugsBySeed(
  engine: BrainEngine,
  seedSlugs: string[],
): Promise<Map<string, string[]>> {
  if (typeof engine.getBacklinksForSlugs === 'function') {
    try {
      const backlinksBySeed = await engine.getBacklinksForSlugs(seedSlugs);
      return mapLinksBySeed(seedSlugs, backlinksBySeed, (link) => link.from_slug);
    } catch {
      // Optional batch APIs are an optimization; degrade to the per-seed path.
    }
  }
  if (typeof engine.getBacklinks !== 'function') return new Map();

  return new Map(await Promise.all(seedSlugs.map(async (seedSlug): Promise<[string, string[]]> => {
    try {
      const links = await engine.getBacklinks(seedSlug);
      return [seedSlug, links.map((link) => link.from_slug)];
    } catch {
      return [seedSlug, []];
    }
  })));
}

function mapLinksBySeed(
  seedSlugs: string[],
  linksBySeed: Map<string, Link[]>,
  linkedSlug: (link: Link) => string,
): Map<string, string[]> {
  return new Map(seedSlugs.map((seedSlug) => [
    seedSlug,
    (linksBySeed.get(seedSlug) ?? linksBySeed.get(slugLookupKey(seedSlug)) ?? []).map(linkedSlug),
  ]));
}

function slugLookupKey(slug: string): string {
  return slug.toLowerCase();
}

function uniqueSlugs(slugs: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const slug of slugs) {
    const key = slugLookupKey(slug);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(slug);
  }
  return output;
}

export type RetrieveContextGraphFrontierServiceContract = {
  options: RetrieveContextGraphFrontierOptions;
  inputBuilder: RetrieveContextGraphFrontierInputBuilder;
  planner: RetrieveContextGraphFrontierPlanner;
};
