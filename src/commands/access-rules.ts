/**
 * GBRA-218 (PR A2): `gbrain access rule|apply|resume`, the operator surface for folder rules.
 *
 *   gbrain access rule add --prefix <folder/> | --slug <page> --readers a,group:b [--raw-only] [--id <rule>] [--source <id>] [--yes] [--expect <rev>] [--operation <id>]
 *   gbrain access rule rm <rule> [--source <id>] [--yes] [--expect <rev>] [--operation <id>]
 *   gbrain access rule list|status|history [--source <id>] [--operation <id>] [--limit <n>]
 *   gbrain access rule revert --to <revision> [--source <id>] [--yes]
 *   gbrain access rule export [--source <id>] [--approved]
 *   gbrain access rule import --file <access.yml> [--source <id>] [--yes]
 *   gbrain access rule migrate [--to git|database] [--source <id>] [--yes]
 *   gbrain access apply [--source <id>] [--revision <n>] [--yes --expect <plan_hash>]
 *   gbrain access resume [--source <id>]
 *
 * The source's persisted store decides where an edit lands: the database
 * revision log (repo-less sources, the default keyless install) or
 * `.gbrain/access.yml` committed through the git door (git-backed sources). Every
 * edit previews first; narrowing applies at once, widening waits for
 * `gbrain access apply`. Trusted local CLI only.
 */
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { usageError } from '../cli/cli-error.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { opError } from '../core/ops/contract.ts';
import { classifyRulebook, coversDerived, folderRulesAllow, normalizeRule, ruleCovers, ruleCoversSql, parsePolicyYaml, serializePolicyYaml, sortRules, type FolderRule, type RuleChange } from '../core/access/folder-rules.ts';
import { folderHoldingSlug, UNATTRIBUTED_MEMORY_SLUG } from '../core/facts-fence.ts';
import { heldRowsInVersions } from '../core/facts/fence-fact-append.ts';
import { identityFor } from '../core/access/principals.ts';
import { openTwins, openTwinsLines, OPEN_TWINS_PAGES, type OpenTwins } from '../core/access/open-twins.ts';
import { boundCredentials, listGroups, listMembers } from '../core/access/members.ts';
import { ownerReadsRestrictedOn, ownerView } from '../core/access/owner.ts';
import {
  appliedRules, applyApproved, getRevision, listRevisions, newOperationId, policyStatus, previewApply, proposeRevision, readAccessStore, resumePolicy,
  ensurePolicyState, type AccessStore, type ProposalResult, type RestampProgress,
} from '../core/access/policy.ts';
import {
  APPROVED_FILE, isGitWorkTree, POLICY_FILE, rebuildPreflight, sourcePolicyRoot, syncGitPolicy, workingTreeRules, writeApprovedFile, writeGitRules, type GitPolicyReceipt,
} from '../core/access/policy-git.ts';

const VALUE_FLAGS = new Set(['--source', '--prefix', '--slug', '--readers', '--id', '--expect', '--operation', '--to', '--revision', '--file', '--limit']);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw usageError(`${name} requires a value.`, `Put the value right after the flag, as in ${name} VALUE.`);
  return v;
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i]!)) { i++; continue; }
    if (!args[i]!.startsWith('--')) out.push(args[i]!);
  }
  return out;
}

