/**
 * GBRA-582 item 9 (leaver handover, PR 2): \`gbrain access member handover <member>\` gives a disabled or removed member's
 * pages to someone who can still read them, so nothing they kept to themselves ends up readable by no member.
 *
 * It is a planner over the existing writers: page readers go through the label-only readers write (repair/readers.ts,
 * the same door as \`gbrain repair visibility --readers\`), folder rules through the store's rule write and approval
 * (commands/access-rules.ts writeApprovedRules) and personal-source bindings through access/member-sources.ts. Nothing
 * here writes a page or a rule any other way.
 *
 * Groups: \`kept\` (pages naming the leaver that no other enabled member, live group or the owner reads), \`folder\` (rules
 * whose readers name only the leaver, and the leaver-only pages under them), \`shared\` (pages someone else reads too),
 * \`source\` (personal sources bound to the leaver) and \`memory\` (the leaver's member page; listed, never changed).
 * Defaults: kept and folder go to the owner, everything else stays as it is; opening a group (\`everyone\`) is never a
 * default. Preview first: the preview saves its items under a hash (op_checkpoints, command member-handover); the apply
 * replays exactly those items, rechecking each, and records them on an access_handovers row (v327) so a stopped apply
 * resumes with the same command, \`--status\` reports the Git publication and \`--undo\` restores each item's readers once
 * the leaver is enabled again. Works with no repository: labels then write the database, rules use the database store.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../operations.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { getMember, listMembers, type MemberRecord } from './members.ts';
import { listMemberSources, bindMemberSource, unbindMemberSource } from './member-sources.ts';
import { ownerMemberId } from './owner.ts';
import { identityFor, MEMBER_PAGE_PREFIX, normalizeReaders, readersAllow } from './principals.ts';
import { folderRulesAllow, ruleCovers, sortRules, type FolderRule } from './folder-rules.ts';
import { appliedRules, previewApply, resumePolicy, coverageRows } from './policy.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet, type PreviewApprovalCommand } from '../persistence/preview-approval.ts';
import { digest } from '../persistence/digest.ts';
import { READERS_KEY } from '../persistence/label-edit.ts';
import { readersGitCounts, READERS_PHASE, READERS_MAX_PAGES, type ReadersItem } from '../repair/readers.ts';
import { visibilityRepair } from '../repair/visibility.ts';
import { resolveRepairScope } from '../repair/core.ts';
import { currentFolderRules, writeApprovedRules } from '../../commands/access-rules.ts';

export type HandoverGroup = 'kept' | 'folder' | 'shared' | 'source';
/** owner, everyone, keep, drop, or member:<id> (that member plus the owner; for source, rebind to it). */
export type HandoverChoice = string;
export type HandoverChoices = Record<HandoverGroup, HandoverChoice>;
export const DEFAULT_CHOICES: HandoverChoices = { kept: 'owner', folder: 'owner', shared: 'keep', source: 'keep' };
const ALLOWED: Record<HandoverGroup, string[]> = { kept: ['owner', 'everyone', 'keep'], folder: ['owner', 'everyone', 'keep'], shared: ['keep', 'drop'], source: ['keep'] };
const MEMBER_TARGET: Record<HandoverGroup, boolean> = { kept: true, folder: true, shared: false, source: true };
const SAMPLES = 5;

export interface PageItem { kind: 'page'; group: HandoverGroup; source_id: string; slug: string; page_id: number; from: string[] | null; to: string[] | null }
export interface RuleItem { kind: 'rule'; group: 'folder'; source_id: string; rule_id: string; prefix: string; from: string[]; to: string[] | null }
export interface BindingItem { kind: 'binding'; group: 'source'; source_id: string; from: string; to: string }
export type HandoverItem = PageItem | RuleItem | BindingItem;
export type ItemOutcome = 'done' | 'skipped' | 'failed';
export type RecordedItem = HandoverItem & { outcome?: ItemOutcome; reason?: string };
export type HandoverState = 'applying' | 'publishing' | 'applied' | 'partial' | 'undone';

