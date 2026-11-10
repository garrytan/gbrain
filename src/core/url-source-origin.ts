/**
 * Who added a URL source, as recorded on its row (`sources.config.added_by_remote_caller`).
 *
 * A URL source a remote caller adds records `added_by_remote_caller: true`, and every reclone of it, managed or
 * not, clones with git-lfs downloads and hooks off (`lfsDownloadsOff`). Sources added before that record existed
 * carry no record, and nothing else stored on the row, the clone or the request log says whether a remote caller
 * or the local operator added them: both wrote the same row and cloned into the default clone directory. Only a
 * clone outside that directory proves a local add (remote callers cannot choose `clone_dir`). A local URL add now
 * records `false`; only an explicit `true` reads as a remote caller's add, and no record stays undecided.
 *
 * `urlSourcesWithoutOrigin` lists the undecided ones for the `url_source_origin` doctor check, read-only.
 * `recordSourceOrigin` (`gbrain sources record-origin`, trusted local CLI only) records the operator's answer:
 * `remote` writes `true` and turns git-lfs downloads and hooks off in the existing checkout's own .git/config, the
 * settings a remote add's clone gets, so the checkout is locked down now rather than at a reclone that may never come;
 * `local` writes `false`. It previews unless `apply`. `remote` refuses a checkout that tracks files with git-lfs or
 * declares an LFS filter in a committed .gitattributes, or one it cannot inspect: a clone with git-lfs downloads off
 * holds pointer files where that checkout holds the files' content, so the next managed reclone would not match the
 * canonical manifest, and converting the checkout rewrites its files, which this does not do. Without git-lfs files a
 * clone with these settings has the same tracked bytes, so the stored manifest needs no change.
 */
