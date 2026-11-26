/**
 * The household placement table (agent platform plan, lane 2): the one place a household record's folder and audience
 * are decided. household_add, write admission (every write and every sync projection of a `type: household` page,
 * import-file.ts) and H2's template all read it.
 *
 * - bill and credit: household/money/<kind>/<slug>, adults only; return: household/returns/<slug>, adults only.
 * - supply, appointment, birthday and deadline (household/school/ when tagged school, else household/deadlines/):
 *   adults, helpers and family chats.
 * - A record whose about[] names a child (the subject page carries `household_role: child`) goes to
 *   household/kids/<kind>/<slug> and is adults only, whatever its kind.
 * - A record whose subject cannot be classified (no page, no household_role, another source) is adults only: the
 *   classification fails closed.
 * - A record's own `audience: adults` can narrow it; nothing a caller writes widens it.
 *
 * The folder is only a default (a record is never moved). The binding control is the record's explicit readable_by,
 * recomputed from this table on every write: on a brain that serves several people it names the owner and the
 * audience's groups; on a brain that serves one person it is left off, so the owner's own callers read every record.
 */
import type { BrainEngine } from '../engine.ts';
import { brainServes } from '../access/serves.ts';
import { ownerMemberId } from '../access/owner.ts';
import { opError } from '../ops/contract.ts';
import { memberIdentity } from '../access/members.ts';
import { remoteTargetHidden } from '../persistence/page-visibility.ts';
import { accountNumberFields, HOUSEHOLD_KINDS, HOUSEHOLD_ROLES, HOUSEHOLD_STATUSES, HOUSEHOLD_TRANSITIONS, HOUSEHOLD_TYPE, looksLikeAccountNumber, type HouseholdKind, type HouseholdStatus } from './record.ts';

export type HouseholdAudience = 'adults' | 'shared';
export type SubjectClass = 'child' | 'not_child' | 'unclassified';

/** Template-namespaced groups (H2 creates them), so a brain's existing groups are never reused or widened. */
export const HOUSEHOLD_GROUPS = { adults: 'household-adults', helpers: 'household-helpers', chats: 'household-chats' } as const;

export const PLACEMENT: Readonly<Record<HouseholdKind, { folder: string; audience: HouseholdAudience; school_folder?: string }>> = {
  bill: { folder: 'household/money/bill/', audience: 'adults' },
  credit: { folder: 'household/money/credit/', audience: 'adults' },
  return: { folder: 'household/returns/', audience: 'adults' },
  supply: { folder: 'household/supplies/', audience: 'shared' },
  appointment: { folder: 'household/appointments/', audience: 'shared' },
  birthday: { folder: 'household/birthdays/', audience: 'shared' },
  deadline: { folder: 'household/deadlines/', audience: 'shared', school_folder: 'household/school/' },
};

export const kidsFolder = (kind: HouseholdKind): string => `household/kids/${kind}/`;

export interface PlacementDecision {
  folder: string;
  audience: HouseholdAudience;
  /** Why the audience is what it is. */
  basis: 'kind' | 'child_subject' | 'unclassified_subject' | 'requested' | 'unknown_kind';
}

/** Where a record goes and who reads it. Pure: the caller resolves its subjects' classes. */
export function placeRecord(input: { kind: unknown; school?: boolean; subjects: readonly SubjectClass[]; requested?: unknown }): PlacementDecision {
  const kind = input.kind as HouseholdKind;
  if (!HOUSEHOLD_KINDS.includes(kind)) return { folder: 'household/', audience: 'adults', basis: 'unknown_kind' };
  const row = PLACEMENT[kind];
  const folder = kind === 'deadline' && input.school && row.school_folder ? row.school_folder : row.folder;
  if (input.subjects.includes('child')) return { folder: kidsFolder(kind), audience: 'adults', basis: 'child_subject' };
  if (input.subjects.includes('unclassified')) return { folder, audience: 'adults', basis: 'unclassified_subject' };
  if (row.audience === 'shared' && input.requested === 'adults') return { folder, audience: 'adults', basis: 'requested' };
  return { folder, audience: row.audience, basis: 'kind' };
}