export interface GroupSummary { group: HandoverGroup | 'memory'; choice: HandoverChoice | 'never'; count: number; sample: string[]; note?: string }
export interface HandoverPreview {
  member: string; member_status: MemberRecord['status']; owner: string | null; choices: HandoverChoices; undo_of?: string;
  groups: GroupSummary[]; items: HandoverItem[];
  /** Enabled members who read at least one page after the handover that they cannot read now, and those who lose one. */
  gains: string[]; losses: string[]; owner_gains: number; opens_to_source_readers: boolean;
  bound_credentials: number; leaver_groups: string[]; plan_hash: string; warnings: string[];
}
export interface HandoverRecord { id: string; member_id: string; owner_id: string | null; plan_hash: string; choices: HandoverChoices; items: RecordedItem[];
  commits: string[]; state: HandoverState; created_at: string; undone_at: string | null; undo_of: string | null; git?: Record<string, number> }

const plain = (p: string) => (p.startsWith('member:') ? p.slice(7) : p);
const same = (a: string[] | null, b: string[] | null) => JSON.stringify(a) === JSON.stringify(b);
const norm = (readers: string[] | null) => (readers ? normalizeReaders({ [READERS_KEY]: readers }) : null);
const pageRef = (i: { source_id: string; slug: string }) => i.source_id + ':' + i.slug;
const handoverId = (hash: string) => 'ho-' + hash.slice(0, 12);

const handoverError = (code: Parameters<typeof opError>[0], message: string, command: string, why: string, reason?: string) => opError(code, message, 'Run: ' + command, {
  why, ...(reason ? { reason } : {}), fix: { argv: command.split(' '), consent: [], actor: 'user', requires_exclusive: false, why } });

/** Parses --set group=choice flags over the defaults; member targets become member:<id>. */
export function parseChoices(sets: string[]): HandoverChoices {
  const choices = { ...DEFAULT_CHOICES };
  for (const raw of sets) {
    const [group, value] = raw.split('=', 2) as [HandoverGroup, string | undefined];
    if (!(group in DEFAULT_CHOICES) || !value) throw opError('invalid_params', '--set takes <group>=<choice>; got "' + raw + '".', 'Groups: kept, folder, shared, source. For example --set kept=alice-example or --set shared=drop.');
    choices[group] = ALLOWED[group].includes(value) ? value : MEMBER_TARGET[group] ? 'member:' + value.replace(/^member:/, '') : (() => {
      throw opError('invalid_params', '--set ' + group + ' takes ' + ALLOWED[group].join(', ') + '; got "' + value + '".', 'Pick one of ' + ALLOWED[group].join(', ') + '.');
    })();
  }
  return choices;
}

async function targetMember(engine: BrainEngine, choice: string, leaver: string): Promise<string | null> {
  if (!choice.startsWith('member:')) return null;
  const id = choice.slice(7);
  const m = await getMember(engine, id);
  const reason = !m ? 'unknown' : m.id === leaver ? 'leaver' : m.status !== 'enabled' ? m.status : m.kind === 'audience' ? 'audience_target' : null;
  if (reason) throw opError('access_member_invalid', reason === 'audience_target' ? 'Member "' + id + '" is an audience; hand pages to a person.' : reason === 'leaver' ? 'Pages cannot be handed back to the leaver.'
    : 'Member "' + id + '" is ' + (m ? m.status : 'unknown') + '.', 'Pick an enabled person: gbrain access member list.', { reason });
  return id;
}

/** The readers a page or rule gets for a kept/folder choice; undefined for keep. */
function forwardReaders(choice: string, owner: string | null, member: string | null): string[] | null | undefined {
  if (choice === 'keep') return undefined;
  if (choice === 'everyone') return null;
  return [...new Set([...(member ? [member] : []), ...(owner ? [owner] : [])])];
}

interface PlanContext { leaver: string; owner: string | null; enabled: MemberRecord[]; leaverPrincipals: Set<string>; liveGroups: Set<string> }

async function planContext(engine: BrainEngine, leaver: MemberRecord): Promise<PlanContext> {
  const members = await listMembers(engine, { includeRemoved: true });
  const enabled = members.filter(m => m.status === 'enabled' && m.id !== leaver.id);
  const groups = await engine.executeRaw<{ group_id: string; member_id: string }>('SELECT group_id, member_id FROM access_group_members');
  const leaverGroups = groups.filter(g => g.member_id === leaver.id).map(g => g.group_id);
  const liveGroups = new Set(groups.filter(g => enabled.some(m => m.id === g.member_id)).map(g => g.group_id));
  return { leaver: leaver.id, owner: await ownerMemberId(engine), enabled, liveGroups,
    leaverPrincipals: new Set(['member:' + leaver.id, ...leaverGroups.map(g => 'group:' + g)]) };
}