import { closeSync, existsSync, fchmodSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { execFileSync } from './spawn.ts';
import { opError } from './ops/contract.ts';
import { LFS_OFF_CLONE_CONFIG } from './git-remote.ts';
import { hardenedGitEnvironment, hardenedGitSync } from './hardened-git.ts';
import { managedPersistenceEnabled } from './persistence/ownership.ts';
import { normalizeSourceConfig, parseSourceConfig } from './sources-load.ts';
import { defaultCloneDir, isOwnedClone } from './url-clone.ts';

export type SourceOrigin = 'remote' | 'local';
type OriginState = 'not_url_clone' | 'custom_clone_dir' | 'remote' | 'local' | 'unknown';
interface SourceRowLike { id: string; local_path: string | null; config: unknown; archived?: boolean | null }

export const RECORD_ORIGIN_DOCS = 'docs/guides/repair.md#url-source-origin';
export const recordOriginArgv = (ids: string[], origin: SourceOrigin): string[] => ['gbrain', 'sources', 'record-origin', ...ids, `--${origin}`];

/** The default clone directory, or a `clones/<id>` directory under an earlier GBRAIN_HOME. */
function atDefaultCloneDir(id: string, localPath: string): boolean {
  const path = resolve(localPath);
  return path === resolve(defaultCloneDir(id)) || (basename(path) === id && basename(dirname(path)) === 'clones');
}

function originState(row: SourceRowLike): OriginState {
  const config = parseSourceConfig(row.config);
  if (typeof config.remote_url !== 'string' || !isOwnedClone(row)) return 'not_url_clone';
  if (config.added_by_remote_caller === true) return 'remote';
  if (config.added_by_remote_caller === false) return 'local';
  return atDefaultCloneDir(row.id, row.local_path!) ? 'unknown' : 'custom_clone_dir';
}

/** Active URL sources in the default clone directory with no record of who added them. */
export async function urlSourcesWithoutOrigin(engine: BrainEngine): Promise<Array<{ id: string; local_path: string }>> {
  const rows = await engine.executeRaw<SourceRowLike>(
    'SELECT id, local_path, config FROM sources WHERE archived IS NOT TRUE AND local_path IS NOT NULL ORDER BY id');
  return rows.filter(row => originState(row) === 'unknown').map(row => ({ id: row.id, local_path: row.local_path! }));
}

type LfsState = { state: 'none' | 'tracked' | 'declared' } | { state: 'unknown'; cause: 'missing' | 'not_top_level' | 'unsafe_owner' | 'git_failed' };
const GIT_LIMITS = { timeoutMs: 30_000, maxBytes: 64 * 1024 * 1024 };
const sameDirectory = (a: string, b: string): boolean => { try { return realpathSync.native(a) === realpathSync.native(b); } catch { return false; } };
const declaresLfs = (attributes: string): boolean => attributes.split('\n')
  .some(line => { const rule = line.trim(); return rule !== '' && !rule.startsWith('#') && /(^|\s)filter=lfs(\s|$)/.test(rule); });

/**
 * `none` only when the checkout is its own repository's top level, Git lists it, no tracked path has `filter=lfs` (`tracked`)
 * and no committed `.gitattributes` declares `filter=lfs` outside a comment (`declared`). The committed files decide because a
 * reclone gets only those: clone-local attributes (`info/attributes`, an edited `.gitattributes`) can hide git-lfs paths from
 * the listing. An unborn HEAD with an empty index (a clone of an empty repository) has no committed attributes. A missing
 * checkout, a directory Git resolves to an enclosing repository (or none), or a Git read that fails is not known to be free
 * of git-lfs.
 */
function lfsTracked(root: string): LfsState {
  if (!existsSync(root)) return { state: 'unknown', cause: 'missing' };
  const gitFailed = { state: 'unknown', cause: 'git_failed' } as const;
  const top = hardenedGitSync(root, ['rev-parse', '--show-toplevel'], { ...GIT_LIMITS, stderr: true });
  if (!top.ok) {
    if (/not a git repository/i.test(top.stderr ?? '')) return { state: 'unknown', cause: 'not_top_level' };
    return /dubious ownership/i.test(top.stderr ?? '') ? { state: 'unknown', cause: 'unsafe_owner' } : gitFailed;
  }
  if (!sameDirectory(top.stdout.toString('utf8').replace(/\n$/, ''), root)) return { state: 'unknown', cause: 'not_top_level' };
  const listed = hardenedGitSync(root, ['ls-files', '-z', '--cached', '--', ':(attr:filter=lfs)'], GIT_LIMITS);
  if (!listed.ok) return gitFailed;
  if (listed.stdout.length) return { state: 'tracked' };
  const head = hardenedGitSync(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], GIT_LIMITS);
  if (!head.ok) {
    const index = head.reason === 'exit' ? hardenedGitSync(root, ['ls-files', '-z', '--cached'], GIT_LIMITS) : null;
    return index?.ok && !index.stdout.length ? { state: 'none' } : gitFailed;
  }
  const tree = hardenedGitSync(root, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], GIT_LIMITS);
  if (!tree.ok) return gitFailed;
  for (const entry of tree.stdout.toString('utf8').split('\0')) {
    const tab = entry.indexOf('\t');
    const [, type, object] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (tab < 0 || type !== 'blob' || (path !== '.gitattributes' && !path.endsWith('/.gitattributes'))) continue;
    const blob = hardenedGitSync(root, ['cat-file', 'blob', object!], GIT_LIMITS);
    if (!blob.ok) return gitFailed;
    if (declaresLfs(blob.stdout.toString('utf8'))) return { state: 'declared' };
  }
  return { state: 'none' };
}

const LOCK_DOWN = LFS_OFF_CLONE_CONFIG.filter((_, at) => at % 2 === 1).map(setting => [setting.slice(0, setting.indexOf('=')), setting.slice(setting.indexOf('=') + 1)] as const);

/** The lock-down keys whose value Git reads in the checkout (worktree config and includes counted) is not the clone-time one. */
function lockDownGaps(root: string): string[] {
  return LOCK_DOWN.filter(([key, value]) => {
    try { return execFileSync('git', ['-C', root, 'config', '--get', key], { env: hardenedGitEnvironment(), stdio: 'pipe', timeout: GIT_LIMITS.timeoutMs }).toString('utf8').replace(/\n$/, '') !== value; }
    catch { return true; }
  }).map(([key]) => key);
}

