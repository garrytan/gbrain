/**
 * `gbrain storage adopt` (GST-1943): moves interim storage records onto the shelf. An interim record is a page of type
 * `stored-object` under a slug prefix (default `storage-manifest/`) in an ordinary source, written before the shelf
 * existed, holding its record as JSON in a fenced json block under a `## Record` heading (other sections, such as
 * `## Restore`, are not read; the finalize preview names them). Records use the draft schema: card fields, plus
 * free-text `restore.command` and other fields the card refuses. Trusted local CLI only; three steps, each
 * preview-first and bound to its plan_hash:
 *
 *   preview   (default) per page the mapped card and every refused field with its reason; writes nothing.
 *   apply     registers each card through registerCard (the storage_register path) with origin `adopt`, then tags the
 *             original `storage-manifest-adopted` through its source's page door. Deletes nothing. Refused fields must
 *             each be named with `--drop-field`; a credential-shaped value or an invalid record always refuses.
 *   finalize  soft-deletes the tagged originals through the page door (restorable for 72 h), only when every adopted
 *             card is on the shelf and matches its original's mapped card (a restore the card recorded since does not
 *             count as a difference). The preview names each original's other sections (a `## Restore`, notes), which
 *             the card does not carry, and flags an original longer than the 64 KiB it reads. The plan_hash binds each
 *             original's whole content (content_hash), checked again just before its delete, so an original edited
 *             after the preview refuses preview_changed.
 *
 * Idempotent: a card already on the shelf that matches is skipped, and so is an original already tagged. A card on
 * the shelf that differs is a conflict: reported, never overwritten, its original left untagged. The plan_hash covers
 * what the run ends with (mapped cards, refused fields, blocked pages, conflicts), not progress, so the apply
 * command a partial run prints still applies. The record is read from the page's bounded 64 KiB prefix.
 */
import { createHash } from 'node:crypto';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { registerCard } from '../ops/storage-manifest.ts';
import { boundedBodyPrefixSql } from '../page-window/bounded-lead.ts';
import { BOUNDED_PREFIX_BYTES } from '../page-window/document.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { acceptedPendingReceipt } from '../persistence/accepted-pending.ts';
import { ruleCoversSql } from '../access/folder-rules.ts';
import { hasReaders, normalizeReaders } from '../access/principals.ts';
import { canonicalJson } from '../remediation-step.ts';
import { readShelfCards } from './find.ts';
import { accessLabels, CARD_KEYS, cardContent, cardDigest, credentialShape, holdsCredential, isCommandKey, parseCardInput, STAMPED_KEYS, STORED_OBJECT_TYPE, type AccessLabels, type CardInput } from './schema.ts';
import { shelfWritable, STORAGE_SOURCE_ID } from './source.ts';

export const ADOPT_DEFAULT_PREFIX = 'storage-manifest/';
export const ADOPT_DEFAULT_SOURCE = 'default';
export const ADOPTED_TAG = 'storage-manifest-adopted';

export type RefusedReason = 'command_field' | 'stamped_field' | 'unknown_field';
export interface RefusedField { field: string; reason: RefusedReason }
export interface EntryProblem { code: 'storage_record_secret' | 'storage_record_invalid'; reason: string; message: string }
export type AdoptState = 'register' | 'retag' | 'adopted' | 'conflict' | 'blocked';
export interface AdoptEntry { slug: string; card_id: string | null; state: AdoptState; card: CardInput | null; labels: AccessLabels | null; refused: RefusedField[]; problem: EntryProblem | null }
export interface AdoptOptions { sourceId: string; prefix: string }
export interface AdoptPlan {
  action: 'adopt'; dry_run: true; source_id: string; prefix: string; shelf: 'exists' | 'creates';
  entries: AdoptEntry[]; counts: Record<AdoptState, number>; drop_fields: string[]; plan_hash: string; summary: string[]; apply?: string[];
}
export type SideEffects = 'none' | 'partial' | 'complete';
export interface StepFailure { item: string; code: string; message: string }
/** A write gbrain accepted that has not committed yet: poll its receipt; submitting it again is never needed. */
export interface PendingWrite { item: string; request_id: string; state: string; poll: string[] }