/** Whether a principal in a readers list still admits someone once the leaver is gone. */
const liveReader = (p: string, ctx: PlanContext) => p === 'member:' + ctx.owner
  || (p.startsWith('group:') ? ctx.liveGroups.has(p.slice(6)) : ctx.enabled.some(m => 'member:' + m.id === p));

/** Folder rules whose readers name the leaver and nobody else who still reads. */
const leaverRule = (rule: FolderRule, ctx: PlanContext) => rule.readable_by.length > 0
  && rule.readable_by.some(p => ctx.leaverPrincipals.has(p)) && !rule.readable_by.some(p => liveReader(p, ctx));

/** Plans the handover: every item it would write, grouped, with who gains and loses access. Writes only the approved set. */
export async function previewHandover(engine: BrainEngine, rawMember: string, choices: HandoverChoices): Promise<HandoverPreview> {
  const leaver = await getMember(engine, rawMember);
  if (!leaver) throw opError('not_found', 'No member "' + rawMember + '".', 'List members with gbrain access member list --all.');
  if (leaver.status === 'enabled') throw handoverError('handover_member_enabled', 'Member "' + leaver.id + '" is still enabled; hand over pages only after it is switched off.',
    'gbrain access member disable ' + leaver.id, 'A handover takes pages away from the member; while it is enabled it would lose its own pages.');
  const ctx = await planContext(engine, leaver);
  const keptTarget = await targetMember(engine, choices.kept, leaver.id);
  const folderTarget = await targetMember(engine, choices.folder, leaver.id);
  const sourceTarget = await targetMember(engine, choices.source, leaver.id);
  const needsOwner = (['kept', 'folder'] as const).find(g => choices[g] === 'owner');
  if (needsOwner && !ctx.owner) throw handoverError('handover_owner_unset', 'The ' + needsOwner + ' group goes to the owner, but this brain names no owner.',
    'gbrain access owner set <member>', 'Without an owner the default would leave the pages readable by no member.');
  const items: HandoverItem[] = [];
  const warnings: string[] = [];
  const sources = (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(r => r.id);
  const rulesBefore = new Map<string, FolderRule[]>();
  const rulesAfter = new Map<string, FolderRule[]>();
  for (const source of sources) {
    const base = await currentFolderRules(engine, source).catch(() => appliedRules(engine, source));
    rulesBefore.set(source, await appliedRules(engine, source));
    const to = forwardReaders(choices.folder, ctx.owner, folderTarget);
    const after: FolderRule[] = [];
    for (const rule of base) {
      if (!leaverRule(rule, ctx) || to === undefined) { after.push(rule); continue; }
      items.push({ kind: 'rule', group: 'folder', source_id: source, rule_id: rule.id, prefix: rule.prefix, from: rule.readable_by, to: to && norm(to) });
      if (to) after.push({ ...rule, readable_by: norm(to)! });
    }
    rulesAfter.set(source, sortRules(after));
  }
  const folderRules = new Map<string, FolderRule[]>(sources.map(s => [s, (rulesBefore.get(s) ?? []).filter(r => leaverRule(r, ctx))]));
  const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string; frontmatter: unknown }>(
    'SELECT id, source_id, slug, frontmatter FROM pages WHERE deleted_at IS NULL AND frontmatter ? \'readable_by\' AND gbrain_access_readers(frontmatter) && $1::text[] ORDER BY source_id, slug LIMIT ' + (READERS_MAX_PAGES + 1),
    [[...ctx.leaverPrincipals]]);
  if (rows.length > READERS_MAX_PAGES) warnings.push('More than ' + READERS_MAX_PAGES + ' pages name ' + leaver.id + '; this handover lists the first ' + READERS_MAX_PAGES + ' and a second run takes the rest.');
  let memory = 0;
  for (const row of rows.slice(0, READERS_MAX_PAGES)) {
    if (row.slug === MEMBER_PAGE_PREFIX + leaver.id) { memory++; continue; }
    const fm = typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter;
    const from = normalizeReaders(fm);
    if (!from) continue;
    const base = { kind: 'page' as const, source_id: row.source_id, slug: row.slug, page_id: Number(row.id), from };
    if (from.some(p => liveReader(p, ctx))) {
      const kept = from.filter(p => p !== 'member:' + leaver.id);
      if (choices.shared === 'drop' && kept.length !== from.length) items.push({ ...base, group: 'shared', to: kept.map(plain) });
      else items.push({ ...base, group: 'shared', to: from.map(plain) });
      continue;
    }
    const inFolder = (folderRules.get(row.source_id) ?? []).some(r => ruleCovers(row.slug, r.prefix));
    const group = inFolder ? 'folder' : 'kept';
    const to = forwardReaders(choices[group], ctx.owner, group === 'folder' ? folderTarget : keptTarget);
    items.push({ ...base, group, to: to === undefined ? from.map(plain) : to });
  }
  const [memoryPage] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL AND slug = $1', [MEMBER_PAGE_PREFIX + leaver.id]);
  const [memoryFacts] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts f JOIN pages p ON p.id = f.page_id WHERE p.deleted_at IS NULL AND p.slug = $1', [MEMBER_PAGE_PREFIX + leaver.id]).catch(() => [{ n: 0 }]);
  if (leaver.status === 'removed') warnings.push(leaver.id + ' was removed, so its group memberships were dropped: pages it read only through a group cannot be attributed to it. gbrain doctor lists pages no member reads.');
  for (const binding of leaver.status === 'removed' ? [] : await listMemberSources(engine, { member: leaver.id })) {
    if (sourceTarget) items.push({ kind: 'binding', group: 'source', source_id: binding.source_id, from: leaver.id, to: sourceTarget });
  }
  const changed = items.filter(i => i.kind !== 'page' || !same(i.from, norm(i.to)));
  const pageItems = items.filter((i): i is PageItem => i.kind === 'page');
  const impact = await readImpact(engine, ctx, pageItems.filter(i => !same(i.from, norm(i.to))), changed.filter((i): i is RuleItem => i.kind === 'rule'), rulesBefore, rulesAfter);
  const groupOf = (g: HandoverGroup) => {
    const its = items.filter(i => i.group === g && (i.kind !== 'page' || g === 'shared' || choices[g] !== 'keep'));
    const pages = items.filter((i): i is PageItem => i.kind === 'page' && i.group === g);
    const rules = its.filter((i): i is RuleItem => i.kind === 'rule');
    return { group: g, choice: choices[g], count: g === 'source' ? its.length : pages.length + rules.length,
      sample: [...rules.map(r => r.source_id + ':' + r.prefix), ...pages.map(pageRef)].slice(0, SAMPLES) };
  };
  const groups: GroupSummary[] = [groupOf('kept'), groupOf('folder'), groupOf('shared'), groupOf('source'),
    { group: 'memory', choice: 'never', count: memory + Number(memoryPage?.n ?? 0) - memory, sample: Number(memoryPage?.n ?? 0) ? [MEMBER_PAGE_PREFIX + leaver.id] : [],
      note: Number(memoryFacts?.n ?? 0) + ' private fact(s); never opened. The owner reads them on the brain host.' }];
  const [creds] = await engine.executeRaw<{ n: number }>("SELECT (SELECT count(*) FROM access_tokens WHERE member_id = $1 AND revoked_at IS NULL) + (SELECT count(*) FROM oauth_clients WHERE member_id = $1) AS n", [leaver.id]).catch(() => [{ n: 0 }]);
  const [undone] = await engine.executeRaw<{ id: string }>("SELECT id FROM access_handovers WHERE member_id = $1 AND state = 'undone' ORDER BY undone_at DESC LIMIT 1", [leaver.id]);
  const hash = previewHash({ kind: 'member-handover-v1', member: leaver.id, owner: ctx.owner, choices, items: changed, ...(undone ? { after_undo: String(undone.id) } : {}) });
  if (changed.length) await saveApprovedSet<HandoverItem>(engine, { command: approvalCommand(leaver.id), hash }, changed);
  return { member: leaver.id, member_status: leaver.status, owner: ctx.owner, choices, groups, items: changed, ...impact,
    bound_credentials: Number(creds?.n ?? 0), leaver_groups: [...ctx.leaverPrincipals].filter(p => p.startsWith('group:')).map(plain), plan_hash: hash, warnings };
}

