/**
 * Multi-hop relational chains: walk 1-3 typed hops ("Alice → companies she
 * invested in → their founders") over `links`, one bounded engine query per
 * hop, with path state, scoring and tie breaking in TypeScript.
 *
 * Determinism: frontier selection, path retention and answer order use
 * `(score DESC, source_id ASC, slug ASC)` with byte-wise string comparison;
 * scores are summed in a pinned path order, so both engines produce identical
 * output for identical rows.
 *
 * Path state: each retained path keeps its own node list; cycle prevention is
 * path-local, and a path may end on its own anchor ("who invested in the
 * companies Alice founded?" can answer Alice). A node reached as another
 * path's intermediate can still be an answer. The anchor is dropped from answers only when the plan says so
 * (`excludeAnchor`: "other/else/also" questions and the co-relation shape).
 *
 * Bounds: at most `frontierCap` nodes expand per hop, each with at most
 * `neighborCap` logical edges, and at most `pathsPerNode` paths are retained
 * per node, so the work per hop is bounded regardless of hub size.
 *
 * Tested in test/relational-chain.test.ts.
 */

import type { BrainEngine } from '../engine.ts';
import type { ChainHopEdge, PageReadPolicy } from '../types.ts';
import type { EdgeStatusFilter, EdgeTemporalOpts } from '../link-validity.ts';
import { hubWeight } from './hub-dampening.ts';
import { pageReadFilter } from './read-policy-sql.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import type { StoredEdgeRef } from '../eligibility/fence-overlay.ts';

/** Page-type signature of each chain relation: subject types → object types. */
export const LINK_SIGNATURES: Readonly<Record<string, { subject: readonly string[]; object: readonly string[] }>> = {
  founded: { subject: ['person'], object: ['company'] },
  invested_in: { subject: ['person', 'company'], object: ['company', 'deal'] },
  led_round: { subject: ['person', 'company'], object: ['company', 'deal'] },
  advises: { subject: ['person'], object: ['company'] },
  works_at: { subject: ['person'], object: ['company'] },
  attended: { subject: ['person'], object: ['meeting'] },
  yc_partner: { subject: ['person'], object: ['company'] },
};

/** Link types a chain hop may walk (the ones with a signature). */
export const CHAIN_LINK_TYPES: readonly string[] = Object.keys(LINK_SIGNATURES);

/** Relations that share one meaning for chain purposes. */
const LINK_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  invested_in: ['invested_in', 'led_round'],
  led_round: ['invested_in', 'led_round'],
};

export function linkFamily(linkType: string): string[] {
  return [...(LINK_FAMILIES[linkType] ?? [linkType])];
}

export interface ChainHop {
  /** One relation family; every member must be in CHAIN_LINK_TYPES. */
  linkTypes: string[];
  /** Walk from the current node to the relation's object or subject. */
  toward: 'object' | 'subject';
  /** Page type the landing node must have, when the question names one. */
  nodeType?: string | null;
  /** Which relationships this hop walks when relationship validity is on ("formerly advised" → ended); default: the call's policy. */
  status?: EdgeStatusFilter;
}

export interface ChainPlan {
  hops: ChainHop[];
  excludeAnchor: boolean;
}

export interface ChainAnchor {
  page_id: number;
  slug: string;
  source_id: string;
}

export interface ChainEvidenceEdge {
  link_type: string;
  stored_from: string;
  stored_to: string;
  orientation: ChainHopEdge['orientation'];
  context: string | null;
  origin: string | null;
}

export interface RelationalChainRow {
  source_id: string;
  slug: string;
  page_id: number;
  role: 'answer' | 'support' | 'origin';
  /** Hop at which the node is reached on its best path (origin rows: the edge's hop). */
  hop: number;
  path_count: number;
  score: number;
  best_path: { nodes: string[]; edges: ChainEvidenceEdge[] };
  canonical_chunk_id: number | null;
}

export type ChainStatus = 'fired' | 'anchor_not_found' | 'no_edges' | 'empty_hop' | 'truncated';

export interface ChainDiagnostics {
  status: ChainStatus;
  per_hop: Array<{ link_types: string[]; toward: 'object' | 'subject'; frontier: number; edges: number }>;
  cap_hit: null | { cap: 'neighbor' | 'frontier' | 'paths'; hop: number };
  /** 1-based hop that came back empty, for `empty_hop`. */
  empty_hop?: number;
}

