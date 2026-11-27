/**
 * Guest notes, slice 2 (GBRA-504): write admission for a guest source.
 *
 * A guest source (guests/sources.ts) takes page writes only from a principal on its writer list, only as a new page
 * through put_page, and only with the guest attribution the broker sends beside the call: the X-Gbrain-Guest header
 * (URL-encoded form, `sender_label=<label>&group=<group-slug>`) or request-level `_meta.guest`
 * (`{ sender_label, group }`). The attribution joins the stored write intent as `guest_note`, so a
 * replay with different attribution is idempotency_conflict, and publication turns it into the page's guest_marks row.
 * The page's frontmatter keeps to an allowlist, names the sender and group the attribution names, and is readable
 * by exactly the brain owner plus the call's one audience principal. Every refusal here writes nothing; the database
 * trigger (trust/schema.ts GUEST_GUARD) is the backstop for any path that bypasses this module.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { parseMarkdownHead } from '../markdown.ts';
import { normalizeReaders } from '../access/principals.ts';
import { ownerMemberId } from '../access/owner.ts';
import type { Principal } from '../persistence/model.ts';
import type { GuestSource } from './sources.ts';
import { GUEST_SOURCES_HIDDEN_SQL, type GuestAttribution } from './note.ts';
import { schemaAdmissionRefusal } from '../persistence/schema-admission.ts';
import { isMissingSchemaObject } from '../utils.ts';

export { GUEST_NOTE_INTENT_KEY, type GuestAttribution } from './note.ts';

export const GUEST_HEADER = 'X-Gbrain-Guest';
/** The only frontmatter keys a guest page may carry. */
export const GUEST_FRONTMATTER_KEYS: readonly string[] = ['type', 'title', 'readable_by', 'guest_group', 'guest_sender', 'saved_at'];
const DOCS = (code: string) => `docs/guides/write-refusals.md#${code}`;

/** The attribution channels a transport saw: the header and request-level _meta (its `guest` key). */
export interface GuestChannels { header?: string | null; requestMeta?: unknown }