function intFlag(args: string[], name: string): number | undefined {
  const raw = flag(args, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw usageError(`${name} takes a whole number.`, `For example ${name} 3.`);
  return Number(raw);
}

function print(json: boolean, value: unknown, human: () => string[]): void {
  console.log(json ? JSON.stringify(value, null, 2) : human().join('\n'));
}

function progressLogger(json: boolean): (p: RestampProgress) => void {
  let last = 0;
  return p => {
    if (Date.now() - last < 1000) return;
    last = Date.now();
    process.stderr.write(`[access] restamping: ${p.pages_scanned} pages scanned, ${p.pages_restamped} restamped` + '\n');
    void json;
  };
}

const reader = (p: string) => (p.startsWith('member:') ? p.slice(7) : p);
const ruleLine = (r: FolderRule) => `  ${r.id}  ${r.prefix}  readable by ${r.readable_by.map(reader).join(', ') || 'nobody'}${coversDerived(r) ? '' : '  (raw only: its derived pages and facts are not kept to these readers)'}`;

function changeLine(c: RuleChange): string {
  const what = c.kind === 'added' ? 'add rule' : c.kind === 'removed' ? 'remove rule' : c.kind === 'prefix_moved' ? `move rule to ${c.prefix}` : c.kind === 'prefix_released' ? 'release the old prefix of moved rule'
    : c.kind === 'derived_released' ? 'stop keeping derived pages and facts to the readers of (raw only)' : c.kind === 'derived_covered' ? 'keep derived pages and facts to the readers of'
    : c.kind === 'readers_removed' ? `remove readers ${(c.readers ?? []).map(reader).join(', ')} from` : `add readers ${(c.readers ?? []).map(reader).join(', ')} to`;
  return `  ${what} ${c.rule} (${c.prefix}): ${c.narrowing ? 'narrowing, applies at once' : 'widening, held until gbrain access apply'}`;
}

/** The store an edit lands in: the persisted one, else git when the source root is a git work tree, else the database. */
async function resolveStore(engine: BrainEngine, sourceId: string): Promise<{ store: AccessStore; persisted: boolean; root: string | null }> {
  const persisted = await readAccessStore(engine, sourceId);
  const root = await sourcePolicyRoot(engine, sourceId);
  const gitRoot = root && isGitWorkTree(root) ? root : null;
  if (persisted === 'git' && !gitRoot) {
    throw opError('access_policy_store_mismatch', `Source ${sourceId} keeps its folder rules in git, but this host sees no git work tree at its root (${root ?? 'no local path'}); nothing was written.`,
      `Run gbrain access rule migrate --source ${sourceId} to move the rules into the database (preview first), or run this on the host that holds the checkout.`,
      { fix: { argv: ['gbrain', 'access', 'rule', 'migrate', '--source', sourceId], consent: [], actor: 'user', requires_exclusive: false, why: 'Previews moving the applied rulebook into the database store; writes nothing without --yes.',
        verify: { argv: ['gbrain', 'access', 'rule', 'status', '--source', sourceId, '--json'] } } });
  }
  if (persisted) return { store: persisted, persisted: true, root: gitRoot };
  return { store: gitRoot ? 'git' : 'database', persisted: false, root: gitRoot };
}

/** The desired rulebook an edit starts from: the working tree's access.yml on git, the latest revision (else the applied rules) on the database. */
async function baseRules(engine: BrainEngine, sourceId: string, store: AccessStore, root: string | null): Promise<FolderRule[]> {
  if (store === 'git') return workingTreeRules(root!, sourceId);
  return (await getRevision(engine, sourceId))?.rules ?? await appliedRules(engine, sourceId);
}

export interface RulePreview {
  source_id: string;
  store: AccessStore;
  store_persisted: boolean;
  expect: number;
  desired: FolderRule[];
  changes: RuleChange[];
  held: RuleChange[];
  matched_pages: Record<string, number>;
  /** GST-2603: same-slug pages in other sources the narrowed rules leave readable (listed, never approved). */
  open_twins: OpenTwins;
  unknown_readers: string[];
  members_losing: string[];
  credentials_losing: Array<{ member: string; kind: string; name: string }>;
  /**
   * GST-2492: facts a strict source holds on memory/unattributed for an entity this change starts covering, and the page
   * the apply moves each to (its folder's holding page, or the entity's own page, created for an exact page rule).
   */
  held_facts_moving: Array<{ fact_id: number; entity_slug: string; from: string; to: string; because?: 'its page exists' }>;
  /** Struck (withdrawn) held rows of those entities, removed from their holding page with them. */
  held_struck_rows_leaving: number;
  /** The rows of those facts in the shared page's saved versions, and those versions, the apply removes them from (database only; the version the move itself saves is edited too). */
  held_versions_editing: { rows: number; versions: number; pages?: Array<{ slug: string; rows: number; versions: number; segmented_versions_not_edited?: number }>; segmented_versions_not_edited?: number };
  /**
   * GST-2638: with owner reads restricted on (access.owner_reads_restricted) and a live owner, the pages under the prefixes
   * this change starts covering, which read as nobody (the owner's remote callers included) until the apply finishes
   * stamping them.
   */
  owner_reads_pending?: { owner: string; pages: number; prefixes: string[] };
}

async function previewRules(engine: BrainEngine, sourceId: string, store: AccessStore, persisted: boolean, desired: FolderRule[]): Promise<RulePreview> {
  const current = await appliedRules(engine, sourceId);
  const cls = classifyRulebook(current, desired);
  const expect = (await getRevision(engine, sourceId))?.revision ?? 0;
  const prefixes = [...new Set(cls.changes.map(c => c.prefix).concat(cls.changes.map(c => current.find(r => r.id === c.rule)?.prefix ?? c.prefix)))];
  const matched: Record<string, number> = {};
  for (const prefix of prefixes) {
    const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND ${ruleCoversSql('slug', '$2::text')}`, [sourceId, prefix]);
    matched[prefix] = Number(row?.n ?? 0);
  }
  const members = await listMembers(engine, { includeRemoved: true });
  const groups = new Set((await listGroups(engine)).map(g => g.id));
  const known = (p: string) => p.startsWith('group:') ? groups.has(p.slice(6)) : members.some(m => m.id === p.slice(7) && m.status !== 'removed');
  const unknown = [...new Set(desired.flatMap(r => r.readable_by))].filter(p => !known(p)).map(reader).sort();
  const slugs = prefixes.length ? (await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS pfx WHERE ${ruleCoversSql('slug', 'pfx')})`, [sourceId, prefixes])).map(r => r.slug) : [];
  const losing: string[] = [];
  for (const m of members.filter(x => x.status === 'enabled')) {
    const identity = identityFor(m.id, m.groups);
    if (slugs.some(s => folderRulesAllow(s, current, identity) && !folderRulesAllow(s, cls.target, identity))) losing.push(m.id);
  }
  const credentials: RulePreview['credentials_losing'] = [];
  for (const m of losing) for (const c of await boundCredentials(engine, m)) credentials.push({ member: m, kind: c.kind, name: c.name });
  // A narrowing applies at once, so the held facts it covers leave their holding page in the same apply. The preview runs
  // the apply's own planner (planHeldMoves, every holding page), with the desired rules deciding a page-less entity's home.
  const { planHeldMoves, holdingHome } = await import('../core/facts/held-fact-move.ts');
  const covers = (slug: string) => cls.target.some(rule => ruleCovers(slug, rule.prefix));
  const desiredHome = async (key: string) => {
    const now = await holdingHome(engine, sourceId, key);
    if (!now || ('refused' in now && now.refused === 'access_unreadable')) return now;
    if (cls.target.some(rule => rule.prefix === key)) return { refused: 'page_rule' as const };
    return { slug: covers(key) ? folderHoldingSlug(key) : UNATTRIBUTED_MEMORY_SLUG };
  };
  const plan = await planHeldMoves(engine, sourceId, { home: desiredHome, hidden: covers });
  // A row the apply moves only because its entity's page now exists (as the next maintenance cycle would) says so.
  const moving = plan.groups.flatMap(g => g.group.map(row => ({ fact_id: Number(row.id), entity_slug: row.entity_slug!, from: g.from, to: g.slug,
    ...(g.kind === 'page' && !covers(g.slug) ? { because: 'its page exists' as const } : {}) })));
  // A2: each move whose note is `moved` also removes its rows (and the entity's struck rows) from the saved versions of the
  // page it leaves (database only; Git history stays): the versions carrying them now, plus the one each move on that page
  // saves before it (the k-th move there finds its rows in k such versions).
  const pages = new Map<string, { slug: string; rows: number; versions: number; segmented_versions_not_edited?: number }>(), moves = new Map<string, number>();
  for (const g of plan.groups) {
    const k = (moves.get(g.from) ?? 0) + 1;
    moves.set(g.from, k);
    if (g.note !== 'moved') continue;
    const keys = [...g.group.map(row => ({ entity: row.entity_slug!, claim: row.fact })), ...g.struck];
    const v = await heldRowsInVersions(engine, sourceId, g.from, keys, false);
    const page = pages.get(g.from) ?? { slug: g.from, rows: 0, versions: 0 };
    pages.set(g.from, { ...page, rows: page.rows + v.rows + k * keys.length, versions: page.versions + v.versions + k, ...(v.segmented ? { segmented_versions_not_edited: v.segmented } : {}) });
  }
  const edits = [...pages.values()], segmented = Math.max(0, ...edits.map(p => p.segmented_versions_not_edited ?? 0));
  const twins: OpenTwins = { count: 0, twins: [], commands: [] };
  for (const rule of cls.changes.filter(c => c.narrowing).map(c => cls.target.find(r => r.id === c.rule)).filter(r => r !== undefined)) {
    const covered = await engine.executeRaw<{ source_id: string; slug: string }>(`SELECT source_id, slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND ${ruleCoversSql('slug', '$2::text')} ORDER BY slug LIMIT ${OPEN_TWINS_PAGES}`, [sourceId, rule.prefix]);
    const found = await openTwins(engine, covered, rule.readable_by,
      source => `gbrain access rule add ${rule.prefix.endsWith('/') ? '--prefix' : '--slug'} ${rule.prefix} --readers ${rule.readable_by.map(reader).join(',')} --source ${source}`);
    Object.assign(twins, { count: twins.count + found.count, twins: [...twins.twins, ...found.twins], commands: [...twins.commands, ...found.commands] });
  }
  const owner = await ownerReadsRestrictedOn(engine) ? (await ownerView(engine)).owner : null;
  const covering = [...new Set(cls.target.filter(r => !current.some(c => c.id === r.id && c.prefix === r.prefix)).map(r => r.prefix))].sort();
  const [ownerPages] = owner && covering.length ? await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS pfx WHERE ${ruleCoversSql('slug', 'pfx')})`, [sourceId, covering]) : [];
  return { source_id: sourceId, store, store_persisted: persisted, expect, desired, changes: cls.changes, held: cls.held, matched_pages: matched,
    ...(owner && covering.length ? { owner_reads_pending: { owner, pages: Number(ownerPages?.n ?? 0), prefixes: covering } } : {}),
    unknown_readers: unknown, members_losing: losing, credentials_losing: credentials, held_facts_moving: moving,
    held_struck_rows_leaving: plan.groups.reduce((n, g) => n + (g.note === 'moved' ? g.struck.length : 0), 0),
    held_versions_editing: { rows: edits.reduce((n, p) => n + p.rows, 0), versions: edits.reduce((n, p) => n + p.versions, 0),
      ...(edits.length ? { pages: edits } : {}), ...(segmented ? { segmented_versions_not_edited: segmented } : {}) }, open_twins: twins };
}

function previewLines(p: RulePreview, rerun: string): string[] {
  return [
    `Source ${p.source_id} (${p.store} store${p.store_persisted ? '' : ', chosen now: set with the first rule'}), desired revision ${p.expect}`,
    ...(p.changes.length ? p.changes.map(changeLine) : ['  no change']),
    ...Object.entries(p.matched_pages).map(([prefix, n]) => `  ${prefix}: ${n} page(s) match`),
    ...(p.unknown_readers.length ? [`  Unknown readers (no such member or group; they match nobody): ${p.unknown_readers.join(', ')}`] : []),
    ...(p.members_losing.length ? [`  Members losing access: ${p.members_losing.join(', ')}`] : []),
    ...(p.credentials_losing.length ? [`  Credentials losing access: ${p.credentials_losing.map(c => `${c.kind} ${c.name} (${c.member})`).join(', ')}`] : []),
    ...openTwinsLines(p.open_twins),
    ...(p.owner_reads_pending ? [`  Owner reads restricted: the owner's (${p.owner_reads_pending.owner}) remote callers read none of the ${p.owner_reads_pending.pages} page(s) under ${p.owner_reads_pending.prefixes.join(', ')} until this apply finishes stamping them`] : []),
    ...(p.held_facts_moving.length ? [`  Held facts leaving their holding page with this change: ${p.held_facts_moving.length} (${p.held_facts_moving.slice(0, 10).map(m => `fact ${m.fact_id} for ${m.entity_slug} from ${m.from} to ${m.to}${m.to === m.entity_slug ? ' (its page)' : ''}${m.because ? `, because ${m.because}` : ''}`).join(', ')}${p.held_facts_moving.length > 10 ? ', ...' : ''})`] : []),
    ...(p.held_struck_rows_leaving ? [`  ${p.held_struck_rows_leaving} struck (withdrawn) held row(s) of those entities leave their holding page with them`] : []),
    ...(p.held_versions_editing.pages ?? []).flatMap(e => [
      ...(e.versions ? [`  Their rows also leave ${e.versions} saved version(s) of ${e.slug} (${e.rows} row(s); database only, Git history is not rewritten)`] : []),
      ...(e.segmented_versions_not_edited ? [`  Not edited: ${e.segmented_versions_not_edited} saved version(s) of ${e.slug} are stored in segments, which this apply cannot edit. ${segmentedConsequence(e.slug, e.segmented_versions_not_edited)} The apply will report itself incomplete.`] : [])]),
    'Pages under no rule are unchanged; unbound credentials and stdio read no page under a rule.',
    `Nothing written. To approve, add --yes --expect ${p.expect} (${rerun}).`,
  ];
}

