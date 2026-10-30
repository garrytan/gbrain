/**
 * Git-canonical memory, wave G7a (docs/designs/GIT_CANONICAL_MEMORY.md, "Declared database-only classes"): which pages of
 * a strict source (`sources.config.canonical = "git"`, set only by conversion) keep no file in Git on purpose, and the
 * refusal for anything else that would land in the database alone.
 *
 * - **Classification** (`strictPageClass`): a page under a `storage.db_only` prefix, a derive-phase page that never
 *   recorded a file (G1's per-page rule), or a private, alias-private or lineage-private page is declared database-only.
 *   A file target the checkout's Git ignores is declared `git_ignored`. page-prepare.ts `prepareFileTarget` asks this
 *   before it builds a file target, so such a page gets no file, no door commit and no Git effect; a page turning private
 *   gets a removal that the door commits.
 * - **Private backstop** (`assertNoPrivateCommit`, before a publication writes its file): a file target carrying a
 *   private page's bytes is refused (`git_private_commit_refused`), whatever writer prepared it.
 * - **Publication check** (`declareStrictPublication`, called by publishMutation and publishGroup after apply, before
 *   the door commit): a strict publication that writes no file must be declared (else `git_home_required`), one that
 *   writes a file must not be (`declared_target`). It stamps `pages.database_only_reason` with the class
 *   (`private`, `alias_private`, `lineage_private`, `git_ignored`) and, for the privacy classes, clears the recorded
 *   origin in the same transaction as the door commit that removed the file, so the indexer never reads that removal as
 *   a deletion of a live page.
 * - **LFS** (`assertLfsTarget`): a target whose `filter` attribute is `lfs` commits only when the operator opted in
 *   (`storage.git_lfs`, default off) and the checkout configures the LFS filter itself; the door's `hash-object -w` applies
 *   that clean filter and commits the pointer.
 *
 * Nothing here runs for a source without the flag or for an unbound write (a database-only source is its own class).
 */
