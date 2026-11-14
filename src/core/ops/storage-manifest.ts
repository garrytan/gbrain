/**
 * Storage manifest verbs (GST-1943): `storage_find`, `storage_get` and `storage_list` read the storage shelf (the
 * `storage` source) under the caller's ordinary read authority; `storage_register` and `storage_update` write it and
 * are trusted-local only (v1: remote write grants are a later plan). Writes go through the page door with the storage
 * door mark, so the card is committed to the hosted repository first on a repo brain and the database is the record on
 * a repo-less one. Cards and shapes: src/core/storage-manifest/schema.ts.
 */
import { clampSearchLimit } from '../engine.ts';
import { dataFrontmatter } from '../data-frontmatter.ts';
import { PROTECTED_FRONTMATTER_KEYS } from '../frontmatter-recovery.ts';
import { REVISION_BACKFILL_PENDING } from '../page-state/types.ts';
import type { Operation, OperationContext } from './contract.ts';
import { opError, OperationError } from './contract.ts';
import { federatedSearchScope, readPolicyOpts } from './context.ts';
import { readFix } from './op-fix.ts';
import { cliOnlyRefusal } from './callable.ts';
import type { PageReadScope } from '../types.ts';
import { initializeLocalPersistence, submitPageMutation, requestPrincipalForContext } from '../persistence/page-mutations.ts';

async function principalLabel(ctx: OperationContext): Promise<string> {
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  return `${principal.kind}:${principal.id}`;
}
import { cardFromPage, cardPage, parseCardInput, STATUSES, STORES, withRestore, type Card, type CardInput, ORIGINS } from '../storage-manifest/schema.ts';
import { ensureStorageSource, storageDoorContext, STORAGE_SOURCE_ID } from '../storage-manifest/source.ts';
import { findCards, listCards, type CardFilters } from '../storage-manifest/find.ts';

const FIND_DEFAULT = 10, FIND_MAX = 50;
const LIST_DEFAULT = 50, LIST_LOCAL_MAX = 500, LIST_REMOTE_MAX = 100;

function getFix(id: string) {
  return readFix('Reads the card with its restore form and current revision.', { argv: ['gbrain', 'storage-get', id, '--json'], mcp: { tool: 'storage_get', arguments: { id } } });
}

async function shelfExists(ctx: OperationContext): Promise<boolean> {
  const rows = await ctx.engine.executeRaw<{ ok: number }>('SELECT 1 AS ok FROM sources WHERE id=$1 AND archived IS NOT TRUE', [STORAGE_SOURCE_ID]);
  return rows.length > 0;
}

/** The read policy for the shelf: the caller's grant must allow the storage source (federatedSearchScope refuses otherwise). */
async function shelfPolicy(ctx: OperationContext): Promise<PageReadScope | undefined> {
  const scope = federatedSearchScope(ctx, STORAGE_SOURCE_ID);
  return ctx.remote === false && !ctx.applyRemoteReadPolicy ? scope : await readPolicyOpts(ctx, scope);
}

function filtersOf(p: Record<string, unknown>): CardFilters {
  const filters: CardFilters = {};
  if (p.store !== undefined) {
    if (typeof p.store !== 'string' || !(STORES as readonly string[]).includes(p.store)) throw opError('invalid_params', `store must be one of ${STORES.join(', ')}.`, 'Pass a store name, or omit store.');
    filters.store = p.store;
  }
  if (p.status !== undefined) {
    if (typeof p.status !== 'string' || !(STATUSES as readonly string[]).includes(p.status)) throw opError('invalid_params', `status must be one of ${STATUSES.join(', ')}.`, 'Pass a status, or omit status.');
    filters.status = p.status;
  }
  if (p.on_source_machine !== undefined) filters.onSourceMachine = p.on_source_machine === true || p.on_source_machine === 'true';
  return filters;
}

const NO_SHELF = 'This brain has no storage shelf yet: nothing has been registered. The archiving agent registers each item with gbrain storage-register after it verifies the archive.';

