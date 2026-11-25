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
import { normalizeSlug, withStoredSlug } from '../utils.ts';
import { isEngineCapabilityRefusal } from '../engine-capability-refusal.ts';
import { storedWriteSlug } from '../persistence/legacy-slug-put.ts';
import { SCAN_KEY_SQL, SPELLING_KEY_SQL, spellingKeys } from '../slug-spelling-key.ts';
import type { Page } from '../types.ts';
import { opError, type Operation } from './contract.ts';
import { federatedSearchScope, parseSourceIdParam, sourceScopeOpts } from './context.ts';
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
  // household records (GST-3825 H1)
  household_mark: ['slug'],
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
  household_add: { slug: 'a name for the new record, slugified under its placement folder; not a page slug' },
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

/** The source scope the op's own handler reads in: a per-call `source_id` and the caller's grant narrow it, as `get_page` resolves it. */
function readScope(ctx: Ctx, op: string, params: Params): { sourceId?: string; sourceIds?: string[] } {
  const sourceIdParam = parseSourceIdParam(params.source_id, op, { allowAll: true });
  return op === 'get_page' || sourceIdParam !== undefined ? federatedSearchScope(ctx, sourceIdParam) : sourceScopeOpts(ctx);
}

/**
 * Every stored spelling in `scope` that normalizes to `normalized` and is not in `skip`, in code-unit order (the scope applies
 * before any row is kept). The rows come from the spelling index, probed by the slug's own key and the keys of its capital
 * forms; a slug with more capital forms than `MAX_SPELLING_VARIANTS` is read by scanning the ASCII key instead. Either way
 * `normalizeSlug` has the last word on each row.
 */
async function storedSpellings(ctx: Ctx, normalized: string, scope: { sourceId?: string; sourceIds?: string[] }, skip: readonly string[]): Promise<string[]> {
  const keys = spellingKeys(normalized);
  const args: unknown[] = keys ? [keys] : [normalized.replace(/[^a-z0-9]/g, '')];
  const match = keys ? `${SPELLING_KEY_SQL} = ANY($1::text[])` : `${SCAN_KEY_SQL} = $1`;
  let scoped = '';
  if (scope.sourceIds) { args.push(scope.sourceIds); scoped = `AND source_id = ANY($${args.length}::text[])`; }
  else if (scope.sourceId !== undefined) { args.push(scope.sourceId); scoped = `AND source_id = $${args.length}`; }
  args.push('');
  const found = new Set<string>();
  for (;;) {
    const rows = await ctx.engine.executeRaw<{ s: string }>(
      `SELECT DISTINCT slug COLLATE "C" AS s FROM pages WHERE ${match} ${scoped} AND slug COLLATE "C" > $${args.length} ORDER BY s LIMIT 200`, args);
    for (const { s } of rows) if (!skip.includes(s) && normalizeSlug(s) === normalized) found.add(s);
    if (rows.length < 200) return [...found].sort();
    args[args.length - 1] = rows[rows.length - 1]!.s;
  }
}

/**
 * The spelling of the scalar slug param `raw` that a read should receive, and the spellings `legacySpellings` offers.
 * Pages written before slugs were composed keep their stored spelling, so a read answers as it did before: the page the
 * caller's own bytes name (a stored page, or an alias of one, in the scope and with the deleted rows the op reads), then the
 * lowercased bytes, then the normal form. Only where none of those answers, the other stored spellings that normalize to the
 * same slug: one is the page, two are ambiguous. A spelling with no page of its own may still key files and facts, so it is
 * offered along with the chosen one; a spelling that is another page's never is. Only the op's own source scope and privacy
 * gate are probed, so a page the caller cannot read never decides a spelling or shows up in an ambiguity message.
 */