export interface ChainLimits {
  frontierCap: number;
  neighborCap: number;
  pathsPerNode: number;
  /** Multiply path weight by hubWeight(degree) of each intermediate node. */
  hubWeighting: boolean;
}

export const DEFAULT_CHAIN_LIMITS: Readonly<ChainLimits> = {
  frontierCap: 50, neighborCap: 100, pathsPerNode: 10, hubWeighting: true,
};

/**
 * Degree at which a chain path's weight through an intermediate node halves
 * (hub dampening; ~1/(1+0.001·(n−1)²)). Chain ranking uses it when
 * `hubWeighting` is on, independent of the search-wide hub setting.
 */
export const CHAIN_HUB_HALF_DEGREE = 32;

/** Weight applied to an edge whose direction could not be established from types. */
export const UNCERTAIN_EDGE_WEIGHT = 0.5;

interface PathRec {
  source_id: string;
  ids: number[];
  slugs: string[];
  edges: ChainHopEdge[];
  weight: number;
  key: string;
}

const byteCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function nodeKey(source: string, id: number): string {
  return `${source}\u0000${id}`;
}

/** Order paths: weight DESC, then the path key (byte-wise). */
function comparePaths(a: PathRec, b: PathRec): number {
  return b.weight - a.weight || byteCmp(a.key, b.key);
}

interface NodeAgg {
  source_id: string;
  id: number;
  slug: string;
  score: number;
  paths: PathRec[];
}

function aggregate(paths: PathRec[]): NodeAgg[] {
  const byNode = new Map<string, NodeAgg>();
  for (const p of [...paths].sort((a, b) => byteCmp(a.key, b.key))) {
    const id = p.ids[p.ids.length - 1];
    const key = nodeKey(p.source_id, id);
    let agg = byNode.get(key);
    if (!agg) {
      agg = { source_id: p.source_id, id, slug: p.slugs[p.slugs.length - 1], score: 0, paths: [] };
      byNode.set(key, agg);
    }
    agg.score += p.weight;
    agg.paths.push(p);
  }
  for (const agg of byNode.values()) agg.paths.sort(comparePaths);
  return [...byNode.values()].sort((a, b) =>
    b.score - a.score || byteCmp(a.source_id, b.source_id) || byteCmp(a.slug, b.slug));
}

function evidence(e: ChainHopEdge): ChainEvidenceEdge {
  return {
    link_type: e.link_type, stored_from: e.stored_from_slug, stored_to: e.stored_to_slug,
    orientation: e.orientation, context: e.context, origin: e.origin_slug,
  };
}

/**
 * Run a chain plan from resolved anchors. Never throws for an empty graph:
 * an empty first hop is `no_edges`, a later one `empty_hop`.
 */