export interface EditResult {
  source_id: string;
  store: AccessStore;
  operation_id: string;
  applied: boolean;
  state: ProposalResult['state'] | 'invalid';
  revision: number | null;
  change_kind: string;
  changes: RuleChange[];
  held: RuleChange[];
  pages_restamped: number;
  git?: GitPolicyReceipt;
  note?: string;
  /** GST-2492: held facts this apply moved off memory/unattributed to a page the new rules cover, and those that could not move. */
  held_facts?: { moved: number; unmovable: Array<{ slug: string; fact_ids: number[]; reason: string }>; complete?: false; segmented_versions_not_edited?: number;
    segmented_pages?: Array<{ slug: string; versions: number }>; pending?: Array<{ slug: string; from: string; request_id: string }> };
}

/** GST-2492 (B): what an unedited segmented saved version of a holding page leaves readable. */
const segmentedConsequence = (slug: string, n: number) => `Readers of ${slug}'s saved versions can still read the moved rows in up to ${n} of those version(s).`;

/** The words of a held-fact move left incomplete: segmented saved versions of the page it left unedited, or a move still pending. */
function heldIncompleteLines(held: EditResult['held_facts']): string[] {
  return [...(held?.segmented_pages ?? []).map(p => `  Incomplete: the held facts moved, but ${p.versions} saved version(s) of ${p.slug} are stored in segments and were not edited. ${segmentedConsequence(p.slug, p.versions)}`),
    ...(held?.pending ?? []).map(p => `  Incomplete: the move of held facts off ${p.from} to ${p.slug} is accepted and still pending (request ${p.request_id}; gbrain write-request ${p.request_id} shows it); until it commits they read as they did on ${p.from}.`)];
}