import { promisify } from 'node:util';
import { join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { gitChildEnv } from '../git-env.ts';
import type { Action } from '../agent-output.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { execFile } from '../spawn.ts';
import { isDerivationPrivate, isPrivatePage, privatePagesFilterFragment, readHonorAliases } from '../search/private-visibility.ts';
import { DERIVE_PHASE_DB_ONLY_DEFAULTS } from '../storage-config.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { PageMutationFile } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import type { WorktreeBinding } from './ownership.ts';
import { isSourceDbOnlySlug } from './source-storage.ts';
import { gitIgnoresUntracked } from './sync-origin-evidence.ts';
import { isStreamedContent, type StreamedFileContent } from './large-file.ts';
import { parseMarkdown } from '../markdown.ts';

const execFileAsync = promisify(execFile);
const DOCS = 'docs/guides/write-refusals.md#git_home_required';

/** The `database_only_reason` values G7a stamps, one per declared class that is not computed from the slug or config. */
export const DECLARED_REASONS = ['private', 'alias_private', 'lineage_private', 'git_ignored'] as const;
export type DeclaredReason = typeof DECLARED_REASONS[number];
export type PrivacyClass = 'private' | 'alias_private' | 'lineage_private';
export type StrictClass = PrivacyClass | 'db_only_prefix' | 'derive_folder' | 'git_ignored' | 'database_only';
const PRIVACY: ReadonlySet<string> = new Set<PrivacyClass>(['private', 'alias_private', 'lineage_private']);
/** A reason a publication or page already carries that declares it database-only (detached pages, origin twins, mirrors...): any but the generic `db_only` and G7a's own. */
const legacyReason = (value: string | null | undefined) => value != null && value !== 'db_only' && !isDeclaredReason(value);

export const isPrivacyClass = (value: string | null | undefined): value is PrivacyClass => value != null && PRIVACY.has(value);
export const isDeclaredReason = (value: string | null | undefined): value is DeclaredReason => value != null && (DECLARED_REASONS as readonly string[]).includes(value);

type RecordedFile = { source_path?: string | null; source_uri?: string | null; withheld_source_path?: string | null };

/** Whether a page has a canonical file: one it records, or the one its private transition removed (`withheld_source_path`). */
export const keepsCanonicalFile = (page: RecordedFile) => Boolean(page.source_path || page.withheld_source_path);

/** A derive-phase page (DERIVE_PHASE_DB_ONLY_DEFAULTS) that never recorded a canonical file; a file withheld while private counts as recorded. */
export function isNeverFiledDerivedPage(slug: string, page: RecordedFile): boolean {
  return !keepsCanonicalFile(page) && !page.source_uri && DERIVE_PHASE_DB_ONLY_DEFAULTS.some(prefix => slug.startsWith(prefix));
}

/**
 * The class G3's indexer reads for a page's path: `db_only_prefix` (a `storage.db_only` dir, folder-wide) or
 * `derive_folder` (a derive-phase page that never recorded a file), else null. A committed file under a derive folder
 * belongs to Git, so a page that records one is never `derive_folder`. `page` null is a page with no row yet: it takes
 * the file its write offers (G6 commits a strict source's new atoms through the door), and a write that offers none
 * passes an empty page so the new page is declared (a new concept publishes `file: false`).
 */
export function declaredPathClass(root: string, slug: string, page: RecordedFile | null): 'db_only_prefix' | 'derive_folder' | null {
  if (isSourceDbOnlySlug(root, slug, 'refuse')) return 'db_only_prefix';
  return page && isNeverFiledDerivedPage(slug, page) ? 'derive_folder' : null;
}

/**
 * Why a page is private, or null: its own fields (`visibility`, a pinned question, the derived-type default), a privacy
 * alias (with `visibility.honor_aliases` read first), or its declared lineage and derived origin, read with the same SQL
 * remote reads use (`privatePagesFilterFragment`) over the page's own values, so an unwritten page is judged too.
 */
export async function privacyClass(engine: BrainEngine, sourceId: string, page: { id?: number | null; slug: string; type?: string | null; frontmatter?: unknown }): Promise<PrivacyClass | null> {
  await readHonorAliases(engine);
  if (isPrivatePage(page)) return 'private';
  if (isDerivationPrivate(page)) return 'alias_private';
  const frontmatter = typeof page.frontmatter === 'object' && page.frontmatter !== null ? page.frontmatter as Record<string, unknown> : {};
  if (frontmatter.derived_from == null && !['atom', 'concept', 'event'].includes(page.type ?? '')) return null;
  const [row] = await engine.executeRaw<{ lineage: boolean }>(`SELECT NOT ${privatePagesFilterFragment('p')} AS lineage
    FROM (SELECT $1::text AS source_id, $2::text AS slug, $3::text AS type, $4::text::jsonb AS frontmatter, $5::bigint AS id) p`,
  [sourceId, page.slug, page.type ?? null, JSON.stringify(frontmatter), page.id ?? null]);
  return row?.lineage === true ? 'lineage_private' : null;
}

/** The declared class a strict page belongs to by its slug, its prior file and its content, or null when it belongs in Git. */
export async function strictPageClass(engine: BrainEngine, sourceId: string, root: string,
  page: { id?: number | null; slug: string; type?: string | null; frontmatter?: unknown }, before: RecordedFile | null): Promise<StrictClass | null> {
  return declaredPathClass(root, page.slug, before) ?? await privacyClass(engine, sourceId, page);
}

const rel = (root: string, path: string) => relative(root, path).split(sep).join('/');

/** Whether the checkout ignores `path` and does not track it, so Git could never commit a file there. */
export function ignoredTarget(root: string, path: string): Promise<boolean> {
  return gitIgnoresUntracked(root, rel(root, path));
}

async function git(root: string, args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', '-C', root, ...args], { env: gitChildEnv(), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: unknown };
    return { code: typeof e.code === 'number' ? e.code : -1, stdout: typeof e.stdout === 'string' ? e.stdout : '' };
  }
}

export const GIT_LFS_KEY = 'storage.git_lfs';
const ON = /^(true|1|on|yes)$/i;