/**
 * Writes the clone-time lock-down (`LFS_OFF_CLONE_CONFIG`) into the repository's shared config (`--git-common-dir`, so a linked
 * worktree's repository gets it too), without running Git in the checkout, then reads back what Git uses there and throws when a
 * worktree-scoped or included setting still overrides a key. Like Git, it takes `config.lock` beside the config's real path
 * first, copies the config into it (mode kept), writes the keys there and renames it over the config in one step, so a failure part way leaves the config as it was; each key's existing values are removed
 * before its one value is written, so a key that held several ends with the clone-time value. `progress` says how far it got:
 * `written` once the config holds every key.
 */
function lockDownCheckout(root: string, progress: { state: 'none' | 'written' | 'done' }): void {
  const commonDir = hardenedGitSync(root, ['rev-parse', '--git-common-dir'], GIT_LIMITS);
  if (!commonDir.ok) throw new Error(`Git could not locate the repository of ${root}.`);
  const file = realpathSync(join(resolve(root, commonDir.stdout.toString('utf8').replace(/\n$/, '')), 'config'));
  const staged = `${file}.lock`;
  let lock: number;
  try { lock = openSync(staged, 'wx'); }
  catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') throw new Error(`${staged} exists, so another Git process is writing that config (or one stopped and left the file).`);
    throw error;
  }
  try {
    try { fchmodSync(lock, statSync(file).mode & 0o7777); writeFileSync(lock, readFileSync(file)); }
    finally { closeSync(lock); }
    const options = { cwd: dirname(file), env: hardenedGitEnvironment(), stdio: 'pipe', timeout: GIT_LIMITS.timeoutMs } as const;
    for (const [key, value] of LOCK_DOWN) {
      try { execFileSync('git', ['config', '--file', staged, '--unset-all', key], options); }
      catch (error) { if ((error as { status?: number }).status !== 5) throw error; }
      execFileSync('git', ['config', '--file', staged, key, value], options);
    }
    renameSync(staged, file);
  } catch (error) { rmSync(staged, { force: true }); throw error; }
  progress.state = 'written';
  const gaps = lockDownGaps(root);
  if (gaps.length) throw new Error(`Git in the checkout at ${root} still reads another value for ${gaps.join(', ')} (a worktree-scoped or included config overrides ${file}).`);
  progress.state = 'done';
}

export interface RecordOriginResult {
  source_id: string;
  status: 'would_record' | 'recorded' | 'already_recorded' | 'refused';
  code?: 'not_found' | 'archived' | 'not_url_clone' | 'custom_clone_dir' | 'recorded_remote' | 'lfs_tracked' | 'lfs_unknown' | 'source_changed'
    | 'source_busy' | 'write_failed';
  reason: string;
}

const refusal = (id: string, code: NonNullable<RecordOriginResult['code']>, reason: string): RecordOriginResult => ({ source_id: id, status: 'refused', code, reason });

/**
 * The refusal a `--remote` record gets when the checkout is not known to be free of git-lfs, or null. A `relock` (a source
 * already recorded as remote) keeps its record whatever its files hold, so only a checkout Git cannot place refuses it.
 */
