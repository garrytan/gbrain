/**
 * GBRA-156: `whois` — exact identity lookup for triage agents ("is this
 * sender a known contact?"). Semantic search can rank the wrong person first,
 * and `entity` resolves fuzzy name variants on purpose; this op answers only
 * on an exact match: a frontmatter `email` / `emails` value, the page title,
 * or a declared alias equal to the query, ignoring case, accents (NFKD with
 * marks stripped, stroke letters folded), compatibility width forms and
 * surrounding whitespace or quotes. An email query compares whole addresses
 * case-insensitively, with no accent folding. No nickname, typo, prefix or
 * semantic matching, and no search fallback: no match is an empty list.
 *
 * Candidates come from index-served equality probes
 * (engine-sql/exact-identity.ts); every candidate is verified here.
 */
import type { Operation, OperationContext } from './contract.ts';
import { invalidParam } from './op-fix.ts';
import { assertExplicitSourceLive, federatedSearchScope, parseSourceIdParam } from './context.ts';
import { foldNonDecomposingLatin } from '../latin-fold.ts';
import { normalizeAlias, normalizeAliasList } from '../search/alias-normalize.ts';
import { slugify } from '../entities/resolve.ts';
import { slugifySegment } from '../sync.ts';
import { exactIdentityStatement, type ExactIdentityProbes, type ExactIdentityRow } from '../engine-sql/exact-identity.ts';

export const WHOIS_MAX_QUERY_CHARS = 320;
export const WHOIS_MAX_TYPES = 20;
/** Candidate rows verified per call; past it the answer says truncated. */
export const WHOIS_CANDIDATE_CAP = 100;