/** Who gains and who loses a page across the changed pages and the pages under changed rules (members, the owner, source readers). */
async function readImpact(engine: BrainEngine, ctx: PlanContext, pages: PageItem[], rules: RuleItem[], before: Map<string, FolderRule[]>, after: Map<string, FolderRule[]>) {
  const identities = ctx.enabled.map(m => ({ id: m.id, identity: identityFor(m.id, m.groups) }));
  const gains = new Set<string>();
  const losses = new Set<string>();
  let ownerGains = 0;
  let opens = rules.some(r => r.to === null) || pages.some(p => p.to === null);
  const touched = new Map<string, { source_id: string; slug: string; fmBefore: unknown; fmAfter: unknown }>();
  for (const p of pages) touched.set(pageRef(p), { source_id: p.source_id, slug: p.slug, fmBefore: { [READERS_KEY]: p.from }, fmAfter: p.to ? { [READERS_KEY]: p.to } : {} });
  for (const r of rules) {
    const under = await engine.executeRaw<{ source_id: string; slug: string; frontmatter: unknown }>('SELECT source_id, slug, frontmatter FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND (slug = $2 OR ($2 LIKE \'%/\' AND left(slug, length($2)) = $2)) LIMIT 5000', [r.source_id, r.prefix]);
    for (const row of under) if (!touched.has(pageRef(row))) touched.set(pageRef(row), { ...row, fmBefore: row.frontmatter, fmAfter: row.frontmatter });
  }
  for (const t of touched.values()) {
    const fmB = typeof t.fmBefore === 'string' ? JSON.parse(t.fmBefore) : t.fmBefore;
    const fmA = typeof t.fmAfter === 'string' ? JSON.parse(t.fmAfter) : t.fmAfter;
    const rb = before.get(t.source_id) ?? [];
    const ra = after.get(t.source_id) ?? [];
    for (const { id, identity } of identities) {
      const was = folderRulesAllow(t.slug, rb, identity) && readersAllow(fmB, identity);
      const now = folderRulesAllow(t.slug, ra, identity) && readersAllow(fmA, identity);
      if (now && !was) { gains.add(id); if (id === ctx.owner) ownerGains++; }
      if (was && !now) losses.add(id);
    }
    if (normalizeReaders(fmA) === null && !ra.some(r => ruleCovers(t.slug, r.prefix))) opens = true;
  }
  return { gains: [...gains].sort(), losses: [...losses].sort(), owner_gains: ownerGains, opens_to_source_readers: opens };
}