/** The readers an audience names: the owner (when one is set) and the audience's household groups. */
export function audienceReaders(audience: HouseholdAudience, owner: string | null): string[] {
  const groups = audience === 'adults' ? [HOUSEHOLD_GROUPS.adults] : Object.values(HOUSEHOLD_GROUPS);
  return [...(owner ? [`member:${owner}`] : []), ...groups.map(g => `group:${g}`)].sort();
}

/** The folder rules H2 generates from the table: every folder with the readers of its audience. */
export function placementFolderRules(owner: string | null): Array<{ prefix: string; readable_by: string[] }> {
  const rows = new Map<string, HouseholdAudience>();
  for (const kind of HOUSEHOLD_KINDS) {
    const row = PLACEMENT[kind];
    rows.set(row.folder, row.audience);
    if (row.school_folder) rows.set(row.school_folder, row.audience);
    rows.set(kidsFolder(kind), 'adults');
  }
  return [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([prefix, audience]) => ({ prefix, readable_by: audienceReaders(audience, owner) }));
}

/** The class of each subject slug, read from its live page in the record's own source (trusted internal read). */
export async function classifySubjects(engine: Pick<BrainEngine, 'getPage'>, sourceId: string, about: readonly string[]): Promise<Map<string, SubjectClass>> {
  const pages = await Promise.all(about.map(slug => engine.getPage(slug, { sourceId })));
  return new Map(about.map((slug, i) => [slug, subjectClass(pages[i])]));
}

/** The class a page's household_role gives the records about it. */
export function roleClass(raw: unknown): SubjectClass {
  const role = typeof raw === 'string' ? raw.trim().toLowerCase() : null;
  return role === 'child' ? 'child' : role && (HOUSEHOLD_ROLES as readonly string[]).includes(role) ? 'not_child' : 'unclassified';
}

/** The class a subject page gives the records about it. A household record is never a subject, whatever role it names. */
export function subjectClass(page: { type?: string | null; frontmatter?: Record<string, unknown> | null } | null | undefined): SubjectClass {
  return !page || page.type === HOUSEHOLD_TYPE ? 'unclassified' : roleClass(page.frontmatter?.household_role);
}

/**
 * Live household records about `slug` in `sourceId` that someone outside the adults audience can read: a stored reader
 * the adults readers do not cover (the helpers or family chats group, or a member named directly).
 */
export async function sharedRecordsAbout(engine: Pick<BrainEngine, 'listPages' | 'executeRaw' | 'getConfig'>, sourceId: string, slug: string): Promise<string[]> {
  const adults = tableReaders('adults', await ownerMemberId(engine));
  const missing = (await brainServes(engine as BrainEngine)).serves === 'several' ? null : [];
  const shared: string[] = [];
  for (const row of await recordsAbout(engine, sourceId, slug)) {
    if (await readersWiden(engine, readerList(row.frontmatter?.readable_by) ?? missing, adults)) shared.push(row.slug);
  }
  return shared;
}

/**
 * A check for records whose stored readers are wider than the table's readers for their audience, on a brain that
 * serves several people (no stored list reads as everyone); on a brain that serves one person nothing is wider.
 */
export async function readersWiderThanTable(engine: Pick<BrainEngine, 'executeRaw' | 'getConfig'>): Promise<(frontmatter: Record<string, unknown>, audience: HouseholdAudience) => Promise<boolean>> {
  if ((await brainServes(engine as BrainEngine)).serves !== 'several') return async () => false;
  const owner = await ownerMemberId(engine);
  return (frontmatter, audience) => readersWiden(engine, readerList(frontmatter.readable_by), tableReaders(audience, owner));
}