/**
 * Whether a door commit of the file at `path` may run under LFS rules. Null when the path's `filter` attribute is not
 * `lfs` (the ordinary case: one `check-attr`). Otherwise `ready` only when the operator opted in (`storage.git_lfs`) and
 * the checkout's own config names the LFS filter (`filter.lfs.process` or `filter.lfs.clean`) and `git lfs` runs: the
 * door's child Git keeps repo-local config and PATH, so its `hash-object -w` commits the pointer and stores the object.
 * That hash runs before the door's ref update, so a publication that rolls back can leave the object in the LFS store,
 * which is harmless (an unreferenced LFS object).
 */
export async function lfsTargetState(engine: Pick<BrainEngine, 'getConfig'>, root: string, path: string): Promise<null | 'opt_in_off' | 'checkout_unconfigured' | 'ready'> {
  const attr = await git(root, ['check-attr', '-z', 'filter', '--', rel(root, path)]);
  if (attr.code !== 0 || attr.stdout.split('\0')[2] !== 'lfs') return null;
  if (!ON.test((await engine.getConfig(GIT_LFS_KEY))?.trim() ?? '')) return 'opt_in_off';
  const [process, clean, binary] = await Promise.all([git(root, ['config', '--local', '--get', 'filter.lfs.process']),
    git(root, ['config', '--local', '--get', 'filter.lfs.clean']), git(root, ['lfs', 'version'])]);
  return (process.code === 0 || clean.code === 0) && binary.code === 0 ? 'ready' : 'checkout_unconfigured';
}

/** Refuses a strict file target under an LFS rule unless `lfsTargetState` says ready. */
export async function assertLfsTarget(engine: Pick<BrainEngine, 'getConfig'>, row: Pick<WriteRequest, 'source_id' | 'slug'>, root: string, path: string, remote: boolean): Promise<void> {
  const state = await lfsTargetState(engine, root, path);
  if (state === null || state === 'ready') return;
  const where = remote ? `page ${row.slug}'s file` : rel(root, path);
  const why = 'A git-canonical source commits a file before its database row. A path .gitattributes routes through Git LFS commits as an LFS pointer only when the checkout configures the LFS filter and the operator opted in; otherwise the door would commit the raw bytes.';
  throw opError('git_lfs_not_enabled', state === 'opt_in_off'
    ? `Source ${row.source_id} is git-canonical and ${where} falls under a Git LFS rule, but ${GIT_LFS_KEY} is off, so nothing was written.`
    : `Source ${row.source_id} is git-canonical and ${where} falls under a Git LFS rule, but the checkout does not configure the LFS filter (git lfs install --local) or git-lfs does not run, so nothing was written.`,
  'Ask the user whether this file belongs in Git LFS. If it does, they configure git-lfs in the checkout and turn on storage.git_lfs, then the write is submitted again with a new request_id; if not, they narrow the .gitattributes rule.',
  { reason: state, why, docs: 'docs/guides/write-refusals.md#git_lfs_not_enabled', fix: { ask_user: true, actor: 'user', consent: [], requires_exclusive: false, why,
    user_message: `A write to source ${row.source_id} falls under a Git LFS rule in .gitattributes. Should it be stored with Git LFS? If so, configure git-lfs in the checkout (git lfs install --local) and run gbrain config set ${GIT_LFS_KEY} true on the brain host; otherwise narrow the .gitattributes rule.`,
    verify: { argv: ['gbrain', 'config', 'get', GIT_LFS_KEY] } } });
}

/**
 * The refusal for content a strict source would hold in the database alone (`no_file_form`, `facts_lane`), or for a
 * file a strict publication would commit for a declared page (`declared_target`). Remote callers get no class.
 */