/**
 * GST-2492: a narrowing applies at once, held facts included: after the rules apply, each fact a strict source holds on
 * memory/unattributed for an entity the rules now cover moves to its folder's holding page (or into the entity's page),
 * the same step the extract_facts upkeep runs. A source that is not strict holds none.
 */
async function withHeldFactsMoved(engine: BrainEngine, result: EditResult): Promise<EditResult> {
  if (result.state !== 'applied' && result.state !== 'pending') return result;
  const held = await heldFactsMoved(engine, result.source_id);
  return held ? { ...result, held_facts: held } : result;
}

/** The held-fact move after any rule apply (edit, approved widening, resume); undefined when nothing was held. */
async function heldFactsMoved(engine: BrainEngine, sourceId: string): Promise<EditResult['held_facts']> {
  const { moveHeldFacts } = await import('../core/facts/held-fact-move.ts');
  const moved = await moveHeldFacts(engine, sourceId).catch((error: unknown) => ({ moved: 0, rehomed: 0, segmented_versions_not_edited: 0, segmented_pages: [], pending: [],
    unmovable: [{ slug: UNATTRIBUTED_MEMORY_SLUG, fact_ids: [], reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) }] }));
  if (!moved.moved && !moved.rehomed && !moved.unmovable.length && !moved.pending.length) return undefined;
  const segmented = moved.segmented_versions_not_edited;
  return { moved: moved.moved + moved.rehomed, unmovable: moved.unmovable.map(({ slug, fact_ids, reason }) => ({ slug, fact_ids, reason })),
    ...(segmented || moved.pending.length ? { complete: false as const } : {}),
    ...(segmented ? { segmented_versions_not_edited: segmented, segmented_pages: moved.segmented_pages } : {}), ...(moved.pending.length ? { pending: moved.pending } : {}) };
}

