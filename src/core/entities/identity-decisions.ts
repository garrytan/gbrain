/**
 * The owner's duplicate-people decisions (plan autoplan-20261117192252, Decision B and review round 2): "same person"
 * (gbrain dedupe confirm) and "different people" (gbrain dedupe reject) on a group of person or company pages, kept by
 * (source_id, slug).
 *
 * Where they live. On a brain whose home source (the default source, when it is writable and its root is a git work tree)
 * has a repository, each decision is `.gbrain/identity/<decision_id>.md` there, frontmatter
 * only, committed through the one door (gbrain git commit-push's commit lock and push) before anything reaches the
 * database: the entity_identity_reviews rows are its projection, read from the committed files at HEAD (sync repeats it),
 * so a failed commit leaves no row and a database rebuilt from git gets every decision back. A pair whose pages sit in a
 * read-only source is recorded in the home source, never in that source. On a brain with no repository the rows are the
 * record. Either way engine.applyIdentityDecisions materializes a "same" decision into entity_identities rows
 * ('dedupe:confirm') for the pages that exist, in the same transaction.
 *
 * A decision file names every member's (source_id, slug), so a decision across sources writes each member's source and
 * slug into the default source's repository; recordDecisions therefore refuses a group with a page in an owner-only
 * source there (dedupe_group_not_confirmable, reason owner_only_source), while a repo-less brain records it as a row.
 *
 * A store mismatch (decisions projected from git, but this host sees no repository for the brain) refuses with
 * dedupe_decision_store_mismatch instead of writing a decision only the database would hold.
 */
import { createHash } from 'node:crypto';
import { isOwnerOnlySourceConfig } from '../access/owner-only.ts';
import { withEngineScope } from '../engine-scope.ts';
import { DEFAULT_SOURCE_ID } from '../sync-failure-ledger.ts';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { dump, JSON_SCHEMA } from 'js-yaml';
import { loadBoundedYaml } from '../data-frontmatter.ts';
import type { BrainEngine } from '../engine.ts';
import type { ApplyIdentityDecisionsResult, IdentityDecision, IdentityDecisionsRead, IdentityMemberRef, IdentityVerdict, PendingIdentityMember } from '../engine-sql/identity-decisions.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { isGitWorkTree, sourcePolicyRoot } from '../access/policy-git.ts';
import { acquireCommitLock, checkoutRoot, commitAndPush, COMMIT_LOCK_ENV } from '../git/commit-push.ts';
import { execFileBounded } from '../bounded-child-exec.ts';
import { gitChildEnv } from '../git-env.ts';
import { HARDENED_GIT_ARGS, NO_LAZY_FETCH_ENV } from '../hardened-git.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { spawnSync } from '../spawn.ts';

export const IDENTITY_DIR = '.gbrain/identity';
const DECISION_ID = /^[0-9a-f]{16}$/;

/** A decision before it is stored: who, what and when, without where it lives. */
export type DecisionInput = Pick<IdentityDecision, 'verdict' | 'members' | 'group_id' | 'entity_id' | 'canonical' | 'decided_by'> & { evidence?: string[] | null };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const memberKey = (m: IdentityMemberRef) => `${m.source_id}\t${m.slug}`;

export function sortMembers(members: readonly IdentityMemberRef[]): IdentityMemberRef[] {
  return [...new Map(members.map(m => [memberKey(m), { source_id: m.source_id, slug: m.slug }])).values()]
    .sort((a, b) => cmp(a.source_id, b.source_id) || cmp(a.slug, b.slug));
}

/** The decision id of a member set: 16 hex of sha256 over the sorted member lines, so one set has one decision and one file. */
export function decisionId(members: readonly IdentityMemberRef[]): string {
  return createHash('sha256').update(sortMembers(members).map(memberKey).join('\n')).digest('hex').slice(0, 16);
}

export const decisionPath = (id: string) => `${IDENTITY_DIR}/${id}.md`;