function lfsRefusal(id: string, root: string, relock: boolean): RecordOriginResult | null {
  const lfs = lfsTracked(root);
  if (relock && lfs.state !== 'unknown') return null;
  const why = 'A clone with git-lfs downloads off holds pointer files where this checkout holds their content, so its next reclone would not match the canonical manifest, '
    + `and converting the checkout rewrites its files, which this command does not do; nothing changed. If the source should not keep these files, check that nothing in its checkout is unpushed or only local, then remove it (gbrain sources remove ${id} --confirm-destructive).`;
  if (lfs.state === 'tracked') return refusal(id, 'lfs_tracked', `Source ${id} tracks files with git-lfs. ${why}`);
  if (lfs.state === 'declared') return refusal(id, 'lfs_tracked', `A committed .gitattributes in source ${id} declares a git-lfs filter (filter=lfs), so a reclone would store matching files with git-lfs. ${why}`);
  if (lfs.state !== 'unknown') return null;
  const unconfirmed = relock ? 'so gbrain cannot turn git-lfs downloads and hooks off in it; nothing changed.' : 'so gbrain cannot confirm that no file is tracked with git-lfs; nothing changed.';
  if (lfs.cause === 'missing') return refusal(id, 'lfs_unknown', `Source ${id}'s checkout at ${root} is missing, ${unconfirmed} Restore the checkout, then run this again.`);
  if (lfs.cause === 'not_top_level') return refusal(id, 'lfs_unknown', `Source ${id}'s clone directory ${root} is not the top level of its own Git repository (Git resolves it to an enclosing repository, or to none), ${unconfirmed} Check what that directory holds before you run this again.`);
  if (lfs.cause === 'unsafe_owner') return refusal(id, 'lfs_unknown', `Git refuses to read source ${id}'s checkout at ${root} because another user owns it (safe.directory), ${unconfirmed} Check who owns that checkout, then run this again as that user or after fixing its ownership.`);
  return refusal(id, 'lfs_unknown', `Git could not list or read source ${id}'s checkout at ${root}, ${unconfirmed} Check that git works in that checkout, then run this again.`);
}

/** The outcome that needs no checkout inspection, or null when the source can take the record. */
function check(row: SourceRowLike | undefined, id: string, origin: SourceOrigin): RecordOriginResult | null {
  if (!row) return refusal(id, 'not_found', `No source ${id} is registered.`);
  if (row.archived) return refusal(id, 'archived', `Source ${id} is archived; restore it first if its origin still matters.`);
  const state = originState(row);
  if (state === 'not_url_clone') return refusal(id, 'not_url_clone', `Source ${id} is not a URL clone gbrain made, so it has no clone settings to record.`);
  if (state === 'custom_clone_dir') return origin === 'local'
    ? { source_id: id, status: 'already_recorded', reason: `Source ${id} was cloned into a directory only the local CLI can choose, so it is already treated as a local add.` }
    : refusal(id, 'custom_clone_dir', `Source ${id} was cloned into a directory only the local CLI can choose, so a remote caller did not add it; nothing changed.`);
  if (state === origin) return { source_id: id, status: 'already_recorded', reason: `Source ${id} is already recorded as added by ${origin === 'remote' ? 'a remote caller' : 'the local operator'}.` };
  if (state === 'remote') return refusal(id, 'recorded_remote', `Source ${id} is recorded as added by a remote caller; this command does not remove that record or its clone settings.`);
  return null;
}

/**
 * Records who added each named URL source. Preview unless `apply`. Each apply re-reads and locks the row, so a source changed
 * since its check is refused `source_changed` and left alone; on a managed brain it first takes the same worktree locks and
 * rows a reclone takes (`withTopologyLocks`, `lockTopologyRows`), so no reclone runs between the record and the next one,
 * and one that holds them refuses this id `source_busy`. A `remote` record inspects the checkout again under those locks and
 * locks it down before the row is written. A throw ends only its own id (`write_failed`); the others keep their results.
 * Trusted local CLI only: `remote` must be false.
 */