/** Writes a desired rulebook through the source's store (after the caller's preview) and reports the result. */
async function writeRules(engine: BrainEngine, sourceId: string, desired: FolderRule[], opts: { expect?: number; operation?: string; message: string; json: boolean }): Promise<EditResult> {
  const { store, root } = await resolveStore(engine, sourceId);
  const operationId = opts.operation ?? newOperationId();
  if (!opts.json) process.stderr.write(`[access] operation ${operationId} (if this reply is lost: gbrain access rule status --source ${sourceId} --operation ${operationId})` + '\n');
  if (store === 'database') {
    const r = await proposeRevision(engine, sourceId, desired, { origin: 'cli', operationId, expectDesired: opts.expect, store: 'database', onProgress: progressLogger(opts.json) });
    return withHeldFactsMoved(engine, { source_id: sourceId, store, operation_id: operationId, applied: r.state === 'applied' || r.state === 'unchanged', state: r.state, revision: r.revision,
      change_kind: r.change_kind, changes: r.changes, held: r.held, pages_restamped: r.pages_restamped, ...(r.reconciled ? { note: 'This operation was already recorded; nothing new was written.' } : {}) });
  }
  if (opts.expect !== undefined) {
    const latest = (await getRevision(engine, sourceId))?.revision ?? 0;
    if (latest !== opts.expect) throw opError('preview_changed', `Source ${sourceId}'s folder rules changed since the preview (previewed revision ${opts.expect}, now ${latest}); nothing was written.`, 'Preview again and rerun with the new --expect value.');
  }
  await ensurePolicyState(engine, sourceId);
  const { receipt, sync } = await writeGitRules(engine, sourceId, root!, desired, opts.message, progressLogger(opts.json));
  const p = sync.proposal;
  return withHeldFactsMoved(engine, { source_id: sourceId, store, operation_id: operationId, applied: sync.state === 'applied' || sync.state === 'unchanged', state: sync.state === 'skipped' ? 'unchanged' : sync.state,
    revision: p?.revision ?? null, change_kind: p?.change_kind ?? 'unchanged', changes: p?.changes ?? [], held: p?.held ?? [], pages_restamped: p?.pages_restamped ?? 0, git: receipt,
    ...(receipt.note ? { note: receipt.note } : {}) });
}

function editLines(r: EditResult): string[] {
  return [
    `Source ${r.source_id} (${r.store} store): revision ${r.revision ?? '-'} ${r.state}`,
    ...r.changes.map(changeLine),
    ...(r.git ? [`  ${r.git.path} committed ${r.git.commit?.slice(0, 12) ?? '(nothing to commit)'} (${r.git.outcome})`] : []),
    ...(r.pages_restamped ? [`  ${r.pages_restamped} page(s) restamped`] : []),
    ...(r.held_facts?.moved ? [`  ${r.held_facts.moved} held fact(s) moved to a page the rules now cover`] : []),
    ...(r.held_facts?.unmovable.length ? [`  Held facts that could not move yet (the next gbrain dream retries): ${r.held_facts.unmovable.map(u => `${u.slug} facts ${u.fact_ids.join(',')} (${u.reason})`).join('; ')}`] : []),
    ...heldIncompleteLines(r.held_facts),
    ...(r.held.length ? [`Held: preview with gbrain access apply --source ${r.source_id}`] : []),
    ...(r.state === 'pending' ? [`Still pending: finish with gbrain access resume --source ${r.source_id}`] : []),
    ...(r.note ? [r.note] : []),
  ];
}

/**
 * GST-363: adds folder rules through the same path as `gbrain access rule add`: one desired rulebook (the store's
 * base plus `rules`), previewed, then written with the preview's revision as --expect when `apply` is set.
 */
export async function addFolderRules(engine: BrainEngine, sourceId: string, rules: FolderRule[], opts: { apply: boolean; json: boolean }): Promise<{ preview: RulePreview; result: EditResult | null }> {
  const { store, persisted, root } = await resolveStore(engine, sourceId);
  const base = await baseRules(engine, sourceId, store, root);
  const desired = sortRules([...base.filter(b => !rules.some(r => r.id === b.id)), ...rules]);
  const preview = await previewRules(engine, sourceId, store, persisted, desired);
  if (!opts.apply) return { preview, result: null };
  const message = `access: ${rules.map(r => `rule ${r.id} on ${r.prefix} readable by ${r.readable_by.map(reader).join(', ')}`).join('; ')}`;
  return { preview, result: await writeRules(engine, sourceId, desired, { expect: preview.expect, message, json: opts.json }) };
}