async function readRecord(engine: BrainEngine, where: string, value: string): Promise<HandoverRecord | null> {
  const [row] = await engine.executeRaw<Record<string, unknown>>('SELECT id, member_id, owner_id, plan_hash, choices, items, commits, state, created_at, undone_at, undo_of FROM access_handovers WHERE ' + where + ' = $1', [value]);
  if (!row) return null;
  const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return { id: String(row.id), member_id: String(row.member_id), owner_id: (row.owner_id as string) ?? null, plan_hash: String(row.plan_hash), choices: json(row.choices),
    items: json(row.items) ?? [], commits: (row.commits as string[]) ?? [], state: row.state as HandoverState, created_at: iso(row.created_at)!, undone_at: iso(row.undone_at), undo_of: (row.undo_of as string) ?? null };
}

export async function getHandover(engine: BrainEngine, id: string): Promise<HandoverRecord> {
  const r = await readRecord(engine, 'id', id);
  if (!r) throw opError('not_found', 'No handover "' + id + '".', 'gbrain access member handover <member> previews one; its apply prints the handover id.');
  return r;
}

async function saveRecord(engine: BrainEngine, r: HandoverRecord): Promise<void> {
  await engine.executeRaw('UPDATE access_handovers SET items = $2::text::jsonb, commits = $3::text[], state = $4, updated_at = now() WHERE id = $1',
    [r.id, JSON.stringify(r.items), r.commits, r.state]);
}