export function serializeDecision(d: DecisionInput & { decided_at: string }): string {
  const fm: Record<string, unknown> = { verdict: d.verdict, members: sortMembers(d.members) };
  if (d.group_id) fm.group_id = d.group_id;
  if (d.entity_id) fm.entity_id = d.entity_id;
  if (d.canonical) fm.canonical = { source_id: d.canonical.source_id, slug: d.canonical.slug };
  if (d.verdict === 'different' && d.evidence?.length) fm.evidence = [...d.evidence].sort();
  fm.decided_by = d.decided_by;
  fm.decided_at = d.decided_at;
  return `---\n${dump(fm, { lineWidth: -1, noRefs: true })}---\n`;
}

const isRef = (v: unknown): v is IdentityMemberRef => !!v && typeof v === 'object'
  && typeof (v as IdentityMemberRef).source_id === 'string' && typeof (v as IdentityMemberRef).slug === 'string';

/** A decision file's content, or null when it does not validate (wrong shape, or its name is not its members' id). */
export function parseDecisionFile(text: string, id: string): (DecisionInput & { decided_at: string }) | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n?---\s*$/.exec(text);
  if (!m) return null;
  let fm: unknown;
  try { fm = loadBoundedYaml(m[1]!, { schema: JSON_SCHEMA }); } catch { return null; }
  if (!fm || typeof fm !== 'object') return null;
  const f = fm as Record<string, unknown>;
  const verdict = f.verdict;
  if (verdict !== 'same' && verdict !== 'different') return null;
  if (!Array.isArray(f.members) || !f.members.every(isRef)) return null;
  const members = sortMembers(f.members as IdentityMemberRef[]);
  if (members.length < 2 || decisionId(members) !== id) return null;
  const entityId = typeof f.entity_id === 'string' ? f.entity_id : null;
  if (verdict === 'same' && !entityId) return null;
  const canonical = isRef(f.canonical) && members.some(x => memberKey(x) === memberKey(f.canonical as IdentityMemberRef)) ? f.canonical as IdentityMemberRef : null;
  const decidedAt = typeof f.decided_at === 'string' ? Date.parse(f.decided_at) : 0;
  if (Number.isNaN(decidedAt)) return null;
  const evidence = Array.isArray(f.evidence) ? f.evidence.filter((e): e is string => typeof e === 'string' && /^[0-9a-f]{32}$/.test(e)).sort() : [];
  return {
    verdict: verdict as IdentityVerdict, members, group_id: typeof f.group_id === 'string' ? f.group_id : null,
    entity_id: verdict === 'same' ? entityId : null, canonical: verdict === 'same' ? canonical : null,
    decided_by: typeof f.decided_by === 'string' ? f.decided_by : 'unknown', decided_at: new Date(decidedAt).toISOString(),
    evidence: verdict === 'different' && evidence.length ? evidence : null,
  };
}

export interface IdentityHome { sourceId: string; root: string }

/** The source whose repository holds the decisions: the default source, when it is not a read-only mirror and is a git work tree. */
export async function identityHome(engine: BrainEngine): Promise<IdentityHome | null> {
  const s = (await engine.listAllSources()).find(x => x.id === DEFAULT_SOURCE_ID);
  if (!s || parseSourceConfig(s.config).mirror_read_only === true) return null;
  const root = await sourcePolicyRoot(engine, s.id);
  return root && isGitWorkTree(root) ? { sourceId: s.id, root } : null;
}

async function git(root: string, args: string[]): Promise<string> {
  const r = await execFileBounded('git', ['-c', 'core.quotepath=false', ...HARDENED_GIT_ARGS, '-C', root, ...args],
    { env: gitChildEnv(NO_LAZY_FETCH_ENV), timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`git ${args[0]} failed in ${root}: ${String(r.stderr).trim() || r.error.message}`);
  return r.stdout;
}

/**
 * The decision files committed at `rev`: id, path and blob. A commit with no such folder has none, and so does HEAD of a
 * repository with no commit yet; any other failed read throws, so it is never taken for "every file was deleted".
 */
export async function committedDecisionFiles(root: string, rev = 'HEAD'): Promise<Array<{ id: string; path: string; blob: string }>> {
  let out: string;
  try {
    out = await git(root, ['ls-tree', '-r', '-z', rev, '--', `${IDENTITY_DIR}/`]);
  } catch (e) {
    if (rev === 'HEAD' && (await git(root, ['for-each-ref'])).trim() === '') return [];
    throw e;
  }
  const files: Array<{ id: string; path: string; blob: string }> = [];
  for (const entry of out.split('\0')) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(entry);
    if (!m) continue;
    const id = /^\.gbrain\/identity\/([0-9a-f]{16})\.md$/.exec(m[2]!)?.[1];
    if (id) files.push({ id, path: m[2]!, blob: m[1]! });
  }
  return files;
}