async function chooseSpelling(ctx: Ctx, op: string, params: Params, raw: string, normalized: string): Promise<{ slug: string; slugs: string[] }> {
  const lowered = raw.toLowerCase();
  const order = distinct([raw, lowered, normalized]);
  try {
    const scope = readScope(ctx, op, params);
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
    if (PREFIX_READS.has(op)) {
      const held: string[] = [];
      for (const slugPrefix of order) {
        if ((await ctx.engine.listPages({ slugPrefix, limit: 1, ...scope, excludePrivate })).length > 0) held.push(slugPrefix);
      }
      return held.length > 0 ? { slug: held[0]!, slugs: held } : { slug: normalized, slugs: [normalized] };
    }
    const includeDeleted = params.include_deleted === true;
    const pages = new Map(await Promise.all(order.map(async slug => [slug, await ctx.engine.getPage(slug, { ...scope, excludePrivate, includeDeleted: true })] as const)));
    const readable = (page: Page | null | undefined) => page !== null && page !== undefined && !(excludePrivate && isPrivatePageForCaller(page));
    const visible = (slug: string) => readable(pages.get(slug));
    // get_page also answers a former slug of a page (an alias), which no row of this name holds.
    const reached = op === 'get_page'
      ? new Map(await Promise.all(order.map(async slug => [slug, (await ctx.engine.readPageSnapshot(slug, { ...scope, excludePrivate, includeDeleted, resolveAlias: true }))?.page ?? null] as const)))
      : null;
    const eligible = (slug: string) => reached ? readable(reached.get(slug)) : visible(slug) && (includeDeleted || !pages.get(slug)!.deleted_at);
    const offered = (slug: string) => [slug, ...order.filter(other => other !== slug && !pages.get(other))];
    // (a) the caller's exact bytes, (b) the lowercased bytes, which is what a read looked up before slugs were composed,
    // (c) the normal form: the first answer wins, so a read that found a page before still finds that page.
    const first = order.find(eligible);
    if (first !== undefined) return { slug: first, slugs: offered(first) };
    // (d) no page under any of those: the stored spellings that normalize to the same slug. One is the page; two or more are ambiguous.
    const liveOthers: string[] = [];
    try {
      for (const slug of await storedSpellings(ctx, normalized, scope, order)) {
        const page = await ctx.engine.getPage(slug, { ...scope, excludePrivate, includeDeleted: true });
        if (readable(page) && (includeDeleted || !page!.deleted_at)) liveOthers.push(slug);
        if (liveOthers.length > 1) break;
      }
    } catch (err) {
      // An engine without raw reads (a typed capability refusal) knows no other spelling; any other failure is not
      // "nothing found", so it reaches the fallback below, which answers the normal form.
      if (!isEngineCapabilityRefusal(err)) throw err;
    }
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
 * A write (`NORMALIZED_WRITES`) acts on the page stored under the caller's exact spelling, or its lowercase, when one is
 * stored in the caller's source (storedWriteSlug), as it did before slugs were normalized; only a name that no stored page
 * holds is normalized. Normalizing first would attach the write to a different page that prints the same name, such as a
 * public composed page beside a private decomposed one.
 */
async function writeByStoredSpelling(ctx: Parameters<Operation['handler']>[0], params: Params, normalized: Params, scalars: string[], handler: Operation['handler']) {
  let chosen = normalized;
  let kept: string | null = null;
  for (const path of scalars) {
    const raw = scalarAt(params, path);
    const wanted = scalarAt(normalized, path);
    if (raw === undefined || wanted === undefined || raw === wanted) continue;
    const stored = await storedWriteSlug(ctx.engine, ctx.sourceId ?? 'default', raw, wanted);
    if (stored === null) continue;
    chosen = normalizeAt(chosen, path, () => stored);
    kept ??= stored;
  }
  return kept === null ? handler(ctx, chosen) : withStoredSlug(kept, () => handler(ctx, chosen));
}

/**
 * Wraps an operation handler so a read receives normalized slug params (see the file comment), except that a page
 * stored under the caller's exact spelling (a capital, or the decomposed Unicode form older writes kept) is read as
 * stored. A mutating operation is passed through as sent, except `NORMALIZED_WRITES` (writeByStoredSpelling): a page write normalizes the
 * slug itself (validateSlug), and its request digest covers what the caller sent, so a retry of a request journaled
 * before this change still replays.
 */
export function withNormalizedSlugParams(op: Operation, handler: Operation['handler']): Operation['handler'] {
  const write = op.mutating === true;
  if (!SLUG_PARAMS[op.name] || (write && !NORMALIZED_WRITES.has(op.name))) return handler;
  const scalars = SLUG_PARAMS[op.name]!.filter(path => !/[.[]/.test(path));
  return async (ctx, params) => {
    const normalized = normalizeSlugParams(op.name, params);
    if (write) return writeByStoredSpelling(ctx, params, normalized, scalars, handler);
    // `onlyChanged`: a param already in normal form needs no probe unless the read found nothing (below).
    const choose = async (onlyChanged: boolean) => {
      let chosen = normalized;
      const spellings = new Map<string, string[]>();
      for (const path of scalars) {
        const raw = scalarAt(params, path);
        const wanted = scalarAt(normalized, path);
        if (raw === undefined || wanted === undefined || onlyChanged && raw === wanted) continue;
        const pick = await chooseSpelling(ctx, op.name, params, raw, wanted);
        chosen = normalizeAt(chosen, path, () => pick.slug);
        if (pick.slugs.length > 1) spellings.set(pick.slug, pick.slugs);
      }
      return { chosen, run: (args: Params) => spellings.size > 0 ? spellingStore.run(spellings, () => handler(ctx, args)) : handler(ctx, args) };
    };
    if (normalized === params) {
      // Already in normal form: master read it as sent. Only where that finds no page, a page stored under another spelling of the name answers.
      try { return await handler(ctx, params); } catch (err) {
        if ((err as { code?: unknown } | null)?.code !== 'page_not_found' || scalars.length === 0) throw err;
        const { chosen, run } = await choose(false);
        if (JSON.stringify(chosen) === JSON.stringify(params)) throw err;
        try { return await run(chosen); } catch (again) { throw (again as { code?: unknown } | null)?.code === 'page_not_found' ? err : again; }
      }
    }
    const { chosen, run } = await choose(true);
    try {
      return await run(chosen);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== 'page_not_found') throw err;
      // The probe found no page the handler could read (another source scope than the probe's): try the spellings the caller may have meant.
      const lowered = legacySpellingParams(op.name, params, chosen);
      // When no spelling finds a page, the refusal names the id as the caller typed it (its message and the fix it
      // prints), so an agent that re-runs the fix sends what it sent.
      let asSent: unknown = err;
      for (const retry of [lowered, params].filter((v): v is Params => v !== null && JSON.stringify(v) !== JSON.stringify(chosen))) {
        try { return await run(retry); } catch (again) {
          if (retry === params && (again as { code?: unknown } | null)?.code === 'page_not_found') asSent = again;
        }
      }
      throw asSent;
    }
  };
}