async function recordsAbout(engine: Pick<BrainEngine, 'listPages'>, sourceId: string, slug: string) {
  const rows = await engine.listPages({ type: HOUSEHOLD_TYPE as never, sourceId, sort: 'slug', limit: 100_000, omitBodies: true });
  return rows.filter(row => aboutOf(row.frontmatter?.about).includes(slug));
}

/** A record kept to adults only by its subjects (not by its kind or its own audience), which a not_child subject would widen. */
function heldBySubject(fm: Record<string, unknown> | null | undefined): boolean {
  return fm?.household_audience === 'adults' && fm.audience !== 'adults' && PLACEMENT[fm.kind as HouseholdKind]?.audience === 'shared';
}

/** A record's about[] as lower-case slugs (a scalar or a list; anything else is none). */
export function aboutOf(value: unknown): string[] {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return [...new Set(list.filter((v): v is string => typeof v === 'string').map(v => v.trim().toLowerCase()).filter(Boolean))];
}

/** A readable_by value as sorted principals (member ids bare, groups as group:<id>); null when the page names none. */
function readerList(value: unknown): string[] | null {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
  if (!list) return null;
  return [...new Set(list.filter((v): v is string => typeof v === 'string').map(v => v.trim().replace(/^member:/i, '')).filter(Boolean))].sort();
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** The readers the table writes for an audience, as stored on the page. */
function tableReaders(audience: HouseholdAudience, owner: string | null): string[] {
  return audienceReaders(audience, owner).map(p => p.startsWith('member:') ? p.slice(7) : p).sort();
}

/** True when `entry` is in `readers`, or is a member of a group `readers` names. */
async function readerCovered(engine: Pick<BrainEngine, 'executeRaw'>, entry: string, readers: readonly string[]): Promise<boolean> {
  if (readers.includes(entry)) return true;
  if (entry.startsWith('group:')) return false;
  const groups = await memberIdentity(engine as BrainEngine, entry).then(m => m.groups, () => [] as string[]);
  return groups.some(g => readers.includes('group:' + g));
}

/**
 * Account and card numbers anywhere in a household record: its frontmatter (but not readable_by or household_audience,
 * which the server writes), its body and its timeline. Refuses with account_number_key; the value is never echoed.
 */
export function refuseAccountNumbers(fields: string[]): void {
  if (!fields.length) return;
  throw opError('account_number_key', `Nothing was written: ${fields.join(', ')} looks like a full account or card number.`,
    'Household records never hold full account or card numbers. Leave the number out (the last four digits in the title are fine) and submit again.');
}

function recordAccountNumbers(frontmatter: Record<string, unknown>, body?: { compiled_truth?: string | null; timeline?: string | null }): string[] {
  const authored = Object.fromEntries(Object.entries(frontmatter).filter(([k]) => k !== 'readable_by' && k !== 'household_audience'));
  return [...accountNumberFields(authored), ...(['compiled_truth', 'timeline'] as const).filter(k => typeof body?.[k] === 'string' && looksLikeAccountNumber(body[k]!)).map(k => k === 'compiled_truth' ? 'body' : k)];
}

/** Refuses a status move HOUSEHOLD_TRANSITIONS does not allow, from the stored record (a live household page) to the new one. */
export function assertHouseholdTransition(previous: { type?: string | null; frontmatter?: Record<string, unknown> | null; deleted_at?: unknown } | null | undefined,
  frontmatter: Record<string, unknown>, slug: string): void {
  if (!previous || previous.deleted_at || previous.type !== HOUSEHOLD_TYPE) return;
  const statusOf = (v: unknown): string => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : 'active');
  const from = statusOf(previous.frontmatter?.status);
  const to = statusOf(frontmatter.status);
  if (from === to || !(HOUSEHOLD_STATUSES as readonly string[]).includes(from)) return;
  if (HOUSEHOLD_TRANSITIONS[from as HouseholdStatus].includes(to as HouseholdStatus)) return;
  const allowed = HOUSEHOLD_TRANSITIONS[from as HouseholdStatus];
  throw opError('household_transition', `${slug}: a household record cannot move from status ${from} to ${to}, so nothing was written.`,
    allowed.length ? `From ${from} a record can move to ${allowed.join(' or ')}; record what happened with household_mark (gbrain household mark ${slug} <event>).`
      : `An archived record is final; add a new one with household_add (gbrain household add <kind> --title <title>).`);
}