export interface ProjectionResult { source_id: string; upserted: number; removed: number; invalid: string[]; linked: number; unlinked: number }

/**
 * Reads the decision files committed at `rev` in the home source and makes the git-origin rows of that source match them
 * (a changed blob is re-read, a file removed in git removes its row), then reconciles the identity rows; one transaction.
 */
export async function projectIdentityDecisions(engine: BrainEngine, home: IdentityHome, rev = 'HEAD'): Promise<ProjectionResult> {
  for (let attempt = 1; ; attempt++) {
    const r = await applyIdentityProjection(engine, await planIdentityProjection(engine, home, rev));
    if (!r.stale) return r;
    if (attempt === PROJECTION_ATTEMPTS) throw new Error(`the duplicate decisions changed while they were being projected, ${PROJECTION_ATTEMPTS} times in a row; nothing was applied (gbrain dedupe reconcile retries)`);
  }
}

const PROJECTION_ATTEMPTS = 5;

export interface IdentityProjectionPlan { home: IdentityHome; upsert: Array<Omit<IdentityDecision, 'evidence'> & { evidence?: string[] | null }>; remove: string[]; invalid: string[]; pending: number; revision: string }

/** What a projection of the files committed at `rev` would write, read against the current rows. Writes nothing. */
export async function planIdentityProjection(engine: BrainEngine, home: IdentityHome, rev = 'HEAD'): Promise<IdentityProjectionPlan> {
  const { decisions, pending, revision } = await engine.listIdentityDecisions();
  const mine = new Map(decisions.filter(d => d.origin === 'git' && d.home_source_id === home.sourceId).map(d => [d.decision_id, d]));
  const files = await committedDecisionFiles(home.root, rev);
  const upsert: IdentityProjectionPlan['upsert'] = [];
  const invalid: string[] = [];
  for (const f of files) {
    if (mine.get(f.id)?.git_blob === f.blob) continue;
    const parsed = parseDecisionFile(await git(home.root, ['cat-file', 'blob', f.blob]), f.id);
    if (!parsed) { invalid.push(f.path); continue; }
    upsert.push({ ...parsed, decision_id: f.id, origin: 'git', home_source_id: home.sourceId, git_blob: f.blob });
  }
  const present = new Set(files.map(f => f.id));
  const remove = [...mine.keys()].filter(id => !present.has(id));
  return { home, upsert, remove, invalid, pending: pending.length, revision };
}

/** Applies a projection plan in one transaction, unless the rows changed since the plan read them: then it writes nothing and is stale. */
export async function applyIdentityProjection(engine: BrainEngine, plan: IdentityProjectionPlan): Promise<ProjectionResult & { stale?: true }> {
  const { home, upsert, remove, invalid } = plan;
  if (!upsert.length && !remove.length && !plan.pending) return { source_id: home.sourceId, upserted: 0, removed: 0, invalid, linked: 0, unlinked: 0 };
  const r = await engine.applyIdentityDecisions({ upsert, remove, expectRevision: plan.revision });
  if (r.stale) return { source_id: home.sourceId, upserted: 0, removed: 0, invalid, linked: 0, unlinked: 0, stale: true };
  return { source_id: home.sourceId, upserted: upsert.length, removed: remove.length, invalid, linked: r.linked, unlinked: r.unlinked };
}

export interface DecisionCommitReceipt { outcome: string; commit: string | null; paths: string[]; note?: string }

