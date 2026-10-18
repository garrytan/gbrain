import { lstatSync, readdirSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { OperationError, opError } from '../ops/contract.ts';
import { catalogueError } from '../error-catalogue.ts';

/** The longest file or directory name, in bytes, the supported file systems store (NAME_MAX). */
const NATIVE_NAME_MAX_BYTES = 255;

/**
 * A name the file system cannot store (over NAME_MAX bytes, or ENAMETOOLONG):
 * the slug is the problem, so it is a caller error with the move as its fix,
 * never a storage failure an agent retries.
 */
function fileNameTooLong(): OperationError {
  return opError('invalid_params', 'The canonical file name is longer than the file system allows.',
    'Write the page under a slug whose segments are at most 240 bytes each (put_page refuses new longer ones and names one), then delete_page the old slug.',
    { detail: 'file_name_too_long', why: `A slug segment becomes a file or directory name, and file systems store at most ${NATIVE_NAME_MAX_BYTES} bytes per name.` });
}

export function nativeFileTarget(root: string, target: string, code?: string): string {
  const unsafe = () => new OperationError(code ?? 'source_changed', 'The canonical file target has no unambiguous native identity.',
    'Reconcile the recorded file path with the registered worktree before retrying publication.');
  const inaccessible = () => new OperationError(code ?? 'storage_error', 'The canonical file target cannot be accessed as a regular file.',
    'Repair the filesystem obstruction or permissions before submitting a new publication request.');
  try {
    const localRoot = resolve(root);
    const path = relative(localRoot, resolve(target));
    if (!path || isAbsolute(path) || path.split(sep).includes('..')) throw unsafe();
    const physicalRoot = realpathSync(localRoot);
    const rootInfo = statSync(physicalRoot, { bigint: true });
    if (!rootInfo.isDirectory()) throw unsafe();
    const segments = path.split(sep);
    if (segments.some(segment => Buffer.byteLength(segment) > NATIVE_NAME_MAX_BYTES)) throw fileNameTooLong();
    const names: string[] = [];
    let parent = physicalRoot;
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i];
      let info: BigIntStats;
      try { info = lstatSync(join(parent, name), { bigint: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENAMETOOLONG') throw fileNameTooLong();
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        names.push(...segments.slice(i));
        break;
      }
      if (info.isSymbolicLink()) throw unsafe();
      if (i < segments.length - 1 ? !info.isDirectory() : !info.isFile()) throw inaccessible();
      const entries = readdirSync(parent);
      let actual = name;
      if (!entries.includes(name)) {
        if (!info.ino) throw unsafe();
        const matches = entries.filter(entry => {
          const candidate = lstatSync(join(parent, entry), { bigint: true });
          return candidate.dev === info.dev && candidate.ino === info.ino && candidate.mode === info.mode;
        });
        if (matches.length !== 1) throw unsafe();
        actual = matches[0];
      }
      names.push(actual);
      parent = join(parent, actual);
    }
    const current = statSync(localRoot, { bigint: true });
    if (realpathSync(localRoot) !== physicalRoot || current.dev !== rootInfo.dev || current.ino !== rootInfo.ino
      || current.birthtimeNs !== rootInfo.birthtimeNs) throw unsafe();
    return join(localRoot, ...names);
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw inaccessible();
  }
}

/**
 * #5032: `:` is not a legal NTFS file-name character (Windows reads it as an
 * alternate data stream), so a page whose canonical file name would contain
 * one has no file on Windows. Refused rather than mangled; database-only
 * writes of the same slug are unaffected.
 */
export function colonSlugWindowsRefusal(slug: string, sourceId: string): OperationError {
  return catalogueError('colon_slug_windows_write_through',
    `Page ${slug} has a ':' in its file name, which Windows cannot store.`,
    `Use a slug without ':' (for example ${slug.replaceAll(':', '-')}), or write ${slug} from a macOS or Linux host that owns source ${sourceId}.`);
}

/** #5032: true when this process is on Windows and the relative file target contains `:`. */
export function isWindowsColonTarget(relativeTarget: string): boolean {
  return process.platform === 'win32' && relativeTarget.includes(':');
}