const LABEL_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}·[\]<>"]/u;
const GROUP_RE = /^[a-z0-9-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function guestAttributionMissing(why: string): OperationError {
  return new OperationError('guest_attribution_missing', `A write to a guest source needs guest attribution: ${why}. Nothing was written.`,
    'Send the sender label and group slug beside the call, as request-level _meta.guest {"sender_label": "...", "group": "..."} or the X-Gbrain-Guest header (sender_label=<url-encoded label>&group=<group-slug>). A label is 1 to 64 characters with no control or format characters and none of · [ ] < > ".',
    DOCS('guest_attribution_missing'));
}

function checked(value: unknown, channel: string): GuestAttribution {
  if (!isObj(value)) throw guestAttributionMissing(`${channel} is not an object with sender_label and group`);
  const { sender_label: label, group } = value;
  if (typeof label !== 'string' || [...label].length < 1 || [...label].length > 64 || LABEL_FORBIDDEN.test(label) || label.trim() !== label) {
    throw guestAttributionMissing(`${channel} sender_label is missing or not an allowed label`);
  }
  if (typeof group !== 'string' || !GROUP_RE.test(group)) throw guestAttributionMissing(`${channel} group is missing or not a group slug`);
  return { sender_label: label, group };
}

/** The attribution a call carries, or null when it carries none; malformed or disagreeing channels refuse. */
export function parseGuestAttribution(channels: GuestChannels | undefined): GuestAttribution | null {
  const header = typeof channels?.header === 'string' && channels.header.trim() !== '' ? channels.header : null;
  const meta = isObj(channels?.requestMeta) && Object.hasOwn(channels.requestMeta, 'guest') ? channels.requestMeta.guest : undefined;
  let fromHeader: GuestAttribution | null = null;
  if (header !== null) {
    const form = new URLSearchParams(header);
    fromHeader = checked({ sender_label: form.get('sender_label'), group: form.get('group') }, 'the ' + GUEST_HEADER + ' header');
  }
  const fromMeta = meta === undefined ? null : checked(meta, '_meta.guest');
  if (fromHeader && fromMeta && (fromHeader.sender_label !== fromMeta.sender_label || fromHeader.group !== fromMeta.group)) {
    throw guestAttributionMissing('the ' + GUEST_HEADER + ' header and _meta.guest name different senders or groups');
  }
  return fromMeta ?? fromHeader;
}

/** A lookup of guest_sources by a role that row-level security keeps from reading it (GUEST_SOURCES_HIDDEN_SQL). */
export function guestSourcesUnreadable(sourceId: string): OperationError {
  return new OperationError('writer_coordinator_required',
    `writer_coordinator_required: writer state is unreadable to this database role: row-level security hides guest_sources, so gbrain cannot tell whether source ${sourceId} is a guest source. Nothing was written.`,
    'Run gbrain as a database role that can read guest_sources (the table owner, a role that bypasses row-level security, or a scoped write role holding the guest_sources SELECT policy in docs/ENGINES.md#derived-state-maintainers), then retry with a new request ID.',
    'docs/guides/write-refusals.md#writer-coordinator-required');
}

/**
 * A guest-table read that failed: on a brain whose schema is behind the guest-notes migration (no guest_sources table)
 * the write is refused migrations_pending (schema-admission.ts), as admission refuses any write on a schema behind this
 * build, instead of failing with the raw missing-table error. Any other error is rethrown.
 */
export async function schemaBehindGuests(exec: Pick<BrainEngine, 'executeRaw' | 'ownsSchemaTables'>, error: unknown): Promise<never> {
  if (isMissingSchemaObject(error, 'table', 'guest_sources')) {
    const refusal = await schemaAdmissionRefusal(exec as BrainEngine);
    if (refusal) throw refusal;
  }
  throw error;
}

/**
 * The guest_sources row of `sourceId`, or null when it is not a guest source. One statement; refuses
 * (guestSourcesUnreadable) when row-level security hides guest_sources from the role instead of answering null.
 */
export async function lookupGuestSource(exec: Pick<BrainEngine, 'executeRaw' | 'readGuestSourceRow' | 'ownsSchemaTables'>, sourceId: string): Promise<GuestSource | null> {
  const row = await exec.readGuestSourceRow(sourceId).catch(e => schemaBehindGuests(exec, e));
  if (row.hidden) throw guestSourcesUnreadable(sourceId);
  return row.source_id ? { source_id: row.source_id, writers: row.writers!, trust_ceiling: row.trust_ceiling! } : null;
}

export function sourceWriterRestricted(sourceId: string): OperationError {
  return new OperationError('source_writer_restricted', `Source ${sourceId} is a guest source: only its listed writers create pages there, and nothing else writes to it. Nothing was written.`,
    "Do not retry. Write to another source, or ask the brain owner whether this content belongs in the guest source; changing who may write there is the owner's decision.",
    DOCS('source_writer_restricted'));
}

export function guestPageImmutable(what: string): OperationError {
  return new OperationError('guest_page_immutable', `${what}: a guest page is saved once, as a new page, and never changed. Nothing was written.`,
    'Save the note again under a new slug with put_page, or ask the brain owner to promote the page (gbrain guests promote) and edit the owner page.',
    DOCS('guest_page_immutable'));
}

export function guestPagePromoted(slug: string): OperationError {
  return new OperationError('guest_page_promoted', `The brain owner kept guest note ${slug} as an owner page, so it is not deleted remotely. Nothing was deleted.`,
    'Do not retry. Treat the note as kept; only the brain owner removes it, on the brain host.', DOCS('guest_page_promoted'));
}

export function guestNoteNotYours(slug: string): OperationError {
  return new OperationError('permission_denied', `Guest note ${slug} was saved by another writer, so this credential cannot delete it. Nothing was deleted.`,
    'Delete only the guest notes this credential saved; the brain owner deletes any guest note on the brain host (gbrain delete).', 'docs/guides/guest-notes.md#save-a-guest-note-for-the-writer');
}

/**
 * A remote delete of a page in a guest source: refused when the owner promoted it (guest_promotions) and when its guest
 * mark names another writer than `principal` (a writer deletes only what it saved). Checked at submission and in publication.
 */
export async function refuseRemoteGuestDelete(exec: Pick<BrainEngine, 'executeRaw' | 'ownsSchemaTables'>, sourceId: string, slug: string, principal: Principal): Promise<void> {
  const [page] = await exec.executeRaw<{ hidden: boolean; guest: boolean; kept: boolean; writer: string | null }>(
    `SELECT ${GUEST_SOURCES_HIDDEN_SQL} AS hidden, EXISTS (SELECT 1 FROM guest_sources g WHERE g.source_id = p.source_id) AS guest, EXISTS (SELECT 1 FROM guest_promotions g WHERE g.guest_page_id = p.id) AS kept,
       (SELECT m.writer_kind || ':' || m.writer_id FROM guest_marks m WHERE m.page_id = p.id) AS writer FROM pages p WHERE p.source_id = $1 AND p.slug = $2 LIMIT 1`, [sourceId, slug])
    .catch(e => schemaBehindGuests(exec, e));
  if (page?.hidden) throw guestSourcesUnreadable(sourceId);
  if (!page?.guest && !page?.kept) return;
  if (page.kept) throw guestPagePromoted(slug);
  if (page.writer !== principalKey(principal)) throw guestNoteNotYours(slug);
}

const principalKey = (principal: Principal) => `${principal.kind}:${principal.id}`;
export const isListedWriter = (guest: Pick<GuestSource, 'writers'>, principal: Principal) => guest.writers.includes(principalKey(principal));

/**
 * The first gate on a guest source, before any page is read: who may submit which operation. A principal not on the
 * writer list may only delete or restore, and only from the trusted local CLI (the owner); a listed writer may delete,
 * or create through a plain single put_page. Returns the attribution a listed writer's put_page carries.
 */
export function admitGuestOperation(guest: GuestSource, input: { principal: Principal; operation: string; remote: boolean;
  plainPut: boolean; params: Record<string, unknown>; channels: GuestChannels | undefined }): GuestAttribution | null {
  const { principal, operation } = input;
  if (!isListedWriter(guest, principal)) {
    if (!input.remote && (operation === 'delete_page' || operation === 'restore_page')) return null;
    throw sourceWriterRestricted(guest.source_id);
  }
  if (operation === 'delete_page') return null;
  if (operation !== 'put_page') throw guestPageImmutable(`${operation} on a guest source`);
  if (!input.plainPut) throw guestPageImmutable('A batch, staged-upload or imported page write on a guest source');
  if (input.params.force === true || input.params.expected_revision !== undefined) throw guestPageImmutable('force or expected_revision on a guest page');
  const note = parseGuestAttribution(input.channels);
  if (!note) throw guestAttributionMissing('the call carries neither _meta.guest nor the ' + GUEST_HEADER + ' header');
  return note;
}

/** Refuses any write other than a page through admitGuestOperation (remember, links, import) on a guest source. */
export async function refuseGuestSourceWrite(engine: Pick<BrainEngine, 'executeRaw' | 'readGuestSourceRow' | 'ownsSchemaTables'>, sourceId: string, principalOf: () => Promise<Principal>, operation: string): Promise<void> {
  const guest = await lookupGuestSource(engine, sourceId);
  if (!guest) return;
  if (isListedWriter(guest, await principalOf())) throw guestPageImmutable(`${operation} on a guest source`);
  throw sourceWriterRestricted(sourceId);
}

export function guestFrontmatterRefused(why: string): OperationError {
  return new OperationError('guest_frontmatter_refused', `A guest page's frontmatter ${why}. Nothing was written.`,
    `Send only ${GUEST_FRONTMATTER_KEYS.join(', ')} in the frontmatter, with guest_sender and guest_group equal to the attribution's sender_label and group.`,
    DOCS('guest_frontmatter_refused'));
}

export function guestReadersInvalid(why: string): OperationError {
  return new OperationError('guest_readers_invalid', `A guest page's readable_by ${why}. Nothing was written.`,
    'Set readable_by to exactly the brain owner and the one member or group the call speaks for (X-Gbrain-On-Behalf-Of), for example [alice-example, group:team-a].',
    DOCS('guest_readers_invalid'));
}

/** The frontmatter allowlist and the sender and group match, read from the raw frontmatter keys. */
export function assertGuestFrontmatter(content: unknown, note: GuestAttribution): Record<string, unknown> {
  if (typeof content !== 'string') throw guestFrontmatterRefused('is missing (send the page as content)');
  const frontmatter = parseMarkdownHead(content).frontmatter;
  const extra = Object.keys(frontmatter).filter(key => !GUEST_FRONTMATTER_KEYS.includes(key));
  if (extra.length) throw guestFrontmatterRefused(`carries keys outside the allowlist (${extra.slice(0, 5).join(', ')})`);
  if (frontmatter.guest_sender !== note.sender_label) throw guestFrontmatterRefused("has a guest_sender that is not the attribution's sender_label");
  if (frontmatter.guest_group !== note.group) throw guestFrontmatterRefused("has a guest_group that is not the attribution's group");
  return frontmatter;
}

/** Readers are exactly {owner, the single audience principal}; checked at submission and again at preparation. */
export async function assertGuestReaders(engine: Pick<BrainEngine, 'getConfig'>, frontmatter: Record<string, unknown>, audience: readonly string[] | null | undefined): Promise<string> {
  if (!audience || audience.length !== 1 || audience[0] === 'guest') throw guestReadersInvalid('needs a call that speaks for exactly one member or group');
  const owner = await ownerMemberId(engine);
  if (!owner) throw guestReadersInvalid('cannot be checked: this brain has no owner set (gbrain access owner set)');
  const readers = normalizeReaders(frontmatter);
  const want = new Set([`member:${owner}`, audience[0]!]);
  if (!readers || readers.length !== want.size || !readers.every(r => want.has(r))) throw guestReadersInvalid('is not exactly the brain owner and the audience the call speaks for');
  return audience[0]!;
}

/**
 * Publication's recheck: the source is still a guest source and the request's principal is still a listed writer. The
 * same statement sets gbrain.guest_note to the request's id (the gbrain.write_request it publishes as), which the guest-source trigger (trust/schema.ts GUEST_GUARD)
 * requires of a listed writer's page write; any other write to a guest source, such as one admitted before its source
 * became a guest source, is refused there (source_writer_restricted or guest_attribution_missing) with no read here.
 */
export async function assertGuestWriterAtPublication(tx: Pick<BrainEngine, 'claimGuestNotePublication'>, row: { source_id: string; principal_kind: string; principal_id: string; id: string }): Promise<void> {
  const guest = await tx.claimGuestNotePublication(row.source_id, row.id);
  if (!guest || !guest.writers.includes(`${row.principal_kind}:${row.principal_id}`)) throw sourceWriterRestricted(row.source_id);
}

/**
 * The guest mark, written in the publication transaction right after the page row. A mark that writes no row (the page
 * row is not there to mark) throws, so the publication rolls back instead of leaving a guest page with no mark.
 */
export async function insertGuestMark(tx: Pick<BrainEngine, 'insertGuestMark'>, row: { source_id: string; slug: string; principal_kind: string; principal_id: string; request_id: string },
  note: GuestAttribution, audience: string): Promise<void> {
  const marked = await tx.insertGuestMark({ sourceId: row.source_id, slug: row.slug, audienceMember: audience, groupSlug: note.group,
    senderLabel: note.sender_label, writerKind: row.principal_kind, writerId: row.principal_id, requestId: row.request_id });
  if (marked !== 1) {
    throw new OperationError('storage_error', `The guest mark for ${row.slug} wrote ${marked} rows instead of one, so the guest note was not saved. Nothing was written.`,
      'Retry the save with a new request_id; if it fails the same way, run gbrain doctor --json on the brain host and report the result.');
  }
}
