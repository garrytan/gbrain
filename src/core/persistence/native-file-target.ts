import { lstatSync, readdirSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { OperationError } from '../ops/contract.ts';

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
    const names: string[] = [];
    let parent = physicalRoot;
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i];
      let info: BigIntStats;
      try { info = lstatSync(join(parent, name), { bigint: true }); }
      catch (error) {
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
