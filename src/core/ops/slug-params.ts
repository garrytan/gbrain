/**
 * Slug normalization at the operation boundary (audit decision C1).
 *
 * Writes store every slug lowercased and in Unicode NFC (`validateSlug`), so a
 * read must look the slug up in the same form: `People/Alice-Example` and a
 * decomposed `notes/café` name the pages stored as `people/alice-example`
 * and `notes/café`. `finalizeOperation` (operation-load.ts) wraps every
 * operation with `withNormalizedSlugParams`, so CLI, MCP and every in-process
 * caller of `op.handler` get the same normalization before the handler, its
 * scope checks and its receipts see the value. The one normal form is
 * `normalizeSlug` (utils.ts); this file only says which params carry a slug.
 *
 * `SLUG_PARAMS` is the single reviewable list of params that name a page by
 * slug (or a slug prefix). A param path is `name`, `name[]` (each string of an
 * array), `name[].member` (a member of each object of an array) or
 * `name.member` (a member of an object). `SLUG_PARAM_EXEMPT` lists the params
 * whose name says "slug" but whose value is something else, with the reason;
 * test/slug-params.test.ts fails when an op gains a slug-named param that is
 * on neither list.
 */
import { normalizeSlug } from '../utils.ts';
import type { Operation } from './contract.ts';

export const SLUG_PARAMS: Readonly<Record<string, readonly string[]>> = {
  // page reads
  get_page: ['slug'], get_chunks: ['slug'], get_raw_data: ['slug'], get_versions: ['slug'],
  get_tags: ['slug'], get_timeline: ['slug'], get_write_attribution: ['slug'],
  get_links: ['slug'], get_backlinks: ['slug'], traverse_graph: ['slug'],
  list_pages: ['slug_prefix', 'updated_after_slug'], search_exact: ['slug_prefix'],
  file_list: ['slug'], file_verify: ['slug'], entity_identity_list: ['slug'],
  find_trajectory: ['entity_slug'], find_contradictions: ['slug'], takes_list: ['page_slug'],
  takes_scorecard: ['domain_prefix'], get_recent_salience: ['slugPrefix'],
  chronicle_last_seen: ['entity'], ontology_get: ['entity'],
  context_pack: ['entity_refs[].slug'], assemble_evidence: ['hits[].slug'], delta: ['since_slug'],
  // page writes (validateSlug normalizes the stored slug; the op layer must see the same form)
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
  open_loops: { counterparty: 'slug or email address' },
  submit_agent: { allowed_slug_prefixes: 'write prefixes, compared with normalizeSlugPrefix' },
  capture: { who: 'names or slugs (entity resolution)' },
  think: { anchor: 'name or slug (entity resolution)' },
};

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

/**
 * A read whose normalized slug missed may name a page stored before writes
 * composed slugs to NFC (a decomposed `café` written through put_page).
 * Such a read retries once with the caller's spelling, lowercased as writes
 * always did, so a slug that list or search printed still opens.
 */
function legacySpellingParams(opName: string, raw: Params, normalized: Params): Params | null {
  const paths = SLUG_PARAMS[opName] ?? [];
  const lowered = paths.reduce((acc, path) => normalizeAt(acc, path, v => typeof v === 'string' ? v.toLowerCase() : v), raw);
  return JSON.stringify(lowered) === JSON.stringify(normalized) ? null : lowered;
}

/** Wraps an operation handler so it receives normalized slug params (see the file comment). */
export function withNormalizedSlugParams(op: Operation, handler: Operation['handler']): Operation['handler'] {
  if (!SLUG_PARAMS[op.name]) return handler;
  return async (ctx, params) => {
    const normalized = normalizeSlugParams(op.name, params);
    if (op.mutating === true || normalized === params) return handler(ctx, normalized);
    try {
      return await handler(ctx, normalized);
    } catch (err) {
      const legacy = (err as { code?: unknown } | null)?.code === 'page_not_found' ? legacySpellingParams(op.name, params, normalized) : null;
      if (legacy === null) throw err;
      try {
        return await handler(ctx, legacy);
      } catch {
        throw err;
      }
    }
  };
}