/** The rulebook a new edit would start from (the store's base), for callers that plan rules before adding them. */
export async function currentFolderRules(engine: BrainEngine, sourceId: string): Promise<FolderRule[]> {
  const { store, root } = await resolveStore(engine, sourceId);
  return baseRules(engine, sourceId, store, root);
}

async function ruleCmd(engine: BrainEngine, sub: string | undefined, args: string[], json: boolean): Promise<void> {
  const sourceId = flag(args, '--source') ?? 'default';
  const yes = args.includes('--yes');
  const expect = intFlag(args, '--expect');
  const operation = flag(args, '--operation');
  switch (sub) {
    case 'add':
    case 'rm':
    case 'revert':
    case 'import': {
      const { store, persisted, root } = await resolveStore(engine, sourceId);
      const refusal = store === 'git' ? await rebuildPreflight(engine, sourceId, root!) : null;
      if (refusal) throw refusal;
      const base = await baseRules(engine, sourceId, store, root);
      let desired: FolderRule[];
      let message: string;
      if (sub === 'add') {
        const readers = flag(args, '--readers');
        const slug = flag(args, '--slug');
        const r = normalizeRule({ ...(slug === undefined ? { prefix: flag(args, '--prefix') } : { slug, ...(flag(args, '--prefix') === undefined ? {} : { prefix: flag(args, '--prefix') }) }), readable_by: readers === undefined ? undefined : readers.split(',').map(s => s.trim()).filter(Boolean), ...(flag(args, '--id') ? { id: flag(args, '--id') } : {}), ...(args.includes('--raw-only') ? { covers_derived: false } : {}) });
        if ('problem' in r) {
          throw opError('access_rule_invalid', `The rule is invalid: ${r.problem}.`, 'Nothing was written. Example: gbrain access rule add --prefix partners/alice-example/ --readers alice-example,group:team-a');
        }
        const taken = flag(args, '--id') === undefined ? base.find(b => b.id === r.rule.id && b.prefix !== r.rule.prefix) : undefined;
        if (taken) throw opError('access_rule_invalid', `Rule id "${taken.id}" already names ${taken.prefix}, and ${r.rule.prefix} derives the same id.`, `Nothing was written. Name the new rule yourself: gbrain access rule add --id <rule> ${r.rule.prefix.endsWith('/') ? '--prefix' : '--slug'} ${r.rule.prefix} --readers <list>.`);
        const clash = base.find(b => b.prefix === r.rule.prefix && b.id !== r.rule.id);
        if (clash) throw opError('access_rule_invalid', `Rule "${clash.id}" already covers ${r.rule.prefix}.`, `Nothing was written. Change that rule's readers instead: gbrain access rule add --id ${clash.id} ${r.rule.prefix.endsWith('/') ? '--prefix' : '--slug'} ${r.rule.prefix} --readers <list>.`);
        desired = sortRules([...base.filter(b => b.id !== r.rule.id), r.rule]);
        message = `access: rule ${r.rule.id} on ${r.rule.prefix} readable by ${r.rule.readable_by.map(reader).join(', ')}${coversDerived(r.rule) ? '' : ' (raw only)'}`;
      } else if (sub === 'rm') {
        const id = positionals(args)[0];
        if (!id) throw usageError('rule rm needs a rule id.', 'gbrain access rule rm <rule> --source <id> (gbrain access rule list shows the ids)');
        if (!base.some(b => b.id === id)) throw opError('not_found', `Source ${sourceId} has no rule "${id}".`, `List rules with gbrain access rule list --source ${sourceId}.`);
        desired = base.filter(b => b.id !== id);
        message = `access: remove rule ${id}`;
      } else if (sub === 'revert') {
        const to = intFlag(args, '--to');
        if (to === undefined) throw usageError('rule revert needs --to <revision>.', `gbrain access rule history --source ${sourceId} lists revisions.`);
        const rev = await getRevision(engine, sourceId, to);
        if (!rev) throw opError('not_found', `Source ${sourceId} has no folder-rule revision ${to}.`, `List revisions with gbrain access rule history --source ${sourceId}.`);
        desired = rev.rules;
        message = `access: revert folder rules to revision ${to}`;
      } else {
        const file = flag(args, '--file');
        if (!file) throw usageError('rule import needs --file <access.yml>.', 'gbrain access rule import --file access.yml --source <id>');
        const parsed = parsePolicyYaml(readFileSync(file, 'utf8'));
        if (!parsed.ok) throw opError('access_policy_invalid', `${file} does not validate: ${parsed.problems.map(p => `${p.line ? `line ${p.line}: ` : ''}${p.message}`).join('; ')}.`, 'Nothing was written. Fix the file and run the import again.');
        desired = parsed.rules;
        message = `access: import folder rules`;
      }
      const preview = await previewRules(engine, sourceId, store, persisted, desired);
      if (!yes) {
        return print(json, { ...preview, applied: false }, () => previewLines(preview, `gbrain access rule ${[sub, ...args.filter(a => a !== '--json')].join(' ')} --yes`));
      }
      const r = await writeRules(engine, sourceId, desired, { expect, operation, message, json });
      if (r.state === 'invalid') setCliExitVerdict(1);
      return print(json, r, () => editLines(r));
    }
    case 'list':
    case 'status': {
      const s = await policyStatus(engine, sourceId, operation);
      const { root } = await resolveStore(engine, sourceId).catch(() => ({ root: null }));
      const mismatch = s.store === 'database' && !!root ? 'This source now has a git work tree but keeps its rules in the database; gbrain access rule migrate moves them into .gbrain/access.yml.' : undefined;
      return print(json, { ...s, ...(mismatch ? { store_mismatch: mismatch } : {}) }, () => [
        `Source ${sourceId}: ${s.store ?? 'no folder rules yet'}${s.store === 'git' ? ` (${POLICY_FILE})` : s.store === 'database' ? ' (revision log)' : ''}`,
        `  Revisions: desired ${s.desired?.revision ?? '-'}, applied ${s.applied_revision ?? '-'}, approved ${s.approved_revision ?? '-'}`,
        ...(s.rules.length ? ['Applied rules:', ...s.rules.map(ruleLine)] : ['  No applied rule: no folder restricts reads.']),
        ...(s.held.length ? ['Held widening (gbrain access apply previews it):', ...s.held.map(changeLine)] : []),
        ...(s.pending.length ? [`Pending (reads as nobody until stamped; gbrain access resume --source ${sourceId}): ${s.pending.map(c => c.prefix || '(whole source)').join(', ')}`] : []),
        ...s.invalid.flatMap(c => {
          const detail = c.detail as { problems?: Array<{ line: number | null; message: string }>; commit?: string } | null;
          return [`Invalid policy file${detail?.commit ? ` at ${detail.commit}` : ''} (reads as nobody: ${c.prefix || 'the whole source'}):`,
            ...(detail?.problems ?? []).map(p => `  ${p.line ? `line ${p.line}: ` : ''}${p.message}`)];
        }),
        ...(s.operation ? [`Operation ${s.operation.operation_id}: ${s.operation.state}${s.operation.revision ? ` (revision ${s.operation.revision})` : ''}`] : []),
        ...(mismatch ? [mismatch] : []),
      ]);
    }
    case 'history': {
      const revisions = await listRevisions(engine, sourceId, intFlag(args, '--limit') ?? 50);
      return print(json, { source_id: sourceId, revisions }, () => revisions.length ? revisions.map(r =>
        `  ${r.revision}  ${r.created_at}  ${r.change_kind}  ${r.origin}  by ${r.proposed_by ?? '?'}${r.approved_at ? `  approved by ${r.approved_by}` : '  held'}${r.applied_at ? '' : '  (not yet applied)'}  ${r.rules.length} rule(s)`)
        : ['No folder-rule revisions.']);
    }
    case 'export': {
      const s = await policyStatus(engine, sourceId);
      const rules = args.includes('--approved') ? (await listRevisions(engine, sourceId, 500)).find(r => r.approved_at)?.rules ?? s.rules : s.desired?.rules ?? s.rules;
      if (json) return print(true, { source_id: sourceId, rules }, () => []);
      console.log(serializePolicyYaml(rules).trimEnd());
      return;
    }
    case 'migrate': {
      const to = flag(args, '--to');
      if (to !== undefined && to !== 'git' && to !== 'database') throw usageError('rule migrate --to takes git or database.', `gbrain access rule migrate --to database --source ${sourceId}`);
      return migrateCmd(engine, sourceId, yes, json, to);
    }
    default:
      throw usageError(`Unknown access rule subcommand: ${sub ?? '(none)'}.`, 'Use add, rm, list, status, history, revert, export, import or migrate (gbrain access --help).');
  }
}