/** The current readers of an item, as the approved set recorded its from and to lists. */
async function currentReaders(engine: BrainEngine, item: HandoverItem): Promise<string[] | null | undefined> {
  if (item.kind === 'page') {
    const [row] = await engine.executeRaw<{ id: number; frontmatter: unknown }>('SELECT id, frontmatter FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND slug = $2', [item.source_id, item.slug]);
    if (!row || Number(row.id) !== item.page_id) return undefined;
    return normalizeReaders(typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter);
  }
  if (item.kind === 'rule') {
    const rule = (await currentFolderRules(engine, item.source_id)).find(r => r.id === item.rule_id);
    if (rule && rule.prefix !== item.prefix) return undefined;
    return rule ? rule.readable_by : [];
  }
  const bound = await engine.executeRaw<{ member_id: string }>('SELECT member_id FROM access_member_sources WHERE source_id = $1', [item.source_id]);
  return bound.map(b => b.member_id).sort();
}

/** The approved set is keyed by the member it was previewed for, so an apply naming another member finds none. */
const approvalCommand = (member: string, undoOf?: string | null): PreviewApprovalCommand => undoOf ? `member-handover:${member}:undo:${undoOf}` : `member-handover:${member}`;

const holdsTo = (item: HandoverItem, now: string[] | null | undefined) => item.kind === 'binding' ? !!now?.includes(item.to) && !now.includes(item.from) : now !== undefined && same(now, item.kind === 'page' ? norm(item.to) : item.to ?? []);
const holdsFrom = (item: HandoverItem, now: string[] | null | undefined) => item.kind === 'binding' ? !!now?.includes(item.from) : now !== undefined && same(now, item.from);

export interface ApplyOptions { ctx: OperationContext; expect: string; previewCommand: string; undo?: HandoverRecord; onProgress?: (done: number, total: number) => void }

/**
 * Applies exactly the approved set \`expect\` names (a handover, or with \`undo\` the reversal of one). Resumable: a rerun
 * with the same hash continues the row; items already written count as done. Throws handover_partial (exit 1) after
 * recording when an item was skipped or failed.
 */