export async function runRelationalChain(
  engine: Pick<BrainEngine, 'relationalChainHop'>,
  anchors: ChainAnchor[],
  plan: ChainPlan,
  policy: PageReadPolicy & { temporal?: EdgeTemporalOpts },
  limits: ChainLimits = DEFAULT_CHAIN_LIMITS,
): Promise<{ rows: RelationalChainRow[]; diagnostics: ChainDiagnostics }> {
  const diagnostics: ChainDiagnostics = { status: 'fired', per_hop: [], cap_hit: null };
  if (anchors.length === 0) return { rows: [], diagnostics: { ...diagnostics, status: 'anchor_not_found' } };
  const degreeLinkTypes = [...CHAIN_LINK_TYPES];
  let paths: PathRec[] = anchors.map(a => ({
    source_id: a.source_id, ids: [a.page_id], slugs: [a.slug], edges: [], weight: 1, key: a.slug,
  }));
  const chunkIds = new Map<string, number | null>();

  for (let i = 0; i < plan.hops.length; i++) {
    const hop = plan.hops[i];
    let nodes = aggregate(paths);
    if (nodes.length > limits.frontierCap) {
      diagnostics.cap_hit ??= { cap: 'frontier', hop: i + 1 };
      nodes = nodes.slice(0, limits.frontierCap);
    }
    paths = [];
    for (const n of nodes) {
      if (n.paths.length > limits.pathsPerNode) diagnostics.cap_hit ??= { cap: 'paths', hop: i + 1 };
      paths.push(...n.paths.slice(0, limits.pathsPerNode));
    }
    const sig = signatureFor(hop.linkTypes);
    const edges = await engine.relationalChainHop(nodes.map(n => n.id), {
      ...policy,
      ...(hop.status && policy.temporal ? { temporal: { ...policy.temporal, status: hop.status } } : {}),
      linkTypes: hop.linkTypes, toward: hop.toward,
      subjectTypes: [...sig.subject], objectTypes: [...sig.object],
      degreeLinkTypes, neighborCap: limits.neighborCap,
    });
    const byFrom = new Map<number, ChainHopEdge[]>();
    const degree = new Map<number, number>();
    for (const e of edges) {
      if (hop.nodeType && e.to_type !== hop.nodeType) continue;
      if (e.neighbor_cap_hit) diagnostics.cap_hit ??= { cap: 'neighbor', hop: i + 1 };
      degree.set(e.from_page_id, e.from_degree);
      const list = byFrom.get(e.from_page_id) ?? [];
      list.push(e);
      byFrom.set(e.from_page_id, list);
      chunkIds.set(nodeKey(e.source_id, e.to_page_id), e.canonical_chunk_id);
    }
    const next: PathRec[] = [];
    for (const p of paths) {
      const last = p.ids[p.ids.length - 1];
      const hubFactor = i > 0 && limits.hubWeighting ? hubWeight(degree.get(last) ?? 1, CHAIN_HUB_HALF_DEGREE) : 1;
      for (const e of byFrom.get(last) ?? []) {
        if (e.source_id !== p.source_id) continue;
        const returnsToAnchor = e.to_page_id === p.ids[0] && i === plan.hops.length - 1;
        if (p.ids.includes(e.to_page_id) && !returnsToAnchor) continue;
        const w = p.weight * hubFactor * (e.orientation === 'uncertain' ? UNCERTAIN_EDGE_WEIGHT : 1);
        next.push({
          source_id: p.source_id, ids: [...p.ids, e.to_page_id], slugs: [...p.slugs, e.to_slug],
          edges: [...p.edges, e], weight: w, key: `${p.key}\u0001${e.to_slug}`,
        });
      }
    }
    diagnostics.per_hop.push({ link_types: [...hop.linkTypes], toward: hop.toward, frontier: nodes.length, edges: next.length });
    if (next.length === 0) {
      return {
        rows: [],
        diagnostics: { ...diagnostics, status: i === 0 ? 'no_edges' : 'empty_hop', empty_hop: i + 1 },
      };
    }
    paths = next;
  }

  const anchorKeys = new Set(anchors.map(a => nodeKey(a.source_id, a.page_id)));
  const answers = aggregate(paths).filter(n => !(plan.excludeAnchor && anchorKeys.has(nodeKey(n.source_id, n.id))));
  if (answers.length === 0) return { rows: [], diagnostics: { ...diagnostics, status: 'empty_hop', empty_hop: plan.hops.length } };

  const rows: RelationalChainRow[] = [];
  const emitted = new Set<string>();
  const push = (row: RelationalChainRow) => {
    const k = nodeKey(row.source_id, row.page_id);
    if (emitted.has(k)) return;
    emitted.add(k);
    rows.push(row);
  };
  for (const a of answers) {
    const best = a.paths[0];
    push({
      source_id: a.source_id, slug: a.slug, page_id: a.id, role: 'answer', hop: best.edges.length,
      path_count: a.paths.length, score: a.score,
      best_path: { nodes: best.slugs, edges: best.edges.map(evidence) },
      canonical_chunk_id: chunkIds.get(nodeKey(a.source_id, a.id)) ?? null,
    });
  }
  // Evidence pages: every retained path of every answer (best paths first),
  // so each answer's supporting pages are all present, not only its best path's.
  const maxPaths = Math.max(...answers.map(a => a.paths.length));
  for (let k = 0; k < maxPaths; k++) {
    for (const a of answers) {
      const path = a.paths[k];
      if (!path) continue;
      path.ids.slice(1, -1).forEach((id, j) => push({
        source_id: a.source_id, slug: path.slugs[j + 1], page_id: id, role: 'support', hop: j + 1,
        path_count: 0, score: 0,
        best_path: { nodes: path.slugs.slice(0, j + 2), edges: path.edges.slice(0, j + 1).map(evidence) },
        canonical_chunk_id: chunkIds.get(nodeKey(a.source_id, id)) ?? null,
      }));
      path.edges.forEach((e, j) => {
        if (e.origin_page_id == null || e.origin_slug == null || path.ids.includes(e.origin_page_id)) return;
        push({
          source_id: a.source_id, slug: e.origin_slug, page_id: e.origin_page_id, role: 'origin', hop: j + 1,
          path_count: 0, score: 0, best_path: { nodes: [e.stored_from_slug, e.stored_to_slug], edges: [evidence(e)] },
          canonical_chunk_id: null,
        });
      });
    }
  }
  if (diagnostics.cap_hit) diagnostics.status = 'truncated';
  return { rows, diagnostics };
}