/** The card and its page frontmatter, read only when the caller may read that exact revision (a page that changes between the snapshot and the visibility check is read again). */
async function readCard(ctx: OperationContext, id: string): Promise<{ card: Card; revision: string; updated_at: string; frontmatter: Record<string, unknown> } | null> {
  if (!await shelfExists(ctx)) return null;
  const policy = await shelfPolicy(ctx);
  const { pageReadFilter } = await import('../search/read-policy-sql.ts');
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await ctx.engine.readPageSnapshot(id, { sourceId: STORAGE_SOURCE_ID });
    if (!snapshot) return null;
    const params: unknown[] = [STORAGE_SOURCE_ID, id];
    const visible = await ctx.engine.executeRaw<{ revision: string | number | null }>(`SELECT p.knowledge_revision AS revision FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND ${pageReadFilter('p', policy, params, true)}`, params);
    if (!visible.length) return null;
    const revision = visible[0]!.revision == null ? REVISION_BACKFILL_PENDING : String(visible[0]!.revision);
    if (revision !== snapshot.revision) continue;
    const frontmatter = (snapshot.page.frontmatter ?? {}) as Record<string, unknown>;
    const card = cardFromPage({ slug: snapshot.page.slug, title: snapshot.page.title, frontmatter });
    return card ? { card, revision: snapshot.revision, updated_at: String(snapshot.page.updated_at ?? ''), frontmatter } : null;
  }
  throw opError('storage_revision_conflict', `Card ${id} kept changing while it was read; nothing was returned.`, 'Read the card again in a moment.', { fix: getFix(id) });
}

async function writeCard(ctx: OperationContext, card: Card, opts: { expectedRevision?: string; requestId?: string; stored?: Record<string, unknown> }): Promise<Record<string, unknown>> {
  const { frontmatter, body } = cardPage(card);
  for (const key of PROTECTED_FRONTMATTER_KEYS) if (opts.stored && Object.hasOwn(opts.stored, key) && !Object.hasOwn(frontmatter, key)) frontmatter[key] = opts.stored[key];
  const content = dataFrontmatter.stringify(body, frontmatter);
  try {
    const response = await submitPageMutation(storageDoorContext(ctx), { operation: 'put_page', params: {
      slug: card.id, source_id: STORAGE_SOURCE_ID, content,
      ...(opts.expectedRevision ? { expected_revision: opts.expectedRevision } : {}),
      ...(opts.requestId ? { request_id: opts.requestId } : {}) } });
    return response;
  } catch (error) {
    if (error instanceof OperationError && error.code === 'revision_required' && !opts.expectedRevision) {
      const current = await ctx.engine.readPageSnapshot(card.id, { sourceId: STORAGE_SOURCE_ID });
      throw cardExists(card.id, current?.revision ?? 'unknown');
    }
    if (error instanceof OperationError && error.code === 'revision_conflict') {
      const current = await ctx.engine.readPageSnapshot(card.id, { sourceId: STORAGE_SOURCE_ID });
      throw opError('storage_revision_conflict', `Card ${card.id} changed since revision ${opts.expectedRevision} was read; nothing was written.`,
        `Read the card again (its current revision is ${current?.revision ?? 'unknown'}), apply the change to what it says now, and update once with that revision.`,
        { fix: getFix(card.id), detail: current?.revision });
    }
    throw error;
  }
}

function cardExists(id: string, revision: string): OperationError {
  return opError('storage_card_exists', `A card with id ${id} is already on the storage shelf; nothing was written.`,
    `Change it with gbrain storage-update ${id} --expected-revision ${revision}, or register the new item under another id.`,
    { fix: getFix(id), detail: revision });
}

/**
 * Register a new card. Exported for `storage adopt` and `storage import` (origin adopt / import), which pass the access
 * labels (visibility, readable_by) the card page must carry so it is read no wider than its original.
 */
export async function registerCard(ctx: OperationContext, input: CardInput, origin: (typeof ORIGINS)[number], requestId?: string, labels?: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureStorageSource(ctx.engine);
  const existing = await ctx.engine.readPageSnapshot(input.id, { sourceId: STORAGE_SOURCE_ID });
  if (existing) throw cardExists(input.id, existing.revision);
  const card: Card = { ...input, registered_by: await principalLabel(ctx), origin };
  const response = await writeCard(ctx, card, { requestId, stored: labels });
  return { id: card.id, source_id: STORAGE_SOURCE_ID, origin, write: response };
}

function parsePatch(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw opError('storage_record_invalid', 'patch must be a JSON object; nothing was written.', 'Pass the fields to change as a JSON object, e.g. {"status":"retired"}.', { reason: 'not_json' }); }
  }
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw opError('storage_record_invalid', 'patch must be a JSON object; nothing was written.', 'Pass the fields to change as a JSON object.', { reason: 'not_object' });
  if (Object.hasOwn(value, 'id')) throw opError('storage_record_invalid', 'A card keeps its id; nothing was written.', 'Drop id from the patch, or register the item under a new id.', { reason: 'id_change' });
  return value as Record<string, unknown>;
}

