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
import { HOUSEHOLD_KINDS, HOUSEHOLD_ROLES, HOUSEHOLD_STATUSES, HOUSEHOLD_TRANSITIONS, HOUSEHOLD_TYPE, type HouseholdKind, type HouseholdStatus } from './record.ts';

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

/** The class of each subject slug, read from its page's household_role in the record's own source (trusted internal read). */
export async function classifySubjects(engine: Pick<BrainEngine, 'getPage'>, sourceId: string, about: readonly string[]): Promise<Map<string, SubjectClass>> {
  const pages = await Promise.all(about.map(slug => engine.getPage(slug, { sourceId })));
  return new Map(about.map((slug, i) => [slug, roleClass(pages[i]?.frontmatter?.household_role)]));
}

/** The class a page's household_role gives the records about it. */
export function roleClass(raw: unknown): SubjectClass {
  const role = typeof raw === 'string' ? raw.trim().toLowerCase() : null;
  return role === 'child' ? 'child' : role && (HOUSEHOLD_ROLES as readonly string[]).includes(role) ? 'not_child' : 'unclassified';
}

/** Live household records about `slug` in `sourceId` whose stored readers include the helpers or family chats groups. */
export async function sharedRecordsAbout(engine: Pick<BrainEngine, 'listPages'>, sourceId: string, slug: string): Promise<string[]> {
  const groups = [HOUSEHOLD_GROUPS.helpers, HOUSEHOLD_GROUPS.chats].map(g => 'group:' + g);
  const rows = await engine.listPages({ type: HOUSEHOLD_TYPE as never, sourceId, sort: 'slug', limit: 100_000 });
  return rows.filter(row => aboutOf(row.frontmatter?.about).includes(slug)
    && Array.isArray(row.frontmatter?.readable_by) && (row.frontmatter.readable_by as unknown[]).some(r => groups.includes(String(r)))).map(row => row.slug);
}

function aboutOf(value: unknown): string[] {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return [...new Set(list.filter((v): v is string => typeof v === 'string').map(v => v.trim().toLowerCase()).filter(Boolean))];
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
 * `previous`, the stored page), then recomputes `household_audience` and `readable_by` from the table (server owned;
 * whatever the caller sent for them is replaced). Runs on every import of a `type: household` page, so put_page,
 * edit_page, household_add, household_mark and sync projection all apply it. Mutates `frontmatter`.
 */
export async function placeHouseholdFrontmatter(engine: Pick<BrainEngine, 'executeRaw' | 'getConfig' | 'getPage'>, sourceId: string,
  frontmatter: Record<string, unknown>, tags: readonly string[], previous?: { slug?: string; type?: string | null; frontmatter?: Record<string, unknown> | null; deleted_at?: unknown } | null): Promise<PlacementDecision> {
  assertHouseholdTransition(previous, frontmatter, previous?.slug ?? 'this page');
  const about = aboutOf(frontmatter.about);
  const classes = await classifySubjects(engine, sourceId, about);
  const decision = placeRecord({ kind: frontmatter.kind, school: tags.map(t => t.toLowerCase()).includes('school'), subjects: [...classes.values()], requested: frontmatter.audience });
  frontmatter.household_audience = decision.audience;
  const [serves, owner] = await Promise.all([brainServes(engine as BrainEngine), ownerMemberId(engine)]);
  if (serves.serves === 'several') frontmatter.readable_by = audienceReaders(decision.audience, owner).map(p => p.startsWith('member:') ? p.slice(7) : p).sort();
  else delete frontmatter.readable_by;
  return decision;
}

/**
 * Write admission for a page's household fields, on every import (put_page, edit_page, the household ops and sync
 * projection; import-file.ts). A household record is placed (placeHouseholdFrontmatter). On any other page household_role
 * classifies the records about it, so two changes are refused: a remote caller turning a child into another role (every
 * record about the child would widen at its next write), and narrowing a subject while records about it are still
 * shared with helpers (their stored readers would stay wider than the table). gbrain household replace --about makes
 * either change and re-places the records in the same step.
 */
export async function householdWriteAdmission(engine: Pick<BrainEngine, 'executeRaw' | 'getConfig' | 'getPage' | 'listPages'>, sourceId: string, slug: string,
  parsed: { type: string; frontmatter: Record<string, unknown>; tags: readonly string[] },
  previous: { slug?: string; type?: string | null; frontmatter?: Record<string, unknown> | null; deleted_at?: unknown } | null | undefined, remote: boolean): Promise<void> {
  if (parsed.type === HOUSEHOLD_TYPE) { await placeHouseholdFrontmatter(engine, sourceId, parsed.frontmatter, parsed.tags, previous); return; }
  if (!previous || previous.deleted_at || previous.frontmatter?.household_role === undefined) return;
  const from = roleClass(previous.frontmatter.household_role);
  const to = roleClass(parsed.frontmatter.household_role);
  const role = String(parsed.frontmatter.household_role ?? '').trim().toLowerCase();
  const fix = (argv: string[], why: string) => ({ fix: { argv, consent: [], actor: 'host_admin' as const, requires_exclusive: false, why } });
  if (remote && from === 'child' && to === 'not_child') {
    throw opError('household_reclassify', slug + ' is a child in this household and only the brain\'s owner can change that, so nothing was written.',
      'Keep household_role: child on the page, or ask the brain\'s owner to run gbrain household replace --about ' + slug + ' --role ' + role + '.',
      fix(['gbrain', 'household', 'replace', '--about', slug, '--role', role], 'Changes the role on the brain host and re-places the records about it.'));
  }
  if (from !== 'not_child' || to === 'not_child') return;
  const shared = await sharedRecordsAbout(engine, sourceId, slug);
  if (!shared.length) return;
  const argv = ['gbrain', 'household', 'replace', '--about', slug, ...(to === 'child' ? ['--role', 'child'] : [])];
  throw opError('household_reclassify', shared.length + ' household record(s) about ' + slug + ' are shared with helpers, and this change would leave them readable by helpers, so nothing was written.',
    to === 'child' ? 'Classify it with household_add (about_role child) or gbrain household replace --about ' + slug + ' --role child, which narrows those records to adults in the same step.'
      : 'Run gbrain household replace --about ' + slug + ' first, which narrows those records to adults, then make this change again.',
    fix(argv, 'Narrows the records about the subject to adults, then sets its role.'));
}
