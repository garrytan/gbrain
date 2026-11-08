/**
 * Who added a URL source, as recorded on its row (`sources.config.added_by_remote_caller`).
 *
 * A URL source a remote caller adds records `added_by_remote_caller: true`, and every reclone of it, managed or
 * not, clones with git-lfs downloads and hooks off (`lfsDownloadsOff`). Sources added before that record existed
 * carry no record, and nothing else stored on the row, the clone or the request log says whether a remote caller
 * or the local operator added them: both wrote the same row and cloned into the default clone directory. Only a
 * clone outside that directory proves a local add (remote callers cannot choose `clone_dir`).
 *
 * `urlSourcesWithoutOrigin` lists the undecided ones for the `url_source_origin` doctor check, read-only.
 * `recordSourceOrigin` (`gbrain sources record-origin`, trusted local CLI only) records the operator's answer:
 * `remote` writes `true`, `local` writes `false`. It previews unless `apply`. `remote` refuses a checkout that tracks
 * files with git-lfs, or one it cannot inspect: a clone with git-lfs downloads off holds pointer files where that
 * checkout holds the files' content, so the next managed reclone would not match the canonical manifest, and
 * converting the checkout rewrites its files, which this does not do. Without git-lfs files a clone with these
 * settings has the same tracked bytes, so the stored manifest needs no change.
 */
import { basename, dirname, resolve } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { opError } from './ops/contract.ts';
import { hardenedGitSync } from './hardened-git.ts';
import { normalizeSourceConfig, parseSourceConfig } from './sources-load.ts';
import { defaultCloneDir } from './url-clone.ts';

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
  if (config.managed_clone !== true || typeof config.remote_url !== 'string' || !row.local_path) return 'not_url_clone';
  if (config.added_by_remote_caller === true) return 'remote';
  if (config.added_by_remote_caller === false) return 'local';
  return atDefaultCloneDir(row.id, row.local_path) ? 'unknown' : 'custom_clone_dir';
}

/** Active URL sources in the default clone directory with no record of who added them. */
export async function urlSourcesWithoutOrigin(engine: BrainEngine): Promise<Array<{ id: string; local_path: string }>> {
  const rows = await engine.executeRaw<SourceRowLike>(
    'SELECT id, local_path, config FROM sources WHERE archived IS NOT TRUE AND local_path IS NOT NULL ORDER BY id');
  return rows.filter(row => originState(row) === 'unknown').map(row => ({ id: row.id, local_path: row.local_path! }));
}

/** `none` only when Git lists the checkout and no tracked path has `filter=lfs`; a missing or unreadable checkout is not known to be free of git-lfs. */
function lfsTracked(root: string): 'none' | 'tracked' | 'unknown' {
  const listed = hardenedGitSync(root, ['ls-files', '-z', '--cached', '--', ':(attr:filter=lfs)'], { timeoutMs: 30_000, maxBytes: 64 * 1024 * 1024 });
  if (!listed.ok) return 'unknown';
  return listed.stdout.length ? 'tracked' : 'none';
}

export interface RecordOriginResult {
  source_id: string;
  status: 'would_record' | 'recorded' | 'already_recorded' | 'refused';
  code?: 'not_found' | 'archived' | 'not_url_clone' | 'custom_clone_dir' | 'recorded_remote' | 'lfs_tracked' | 'lfs_unknown' | 'source_changed';
  reason: string;
}

const refusal = (id: string, code: NonNullable<RecordOriginResult['code']>, reason: string): RecordOriginResult => ({ source_id: id, status: 'refused', code, reason });

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
 * Records who added each named URL source. Preview unless `apply`; each apply re-reads and locks the row, so a source
 * changed since its check is refused `source_changed` and left alone. Trusted local CLI only: `remote` must be false.
 */
export async function recordSourceOrigin(engine: BrainEngine, ids: string[], opts: { origin: SourceOrigin; apply: boolean; remote?: boolean })
  : Promise<{ origin: SourceOrigin; apply: boolean; results: RecordOriginResult[] }> {
  if (opts.remote !== false) throw opError('trusted_local_only', 'Recording who added a source runs only from the trusted local CLI on the brain host, not over MCP.',
    'Ask the user to run the command in fix on the brain host.', { legacy_error: 'permission_denied',
      fix: { argv: recordOriginArgv(ids, opts.origin), consent: [], actor: 'user', requires_exclusive: false, docs: RECORD_ORIGIN_DOCS,
        why: 'Previews which sources would get the record; only the local operator can say who added a source.' } });
  const results: RecordOriginResult[] = [];
  const recordedAs = opts.origin === 'remote' ? 'a remote caller' : 'the local operator';
  for (const id of [...new Set(ids)]) {
    const [row] = await engine.executeRaw<SourceRowLike>('SELECT id, local_path, config, archived FROM sources WHERE id=$1', [id]);
    const early = check(row, id, opts.origin);
    if (early) { results.push(early); continue; }
    if (opts.origin === 'remote') {
      const lfs = lfsTracked(row!.local_path!);
      if (lfs === 'tracked') { results.push(refusal(id, 'lfs_tracked', `Source ${id} tracks files with git-lfs. A clone with git-lfs downloads off holds pointer files where this checkout holds their content, so its next reclone would not match the canonical manifest, and converting the checkout rewrites its files, which this command does not do; nothing changed. If the source should not keep these files, check that nothing in its checkout is unpushed or only local, then remove it (gbrain sources remove ${id} --confirm-destructive).`)); continue; }
      if (lfs === 'unknown') { results.push(refusal(id, 'lfs_unknown', `Source ${id}'s checkout is missing or Git could not list it, so gbrain cannot confirm that no file is tracked with git-lfs; nothing changed. Restore the checkout, then run this again.`)); continue; }
    }
    if (!opts.apply) {
      results.push({ source_id: id, status: 'would_record', reason: `Source ${id} would be recorded as added by ${recordedAs}${opts.origin === 'remote' ? '; its next reclone clones with git-lfs downloads and hooks off' : ''}.` });
      continue;
    }
    results.push(await engine.transaction(async tx => {
      const [locked] = await tx.executeRaw<SourceRowLike>('SELECT id, local_path, config, archived FROM sources WHERE id=$1 FOR UPDATE', [id]);
      const config = locked ? parseSourceConfig(locked.config) : {};
      if (check(locked, id, opts.origin) || locked!.local_path !== row!.local_path || config.remote_url !== parseSourceConfig(row!.config).remote_url)
        return refusal(id, 'source_changed', `Source ${id} changed while its origin was being recorded; nothing changed. Run the preview again.`);
      await tx.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1',
        [id, JSON.stringify(normalizeSourceConfig({ ...config, added_by_remote_caller: opts.origin === 'remote' }))]);
      return { source_id: id, status: 'recorded' as const, reason: `Source ${id} is recorded as added by ${recordedAs}.` };
    }));
  }
  return { origin: opts.origin, apply: opts.apply, results };
}