async function migrateCmd(engine: BrainEngine, sourceId: string, yes: boolean, json: boolean, to?: AccessStore): Promise<void> {
  const { migrateAccessStore, previewMigrate } = await import('../core/access/policy-migrate.ts');
  if (!yes) {
    const p = await previewMigrate(engine, sourceId, to);
    return print(json, { ...p, applied: false }, () => [
      `Source ${sourceId}: move folder rules from the ${p.from ?? 'unset'} store to the ${p.to} store`,
      ...(p.to === 'git' ? [`  Writes ${POLICY_FILE} (desired, ${p.desired.length} rule(s)) and ${APPROVED_FILE} (approved, ${p.approved.length} rule(s)) under ${p.root} and commits them through gbrain git commit-push.`]
        : [p.from ? '  The applied rulebook, pending coverage and held widenings stay in the database, which becomes the record.'
          : '  Sets the database store (sources.config.access_store) and records the migration; commits nothing and writes no file, so a checkout that cannot take commits keeps its rules in the database.']),
      '  The applied rules stay in force throughout; no rule is missing at any point.',
      ...(p.resume ? [`  Resumes migration ${p.resume.id} (phase ${p.resume.phase}).`] : []),
      'Nothing written. To apply, add --yes.',
    ]);
  }
  const r = await migrateAccessStore(engine, sourceId, to);
  return print(json, r, () => [`Source ${sourceId}: folder rules now in the ${r.to} store (migration ${r.id}, phase ${r.phase})`,
    ...Object.entries(r.receipts).map(([k, v]) => `  ${k}: ${typeof v === 'object' && v ? (v as { commit?: string }).commit ?? JSON.stringify(v) : String(v)}`)]);
}