/** Writes the decision files under the checkout's commit lock and commits them through the door; a failed commit restores them. */
function commitDecisionFiles(root: string, decisions: Array<DecisionInput & { decided_at: string }>, message: string): DecisionCommitReceipt {
  const files = decisions.map(d => ({ path: decisionPath(decisionId(d.members)), text: serializeDecision(d) }));
  const attempt = (): DecisionCommitReceipt => {
    const lock = acquireCommitLock(checkoutRoot(root));
    const prior = process.env[COMMIT_LOCK_ENV];
    process.env[COMMIT_LOCK_ENV] = lock.lockPath;
    const before = new Map<string, string | null>();
    try {
      for (const rel of ['.gbrain', IDENTITY_DIR, ...files.map(f => f.path)]) {
        const st = lstatSync(join(root, rel), { throwIfNoEntry: false });
        if (st && !(rel.endsWith('.md') ? st.isFile() : st.isDirectory())) {
          throw opError('commit_paths_invalid', `gbrain dedupe: ${rel} in ${root} is a symlink or not a regular ${rel.endsWith('.md') ? 'file' : 'folder'}, so no decision file is written through it; nothing was written.`,
            'Replace it with a regular file or folder in the checkout, then run the command again.');
        }
      }
      mkdirSync(join(root, IDENTITY_DIR), { recursive: true });
      for (const f of files) {
        const abs = join(root, f.path);
        before.set(abs, existsSync(abs) ? readFileSync(abs, 'utf8') : null);
        const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
        try { writeSync(fd, f.text); } finally { closeSync(fd); }
      }
      try {
        const r = commitAndPush({ repo: root, cwd: root, paths: [...before.keys()], message });
        return { outcome: r.outcome, commit: r.committed ?? r.sha, paths: files.map(f => f.path),
          ...(r.outcome === 'committed_local' ? { note: 'Committed locally; this checkout has no remote or is managed, so nothing was pushed.' } : {}) };
      } catch (e) {
        const landed = committedAll(root, files);
        if (landed === null) throw e;
        if (landed && e instanceof OperationError && (e.code === 'push_unconfirmed' || e.code === 'push_credential_refused'
          || e.code === 'publish_secret_found' || e.code === 'publish_scan_unreadable')) {
          return { outcome: 'committed_not_pushed', commit: null, paths: files.map(f => f.path), note: `Committed locally; nothing was pushed. ${e.code}: ${e.message}` };
        }
        if (!landed) for (const [abs, text] of before) if (text === null) rmSync(abs, { force: true }); else writeFileSync(abs, text);
        throw e;
      }
    } finally {
      if (prior === undefined) delete process.env[COMMIT_LOCK_ENV]; else process.env[COMMIT_LOCK_ENV] = prior;
      lock.release();
    }
  };
  try {
    return attempt();
  } catch (e) {
    if ((e as { code?: string }).code === 'commit_lock_busy') return attempt();
    throw e;
  }
}

/** Whether HEAD holds every file as written: true, false, or null when git could not be read (then nothing is restored). */
function committedAll(root: string, files: Array<{ path: string; text: string }>): boolean | null {
  for (const f of files) {
    const r = spawnSync('git', ['-C', root, 'show', `HEAD:./${f.path}`], { encoding: 'utf8', env: gitChildEnv() });
    if (r.status === 0) { if (r.stdout !== f.text) return false; continue; }
    if (r.status === 128 && /does not exist in|exists on disk, but not in|invalid object name 'HEAD'/.test(String(r.stderr))) return false;
    return null;
  }
  return true;
}

function storeMismatch(rows: IdentityDecision[]): OperationError {
  const sourceId = rows.find(d => d.origin === 'git')?.home_source_id ?? 'default';
  return opError('dedupe_decision_store_mismatch',
    `This brain's duplicate decisions are kept in git in source ${sourceId}, but this host sees no git work tree for it, so nothing was written.`,
    `Run the command on the host that holds the checkout of source ${sourceId}, or restore the checkout and run gbrain dedupe reconcile.`,
    { fix: { argv: ['gbrain', 'sources', 'status', sourceId, '--json'], consent: [], actor: 'user', requires_exclusive: false,
      why: 'Shows where the source lives and whether this host has its checkout; changes nothing.' } });
}

export interface UnpublishableMember { member: IdentityMemberRef; reason: 'owner_only_source' | 'restricted_page'; why: string }

