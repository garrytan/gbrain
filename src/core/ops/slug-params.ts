/**
 * Slug normalization at the operation boundary (audit decision C1).
 *
 * Writes store every slug lowercased and in Unicode NFC (`validateSlug`), so a
 * read must look the slug up in the same form: `People/Alice-Example` and a
 * decomposed `notes/café` name the pages stored as `people/alice-example`
 * and `notes/café`. `finalizeOperation` (operation-load.ts) wraps every
 * operation with `withNormalizedSlugParams`, so CLI, MCP and every in-process
 * caller of `op.handler` get the same normalization before the handler, its
 * scope checks and its receipts see the value. A mutating operation is not wrapped, except the three in
 * `NORMALIZED_WRITES`: a page write normalizes the slug through `validateSlug`, and its request digest must
 * keep covering the slug the caller sent (a retry of a request journaled before this change still replays).
 * The one normal form is `normalizeSlug` (utils.ts); this file only says which params carry a slug.
 *
 * `SLUG_PARAMS` is the single reviewable list of params that name a page by
 * slug (or a slug prefix). A param path is `name`, `name[]` (each string of an
 * array), `name[].member` (a member of each object of an array) or
 * `name.member` (a member of an object). `SLUG_PARAM_EXEMPT` lists the params
 * whose name says "slug" but whose value is something else, with the reason;
 * the registry test in test/slug-normalize-reads.test.ts fails when an op gains a slug-named param that is
 * on neither list.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeSlug } from '../utils.ts';
import { opError, type Operation } from './contract.ts';
import { sourceScopeOpts } from './context.ts';
import { readFix } from './op-fix.ts';
import { isPrivatePageForCaller, resolveExcludePrivatePages } from '../search/private-visibility.ts';

export const SLUG_PARAMS: Readonly<Record<string, readonly string[]>> = {
  // page reads
  get_page: ['slug'], get_chunks: ['slug'], get_raw_data: ['slug'], get_versions: ['slug'],
  get_tags: ['slug'], get_timeline: ['slug'], get_write_attribution: ['slug'],
  get_links: ['slug'], get_backlinks: ['slug'], traverse_graph: ['slug'],
  list_pages: ['slug_prefix'], search_exact: ['slug_prefix'],
  file_list: ['slug'], file_verify: ['slug'], entity_identity_list: ['slug'],
  find_trajectory: ['entity_slug'], find_contradictions: ['slug'], takes_list: ['page_slug'],
  takes_scorecard: ['domain_prefix'], get_recent_salience: ['slugPrefix'],
  chronicle_last_seen: ['entity'], ontology_get: ['entity'],
  context_pack: ['entity_refs[].slug'],
  // page writes (listed for the registry check; the write path normalizes through validateSlug, see withNormalizedSlugParams)
  put_page: ['slug'], put_pages: ['pages[].slug'], append_page: ['slug'], edit_page: ['slug'],
  delete_page: ['slug'], restore_page: ['slug'], unpurge_page: ['slug'], revert_version: ['slug'],
  begin_page_upload: ['slug'], capture: ['slug'], put_raw_data: ['slug'],
  add_tag: ['slug'], remove_tag: ['slug'], add_timeline_entry: ['slug'],
  add_link: ['from', 'to'], remove_link: ['from', 'to'],
  takes_add: ['slug'], takes_rebuild: ['slug'], takes_remove: ['slug'], takes_resolve: ['slug'],
  takes_supersede: ['slug'], takes_update: ['slug'],
  entity_identity_link: ['slug'], entity_identity_unlink: ['slug'],
  promote_guest_note: ['slug', 'to'], file_register: ['page_slug'], file_upload: ['page_slug'],
  ontology_propose: ['entity'], extraction_review: ['slugs[]', 'of'],
  extract_entities: ['source_slug'], extract_facts: ['source_slug', 'entity_hints[]'],
  log_ingest: ['pages_updated[]'], memory_propose: ['target'],
  questions_pin: ['scope.entity', 'scope.slug_prefix'],
};

/** Params whose name or description says "slug" but whose value is not a page slug, so they are left as sent. */
export const SLUG_PARAM_EXEMPT: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // A name, alias or slug: entity resolution reads names case- and accent-insensitively and normalizes a slug-shaped value itself.
  entity: { name: 'name, alias or slug (entity resolution)' },
  remember: { entity: 'name or slug (entity resolution)' },
  recall: { entity: 'name or slug (entity resolution)' },
  context_pack: { entities: 'names or slugs (entity resolution)', counterparty: 'name or slug (entity resolution)' },
  list_pages: { updated_after_slug: 'continuation cursor: the last row\'s stored slug, compared byte for byte in the keyset order' },
  delta: { since_slug: 'continuation cursor: a stored slug, compared byte for byte in the keyset order' },
  open_loops: { counterparty: 'slug or email address' },
  submit_agent: { allowed_slug_prefixes: 'write prefixes, compared with normalizeSlugPrefix' },
  capture: { who: 'names or slugs (entity resolution)' },
  think: { anchor: 'name or slug (entity resolution)' },
  // Params that carry a slug but not under a slug name. Each is left as sent, because it is compared to stored text as
  // written (a holder, a source, a ref the caller copies from a result) or is not a whole slug; normalizing it would change what the op returns.
  query: { explain_target: '`slug` or `source:slug` diagnostic target: probeTarget matches the stored slug as sent and a miss is a typed diagnosis' },
  confirm_memory: { ref: '`f<id>`, `t<id>` or `p:<source>/<slug>` trust ref: parsed by parseTrustRef and bound to the owner confirmation as sent' },
  rate_answer: { 'pages[].ref': '`source:slug` ref matched exactly against the pages the answer listed (the caller copies it from the answer)' },
  takes_list: { holder: 'holder label (world, garry, brain or a slug): compared to the stored holder as written' },
  get_calibration_profile: { holder: 'holder label (world, garry, brain or a slug): compared to the stored holder as written' },
  resolve_slugs: { partial: 'partial slug or title fuzzy-matched by resolveSlugs, not a whole slug' },
  find_pages: { pattern: 'glob, slug prefix or plain name parsed by parseFindPattern, echoed back as sent' },
  add_timeline_entry: { source: 'provenance stored with the entry as written: a source slug or a URL' },
  ontology_propose: { source: 'provenance stored with the observation as written: a page slug or a URI' },
  assemble_evidence: { hits: 'search hits: each hit.slug is the stored slug a search returned, joined to its evidence by exact source and slug, so a decomposed page and its composed twin stay apart' },
};