export type IdentityMatchKind = 'email' | 'title' | 'alias';
const MATCH_RANK: Record<IdentityMatchKind, number> = { email: 0, title: 1, alias: 2 };
const TYPE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const EDGE_QUOTES = /^[\s"'`\u2018\u2019\u201c\u201d\u00ab\u00bb]+|[\s"'`\u2018\u2019\u201c\u201d\u00ab\u00bb]+$/g;

/** NFKC, lowercase, whitespace collapsed, surrounding quotes and brackets dropped. */
function displayKey(raw: string): string {
  return normalizeAlias(raw).replace(EDGE_QUOTES, '');
}

/** displayKey with accents stripped (NFKD, combining marks removed) and stroke letters folded. */
export function identityNameKey(raw: string): string {
  return foldNonDecomposingLatin(displayKey(raw).normalize('NFKD').replace(/\p{M}/gu, '')).replace(/\s+/g, ' ').trim();
}

/** The whole address, lowercased, or null when the value is not one email address. */
export function identityEmailKey(raw: string): string | null {
  const key = displayKey(raw).replace(/^<|>$/g, '');
  return EMAIL.test(key) ? key : null;
}

interface IdentityQuery { email: string | null; name: string }

/** A jsonb column as read: drivers hand it back parsed or as JSON text. */
function decoded(value: unknown): unknown {
  if (typeof value !== 'string' || !/^[[{"]/.test(value)) return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function strings(value: unknown): string[] {
  const v = decoded(value);
  return (Array.isArray(v) ? v : [v]).filter((s): s is string => typeof s === 'string');
}

/** The strongest exact match of the query on one candidate page, or null. */
export function identityMatchKind(query: IdentityQuery, row: Pick<ExactIdentityRow, 'title' | 'email' | 'emails' | 'aliases'>): IdentityMatchKind | null {
  const same = (v: string) => (query.email ? identityEmailKey(v) === query.email : identityNameKey(v) === query.name);
  if (query.email && [...strings(row.email), ...strings(row.emails)].some(same)) return 'email';
  if (row.title && same(row.title)) return 'title';
  return normalizeAliasList(decoded(row.aliases)).some(same) ? 'alias' : null;
}

function probesFor(raw: string, query: IdentityQuery): ExactIdentityProbes {
  const uniq = (values: string[]) => [...new Set(values.filter(Boolean))];
  const written = displayKey(raw);
  if (query.email) {
    const asGiven = raw.normalize('NFKC').replace(EDGE_QUOTES, '').replace(/^<|>$/g, '');
    return { titleKeys: [query.email], titleRaw: asGiven, basenames: [], aliasKeys: [query.email], emails: uniq([asGiven, query.email]) };
  }
  const nfkc = raw.normalize('NFKC').replace(EDGE_QUOTES, '').replace(/\s+/g, ' ');
  return {
    titleKeys: uniq([written, query.name]),
    titleRaw: nfkc,
    basenames: uniq([slugify(nfkc), slugifySegment(nfkc)]),
    aliasKeys: uniq([written, query.name]),
    emails: [],
  };
}

function parseParams(ctx: OperationContext, p: Record<string, unknown>) {
  const bad = (param: string, message: string, example: unknown) =>
    invalidParam(ctx, 'whois', param, 'whois: ' + message, { def: whois.params[param], example });
  const raw = typeof p.query === 'string' ? p.query : '';
  if (raw.length > WHOIS_MAX_QUERY_CHARS) throw bad('query', 'query must be at most ' + WHOIS_MAX_QUERY_CHARS + ' characters', 'alice@acme-example.com');
  const query: IdentityQuery = { email: identityEmailKey(raw), name: identityNameKey(raw) };
  if (!query.name) throw bad('query', 'query must be an email address or a name', 'alice@acme-example.com');
  let types: string[] | undefined;
  if (p.types !== undefined) {
    const ok = Array.isArray(p.types) && p.types.length >= 1 && p.types.length <= WHOIS_MAX_TYPES && p.types.every(t => typeof t === 'string' && TYPE_NAME.test(t));
    if (!ok) throw bad('types', 'types must be a list of 1-' + WHOIS_MAX_TYPES + ' page type names', ['person']);
    types = [...new Set(p.types as string[])].sort();
  }
  return { raw, query, types };
}

const whois: Operation = {
  name: 'whois',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  scope: 'read',
  description: 'Exact identity lookup: entity pages whose email, title or declared alias equals an email address or name, ignoring case, accents and quotes. '
    + 'Never fuzzy: empty matches means no exact match; ambiguous means several.',
  params: {
    query: { type: 'string', required: true, description: "Email address or name, e.g. 'alice@acme-example.com'." },
    types: { type: 'array', items: { type: 'string' }, description: "Page types; default: the schema pack's entity types." },
    source_id: { type: 'string', description: "One source; '__all__' spans your sources." },
  },
  handler: async (ctx, p) => {
    const params = parseParams(ctx, p);
    const sourceIdParam = parseSourceIdParam(p.source_id, 'whois', { allowAll: true });
    const scope = federatedSearchScope(ctx, sourceIdParam);
    await assertExplicitSourceLive(ctx, sourceIdParam);
    const sourceIds = scope.sourceIds ?? (scope.sourceId !== undefined
      ? [scope.sourceId]
      : (await ctx.engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(r => r.id));
    const { resolveEntityTypes } = await import('../schema-pack/entity-types.ts');
    const resolution = params.types
      ? { status: 'explicit' as const, filter: { types: params.types, per_source: [] } }
      : await resolveEntityTypes(ctx.engine, sourceIds);
    const { resolveExcludePrivatePages } = await import('../search/private-visibility.ts');
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
    const { text, params: values } = exactIdentityStatement({
      probes: probesFor(params.raw, params.query),
      sourceIds,
      types: resolution.filter,
      ...(ctx.remote !== false ? { remote: { excludePrivate } } : {}),
      limit: WHOIS_CANDIDATE_CAP + 1,
    });
    const rows = await ctx.engine.executeRaw<ExactIdentityRow>(text, values);
    const matches = rows.slice(0, WHOIS_CANDIDATE_CAP)
      .map(r => ({ slug: r.slug, source_id: r.source_id, title: r.title, type: r.type, match: identityMatchKind(params.query, r) }))
      .filter((m): m is typeof m & { match: IdentityMatchKind } => m.match !== null)
      .sort((a, b) => MATCH_RANK[a.match] - MATCH_RANK[b.match] || (a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    const notes: string[] = [];
    if (resolution.status === 'pack_unavailable') notes.push('The schema pack did not load, so no entity types are known: pass types explicitly, e.g. ["person"].');
    if (rows.length > WHOIS_CANDIDATE_CAP) notes.push('More candidates than ' + WHOIS_CANDIDATE_CAP + ' share this key, so matches may be incomplete: narrow with source_id or types.');
    return {
      query: params.raw.trim(),
      query_kind: params.query.email ? 'email' : 'name',
      types: params.types ?? 'schema_pack_entity_types',
      types_status: resolution.status,
      matches,
      ambiguous: matches.length > 1,
      ...(rows.length > WHOIS_CANDIDATE_CAP ? { truncated: true } : {}),
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
  },
  cliHints: { name: 'whois', positional: ['query'] },
};

export const whoisOperations: Operation[] = [whois];