export async function recordSourceOrigin(engine: BrainEngine, ids: string[], opts: { origin: SourceOrigin; apply: boolean; remote?: boolean })
  : Promise<{ origin: SourceOrigin; apply: boolean; results: RecordOriginResult[] }> {
  if (opts.remote !== false) throw opError('trusted_local_only', 'Recording who added a source runs only from the trusted local CLI on the brain host, not over MCP.',
    'Ask the user to run the command in fix on the brain host.', { legacy_error: 'permission_denied',
      fix: { argv: recordOriginArgv(ids, opts.origin), consent: [], actor: 'user', requires_exclusive: false, docs: RECORD_ORIGIN_DOCS,
        why: 'Previews which sources would get the record; only the local operator can say who added a source.' } });
  const results: RecordOriginResult[] = [];
  const remote = opts.origin === 'remote';
  const recordedAs = remote ? 'a remote caller' : 'the local operator';
  const locks = opts.apply && await managedPersistenceEnabled(engine)
    ? { ...await import('./persistence/topology-locks.ts'), ...await import('./persistence/topology-transaction.ts') } : null;
  for (const id of [...new Set(ids)]) {
    const lockDown: { state: 'none' | 'written' | 'done' } = { state: 'none' };
    try {
      const [row] = await engine.executeRaw<SourceRowLike>('SELECT id, local_path, config, archived FROM sources WHERE id=$1', [id]);
      const early = check(row, id, opts.origin);
      const relock = remote && early?.status === 'already_recorded' && originState(row!) === 'remote' && existsSync(row!.local_path!) && lockDownGaps(row!.local_path!).length > 0;
      if (early && !relock) { results.push(early); continue; }
      const lfs = remote ? lfsRefusal(id, row!.local_path!, relock) : null;
      if (lfs) { results.push(lfs); continue; }
      if (!opts.apply) {
        results.push({ source_id: id, status: 'would_record', reason: relock
          ? `Source ${id} is already recorded as added by a remote caller, but its checkout still has git-lfs downloads or hooks on; they would be turned off now.`
          : `Source ${id} would be recorded as added by ${recordedAs}${remote ? '; git-lfs downloads and hooks would be turned off in its checkout now, and every later reclone clones that way' : ''}.` });
        continue;
      }
      const write = async (tx: BrainEngine): Promise<RecordOriginResult> => {
        const [locked] = await tx.executeRaw<SourceRowLike>('SELECT id, local_path, config, archived FROM sources WHERE id=$1 FOR UPDATE', [id]);
        const config = locked ? parseSourceConfig(locked.config) : {};
        const again = check(locked, id, opts.origin);
        if ((again && !(relock && again.status === 'already_recorded')) || (!again && relock) || locked!.local_path !== row!.local_path || config.remote_url !== parseSourceConfig(row!.config).remote_url)
          return refusal(id, 'source_changed', `Source ${id} changed while its origin was being recorded; nothing changed. Run the preview again.`);
        if (remote) {
          const lfsNow = lfsRefusal(id, locked!.local_path!, relock);
          if (lfsNow) return lfsNow;
          lockDownCheckout(locked!.local_path!, lockDown);
        }
        if (relock) return { source_id: id, status: 'recorded', reason: `Source ${id} was already recorded as added by a remote caller; its checkout now has git-lfs downloads and hooks off too.` };
        await tx.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1',
          [id, JSON.stringify(normalizeSourceConfig({ ...config, added_by_remote_caller: remote }))]);
        return { source_id: id, status: 'recorded', reason: `Source ${id} is recorded as added by ${recordedAs}${remote ? '; its checkout now has git-lfs downloads and hooks off, and every later reclone clones that way' : ''}.` };
      };
      results.push(locks
        ? await locks.withTopologyLocks(engine, id, bindings => locks.topologyTransaction(engine, async tx => { await locks.lockTopologyRows(tx, id, bindings); return write(tx); }))
        : await engine.transaction(write));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lockdown = lockDown.state === 'done' ? ' Its checkout already has git-lfs downloads and hooks off.'
        : lockDown.state === 'written' ? " The lock-down settings were already written to its repository's .git/config, but Git does not use them there yet." : '';
      const unchanged = lockdown ? `the record was not written.${lockdown}` : 'nothing changed.';
      const code = (error as { code?: string }).code;
      results.push(code === 'write_pending'
        ? refusal(id, 'source_busy', `Another gbrain process (a reclone, refresh or write) holds source ${id}'s worktree locks, so its origin was not recorded; ${unchanged} Run this again once that process finishes.`)
        : code === 'refresh_in_progress'
          ? refusal(id, 'source_busy', `${message} So source ${id}'s origin was not recorded; ${unchanged} Run this again once that refresh has finished or been recovered.`)
          : refusal(id, 'write_failed', `Recording source ${id}'s origin failed: ${message} The record was not written.${lockdown} The other ids in this run keep their own results; run this again for ${id}.`));
    }
  }
  return { origin: opts.origin, apply: opts.apply, results };
}