export function gitHomeRequired(row: Pick<WriteRequest, 'source_id' | 'slug'>, reason: 'no_file_form' | 'declared_target' | 'facts_lane', remote: boolean, declared?: StrictClass): OperationError {
  const why = 'Git is the source of truth for a git-canonical source: page content reaches the database only after Git commits its file, except for the declared database-only classes (private pages, storage.db_only directories, never-filed derive-phase pages, paths Git ignores).';
  const message = reason === 'declared_target'
    ? `Source ${row.source_id} is git-canonical and page ${row.slug} is declared database-only${remote || !declared ? '' : ` (${declared})`}, so its file is never committed; nothing was written.`
    : `Source ${row.source_id} is git-canonical and this write would store ${reason === 'facts_lane' ? 'rows' : `page ${row.slug}`} in the database without a file in Git, so nothing was written.`;
  const fix: Action = { ask_user: true, actor: 'user', consent: [], requires_exclusive: false, why, docs: DOCS,
    user_message: reason === 'declared_target'
      ? `Page ${row.slug} in git-canonical source ${row.source_id} is declared database-only, so gbrain will not commit its file. Should it stay database-only, or move to a path Git tracks (outside storage.db_only and the derive folders, and not private)?`
      : `Source ${row.source_id} is git-canonical, so every page needs a home in Git. Should ${reason === 'facts_lane' ? 'these rows' : `page ${row.slug}`} be written to a file Git tracks, or declared database-only (its directory under storage.db_only in gbrain.yml, or the page marked visibility: private)?`,
    verify: { argv: ['gbrain', 'sources', 'git-gap', row.source_id, '--json'] } };
  return opError('git_home_required', message, 'Ask the user which git home to configure, then submit the write again with a new request_id.', { reason, why, fix, docs: DOCS });
}

/** The page a strict file target publishes, judged for its class; streamed content keeps the snapshot's frontmatter. */
export function renderedPageForClass(slug: string, content: string | Uint8Array | StreamedFileContent, snapshot: PageSnapshot | null): { id: number | null; slug: string; type: string | null; frontmatter: unknown } {
  if (isStreamedContent(content)) return { id: snapshot?.page.id ?? null, slug, type: snapshot?.page.type ?? null, frontmatter: snapshot?.page.frontmatter };
  const parsed = parseMarkdown(typeof content === 'string' ? content : Buffer.from(content).toString('utf8'), `${slug}.md`);
  return { id: snapshot?.page.id ?? null, slug, type: parsed.typeExplicit ? parsed.type : snapshot?.page.type ?? parsed.type, frontmatter: parsed.frontmatter };
}

/** The refusal for a publication that would commit a private page's bytes: the page stays database-only. */
export function privateCommitRefused(row: Pick<WriteRequest, 'source_id' | 'slug'>, privacy: PrivacyClass, remote: boolean): OperationError {
  const why = 'Private, alias-private and lineage-private pages of a git-canonical source are database-only: their bytes never enter Git history. A page turning private is published as the door commit that removes its file.';
  return opError('git_private_commit_refused', `Source ${row.source_id} is git-canonical and page ${row.slug} is ${privacy.replace('_', '-')}, so its file was not committed; nothing was written and HEAD is unchanged.`,
    'The page stays database-only: write it with put_page, which publishes a private page without a file, or remove visibility: private if it belongs in Git, then submit again with a new request_id.',
    { reason: privacy, why, docs: 'docs/guides/write-refusals.md#git_private_commit_refused', fix: { ask_user: true, actor: 'user', consent: [], requires_exclusive: false, why,
      user_message: `Page ${row.slug} in git-canonical source ${row.source_id} is private, so it stays database-only and gbrain will not commit its file. Should it stay private (written database-only), or become public so its file is committed?`,
      verify: { argv: ['gbrain', 'sources', 'git-gap', row.source_id, '--json'] } } });
}

/** What the publication checks read of a prepared publication: its file target, noop flag and database-only reason. */
type StrictPublication = { noop?: boolean; databaseOnlyReason?: string; file?: Pick<PageMutationFile, 'content'> };

const syncRow = (row: Pick<WriteRequest, 'operation' | 'intent'>) => row.operation === 'submit_job' && /^managed_sync_/.test(String(row.intent?.kind ?? ''));

/**
 * Before a strict publication writes or commits anything: refuses one whose file target carries the bytes of a private,
 * alias-private or lineage-private page, judged from those bytes (the page as it will be published). A removal is the
 * private transition and passes. Sync members are G3's.
 */