export async function applyHandover(engine: BrainEngine, member: string, opts: ApplyOptions): Promise<HandoverRecord> {
  const leaver = await getMember(engine, member);
  if (!leaver) throw opError('not_found', 'No member "' + member + '".', 'List members with gbrain access member list --all.');
  if (!opts.undo && leaver.status === 'enabled') throw handoverError('handover_member_enabled', 'Member "' + leaver.id + '" is enabled again; nothing was written.', 'gbrain access member disable ' + leaver.id, 'A handover takes pages away from the member.');
  if (opts.undo && leaver.status !== 'enabled') throw undoRefusal(leaver);
  const id = handoverId(opts.expect);
  let record = await readRecord(engine, 'plan_hash', opts.expect);
  if (opts.undo && opts.undo.member_id !== leaver.id) throw previewChangedError(opts.expect, opts.previewCommand);
  if (record && (record.member_id !== leaver.id || (record.undo_of ?? null) !== (opts.undo?.id ?? null))) throw previewChangedError(opts.expect, opts.previewCommand);
  const approved = record ? null : await loadApprovedSet<HandoverItem>(engine, { command: approvalCommand(leaver.id, opts.undo?.id), hash: opts.expect, previewCommand: opts.previewCommand });
  if (!record) {
    const items = approved!.items;
    for (const item of items) {
      const now = await currentReaders(engine, item);
      if (!holdsFrom(item, now) && !holdsTo(item, now)) throw previewChangedError(opts.expect, opts.previewCommand);
    }
    for (const source of new Set(items.filter(i => i.kind === 'rule').map(i => i.source_id))) await refuseHeldRules(engine, source);
    await engine.executeRaw('INSERT INTO access_handovers (id, member_id, owner_id, plan_hash, choices, items, state, undo_of) VALUES ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, \'applying\', $7) ON CONFLICT (plan_hash) DO NOTHING',
      [id, leaver.id, await ownerMemberId(engine), opts.expect, JSON.stringify(opts.undo?.choices ?? {}), JSON.stringify(items), opts.undo?.id ?? null]);
    record = (await readRecord(engine, 'plan_hash', opts.expect))!;
  }
  if (record.state === 'undone' || record.state === 'applied') return record;
  const pending = (i: RecordedItem) => i.outcome !== 'done';
  for (const source of [...new Set(record.items.filter(i => i.kind === 'rule' && pending(i)).map(i => i.source_id))]) {
    const rules = record.items.filter((i): i is RecordedItem & RuleItem => i.kind === 'rule' && i.source_id === source && pending(i));
    await refuseHeldRules(engine, source);
    const base = await currentFolderRules(engine, source);
    if (rules.some(i => base.some(r => r.id === i.rule_id && r.prefix !== i.prefix))) throw previewChangedError(opts.expect, opts.previewCommand);
    const desired = sortRules(base.flatMap(r => {
      const item = rules.find(i => i.rule_id === r.id && i.prefix === r.prefix);
      if (!item) return [r];
      if (!holdsFrom(item, r.readable_by)) return [r];
      return item.to ? [{ ...r, readable_by: item.to }] : [];
    }).concat(rules.filter(i => i.to && !base.some(r => r.id === i.rule_id) && i.from.length === 0).map(i => ({ id: i.rule_id, prefix: i.prefix, readable_by: i.to! }))));
    const written = await writeApprovedRules(engine, source, desired, 'access: hand over ' + leaver.id + "'s folder rules (" + record.id + ')');
    record.commits.push(...written.commits);
    const after = await currentFolderRules(engine, source);
    for (const item of rules) {
      const r = after.find(x => x.id === item.rule_id && x.prefix === item.prefix);
      item.outcome = holdsTo(item, r ? r.readable_by : []) ? 'done' : 'failed';
      if (item.outcome === 'failed') item.reason = 'the rule did not take the new readers';
    }
    await saveRecord(engine, record);
  }
  const pages = record.items.filter((i): i is RecordedItem & PageItem => i.kind === 'page' && pending(i));
  let n = 0;
  for (const item of pages) {
    const readersItem: ReadersItem = { cursor: { phase: READERS_PHASE, id: item.page_id }, target: { phase: READERS_PHASE, id: item.page_id }, source_id: item.source_id, slug: item.slug,
      chars: 0, action: 'handover', readers: { from: item.from, to: item.to }, hash: opts.expect };
    if (holdsTo(item, await currentReaders(engine, item))) { item.outcome = 'done'; continue; }
    try {
      const outcome = await visibilityRepair.apply(opts.ctx, readersItem);
      const applied = outcome === true || (typeof outcome === 'object' && outcome.applied);
      item.outcome = applied ? 'done' : 'skipped';
      if (!applied) item.reason = typeof outcome === 'object' ? (outcome.reason ?? outcome.outcome) : 'the page changed since the preview';
    } catch (error) {
      item.outcome = error instanceof OperationError && error.code === 'revision_conflict' ? 'skipped' : 'failed';
      item.reason = error instanceof Error ? error.message : String(error);
    }
    if (++n % 50 === 0) { await saveRecord(engine, record); opts.onProgress?.(n, pages.length); }
  }
  for (const item of record.items.filter((i): i is RecordedItem & BindingItem => i.kind === 'binding' && pending(i))) {
    try {
      await bindMemberSource(engine, item.to, item.source_id);
      if ((await currentReaders(engine, item))?.includes(item.from)) await unbindMemberSource(engine, item.from, item.source_id, { apply: true });
      item.outcome = 'done';
    } catch (error) {
      item.outcome = 'failed';
      item.reason = error instanceof Error ? error.message : String(error);
    }
  }
  record.state = record.items.some(i => i.outcome !== 'done') ? 'partial' : 'applying';
  if (record.state === 'applying') record.state = await publishing(engine, record) ? 'publishing' : 'applied';
  await saveRecord(engine, record);
  if (record.state === 'partial') {
    const left = record.items.filter(i => i.outcome !== 'done');
    throw opError('handover_partial', left.length + ' of ' + record.items.length + ' item(s) of handover ' + record.id + ' were not written; the rest are in place.',
      'Run the same apply command again; it resumes: ' + opts.previewCommand + ' --yes --expect ' + opts.expect, { detail: JSON.stringify({ side_effects: 'partial', handover_id: record.id,
        skipped: left.slice(0, 20).map(i => ({ item: i.kind === 'page' ? pageRef(i) : i.kind === 'rule' ? i.source_id + ':' + i.prefix : i.source_id, reason: i.reason ?? i.outcome })) }),
        fix: { argv: [...opts.previewCommand.split(' '), '--yes', '--expect', opts.expect], consent: [], actor: 'agent', requires_exclusive: false, why: 'Resumes the same approved handover; items already written count as done.' } });
  }
  await clearApprovedSet(engine, { command: approvalCommand(record.member_id, record.undo_of), hash: opts.expect });
  if (opts.undo) await engine.executeRaw('UPDATE access_handovers SET state = \'undone\', undone_at = now(), updated_at = now() WHERE id = $1', [opts.undo.id]);
  return record;
}