/** The pending write an error reports (an accepted, non-terminal receipt), or null for any other error. */
export function pendingWrite(item: string, error: unknown): PendingWrite | null {
  const receipt = acceptedPendingReceipt(error);
  return receipt ? { item, request_id: receipt.request_id, state: receipt.state, poll: ['gbrain', 'write-request', receipt.request_id] } : null;
}

/** What a run changed: an accepted pending write counts as a change, and as unfinished. */
export function sideEffects(wrote: boolean, unfinished: boolean): SideEffects {
  return !wrote ? 'none' : unfinished ? 'partial' : 'complete';
}
export interface AdoptApplyResult {
  action: 'adopt'; dry_run: false; source_id: string; prefix: string; plan_hash: string; side_effects: SideEffects;
  results: Array<{ slug: string; card_id: string | null; outcome: 'registered' | 'retagged' | 'skipped' | 'conflict' }>;
  conflicts: string[]; failure?: StepFailure; pending?: PendingWrite[]; rerun?: string[]; finalize?: string[];
}
export interface FinalizeEntry { slug: string; card_id: string | null; state: 'delete' | 'deleted' | 'unverified' | 'not_adopted'; other_sections?: string[]; unread_tail?: boolean; content?: string }
export interface FinalizePlan { action: 'finalize'; dry_run: true; source_id: string; prefix: string; entries: FinalizeEntry[]; plan_hash: string; summary: string[]; apply?: string[] }
export interface FinalizeApplyResult {
  action: 'finalize'; dry_run: false; source_id: string; prefix: string; plan_hash: string; side_effects: SideEffects;
  deleted: string[]; skipped: string[]; failure?: StepFailure; pending?: PendingWrite[]; rerun?: string[];
}

interface InterimAccess { folder_rule_ids?: string[] | null; folder_readers?: unknown; access_pending?: boolean; write_channel?: string | null }
interface InterimRow extends InterimAccess { slug: string; title: string; frontmatter: unknown; body: string | null; content_hash: string | null; long_body: boolean; tagged: boolean; deleted: boolean }

const INTERIM_COLUMNS = `p.slug, p.title, p.frontmatter, ${boundedBodyPrefixSql('p')} AS body, p.content_hash,
      coalesce(p.body_bytes, 0) > ${BOUNDED_PREFIX_BYTES} AS long_body, p.folder_rule_ids, p.write_origin->>'channel' AS write_channel,
      (SELECT jsonb_agg(r.readable_by) FROM access_rules r WHERE r.source_id || ':' || r.rule_id = ANY(p.folder_rule_ids)) AS folder_readers,
      EXISTS (SELECT 1 FROM access_pending_coverage pc WHERE pc.source_id = p.source_id AND ${ruleCoversSql('p.slug', 'pc.prefix')}) AS access_pending`;

/** What a finalize plan binds for one original: its title, frontmatter and whole content (content_hash), so any edit after the preview changes it. */
const originalDigest = (row: Pick<InterimRow, 'title' | 'frontmatter' | 'body' | 'content_hash'>) => sha256(JSON.stringify([row.title, row.frontmatter, row.content_hash ?? row.body]));

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const SECTION = /^##[ \t]+Record[ \t]*$/m;
const NEXT_SECTION = /^##[ \t]/m;
const JSON_FENCE = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/m;

/** The adopt command for these options (a preview; callers add the step flags). */
export function adoptArgv(opts: AdoptOptions): string[] {
  return ['gbrain', 'storage', 'adopt',
    ...(opts.sourceId !== ADOPT_DEFAULT_SOURCE ? ['--source', opts.sourceId] : []),
    ...(opts.prefix !== ADOPT_DEFAULT_PREFIX ? ['--from-prefix', opts.prefix] : [])];
}

function previewFix(opts: AdoptOptions, finalize = false) {
  return readFix('Prints the current plan and its plan_hash; changes nothing.', { argv: [...adoptArgv(opts), ...(finalize ? ['--finalize'] : []), '--json'] });
}