async function applyCmd(engine: BrainEngine, args: string[], json: boolean): Promise<void> {
  const sourceId = flag(args, '--source') ?? 'default';
  const revision = intFlag(args, '--revision');
  if (!args.includes('--yes')) {
    const p = await previewApply(engine, sourceId, revision);
    return print(json, { ...p, applied: false }, () => [
      `Source ${sourceId}: ${p.desired ? `desired revision ${p.desired.revision} (${p.desired.origin}, by ${p.desired.proposed_by ?? '?'}, ${p.desired.created_at})` : 'no folder-rule revision'}`,
      ...(p.proposals.length ? [`  Proposals not yet approved: ${p.proposals.map(x => `${x.revision} (${x.change_kind})`).join(', ')}`] : []),
      ...(p.widening.length ? p.widening.flatMap(w => [changeLine(w.change),
        w.lineage ? `    ${w.pages} page(s) under it stay kept to its readers, but their derived pages and facts stop being kept to them${w.sample.length ? `: ${w.sample.slice(0, 5).join(', ')}${w.pages > 5 ? ', ...' : ''}` : ''}`
          : `    ${w.pages} page(s) gain readers${w.sample.length ? `: ${w.sample.slice(0, 5).join(', ')}${w.pages > 5 ? ', ...' : ''}` : ''}`,
        w.lineage ? '    Gaining access to those derived pages and facts: whoever reads them (a summary of a raw-only page reads like any other page)'
          : `    Gaining access: ${w.gains === 'every_source_reader' ? 'every caller entitled to the source, unbound credentials included' : w.gains.join(', ') || 'no enabled member'}`])
        : ['  Nothing is held: the applied rules already match.']),
      ...(p.plan_hash ? [`Nothing written; approve with gbrain access apply --source ${sourceId}${revision ? ` --revision ${revision}` : ''} --yes --expect ${p.plan_hash}`] : []),
    ]);
  }
  const expect = flag(args, '--expect');
  if (!expect) throw usageError('access apply --yes needs --expect <plan_hash> from the preview.', `Preview first: gbrain access apply --source ${sourceId}`);
  const r = await applyApproved(engine, sourceId, { revision, expect, onProgress: progressLogger(json) });
  let git: GitPolicyReceipt | undefined;
  if ((await readAccessStore(engine, sourceId)) === 'git') {
    const root = await sourcePolicyRoot(engine, sourceId);
    const approved = (await getRevision(engine, sourceId, r.revision ?? undefined))?.rules ?? [];
    if (!root || !isGitWorkTree(root)) {
      throw opError('access_policy_store_mismatch', `The widening is applied in the database, but ${APPROVED_FILE} could not be committed: this host sees no git work tree for source ${sourceId}.`,
        `Run gbrain access apply --source ${sourceId} on the host that holds the checkout, or gbrain access rule migrate --source ${sourceId} to keep the rules in the database.`);
    }
    git = await writeApprovedFile(root, approved, `access: approve folder rules revision ${r.revision}`);
    await syncGitPolicy(engine, sourceId, root);
  }
  const held = await heldFactsMoved(engine, sourceId);
  return print(json, { ...r, ...(git ? { git } : {}), ...(held ? { held_facts: held } : {}) }, () => [`Source ${sourceId}: revision ${r.revision} approved and applied (${r.pages_restamped} page(s) restamped)`,
    ...(git ? [`  ${git.path} committed ${git.commit?.slice(0, 12) ?? '(unchanged)'} (${git.outcome})`] : []),
    ...(r.held.length ? [`A later revision still holds ${r.held.length} widening change(s); preview with gbrain access apply --source ${sourceId}`] : []), ...heldIncompleteLines(held)]);
}

/** Dispatches `gbrain access rule|apply|resume`; false when `cmd` is not one of them. */
export async function runAccessRules(engine: BrainEngine, cmd: string, rest: string[], json: boolean): Promise<boolean> {
  switch (cmd) {
    case 'rule': await ruleCmd(engine, rest[0], rest.slice(1), json); return true;
    case 'apply': await applyCmd(engine, rest, json); return true;
    case 'resume': {
      const sourceId = flag(rest, '--source') ?? 'default';
      const r = await resumePolicy(engine, sourceId, progressLogger(json));
      const held = await heldFactsMoved(engine, sourceId);
      print(json, { source_id: sourceId, ...r, ...(held ? { held_facts: held } : {}) }, () => [`Source ${sourceId}: ${r.pages_restamped} page(s) restamped${r.pending_before.length ? `; pending prefixes cleared: ${r.pending_before.map(p => p || '(whole source)').join(', ')}` : '; nothing was pending'}`, ...heldIncompleteLines(held)]);
      return true;
    }
    default: return false;
  }
}