function signatureFor(linkTypes: string[]): { subject: string[]; object: string[] } {
  const subject = new Set<string>();
  const object = new Set<string>();
  for (const lt of linkTypes) {
    const sig = LINK_SIGNATURES[lt];
    if (!sig) throw new Error(`relational chain: link type "${lt}" has no signature; chain link types are ${CHAIN_LINK_TYPES.join(', ')}`);
    sig.subject.forEach(t => subject.add(t));
    sig.object.forEach(t => object.add(t));
  }
  return { subject: [...subject].sort(), object: [...object].sort() };
}

/** Resolve an exact slug to chain anchors in every source the policy admits (live pages only). */
export async function resolveChainAnchors(
  engine: Pick<BrainEngine, 'executeRaw'>,
  slug: string,
  policy: PageReadPolicy,
): Promise<ChainAnchor[]> {
  const params: unknown[] = [slug];
  const filter = pageReadFilter('p', policy, params, true);
  const rows = await engine.executeRaw<{ id: number; source_id: string }>(
    `SELECT p.id, p.source_id FROM pages p WHERE p.slug = $1 AND ${filter} ORDER BY p.source_id`, params);
  return rows.map(r => ({ page_id: Number(r.id), slug, source_id: r.source_id }));
}

/** The stored link (from, to, type) behind a chain evidence edge; a chain stays in the source its path walked. */
export function chainStoredEdge(e: ChainEvidenceEdge & { source_id: string }): StoredEdgeRef {
  return { from: { sourceId: e.source_id, slug: e.stored_from }, to: { sourceId: e.source_id, slug: e.stored_to }, linkType: e.link_type };
}

/** Longest edge context shown to an untrusted caller. */
export const REMOTE_EDGE_CONTEXT_CHARS = 160;

/** Edge context as a caller may see it: remote callers get a sanitized, bounded excerpt. */
export function presentEdgeContext(context: string | null, remote: boolean): string | null {
  if (context == null) return null;
  if (!remote) return context;
  const clean = sanitizeRemoteBody(context).replace(/\s+/g, ' ').trim();
  return clean.length > REMOTE_EDGE_CONTEXT_CHARS ? `${clean.slice(0, REMOTE_EDGE_CONTEXT_CHARS - 1)}…` : clean;
}

/** Validate an agent-supplied chain: 1-3 hops over chain link types. Returns the problem or the plan. */
export function validateChainHops(raw: unknown): { ok: true; hops: ChainHop[] } | { ok: false; path: string; problem: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, path: 'hops', problem: 'hops must be a non-empty array of {link_type, toward}' };
  if (raw.length > MAX_CHAIN_HOPS) return { ok: false, path: 'hops', problem: `at most ${MAX_CHAIN_HOPS} hops are supported (got ${raw.length})` };
  const hops: ChainHop[] = [];
  for (let i = 0; i < raw.length; i++) {
    const h = raw[i] as Record<string, unknown> | null;
    const lt = h && typeof h === 'object' ? h.link_type : undefined;
    const toward = h && typeof h === 'object' ? h.toward : undefined;
    if (typeof lt !== 'string' || !LINK_SIGNATURES[lt]) {
      return { ok: false, path: `hops[${i}].link_type`, problem: `${JSON.stringify(lt ?? null)} is not a chain link type; use one of ${CHAIN_LINK_TYPES.join(', ')}` };
    }
    if (toward !== 'object' && toward !== 'subject') {
      return { ok: false, path: `hops[${i}].toward`, problem: `${JSON.stringify(toward ?? null)} must be "object" (subject → object, e.g. investor → company) or "subject" (object → subject, e.g. company → founder)` };
    }
    hops.push({ linkTypes: linkFamily(lt), toward });
  }
  return { ok: true, hops };
}

export const MAX_CHAIN_HOPS = 3;

/** Chain slots: an integer 0..10 (number or numeric string; `off` = 0); anything else → undefined (fall through). */
export function normalizeChainSlots(v: unknown): number | undefined {
  if (v === 'off' || v === false) return 0;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : undefined;
}