/** The `##` headings of a page other than `## Record`: text the card does not carry, which finalize deletes with the page. */
export function otherSections(body: string): string[] {
  return [...body.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((m) => m[1]!).filter((title) => title !== 'Record');
}

/** Whether the shelf card still matches the original it was adopted from, ignoring restores storage_update recorded since (and the `restored` status they set). */
function matchesAdopted(shelf: CardInput, original: CardInput): boolean {
  if (!shelf.restores?.length) return cardDigest(shelf) === cardDigest(original);
  const strip = ({ restores: _restores, status, ...rest }: CardInput) => cardDigest((shelf.status === 'restored' ? rest : { ...rest, status }) as CardInput);
  return strip(shelf) === strip(original);
}

/** The JSON text of a page's `## Record` section, or null when the page has none in its first 64 KiB. */
export function recordJson(body: string): string | null {
  const heading = SECTION.exec(body);
  if (!heading) return null;
  const rest = body.slice(heading.index + heading[0].length);
  const next = NEXT_SECTION.exec(rest);
  const fence = JSON_FENCE.exec(next ? rest.slice(0, next.index) : rest);
  return fence ? fence[1]! : null;
}

function keysAt(path: string): ReadonlySet<string> | null {
  return CARD_KEYS[path.replace(/\.\d+(?=\.|$)/g, '.*')] ?? null;
}

/** The record with every field the card refuses taken out; each one is pushed to `refused` with its reason. */
function strip(value: unknown, path: string, refused: RefusedField[]): unknown {
  if (Array.isArray(value)) return value.map((item, i) => strip(item, `${path}.${i}`, refused));
  if (!value || typeof value !== 'object') return value;
  const allowed = keysAt(path);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    const reason: RefusedReason | null = isCommandKey(key) ? 'command_field'
      : !path && (STAMPED_KEYS as readonly string[]).includes(key) ? 'stamped_field'
      : allowed && !allowed.has(key) ? 'unknown_field' : null;
    if (reason) refused.push({ field: at, reason });
    else out[key] = strip(item, at, refused);
  }
  return out;
}