/**
 * Mutating operations that are not journaled page writes: they hold no request digest over the slug, and their
 * matching reads (ontology_get, file_list, file_verify) normalize it, so a write normalizes it the same way.
 */
const NORMALIZED_WRITES: ReadonlySet<string> = new Set(['ontology_propose', 'file_upload', 'file_register']);

type Params = Record<string, unknown>;

function normalizeValue(value: unknown): unknown {
  return typeof value === 'string' ? normalizeSlug(value) : value;
}

/** `params` with the value at `path` normalized; the same object when nothing changes (copy-on-write). */
function normalizeAt(params: Params, path: string, map: (v: unknown) => unknown): Params {
  const dot = path.indexOf('.');
  const head = dot < 0 ? path : path.slice(0, dot);
  const rest = dot < 0 ? '' : path.slice(dot + 1);
  const isArray = head.endsWith('[]');
  const key = isArray ? head.slice(0, -2) : head;
  const current = params[key];
  let next: unknown = current;
  if (isArray) {
    if (!Array.isArray(current)) return params;
    const items = current.map(item => rest === ''
      ? map(item)
      : item !== null && typeof item === 'object' && !Array.isArray(item) ? normalizeAt(item as Params, rest, map) : item);
    next = items.some((item, i) => item !== current[i]) ? items : current;
  } else if (rest === '') {
    next = map(current);
  } else if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
    next = normalizeAt(current as Params, rest, map);
  }
  return next === current ? params : { ...params, [key]: next };
}

/** The op's params with every slug param in its normal form. */
export function normalizeSlugParams(opName: string, params: Params): Params {
  const paths = SLUG_PARAMS[opName];
  if (!paths || params === null || typeof params !== 'object') return params;
  return paths.reduce((acc, path) => normalizeAt(acc, path, normalizeValue), params);
}

/** `raw` with each slug param lowercased as writes always did, or null when that is no change from `normalized`. */
function legacySpellingParams(opName: string, raw: Params, normalized: Params): Params | null {
  const paths = SLUG_PARAMS[opName] ?? [];
  const lowered = paths.reduce((acc, path) => normalizeAt(acc, path, v => typeof v === 'string' ? v.toLowerCase() : v), raw);
  return JSON.stringify(lowered) === JSON.stringify(normalized) ? null : lowered;
}