/**
 * Write admission for a household record: refuses a status move the transition table does not allow (against
 * `previous`, the stored page) and any account or card number in the record, then recomputes `household_audience` and
 * `readable_by` from the table. A readable_by the server wrote is replaced; one the author wrote is kept where the table
 * allows it and never widened (on a brain that serves one person it is kept as written). Mutates `frontmatter`.
 */
export async function placeHouseholdFrontmatter(engine: Pick<BrainEngine, 'executeRaw' | 'getConfig' | 'getPage'>, sourceId: string,
  frontmatter: Record<string, unknown>, tags: readonly string[], previous?: { slug?: string; type?: string | null; frontmatter?: Record<string, unknown> | null; deleted_at?: unknown } | null,
  body?: { compiled_truth?: string | null; timeline?: string | null }): Promise<PlacementDecision> {
  assertHouseholdTransition(previous, frontmatter, previous?.slug ?? 'this page');
  refuseAccountNumbers(recordAccountNumbers(frontmatter, body));
  const about = aboutOf(frontmatter.about);
  const classes = await classifySubjects(engine, sourceId, about);
  const decision = placeRecord({ kind: frontmatter.kind, school: tags.map(t => t.toLowerCase()).includes('school'), subjects: [...classes.values()], requested: frontmatter.audience });
  frontmatter.household_audience = decision.audience;
  const owner = await ownerMemberId(engine);
  const table = await placedReaders(engine, decision.audience);
  const written = readerList(frontmatter.readable_by);
  const authored = written && !(['adults', 'shared'] as const).some(a => sameList(written, tableReaders(a, owner))) ? written : null;
  if (!authored) {
    if (table) frontmatter.readable_by = table;
    else delete frontmatter.readable_by;
    return decision;
  }
  if (!table) { frontmatter.readable_by = authored; return decision; }
  const kept: string[] = [];
  for (const entry of authored) if (await readerCovered(engine, entry, table)) kept.push(entry);
  frontmatter.readable_by = kept.length ? kept : owner ? [owner] : [`group:${HOUSEHOLD_GROUPS.adults}`];
  return decision;
}

/** The readers the placement table gives an audience on a brain that serves several people; null on a brain that serves one. */
export async function placedReaders(engine: Pick<BrainEngine, 'executeRaw' | 'getConfig'>, audience: HouseholdAudience): Promise<string[] | null> {
  const [serves, owner] = await Promise.all([brainServes(engine as BrainEngine), ownerMemberId(engine)]);
  return serves.serves === 'several' ? tableReaders(audience, owner) : null;
}

/** True when some reader in `next` (null: everyone) is not covered by `before` (null: everyone). */
async function readersWiden(engine: Pick<BrainEngine, 'executeRaw'>, next: string[] | null, before: string[] | null): Promise<boolean> {
  if (!before) return false;
  if (!next) return true;
  for (const entry of next) if (!await readerCovered(engine, entry, before)) return true;
  return false;
}

type StoredPage = { slug?: string; type?: string | null; frontmatter?: Record<string, unknown> | null; deleted_at?: unknown };

function reclassifyRefusal(message: string, hint: string, argv: string[], why: string) {
  return opError('household_reclassify', message, hint, { fix: { argv, consent: [], actor: 'host_admin' as const, requires_exclusive: false, why } });
}