/**
 * For each decision, the first member whose source and slug must stay out of the home source's repository, or null: a page
 * in an owner-only source (archived ones included), in a source that no longer exists, or a page outside the home source
 * that not every reader of it may read (readable_by, a folder rule or a private label). One check for record, reconcile,
 * drift and the bulk confirm list. The page test runs in the engine's scope, so it judges each page's own owner-only
 * lineage instead of refusing every page while the brain holds any owner-only source.
 */
export async function unpublishableMembers(engine: BrainEngine, homeSourceId: string, decisions: ReadonlyArray<{ members: IdentityMemberRef[] }>): Promise<Array<UnpublishableMember | null>> {
  const sources = new Map((await engine.listAllSources({ includeArchived: true })).map(s => [s.id, s]));
  const outside = decisions.flatMap(d => d.members).filter(m => m.source_id !== homeSourceId && sources.has(m.source_id));
  const restricted = new Set((await withEngineScope(engine, () => engine.listRestrictedIdentityMembers(outside))).map(r => `${r.source_id}:${r.slug}`));
  return decisions.map(d => {
    for (const member of d.members) {
      const source = sources.get(member.source_id);
      if (!source) return { member, reason: 'owner_only_source', why: 'a page in a source that no longer exists' };
      if (isOwnerOnlySourceConfig(source.config)) return { member, reason: 'owner_only_source', why: 'a page in an owner-only source' };
    }
    const member = d.members.find(m => m.source_id !== homeSourceId && restricted.has(`${m.source_id}:${m.slug}`));
    return member ? { member, reason: 'restricted_page', why: 'a page outside the default source that not every reader of it may read' } : null;
  });
}

export interface RecordResult { store: 'git' | 'database'; home: IdentityHome | null; receipt?: DecisionCommitReceipt; projection?: ProjectionResult; applied?: ApplyIdentityDecisionsResult }

