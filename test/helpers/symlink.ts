import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let fileSymlinkSupport: boolean | undefined;
let dirSymlinkSupport: boolean | undefined;

function canCreateSymlink(kind: 'file' | 'dir'): boolean {
  const tmp = mkdtempSync(join(tmpdir(), 'gbrain-symlink-cap-'));
  try {
    const target = join(tmp, `target-${kind}`);
    const link = join(tmp, `link-${kind}`);
    if (kind === 'dir') {
      mkdirSync(target);
      symlinkSync(target, link, 'dir');
    } else {
      writeFileSync(target, 'target');
      symlinkSync(target, link, 'file');
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') return false;
    throw error;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function canCreateFileSymlink(): boolean {
  fileSymlinkSupport ??= canCreateSymlink('file');
  return fileSymlinkSupport;
}

export function canCreateDirSymlink(): boolean {
  dirSymlinkSupport ??= canCreateSymlink('dir');
  return dirSymlinkSupport;
}