/** The first string value or object key with a credential shape, by dotted path; the value or key itself is never returned. */
function credentialAt(value: unknown, path: string): { field: string; shape: string } | null {
  if (typeof value === 'string') { const shape = credentialShape(value); return shape ? { field: path || '(record)', shape } : null; }
  if (!value || typeof value !== 'object') return null;
  const items: Array<readonly [string, unknown]> = Array.isArray(value) ? value.map((item, i) => [String(i), item] as const) : Object.entries(value);
  for (const [key, item] of items) {
    const keyShape = Array.isArray(value) ? null : credentialShape(key);
    if (keyShape) return { field: `${path || '(record)'} (a key)`, shape: keyShape };
    if (!Array.isArray(value) && holdsCredential(key, item)) return { field: path ? `${path}.${key}` : key, shape: 'credential_key' };
    const found = credentialAt(item, path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
}

function invalidRecord(reason: string, message: string): EntryProblem {
  return { code: 'storage_record_invalid', reason, message };
}

const sameLabels = (a: AccessLabels | null | undefined, b: AccessLabels | null | undefined) => !!a && !!b && canonicalJson(a) === canonicalJson(b);

/**
 * The access labels the card takes so it is read no wider than its original: the original's own labels, with
 * readable_by narrowed to the readers that it and every folder rule over the original all list. Readers match literally
 * (a member is not matched to its groups), which can only narrow. A problem instead when they share no reader, or a rule
 * over the original is still being applied.
 */
function originalLabels(row: InterimAccess, frontmatter: Record<string, unknown>): { labels: AccessLabels; problem: null } | { labels: null; problem: EntryProblem } {
  const labels = accessLabels(frontmatter);
  const raw = typeof row.folder_readers === 'string' ? JSON.parse(row.folder_readers) as unknown : row.folder_readers;
  const rules = Array.isArray(raw) ? raw as string[][] : [];
  if (row.access_pending || rules.length !== (row.folder_rule_ids?.length ?? 0)) {
    return { labels: null, problem: invalidRecord('access_pending', 'an access rule over the page is still being applied, so who may read it is not settled (gbrain access status names the rule)') };
  }
  if (!rules.length) return { labels, problem: null };
  const lists = [...(hasReaders(frontmatter) ? [normalizeReaders(frontmatter)!] : []), ...rules];
  const readers = lists.reduce((common, list) => common.filter((reader) => list.includes(reader)));
  if (!readers.length) return { labels: null, problem: invalidRecord('access_unpreservable', 'its readable_by and the folder rules over it name no reader in common, so a card cannot carry the same restriction') };
  return { labels: { ...labels, readable_by: [...new Set(readers)].sort() }, problem: null };
}

/** Map one interim page onto a card. Pure: reads nothing beyond the row. */
export function mapInterimPage(row: Pick<InterimRow, 'slug' | 'title' | 'frontmatter' | 'body'> & InterimAccess, prefix: string): Pick<AdoptEntry, 'card' | 'labels' | 'refused' | 'problem'> {
  if (row.write_channel?.startsWith('mcp:')) return { card: null, labels: null, refused: [], problem: invalidRecord('remote_written', `the page was last written by a remote client (${row.write_channel}); adopt takes only records written on this machine or by sync`) };
  const text = recordJson(row.body ?? '');
  if (text === null) return { card: null, labels: null, refused: [], problem: invalidRecord('no_record', 'the page has no json block under a ## Record heading in its first 64 KiB') };
  let record: unknown;
  try { record = JSON.parse(text); } catch { return { card: null, labels: null, refused: [], problem: invalidRecord('not_json', 'the ## Record block is not valid JSON') }; }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { card: null, labels: null, refused: [], problem: invalidRecord('not_object', 'the ## Record block is not a JSON object') };
  const refused: RefusedField[] = [];
  const stripped = strip(record, '', refused) as Record<string, unknown>;
  const secret = credentialAt(record, '');
  if (secret) return { card: null, labels: null, refused: [], problem: { code: 'storage_record_secret', reason: secret.shape, message: `field ${secret.field} has a credential shape (${secret.shape}); the value is not shown` } };
  const frontmatter = (typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter ?? {}) as Record<string, unknown>;
  const aliases = Array.isArray(frontmatter.aliases) ? frontmatter.aliases.filter((a): a is string => typeof a === 'string') : [];
  const mapped = { ...stripped, id: stripped.id ?? row.slug.slice(prefix.length).replace(/\//g, '-'), title: stripped.title ?? row.title, aliases: stripped.aliases ?? aliases };
  let card: CardInput;
  try {
    card = parseCardInput(mapped);
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    return { card: null, labels: null, refused, problem: { code: error.code === 'storage_record_secret' ? 'storage_record_secret' : 'storage_record_invalid',
      reason: error.reason ?? 'schema', message: error.message.replace(/; nothing was written\.$/, '') } };
  }
  const access = originalLabels(row, frontmatter);
  return access.problem ? { card: null, labels: null, refused, problem: access.problem } : { card, labels: access.labels, refused, problem: null };
}

async function listInterim(ctx: OperationContext, opts: AdoptOptions, includeDeleted: boolean): Promise<InterimRow[]> {
  return ctx.engine.executeRaw<InterimRow>(`
    SELECT ${INTERIM_COLUMNS}, p.deleted_at IS NOT NULL AS deleted,
      EXISTS (SELECT 1 FROM tags t WHERE t.page_id = p.id AND t.tag = $4) AS tagged
    FROM pages p
    WHERE p.source_id = $1 AND p.type = $2 AND left(p.slug, length($3)) = $3 AND p.slug <> $3 || 'index'${includeDeleted ? '' : ' AND p.deleted_at IS NULL'}
    ORDER BY p.slug`, [opts.sourceId, STORED_OBJECT_TYPE, opts.prefix, ADOPTED_TAG]);
}

async function assertInterimSource(ctx: OperationContext, opts: AdoptOptions): Promise<void> {
  if (opts.sourceId === STORAGE_SOURCE_ID) throw opError('invalid_params', `Source ${STORAGE_SOURCE_ID} is the storage shelf itself; adopt reads interim records from another source.`,
    'Pass --source with the source that holds the interim pages (the default is default); nothing was changed.');
  const rows = await ctx.engine.executeRaw('SELECT 1 FROM sources WHERE id = $1 AND archived IS NOT TRUE', [opts.sourceId]);
  if (!rows.length) throw opError('invalid_params', `No active source ${opts.sourceId}; nothing was changed.`,
    'Pass --source with an id gbrain sources list shows.', { fix: readFix('Lists the sources of this brain.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
}

/** Preview: what apply would do. Writes nothing; refuses storage_manifest_missing on a brain with a Git checkout until storage init has run. */
export async function previewAdopt(ctx: OperationContext, opts: AdoptOptions): Promise<AdoptPlan> {
  await assertInterimSource(ctx, opts);
  const { creates, exists } = await shelfWritable(ctx.engine);
  const shelf = new Map((await readShelfCards(ctx.engine)).map((row) => [row.id, row]));
  const seen = new Set<string>();
  const entries: AdoptEntry[] = (await listInterim(ctx, opts, false)).map((row): AdoptEntry => {
    const mapped = mapInterimPage(row, opts.prefix);
    const card_id = mapped.card?.id ?? null;
    if (card_id && seen.has(card_id)) return { slug: row.slug, card_id, state: 'blocked', card: null, labels: null, refused: mapped.refused, problem: invalidRecord('duplicate_id', `another interim page maps to card id ${card_id}`) };
    if (card_id) seen.add(card_id);
    if (!mapped.card) return { slug: row.slug, card_id, state: 'blocked', ...mapped };
    const onShelf = shelf.get(mapped.card.id);
    const existing = onShelf?.card ? cardContent(onShelf.card) : null;
    const state: AdoptState = !onShelf ? 'register'
      : !existing || cardDigest(existing) !== cardDigest(mapped.card) || !sameLabels(onShelf.labels, mapped.labels) ? 'conflict' : row.tagged ? 'adopted' : 'retag';
    return { slug: row.slug, card_id, state, ...mapped };
  });
  const counts: Record<AdoptState, number> = { register: 0, retag: 0, adopted: 0, conflict: 0, blocked: 0 };
  for (const entry of entries) counts[entry.state]++;
  const drop_fields = [...new Set(entries.filter((e) => e.state !== 'blocked').flatMap((e) => e.refused.map((f) => f.field)))].sort();
  const plan_hash = sha256(JSON.stringify({ v: 1, kind: 'adopt', source_id: opts.sourceId, prefix: opts.prefix, entries: entries.map((e) => ({
    slug: e.slug, card: e.card ? cardDigest(e.card) : null, labels: e.labels ? canonicalJson(e.labels) : null, refused: e.refused.map((f) => `${f.field}:${f.reason}`),
    problem: e.problem ? `${e.problem.code}:${e.problem.reason}` : null, conflict: e.state === 'conflict' })) }));
  const summary = [`${entries.length} interim record(s) under ${opts.prefix} in source ${opts.sourceId}: ${counts.register} to register, ${counts.retag} already on the shelf to tag, ${counts.adopted} already adopted, ${counts.conflict} conflict(s), ${counts.blocked} blocked.`];
  if (creates && counts.register) summary.push(exists ? `The first card finishes the storage shelf (source ${STORAGE_SOURCE_ID}) that an earlier creation left without its role.`
    : `The first card creates the storage shelf (source ${STORAGE_SOURCE_ID}, database-only: this brain has no Git checkout, so the database is the record).`);
  const restricted = entries.filter((e) => e.state === 'register' && e.labels && Object.keys(e.labels).length).length;
  if (restricted) summary.push(`${restricted} card(s) take their original's access labels (visibility, readable_by, and the readers of the folder rules over it), so each is read no wider than its original.`);
  if (drop_fields.length) summary.push(`Fields a card refuses, left out only when each is named with --drop-field: ${drop_fields.join(', ')}. The original pages keep them until finalize.`);
  if (counts.conflict) summary.push('A conflict is a card already on the shelf that differs from the record or from the access labels its original needs: it is never overwritten, and its original is not tagged.');
  if (counts.blocked) summary.push('Blocked pages need their record fixed on the page first; apply refuses until then.');
  const apply = counts.blocked || !(counts.register + counts.retag) ? undefined
    : [...adoptArgv(opts), ...drop_fields.flatMap((f) => ['--drop-field', f]), '--apply', '--expect', plan_hash];
  return { action: 'adopt', dry_run: true, source_id: opts.sourceId, prefix: opts.prefix, shelf: creates && !exists ? 'creates' : 'exists', entries, counts, drop_fields, plan_hash, summary, ...(apply ? { apply } : {}) };
}

function staleHash(opts: AdoptOptions, expected: string, finalize: boolean): OperationError {
  return opError('preview_changed', `The ${finalize ? 'finalize' : 'adopt'} plan for ${opts.prefix} in source ${opts.sourceId} changed since its preview (approved plan ${expected}); nothing was changed.`,
    'Preview again, show the user the new plan, and apply the plan_hash it prints only if they approve it.', { fix: previewFix(opts, finalize) });
}

function blockedRefusal(opts: AdoptOptions, blocked: AdoptEntry[]): OperationError {
  const first = blocked.find((e) => e.problem?.code === 'storage_record_secret') ?? blocked[0]!;
  const list = blocked.slice(0, 5).map((e) => `${e.slug} (${e.problem!.message})`).join('; ');
  return opError(first.problem!.code, `${blocked.length} interim record(s) cannot become cards: ${list}${blocked.length > 5 ? '; and more' : ''}. Nothing was written.`,
    first.problem!.code === 'storage_record_secret'
      ? 'Remove the credential from the record on each named page (the restore skill reads credentials from its own environment); a field refused only for its name (credential_key) that holds no credential can instead be renamed to end in _id, _ref or another suffix the rule passes. Then preview the adopt again.'
      : first.problem!.reason === 'remote_written'
        ? 'Adopt never registers a record a remote client wrote. Check each named page yourself and register the item with gbrain storage-register, or leave it as it is.'
        : 'Fix the record on each named page so it is a complete card, then preview the adopt again.',
    { reason: first.problem!.reason, fix: previewFix(opts) });
}

/** Apply the previewed plan. Never deletes; a failure stops the run and reports side_effects and the rerun command. */
export async function applyAdopt(ctx: OperationContext, opts: AdoptOptions & { expect: string; dropFields: string[] }): Promise<AdoptApplyResult> {
  const plan = await previewAdopt(ctx, opts);
  if (opts.expect !== plan.plan_hash) throw staleHash(opts, opts.expect, false);
  const blocked = plan.entries.filter((e) => e.state === 'blocked');
  if (blocked.length) throw blockedRefusal(opts, blocked);
  const extra = opts.dropFields.filter((f) => !plan.drop_fields.includes(f));
  if (extra.length) throw opError('invalid_params', `--drop-field names a field no interim record has refused: ${extra.join(', ')}; nothing was written.`,
    `Name only the refused fields the preview lists (${plan.drop_fields.join(', ') || 'none'}).`, { fix: previewFix(opts) });
  const rerun = [...adoptArgv(opts), ...plan.drop_fields.flatMap((f) => ['--drop-field', f]), '--apply', '--expect', plan.plan_hash];
  const missing = plan.drop_fields.filter((f) => !opts.dropFields.includes(f));
  if (missing.length) {
    throw opError('storage_adopt_field_refused', `Interim records carry fields a card refuses: ${missing.join(', ')}; nothing was written.`,
      'Show the user each refused field and its reason from the preview; with their agreement, apply again naming each one with --drop-field.',
      { fix: { ask_user: true, argv: rerun, consent: [], actor: 'agent', requires_exclusive: false, plan_hash: plan.plan_hash,
        why: 'Registers the cards without the refused fields, which stay on the original pages until finalize.',
        user_message: `These fields of the interim storage records cannot go on a card and would be left out: ${missing.join(', ')}. The original pages keep them until you finalize. Leave them out?` } });
  }
  const results: AdoptApplyResult['results'] = [];
  const pending: PendingWrite[] = [];
  let failure: StepFailure | undefined;
  for (const entry of plan.entries) {
    if (entry.state === 'conflict' || entry.state === 'adopted') { results.push({ slug: entry.slug, card_id: entry.card_id, outcome: entry.state === 'conflict' ? 'conflict' : 'skipped' }); continue; }
    try {
      if (entry.state === 'register') {
        await registerCard(ctx, entry.card!, 'adopt', undefined, entry.labels!);
        results.push({ slug: entry.slug, card_id: entry.card_id, outcome: 'registered' });
      }
      await submitPageMutation(ctx, { operation: 'add_tag', params: { slug: entry.slug, tag: ADOPTED_TAG, source_id: opts.sourceId } });
      results.push({ slug: entry.slug, card_id: entry.card_id, outcome: 'retagged' });
    } catch (error) {
      const held = pendingWrite(entry.slug, error);
      if (held) { pending.push(held); continue; }
      if (!(error instanceof OperationError)) throw error;
      failure = { item: entry.slug, code: error.canonical ?? error.code, message: error.message };
      break;
    }
  }
  const wrote = pending.length > 0 || results.some((r) => r.outcome === 'registered' || r.outcome === 'retagged');
  return { action: 'adopt', dry_run: false, source_id: opts.sourceId, prefix: opts.prefix, plan_hash: plan.plan_hash,
    side_effects: sideEffects(wrote, !!failure || pending.length > 0), results,
    conflicts: results.filter((r) => r.outcome === 'conflict').map((r) => r.slug),
    ...(failure ? { failure } : {}), ...(pending.length ? { pending } : {}),
    ...(failure || pending.length ? { rerun } : { finalize: [...adoptArgv(opts), '--finalize'] }) };
}

/** Preview finalize: the tagged originals to soft-delete. Writes nothing. */
export async function previewFinalize(ctx: OperationContext, opts: AdoptOptions): Promise<FinalizePlan> {
  await assertInterimSource(ctx, opts);
  const shelf = new Map((await readShelfCards(ctx.engine)).map((row) => [row.id, row]));
  const entries: FinalizeEntry[] = (await listInterim(ctx, opts, true)).flatMap((row): FinalizeEntry[] => {
    if (!row.tagged) return row.deleted ? [] : [{ slug: row.slug, card_id: null, state: 'not_adopted' }];
    const { card, labels } = mapInterimPage(row, opts.prefix);
    const content = originalDigest(row);
    if (row.deleted) return [{ slug: row.slug, card_id: card?.id ?? null, state: 'deleted', content }];
    const onShelf = card ? shelf.get(card.id) : undefined;
    const existing = onShelf?.card ? cardContent(onShelf.card) : null;
    const state = card && existing && matchesAdopted(existing, card) && sameLabels(onShelf!.labels, labels) ? 'delete' : 'unverified';
    const other = otherSections(row.body ?? '');
    return [{ slug: row.slug, card_id: card?.id ?? null, state, ...(other.length ? { other_sections: other } : {}), ...(row.long_body || (row.body?.length ?? 0) >= BOUNDED_PREFIX_BYTES ? { unread_tail: true } : {}), content }];
  });
  const count = (state: FinalizeEntry['state']) => entries.filter((e) => e.state === state).length;
  const plan_hash = sha256(JSON.stringify({ v: 1, kind: 'finalize', source_id: opts.sourceId, prefix: opts.prefix,
    entries: entries.filter((e) => e.state !== 'not_adopted').map((e) => ({ slug: e.slug, card_id: e.card_id, unverified: e.state === 'unverified', content: e.content })) }));
  const summary = [`${count('delete')} adopted original(s) to soft-delete (restorable for 72 hours), ${count('deleted')} already deleted, ${count('unverified')} whose card is missing or differs (in content or access labels), ${count('not_adopted')} not adopted yet (kept).`];
  const dropping = entries.filter((e) => e.state === 'delete' && e.other_sections);
  if (dropping.length) summary.push(`${dropping.length} original(s) to delete hold sections the card does not carry (${[...new Set(dropping.flatMap((e) => e.other_sections!))].join(', ')}): show the user, and move what matters into the card with gbrain storage-update before finalizing.`);
  const long = entries.filter((e) => e.state === 'delete' && e.unread_tail).map((e) => e.slug);
  if (long.length) summary.push(`${long.length} original(s) to delete are longer than 64 KiB, so sections past that point were not read (${long.slice(0, 5).join(', ')}): read each with gbrain get before finalizing.`);
  if (count('unverified')) summary.push('Finalize refuses while an adopted original has no matching card; compare it with gbrain storage-get and fix the card or the record first.');
  const apply = count('unverified') || !count('delete') ? undefined : [...adoptArgv(opts), '--finalize', '--expect', plan_hash];
  return { action: 'finalize', dry_run: true, source_id: opts.sourceId, prefix: opts.prefix, entries, plan_hash, summary, ...(apply ? { apply } : {}) };
}

/** Soft-delete the adopted originals the preview listed, each only while its content is still what the plan bound (deleted at the revision that matched). */
export async function applyFinalize(ctx: OperationContext, opts: AdoptOptions & { expect: string }): Promise<FinalizeApplyResult> {
  const plan = await previewFinalize(ctx, opts);
  if (opts.expect !== plan.plan_hash) throw staleHash(opts, opts.expect, true);
  const unverified = plan.entries.filter((e) => e.state === 'unverified');
  if (unverified.length) {
    throw opError('storage_adopt_unverified', `${unverified.length} adopted original(s) have no matching card on the storage shelf: ${unverified.slice(0, 5).map((e) => e.slug).join(', ')}; nothing was deleted.`,
      'Compare each original with its card (gbrain storage-get with the card id the finalize preview lists), fix the card or the record, then preview finalize again.', { fix: previewFix(opts, true) });
  }
  const deleted: string[] = [];
  const pending: PendingWrite[] = [];
  let failure: StepFailure | undefined;
  for (const entry of plan.entries.filter((e) => e.state === 'delete')) {
    try {
      const [row] = await ctx.engine.executeRaw<InterimRow & { revision: string | number | null }>(
        `SELECT ${INTERIM_COLUMNS}, p.knowledge_revision AS revision FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL`, [opts.sourceId, entry.slug]);
      if (!row) continue;
      if (originalDigest(row) !== entry.content) throw opError('preview_changed', `${entry.slug} changed after the finalize preview; it was not deleted.`, 'Preview finalize again and show the user what changed.', { fix: previewFix(opts, true) });
      const expected = row.revision == null ? (await ctx.engine.readPageSnapshot(entry.slug, { sourceId: opts.sourceId }))?.revision : String(row.revision);
      await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: entry.slug, source_id: opts.sourceId, ...(expected ? { expected_revision: expected } : {}) } });
      deleted.push(entry.slug);
    } catch (error) {
      const held = pendingWrite(entry.slug, error);
      if (held) { pending.push(held); continue; }
      if (!(error instanceof OperationError)) throw error;
      failure = { item: entry.slug, code: error.canonical ?? error.code, message: error.message };
      break;
    }
  }
  return { action: 'finalize', dry_run: false, source_id: opts.sourceId, prefix: opts.prefix, plan_hash: plan.plan_hash,
    side_effects: sideEffects(deleted.length > 0 || pending.length > 0, !!failure || pending.length > 0), deleted,
    skipped: plan.entries.filter((e) => e.state !== 'delete').map((e) => e.slug),
    ...(pending.length ? { pending } : {}),
    ...(failure ? { failure, rerun: failure.code === 'preview_changed' ? previewFix(opts, true).argv! : [...adoptArgv(opts), '--finalize', '--expect', plan.plan_hash] } : {}) };
}