/** Records decisions: on a brain with a home repository, the files first and then their projection; otherwise the rows. */
export async function recordDecisions(engine: BrainEngine, decisions: DecisionInput[], message: string): Promise<RecordResult> {
  const read = await engine.listIdentityDecisions();
  const home = await identityHome(engine);
  const decidedAt = new Date().toISOString();
  const full = decisions.map(d => ({ ...d, members: sortMembers(d.members), decided_at: decidedAt }));
  if (!home) {
    if (read.decisions.some(d => d.origin === 'git')) throw storeMismatch(read.decisions);
    const applied = await engine.applyIdentityDecisions({ upsert: full.map(d => ({ ...d, decision_id: decisionId(d.members), origin: 'database', home_source_id: null, git_blob: null })) });
    return { store: 'database', home: null, applied };
  }
  const blocked = await unpublishableMembers(engine, home.sourceId, full);
  const at = blocked.findIndex(b => b !== null);
  if (at >= 0) {
    const { member, reason, why } = blocked[at]!, exposed = full[at]!;
    throw opError('dedupe_group_not_confirmable',
      `gbrain dedupe: ${exposed.group_id ?? decisionId(exposed.members)} has ${member.source_id}:${member.slug}, ${why}; this brain keeps duplicate decisions in the default source's repository, where that page's source and slug would be readable by anyone who reads the repository, so nothing was written.`,
      'Leave such a group undecided on a brain whose default source has a repository.',
      { reason, fix: { argv: ['gbrain', 'dedupe', 'confirm'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Prints the confirm list with a hint line per entry; changes nothing.' } });
  }
  const receipt = commitDecisionFiles(home.root, full, message);
  const projection = await projectIdentityDecisions(engine, home);
  return { store: 'git', home, receipt, projection };
}

export interface ReconcileResult { store: 'git' | 'database'; written: number; git_kept?: string[]; receipt?: DecisionCommitReceipt; projection?: ProjectionResult; applied?: ApplyIdentityDecisionsResult; pending: PendingIdentityMember[] }

/**
 * gbrain dedupe reconcile: on a brain with a home repository, writes every decision the database holds alone into git
 * (a database brain that gained a repository) and re-projects the committed files; everywhere, retries the members a
 * "same" decision could not link yet. Git wins: a decision already committed is never rewritten from its row; the
 * projection gives the row the file's verdict, and git_kept names the decisions whose row disagreed.
 */
export async function reconcileDecisions(engine: BrainEngine): Promise<ReconcileResult> {
  await fillDecisionEvidence(engine);
  const read = await engine.listIdentityDecisions();
  const home = await identityHome(engine);
  if (!home) {
    if (read.decisions.some(d => d.origin === 'git')) throw storeMismatch(read.decisions);
    const applied = await engine.applyIdentityDecisions({});
    return { store: 'database', written: 0, applied, pending: (await engine.listIdentityDecisions()).pending };
  }
  const { dbOnly, committed } = await databaseOnly(engine, home, read.decisions);
  const gitKept: string[] = [];
  for (const d of read.decisions) {
    const file = d.origin === 'database' ? committed.get(d.decision_id) : undefined;
    if (!file) continue;
    const parsed = parseDecisionFile(await git(home.root, ['cat-file', 'blob', file.blob]), file.id);
    if (!parsed || parsed.verdict !== d.verdict || parsed.entity_id !== d.entity_id) gitKept.push(d.decision_id);
  }
  const receipt = dbOnly.length ? commitDecisionFiles(home.root, dbOnly, `dedupe: record ${dbOnly.length} duplicate decision(s) kept only in the database`) : undefined;
  const projection = await projectIdentityDecisions(engine, home);
  return { store: 'git', written: dbOnly.length, git_kept: gitKept, ...(receipt ? { receipt } : {}), projection, pending: (await engine.listIdentityDecisions()).pending };
}

/** The database-origin decisions reconcile may write into git: no committed file for them yet, and every member publishable. */
async function databaseOnly(engine: BrainEngine, home: IdentityHome, decisions: IdentityDecision[]) {
  const committed = new Map((await committedDecisionFiles(home.root)).map(f => [f.id, f]));
  const rows = decisions.filter(d => d.origin === 'database' && !committed.has(d.decision_id));
  const blocked = await unpublishableMembers(engine, home.sourceId, rows);
  return { dbOnly: rows.filter((_, i) => blocked[i] === null), committed };
}

/**
 * Sync's hook: re-project the home source's decisions after it syncs, retry pending members after any sync, fill the
 * fingerprints of "different" decisions recorded before they were kept, then run the company sweep from the pages the
 * sync changed. Never throws.
 */
export async function syncIdentityDecisions(engine: BrainEngine, sourceId: string, log?: (line: string) => void, changedSlugs?: readonly string[] | 'all'): Promise<void> {
  try {
    const home = await identityHome(engine);
    if (home && home.sourceId === sourceId) {
      const r = await projectIdentityDecisions(engine, home);
      if (r.invalid.length) log?.(`[dedupe] ${r.invalid.length} decision file(s) in source ${sourceId} do not validate and were skipped: ${r.invalid.slice(0, 5).join(', ')}`);
    } else if ((await engine.listIdentityDecisions()).pending.length) {
      await engine.applyIdentityDecisions({});
    }
    await fillDecisionEvidence(engine);
  } catch (e) {
    log?.(`[dedupe] duplicate decisions were not reconciled after this sync: ${e instanceof Error ? e.message : String(e)} (gbrain dedupe reconcile retries)`);
  }
  if (!changedSlugs?.length) return;
  try {
    const { autoLinkCompanies } = await import('./company-auto-link.ts');
    const r = await autoLinkCompanies(engine, { ...(changedSlugs === 'all' ? {} : { near: changedSlugs.map(slug => ({ source_id: sourceId, slug })) }), log });
    if (r.linked || r.unlinked) log?.(`[dedupe] linked ${r.linked} and unlinked ${r.unlinked} company group(s) that share an id`);
  } catch (e) {
    log?.(`[dedupe] companies that share an id were not linked after this sync: ${e instanceof Error ? e.message : String(e)} (gbrain dedupe reconcile retries)`);
  }
}

/**
 * Fills the fingerprints of "different" decisions that have none (recorded before they were kept) from their current
 * pages, in the database only: the decision file is not rewritten. Returns how many decisions were filled.
 */
export async function fillDecisionEvidence(engine: BrainEngine): Promise<number> {
  const read = await engine.listIdentityDecisions();
  const bare = read.decisions.filter(d => d.verdict === 'different' && !d.evidence?.length);
  if (!bare.length) return 0;
  const { entityPagesOf } = await import('./duplicates.ts');
  const pages = await entityPagesOf(engine, bare.flatMap(d => d.members));
  const upsert = bare.map(d => ({ ...d, evidence: d.members.map(m => pages.get(`${m.source_id}\t${m.slug}`)?.fingerprint).filter((f): f is string => !!f) }))
    .filter(d => d.evidence.length > 1);
  if (!upsert.length) return 0;
  const r = await engine.applyIdentityDecisions({ upsert, expectRevision: read.revision });
  return r.stale ? 0 : upsert.length;
}

export interface IdentityDrift {
  home: string | null;
  /** Decisions projected from git, while this host sees no repository for the brain. */
  store_mismatch: boolean;
  /** Decisions the database holds alone on a brain that has a home repository. */
  database_only: number;
  /** Committed decision files that validate but have no row, or whose row was read from another blob (not synced yet). */
  unsynced_files: number;
  /** Committed decision files that do not validate: a projection skips them, so only an edit to the file clears them. */
  invalid_files: string[];
  /** Rows projected from git whose file is no longer committed. */
  rows_without_file: number;
  pending: PendingIdentityMember[];
}

/** Read-only: where the decisions and their projection disagree (doctor's entity_duplicates line). */
export async function identityDrift(engine: BrainEngine, read?: IdentityDecisionsRead): Promise<IdentityDrift> {
  const r = read ?? await engine.listIdentityDecisions();
  const home = await identityHome(engine);
  const gitRows = r.decisions.filter(d => d.origin === 'git');
  if (!home) return { home: null, store_mismatch: gitRows.length > 0, database_only: 0, unsynced_files: 0, invalid_files: [], rows_without_file: 0, pending: r.pending };
  const files = await committedDecisionFiles(home.root);
  const { dbOnly } = await databaseOnly(engine, home, r.decisions);
  const rows = new Map(gitRows.filter(d => d.home_source_id === home.sourceId).map(d => [d.decision_id, d.git_blob]));
  const fileIds = new Set(files.map(f => f.id));
  const invalid: string[] = [];
  let unsynced = 0;
  for (const f of files.filter(x => rows.get(x.id) !== x.blob)) {
    if (parseDecisionFile(await git(home.root, ['cat-file', 'blob', f.blob]), f.id)) unsynced++;
    else invalid.push(f.path);
  }
  return {
    home: home.sourceId, store_mismatch: false,
    database_only: dbOnly.length,
    unsynced_files: unsynced,
    invalid_files: invalid,
    rows_without_file: [...rows.keys()].filter(id => !fileIds.has(id)).length,
    pending: r.pending,
  };
}

/**
 * The canonical member: the page in the brain's home source when one is, else the oldest page, else the first. Body
 * length never decides, so a longer imported copy never takes over the page the owner keeps.
 */
export async function canonicalOf(engine: BrainEngine, members: IdentityMemberRef[], homeSource: string | null): Promise<IdentityMemberRef> {
  const home = members.find(m => m.source_id === homeSource);
  if (home) return home;
  let best = members[0]!;
  let oldest = Infinity;
  for (const m of members) {
    const p = await engine.getPage(m.slug, { sourceId: m.source_id });
    const at = p?.created_at ? new Date(p.created_at).getTime() : Infinity;
    if (at < oldest) { best = m; oldest = at; }
  }
  return best;
}

/** The finder's view of the decisions: pairs kept apart, and member sets already decided as one. */
export function decidedSets(read: IdentityDecisionsRead): { apart: IdentityMemberRef[][]; confirmed: IdentityMemberRef[][]; apartEvidence: string[][] } {
  return {
    apart: read.decisions.filter(d => d.verdict === 'different').map(d => d.members),
    apartEvidence: read.decisions.filter(d => d.verdict === 'different' && d.evidence?.length).map(d => d.evidence!),
    confirmed: [...read.decisions.filter(d => d.verdict === 'same').reduce((byEntity, d) => {
      const key = d.entity_id ?? d.decision_id;
      return byEntity.set(key, [...(byEntity.get(key) ?? []), ...d.members]);
    }, new Map<string, IdentityMemberRef[]>()).values()],
  };
}