const storage_find: Operation = {
  name: 'storage_find',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'Find archived items on the storage shelf (files moved to B2, Supabase Storage, S3 and similar) by a plain phrase, such as "the October Gmail dataset". ' +
    'Ranks exact id, then exact alias, then cards matching most of the phrase\'s words in title, aliases and description. When nothing matches, not_found is true and closest lists the nearest cards. ' +
    'Then call storage_get with the id for where it is stored and how to restore it.',
  params: {
    query: { type: 'string', required: true, description: 'The phrase, id or alias.' },
    store: { type: 'string', enum: [...STORES], description: 'Only cards with a copy in this store.' },
    status: { type: 'string', enum: [...STATUSES], description: 'Only cards with this status.' },
    limit: { type: 'number', description: `Max hits (default ${FIND_DEFAULT}, max ${FIND_MAX}).` },
  },
  handler: async (ctx, p) => {
    const query = typeof p.query === 'string' ? p.query.trim() : '';
    if (!query) throw opError('invalid_params', 'storage_find needs a query.', 'Pass the phrase people would use for the item, e.g. "october gmail dataset".');
    const filters = filtersOf(p);
    if (!await shelfExists(ctx)) return { query, terms: [], hits: [], not_found: true, closest: [], shelf: false, note: NO_SHELF };
    const limit = clampSearchLimit(typeof p.limit === 'number' ? p.limit : undefined, FIND_DEFAULT, FIND_MAX);
    const result = await findCards(ctx.engine, query, { limit, filters, policy: await shelfPolicy(ctx) });
    const top = result.hits[0] ?? result.closest[0];
    return { ...result, shelf: true, ...(top ? { next: getFix(top.id) } : {}) };
  },
  scope: 'read',
  cliHints: { name: 'storage-find', positional: ['query'] },
};

const storage_get: Operation = {
  name: 'storage_get',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'Read one card from the storage shelf by id: what the item is, every stored copy (store, bucket, path, restic repository and snapshot, size, hash, when verified), ' +
    'the original path, why it was archived, the restore form (restore.skill and restore.args, run by the agent\'s own restore skill; cards carry no commands or credentials), past restores, who registered it, and its revision.',
  params: { id: { type: 'string', required: true, description: 'Card id (storage_find returns it).' } },
  handler: async (ctx, p) => {
    const id = typeof p.id === 'string' ? p.id.trim().toLowerCase() : '';
    if (!id) throw opError('invalid_params', 'storage_get needs an id.', 'Pass the id storage_find returned.');
    const found = await readCard(ctx, id);
    if (!found) {
      throw opError('not_found', `No card ${id} on the storage shelf.`, 'Search with storage_find and the words people would use for the item; it lists the closest cards when nothing matches.',
        { fix: readFix('Finds cards by phrase, with the closest cards when nothing matches.', { argv: ['gbrain', 'storage-find', id, '--json'], mcp: { tool: 'storage_find', arguments: { query: id } } }) });
    }
    const { registered_by: _by, origin: _origin, ...content } = found.card;
    try { parseCardInput(content); } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      throw opError('storage_record_invalid', `Card ${id} on the storage shelf fails the card rules, so it is not served (${error.message})`,
        `Correct it with gbrain storage-update ${id} --expected-revision ${found.revision} --patch '<the fields to replace, as JSON>'; the patch is validated like a new card.`,
        { reason: 'schema', detail: found.revision });
    }
    return { card: found.card, revision: found.revision, updated_at: found.updated_at, source_id: STORAGE_SOURCE_ID, registered_by: found.card.registered_by, origin: found.card.origin };
  },
  scope: 'read',
  cliHints: { name: 'storage-get', positional: ['id'] },
};

const storage_list: Operation = {
  name: 'storage_list',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'List cards on the storage shelf, sorted by id, optionally filtered by store, status or whether a copy is still on the source machine. Returns id, title, status, kind, stores and original path per card, and total.',
  params: {
    store: { type: 'string', enum: [...STORES], description: 'Only cards with a copy in this store.' },
    status: { type: 'string', enum: [...STATUSES], description: 'Only cards with this status.' },
    on_source_machine: { type: 'boolean', description: 'Only cards whose item is (true) or is not (false) still on the machine it came from.' },
    limit: { type: 'number', description: `Max rows (default ${LIST_DEFAULT}; max ${LIST_LOCAL_MAX}, remote ${LIST_REMOTE_MAX}).` },
    offset: { type: 'number', description: 'Rows to skip, for paging.' },
  },
  handler: async (ctx, p) => {
    const filters = filtersOf(p);
    if (!await shelfExists(ctx)) return { cards: [], total: 0, shelf: false, note: NO_SHELF };
    const limit = clampSearchLimit(typeof p.limit === 'number' ? p.limit : undefined, LIST_DEFAULT, ctx.remote === false ? LIST_LOCAL_MAX : LIST_REMOTE_MAX);
    const offset = typeof p.offset === 'number' && p.offset > 0 ? Math.floor(p.offset) : 0;
    const { cards, total } = await listCards(ctx.engine, { limit, offset, filters, policy: await shelfPolicy(ctx) });
    return { cards, total, limit, offset, complete: offset + cards.length >= total, shelf: true };
  },
  scope: 'read',
  cliHints: { name: 'storage-list' },
};