export async function assertNoPrivateCommit(tx: BrainEngine, row: WriteRequest, prepared: StrictPublication, snapshot: PageSnapshot | null,
  binding: Pick<WorktreeBinding, 'canonical_git'> | null | undefined): Promise<void> {
  if (binding?.canonical_git !== true || !row.worktree_id || prepared.noop || !prepared.file || prepared.file.content === null || syncRow(row)) return;
  const privacy = await privacyClass(tx, row.source_id, renderedPageForClass(row.slug, prepared.file.content, snapshot));
  if (privacy) throw privateCommitRefused(row, privacy, row.authority?.remote === true);
}

/** For writers with no file form yet (G4, G5): refuses on a strict source, so a database-only row is never written there. */
export async function assertStrictGitHome(engine: BrainEngine, row: Pick<WriteRequest, 'source_id' | 'slug'>, remote: boolean): Promise<void> {
  const [source] = await engine.executeRaw<{ strict: boolean }>(`SELECT COALESCE(config->>'canonical','')='git' AS strict FROM sources WHERE id=$1`, [row.source_id]);
  if (source?.strict === true) throw gitHomeRequired(row, 'facts_lane', remote);
}

/**
 * The publication check and stamp (see the header). `before` is the page as the publication read it under its page
 * lock, `final` after apply. Runs before the door commit, inside the publication transaction; a no-op unless the
 * binding is strict and the write is bound. Sync members are G3's (the indexer imports what Git holds).
 */
export async function declareStrictPublication(tx: BrainEngine, row: WriteRequest, prepared: StrictPublication,
  before: PageSnapshot | null, final: PageSnapshot | null, binding: Pick<WorktreeBinding, 'canonical_git' | 'local_path' | 'relative_path'> | null | undefined): Promise<void> {
  if (binding?.canonical_git !== true || !binding.local_path || !row.worktree_id || prepared.noop || !final || final.page.deleted_at) return;
  if (syncRow(row)) return;
  const [stored] = await tx.executeRaw<{ reason: string | null }>('SELECT database_only_reason AS reason FROM pages WHERE id=$1', [final.page.id]);
  const reason = stored?.reason ?? null;
  const root = join(binding.local_path, binding.relative_path ?? '');
  const page = final.page;
  const remote = row.authority?.remote === true;
  if (prepared.file && prepared.file.content !== null) {
    const declared = await strictPageClass(tx, row.source_id, root, page, before?.page ?? null);
    if (isPrivacyClass(declared)) throw privateCommitRefused(row, declared, remote);
    if (declared) throw gitHomeRequired(row, 'declared_target', remote, declared);
    await tx.executeRaw(`UPDATE pages SET withheld_source_path=NULL,
      database_only_reason=CASE WHEN database_only_reason=ANY($2::text[]) THEN NULL ELSE database_only_reason END WHERE id=$1`, [page.id, [...DECLARED_REASONS]]);
    return;
  }
  const declared: StrictClass | null = legacyReason(prepared.databaseOnlyReason) || legacyReason(reason) ? 'database_only'
    : await strictPageClass(tx, row.source_id, root, page, before?.page ?? {})
      ?? (await ignoredTarget(root, join(root, page.source_path || `${page.slug}.md`)) ? 'git_ignored' : null);
  if (!declared) throw gitHomeRequired(row, 'no_file_form', remote);
  if (isPrivacyClass(declared)) {
    await tx.executeRaw(`UPDATE pages SET database_only_reason=$2, withheld_source_path=COALESCE(NULLIF(source_path,''), withheld_source_path),
      source_path=NULL, source_uri=NULL WHERE id=$1`, [page.id, declared]);
  } else if (declared === 'git_ignored' && reason !== 'git_ignored') {
    await tx.executeRaw('UPDATE pages SET database_only_reason=$2 WHERE id=$1', [page.id, declared]);
  } else if (declared !== 'git_ignored' && isDeclaredReason(reason)) {
    await tx.executeRaw('UPDATE pages SET database_only_reason=NULL WHERE id=$1', [page.id]);
  }
}