/** The string at a top-level param `path` (`name`), or undefined for a nested path or a non-string. */
function scalarAt(params: Params, path: string): string | undefined {
  const v = /[.[]/.test(path) ? undefined : params[path];
  return typeof v === 'string' ? v : undefined;
}

/** Ops whose scalar slug param is a prefix, not a page: every spelling of it that has rows is read (a union, see `legacySpellings`). */
const PREFIX_READS: ReadonlySet<string> = new Set(['list_pages', 'search_exact', 'takes_scorecard', 'get_recent_salience']);

type Ctx = Parameters<Operation['handler']>[0];

/** The spellings a read names, by the param value the handler receives (see `legacySpellings`). */
const spellingStore = new AsyncLocalStorage<Map<string, string[]>>();

/**
 * Every stored spelling a read of `slug` may name: `slug` itself, then the caller's other spellings (as sent, lowercased,
 * normal form) that no page of its own holds, since files and facts can outlive their page or be keyed by the caller's
 * spelling. Outside a wrapped read, just `slug`.
 */
export function legacySpellings(slug: string): string[] {
  return spellingStore.getStore()?.get(slug) ?? [slug];
}

const distinct = (values: readonly string[]): string[] => [...new Set(values)];
const spellingKind = (s: string): string => `${s === s.normalize('NFC') ? 'composed' : 'decomposed'}${s === s.toLowerCase() ? '' : ', with capitals'}`;

/** The other spellings of a prefix param that hold pages, as the engine option `key` (nothing when only one does). */
export function alsoPrefixes<K extends string>(key: K, prefix: string): { [P in K]?: string[] } {
  const [, ...also] = legacySpellings(prefix);
  return (also.length > 0 ? { [key]: also } : {}) as { [P in K]?: string[] };
}

/** Two pages are stored under spellings that normalize to one slug and the caller sent neither: name both, never pick one. */
function ambiguousSpelling(op: string, raw: string, a: string, b: string) {
  const retry = (slug: string) => ({ argv: ['gbrain', 'get', '--', slug], mcp: { tool: op, arguments: { slug } } });
  return opError('invalid_params',
    `The slug ${JSON.stringify(raw)} is ambiguous: this brain stores two pages whose slugs read the same, ${JSON.stringify(a)} (${spellingKind(a)}) and ${JSON.stringify(b)} (${spellingKind(b)}), and ${JSON.stringify(raw)} is neither of them exactly.`,
    `Send the exact stored spelling, ${JSON.stringify(a)} or ${JSON.stringify(b)} (copy it from list_pages or search), and nothing is read until then.`, {
      detail: 'ambiguous_slug',
      why: 'Slugs are stored lowercase and in composed Unicode (NFC) form; a page stored before that rule keeps its decomposed spelling, so one name can belong to two pages.',
      fix: { ...readFix('Reads the page under one of its exact stored spellings.', retry(a)), verify: retry(b) },
    });
}

/**
 * The spelling of the scalar slug param `raw` that a read should receive, and the spellings `legacySpellings` offers.
 * Pages written before slugs were composed keep their stored spelling, so the caller's own spelling is read first and
 * the normalized spelling is the fallback (a prefix: the first spelling with rows under it). A spelling with no page of
 * its own may still key files and facts, so it is offered along with the chosen one; a spelling that is another page's
 * never is. Only the caller's own source scope and privacy gate are probed, so a page the caller cannot read never
 * decides a spelling or shows up in an ambiguity message.
 */
async function chooseSpelling(ctx: Ctx, op: string, raw: string, normalized: string): Promise<{ slug: string; slugs: string[] }> {
  const lowered = raw.toLowerCase();
  const order = distinct([raw, lowered, normalized]);
  try {
    const scope = sourceScopeOpts(ctx);
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
    if (PREFIX_READS.has(op)) {
      const held: string[] = [];
      for (const slugPrefix of order) {
        if ((await ctx.engine.listPages({ slugPrefix, limit: 1, ...scope, excludePrivate })).length > 0) held.push(slugPrefix);
      }
      return held.length > 0 ? { slug: held[0]!, slugs: held } : { slug: normalized, slugs: [normalized] };
    }
    const pages = new Map(await Promise.all(order.map(async slug => [slug, await ctx.engine.getPage(slug, { ...scope, excludePrivate, includeDeleted: true })] as const)));
    const live = (slug: string) => {
      const page = pages.get(slug) ?? null;
      return page !== null && !page.deleted_at && !(excludePrivate && isPrivatePageForCaller(page));
    };
    const visible = (slug: string) => {
      const page = pages.get(slug) ?? null;
      return page !== null && !(excludePrivate && isPrivatePageForCaller(page));
    };
    const offered = (slug: string) => [slug, ...order.filter(other => other !== slug && !pages.get(other))];
    // (a) the caller's exact bytes, (b) the lowercased bytes, which is what a read looked up before slugs were composed,
    // (c) the normal form: the first stored page wins, so a read that found a page before still finds that page.
    const first = order.find(live);
    if (first !== undefined) return { slug: first, slugs: offered(first) };
    // (d) no page under any of those: the stored spellings that normalize to the same slug. One is the page; two or more are ambiguous.
    const liveOthers: string[] = [];
    try {
      const others = (await ctx.engine.executeRaw<{ slug: string }>(
        `SELECT DISTINCT slug FROM pages WHERE normalize(lower(slug), NFC) = $1 ORDER BY slug LIMIT 20`, [normalized])).map(r => r.slug).filter(slug => !order.includes(slug)).sort(); // code-unit order, so both engines name the same two
      for (const slug of others) {
        const page = await ctx.engine.getPage(slug, { ...scope, excludePrivate, includeDeleted: true });
        if (page !== null && !page.deleted_at && !(excludePrivate && isPrivatePageForCaller(page))) liveOthers.push(slug);
      }
    } catch { /* an engine without raw reads: no other spelling is known */ }
    if (liveOthers.length > 1) throw ambiguousSpelling(op, raw, liveOthers[0]!, liveOthers[1]!);
    if (liveOthers.length === 1) return { slug: liveOthers[0]!, slugs: [liveOthers[0]!] };
    const deleted = order.find(visible);
    if (deleted !== undefined) return { slug: deleted, slugs: offered(deleted) };
  } catch (err) {
    if ((err as { detail?: unknown } | null)?.detail === 'ambiguous_slug') throw err;
  }
  return { slug: normalized, slugs: distinct([normalized, ...order]) };
}

/**
 * Wraps an operation handler so a read receives normalized slug params (see the file comment), except that a page
 * stored under the caller's exact spelling (a capital, or the decomposed Unicode form older writes kept) is read as
 * stored. A mutating operation is passed through as sent, except `NORMALIZED_WRITES`: a page write normalizes the
 * slug itself (validateSlug), and its request digest covers what the caller sent, so a retry of a request journaled
 * before this change still replays.
 */
export function withNormalizedSlugParams(op: Operation, handler: Operation['handler']): Operation['handler'] {
  const write = op.mutating === true;
  if (!SLUG_PARAMS[op.name] || (write && !NORMALIZED_WRITES.has(op.name))) return handler;
  const scalars = SLUG_PARAMS[op.name]!.filter(path => !/[.[]/.test(path));
  return async (ctx, params) => {
    const normalized = normalizeSlugParams(op.name, params);
    if (normalized === params || write) return handler(ctx, normalized);
    let chosen = normalized;
    const spellings = new Map<string, string[]>();
    for (const path of scalars) {
      const raw = scalarAt(params, path);
      const wanted = scalarAt(normalized, path);
      if (raw === undefined || wanted === undefined || raw === wanted) continue;
      const pick = await chooseSpelling(ctx, op.name, raw, wanted);
      chosen = normalizeAt(chosen, path, () => pick.slug);
      if (pick.slugs.length > 1) spellings.set(pick.slug, pick.slugs);
    }
    const run = (args: Params) => spellings.size > 0 ? spellingStore.run(spellings, () => handler(ctx, args)) : handler(ctx, args);
    try {
      return await run(chosen);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== 'page_not_found') throw err;
      // The probe found no page the handler could read (another source scope than the probe's): try the spellings the caller may have meant.
      const lowered = legacySpellingParams(op.name, params, chosen);
      for (const retry of [lowered, params].filter((v): v is Params => v !== null && JSON.stringify(v) !== JSON.stringify(chosen))) {
        try { return await run(retry); } catch { /* keep the first error */ }
      }
      throw err;
    }
  };
}