const storage_register: Operation = {
  name: 'storage_register',
  mutating: true,
  writeInference: 'none',
  idempotent: false,
  outputRedaction: 'no_stored_text',
  description: 'Register a new card on the storage shelf after an archive is verified. card is a JSON object: id, title, aliases, description, kind, status, locations (store, bucket, path, tool, repository, snapshot, size_bytes, file_count, sha256, hash_kind, verified_at), ' +
    'original_path, on_source_machine, source_machine, archived_at, archived_by, reason, restore {skill, args}, restores, details. Credentials, credential-shaped values and command fields are refused. Trusted local CLI only.',
  params: { card: { type: 'object', required: true, description: 'The card (JSON).' } },
  scope: 'write',
  localOnly: true,
  cliOnly: { argv: ['gbrain', 'storage-register', '--card', '<card json>'] },
  handler: async (ctx, p) => {
    if (ctx.remote !== false) throw cliOnlyRefusal(storage_register);
    return registerCard(ctx, parseCardInput(p.card), 'local');
  },
  cliHints: { name: 'storage-register', stdin: 'card' },
};

const storage_update: Operation = {
  name: 'storage_update',
  mutating: true,
  writeInference: 'none',
  idempotent: false,
  outputRedaction: 'no_stored_text',
  description: 'Change a card on the storage shelf: patch replaces the named top-level fields (validated like a new card), and restored_to records a restore (newest first; status becomes restored). ' +
    'expected_revision is the revision storage_get returned; a stale one is refused storage_revision_conflict with the current revision. Trusted local CLI only.',
  params: {
    id: { type: 'string', required: true, description: 'Card id.' },
    expected_revision: { type: 'string', required: true, description: 'The revision storage_get returned.' },
    patch: { type: 'object', description: 'Top-level fields to replace (JSON).' },
    restored_to: { type: 'string', description: 'Path the item was restored to; adds a restores entry.' },
    restored_verified: { type: 'boolean', description: 'With restored_to: the checksums matched.' },
  },
  scope: 'write',
  localOnly: true,
  cliOnly: { argv: ['gbrain', 'storage-update', '<id>', '--expected-revision', '<revision>'] },
  handler: async (ctx, p) => {
    if (ctx.remote !== false) throw cliOnlyRefusal(storage_update);
    const id = typeof p.id === 'string' ? p.id.trim().toLowerCase() : '';
    const expected = typeof p.expected_revision === 'string' ? p.expected_revision : '';
    if (!id || !expected) throw opError('invalid_params', 'storage_update needs id and expected_revision.', 'Read the card with storage_get and pass its id and revision.');
    const found = await readCard(ctx, id);
    if (!found) throw opError('not_found', `No card ${id} on the storage shelf; nothing was written.`, 'Register it with gbrain storage-register, or find the right id with storage_find.');
    if (found.revision !== expected) {
      throw opError('storage_revision_conflict', `Card ${id} changed since revision ${expected} was read; nothing was written.`,
        `Read the card again (its current revision is ${found.revision}), apply the change to what it says now, and update once with that revision.`, { fix: getFix(id), detail: found.revision });
    }
    const patch = parsePatch(p.patch);
    const { registered_by, origin, ...current } = found.card;
    const input = parseCardInput({ ...current, ...patch, id });
    let card = { ...input, ...(registered_by !== undefined ? { registered_by } : {}), ...(origin !== undefined ? { origin } : {}) } as Card;
    if (typeof p.restored_to === 'string' && p.restored_to.trim()) {
      card = withRestore(card, { at: new Date().toISOString(), to: p.restored_to.trim(), by: await principalLabel(ctx), verified: p.restored_verified === true });
      const { registered_by: _stampedBy, origin: _stampedOrigin, ...unstamped } = card;
      parseCardInput(unstamped);
    }
    const response = await writeCard(ctx, card, { expectedRevision: expected, stored: found.frontmatter });
    return { id, source_id: STORAGE_SOURCE_ID, status: card.status, write: response };
  },
  cliHints: { name: 'storage-update', positional: ['id'] },
};

export const storageManifestOperations: Operation[] = [storage_find, storage_get, storage_list, storage_register, storage_update];