/** The one refusal a remote non-owner gets for making a subject a child on a brain that serves several people, before any record about it is read. */
export function nonOwnerChildRefusal(subject: string) {
  return opError('household_reclassify', `Only the brain's owner can make ${subject} a child, since the household records about it have to be narrowed to adults, so nothing was written.`,
    `Ask the brain's owner to run gbrain household replace --about ${subject} --role child on the brain host, or to add this record as the owner.`);
}

/**
 * Write admission for a page's household fields, on every import path (put_page, edit_page, the household ops, sync
 * projection and staged imports; import-file.ts, which holds a caller that does not say it is trusted to the remote
 * rules; the streamed import holds these pages so they take this path). It
 * reads the stored page and the incoming one, so a change of type is seen as well as a change of fields:
 *
 * - A subject page's class (household_role; a household record is never a subject) changes only when the records
 *   about it follow: a remote caller cannot take a subject out of child, or give it a role that would widen records
 *   kept to adults because of it; nobody narrows a subject, or makes a child of one that has no class (a page
 *   deleted by sync and written again), while records about it are still shared with helpers. On a brain that serves
 *   several people a remote caller other than the owner cannot narrow a subject at all, and is refused the same way
 *   whatever records exist, so the refusal tells it nothing about records it cannot read.
 * - A household record is placed (placeHouseholdFrontmatter). A remote write cannot widen it: it cannot retype it to
 *   another type, move it from adults to shared (dropping a child from about, removing audience: adults, changing its
 *   kind), or widen its stored readers.
 *
 * gbrain household replace --about (or a trusted local write) makes these changes on the brain host.
 */
export async function householdWriteAdmission(engine: Pick<BrainEngine, 'executeRaw' | 'getConfig' | 'getPage' | 'listPages'>, sourceId: string, slug: string,
  parsed: { type: string; frontmatter: Record<string, unknown>; tags: readonly string[]; compiled_truth?: string | null; timeline?: string | null },
  previous: StoredPage | null | undefined, remote: boolean, owner?: () => Promise<boolean>): Promise<void> {
  const live = previous && !previous.deleted_at ? previous : null;
  if (live?.type === HOUSEHOLD_TYPE && parsed.type !== HOUSEHOLD_TYPE && remote) {
    throw reclassifyRefusal(`Only the brain's owner can change ${slug} from a household record to another type, since that would drop the readers the placement table gives it, so nothing was written.`,
      'Keep type: household, or ask the brain\'s owner to make the change on the brain host.', ['gbrain', 'get', slug], 'Shows the record as stored; changes nothing.');
  }
  if (live?.frontmatter?.household_role !== undefined || parsed.frontmatter.household_role !== undefined) await subjectAdmission(engine, sourceId, slug, parsed, live, remote, owner);
  if (parsed.type !== HOUSEHOLD_TYPE) return;
  const record = live?.type === HOUSEHOLD_TYPE ? live : null;
  const decision = await placeHouseholdFrontmatter(engine, sourceId, parsed.frontmatter, parsed.tags, previous, parsed);
  if (!remote || !record) return;
  const widened = record.frontmatter?.household_audience === 'adults' && decision.audience === 'shared';
  if (widened || await readersWiden(engine, readerList(parsed.frontmatter.readable_by), readerList(record.frontmatter?.readable_by))) {
    throw reclassifyRefusal(`This write would let more people read ${slug} than read it now (a child dropped from about, audience: adults removed, a shared kind, or wider readable_by), and only the brain's owner can widen a household record, so nothing was written.`,
      'Keep the record\'s about, audience, kind and readable_by as stored, or ask the brain\'s owner to make the change on the brain host.', ['gbrain', 'get', slug], 'Shows the record as stored; changes nothing.');
  }
}