/** Refuses while the source has a folder-rule change waiting for approval: writeApprovedRules would approve it too. */
async function refuseHeldRules(engine: BrainEngine, source: string): Promise<void> {
  if ((await coverageRows(engine, source)).some(c => c.reason === 'pending')) await resumePolicy(engine, source);
  if ((await previewApply(engine, source)).widening.length) throw handoverError('handover_rules_held', 'Source ' + source + ' has a folder-rule change waiting for approval; the handover would approve it too, so its folder rules were not written.',
    'gbrain access apply --source ' + source, 'Approving a rule change installs every change waiting for that source, and a handover approves only what it showed.');
}

/** True while a page write of the handover still waits for its Git commit. */
async function publishing(engine: BrainEngine, record: HandoverRecord): Promise<boolean> {
  const sources = [...new Set(record.items.filter(i => i.kind === 'page').map(i => i.source_id))];
  if (!sources.length) return false;
  const scope = await resolveRepairScope(engine);
  record.git = await readersGitCounts(engine, { ...scope, source_ids: sources }, record.plan_hash);
  return Number(record.git.pending ?? 0) > 0;
}

/** --status: re-reads the Git publication of a publishing handover and settles it. */
export async function handoverStatus(engine: BrainEngine, id: string): Promise<HandoverRecord> {
  const record = await getHandover(engine, id);
  if (record.state !== 'publishing') {
    if (record.items.some(i => i.kind === 'page')) await publishing(engine, record);
    return record;
  }
  if (await publishing(engine, record)) return record;
  record.state = Number(record.git?.failed ?? 0) > 0 ? 'partial' : 'applied';
  await saveRecord(engine, record);
  return record;
}

function undoRefusal(leaver: MemberRecord): OperationError {
  return leaver.status === 'removed'
    ? opError('handover_undo_member_disabled', 'Member "' + leaver.id + '" was removed; its handover cannot be undone.', 'Removed ids are never reused. Give the pages to a member with a new handover or gbrain repair visibility --readers.', { reason: 'removed' })
    : handoverError('handover_undo_member_disabled', 'Member "' + leaver.id + '" is disabled; undoing now would leave its pages readable by no member again.', 'gbrain access member enable ' + leaver.id, 'Undo restores the readers the member had, which only helps once it reads again.', 'disabled');
}

/** The undo preview: each item the handover wrote, reversed, minus items changed since (counted as skipped). */
export async function previewUndo(engine: BrainEngine, id: string): Promise<{ handover: HandoverRecord; items: HandoverItem[]; changed_since: number; plan_hash: string }> {
  const handover = await getHandover(engine, id);
  if (handover.undo_of) throw opError('invalid_params', 'Handover ' + id + ' is itself an undo.', 'Undo the original handover once, or start a new handover.');
  if (handover.state === 'undone') throw opError('invalid_params', 'Handover ' + id + ' was already undone.', 'Start a new handover to move the pages again.');
  const leaver = await getMember(engine, handover.member_id);
  if (!leaver || leaver.status !== 'enabled') throw undoRefusal(leaver ?? { id: handover.member_id, status: 'removed' } as MemberRecord);
  const items: HandoverItem[] = [];
  let changedSince = 0;
  for (const item of handover.items.filter(i => i.outcome === 'done')) {
    const { outcome: _o, reason: _r, ...plainItem } = item;
    const reversed: HandoverItem = item.kind === 'page' ? { ...(plainItem as PageItem), from: norm(item.to), to: item.from?.map(plain) ?? null }
      : item.kind === 'rule' ? { ...(plainItem as RuleItem), from: item.to ?? [], to: item.from }
      : { ...(plainItem as BindingItem), from: item.to, to: item.from };
    if (holdsFrom(reversed, await currentReaders(engine, reversed))) items.push(reversed); else changedSince++;
  }
  const plan_hash = previewHash({ kind: 'member-handover-undo-v1', undo_of: id, items });
  if (items.length) await saveApprovedSet<HandoverItem>(engine, { command: approvalCommand(handover.member_id, id), hash: plan_hash }, items);
  return { handover, items, changed_since: changedSince, plan_hash };
}

export const handoverDigest = (items: HandoverItem[]) => digest(items);