async function subjectAdmission(engine: Pick<BrainEngine, 'executeRaw' | 'getConfig' | 'getPage' | 'listPages'>, sourceId: string, slug: string,
  parsed: { type: string; frontmatter: Record<string, unknown> }, live: StoredPage | null, remote: boolean, owner: (() => Promise<boolean>) | undefined): Promise<void> {
  const from = subjectClass(live);
  const to = subjectClass(parsed);
  const role = parsed.type === HOUSEHOLD_TYPE ? '' : String(parsed.frontmatter.household_role ?? '').trim().toLowerCase();
  const keep = to === 'unclassified' || !role;
  if (remote && from !== to && (from === 'child' || (to === 'not_child' && (await recordsAbout(engine, sourceId, slug)).some(row => heldBySubject(row.frontmatter))))) {
    throw reclassifyRefusal('Only the brain\'s owner can take ' + slug + ' out of household_role child, or give it a role that would widen household records already kept to adults because of it, so nothing was written.',
      'Keep the page\'s type and household_role as they are, or ask the brain\'s owner to run gbrain household replace --about ' + slug + (keep ? '' : ' --role ' + role) + '.',
      ['gbrain', 'household', 'replace', '--about', slug, ...(keep ? [] : ['--role', role])], 'Changes the role on the brain host and re-places the records about it.');
  }
  if (from === to || to === 'not_child' || from === 'child') return;
  if (remote && owner && await placedReaders(engine, 'adults') && !await owner()) {
    if (to === 'child') throw nonOwnerChildRefusal(slug);
    throw reclassifyRefusal('Only the brain\'s owner can take ' + slug + ' out of its household_role, since the household records about it may have to be narrowed to adults first, so nothing was written.',
      'Keep the page\'s household_role, or ask the brain\'s owner to run gbrain household replace --about ' + slug + ' on the brain host.',
      ['gbrain', 'household', 'replace', '--about', slug], 'Narrows the records about the subject to adults on the brain host.');
  }
  const shared = await sharedRecordsAbout(engine, sourceId, slug);
  if (!shared.length) return;
  throw reclassifyRefusal(shared.length + ' household record(s) about ' + slug + ' are shared with helpers, and this change would leave them readable by helpers, so nothing was written.',
    to === 'child' ? 'Classify it with household_add (about_role child) or gbrain household replace --about ' + slug + ' --role child, which narrows those records to adults in the same step.'
      : 'Run gbrain household replace --about ' + slug + ' first, which narrows those records to adults, then make this change again.',
    ['gbrain', 'household', 'replace', '--about', slug, ...(to === 'child' ? ['--role', 'child'] : [])], 'Narrows the records about the subject to adults, then sets its role.');
}

/**
 * Delete admission for a subject page (delete_page, before the soft delete or purge). A remote caller cannot delete a
 * subject while live household records are about it (their readers were written from its role), and nobody deletes a
 * subject while records about it are still shared with helpers (they would stay wider than the table, which reads an
 * absent subject as unclassified). gbrain household replace --about narrows the records first.
 */
export async function householdDeleteAdmission(engine: BrainEngine, sourceId: string, slug: string, ctxRemote: boolean | undefined): Promise<void> {
  const remote = ctxRemote !== false;
  const page = await engine.getPage(slug, { sourceId });
  if (!page || page.type === HOUSEHOLD_TYPE || page.frontmatter?.household_role === undefined) return;
  if (await remoteTargetHidden(engine, ctxRemote, sourceId, slug)) return;
  const records = await recordsAbout(engine, sourceId, slug);
  const shared = subjectClass(page) === 'not_child' ? await sharedRecordsAbout(engine, sourceId, slug) : [];
  if (!shared.length && !(remote && records.length)) return;
  throw reclassifyRefusal(records.length + ' household record(s) are about ' + slug + (shared.length ? ' and ' + shared.length + ' of them are shared with helpers' : '') + ', so only the brain\'s owner can delete it, after narrowing them; nothing was deleted.',
    'Ask the brain\'s owner to run gbrain household replace --about ' + slug + ' (it narrows the records about it to adults), then delete the page on the brain host.',
    ['gbrain', 'household', 'replace', '--about', slug], 'Narrows the records about the subject to adults before it is deleted.');
}
