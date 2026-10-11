import { mkdtemp, copyFile, realpath, lstat, rm } from 'node:fs/promises';
import { existsSync, openSync, closeSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';
import { isSourceGitRepository } from '../source-git.ts';

export type SyncedGitFile = { path: string; hash?: string; deleted?: boolean };
export type SyncedGitResult = { repository: boolean; committed: boolean; commit: string | null; previousCommit: string | null; files: string[]; pending: Array<{ path: string; reason: string }> };
export type SyncedGitOptions = { signal?: AbortSignal; beforeCommit?: () => Promise<void> };
export async function sourceFileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function commitSyncedSourceFiles(root: string, files: SyncedGitFile[], options: SyncedGitOptions = {}): Promise<SyncedGitResult> {
  options.signal?.throwIfAborted();
  const result: SyncedGitResult = { repository: isSourceGitRepository(root), committed: false, commit: null, previousCommit: null, files: [], pending: [] };
  if (!result.repository || !files.length) return result;
  const temporary = await mkdtemp(join(tmpdir(), 'pmbrain-git-'));
  let indexLock: string | undefined;
  let lockOwned = false;
  const git = (args: string[], index?: string, input?: string, optional = false, publishing = false): Promise<string> => new Promise((resolveResult, reject) => {
    if (!publishing) options.signal?.throwIfAborted();
    const child = spawn('git', ['-C', root, '-c', `core.hooksPath=${join(temporary, 'no-hooks')}`, ...args], {
      windowsHide: true, stdio: ['pipe','pipe','pipe'],
      signal: publishing ? undefined : options.signal, timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(index ? { GIT_INDEX_FILE: index } : {}) },
    });
    let output = '', error = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => code !== 0 && !optional ? reject(new Error(error.trim() || `git exited ${code}`)) : resolveResult(output));
    child.stdin.on('error', reject); child.stdin.end(input);
  });
  try {
    const base = (await git(['rev-parse', '--verify', 'HEAD'], undefined, undefined, true)).trim();
    result.previousCommit = base || null;
    const ref = (await git(['symbolic-ref', '-q', 'HEAD'], undefined, undefined, true)).trim();
    if (!ref) throw new Error('Git 当前不在分支上，请先选择分支再提交');
    const index = resolve(root, (await git(['rev-parse', '--git-path', 'index'])).trim());
    indexLock = index + '.lock';
    const fd = openSync(indexLock, 'wx'); closeSync(fd); lockOwned = true;
    const staged = new Set((await git(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean));
    const treeIndex = join(temporary, 'tree-index'), adjustedIndex = join(temporary, 'adjusted-index');
    (await git(base ? ['read-tree', base] : ['read-tree', '--empty'], treeIndex));
    if (existsSync(index)) await copyFile(index, adjustedIndex);
    else (await git(base ? ['read-tree', base] : ['read-tree', '--empty'], adjustedIndex));
    const actualRoot = await realpath(root);
    const entries: string[] = [];
    const trackedFiles = new Map((await git(['ls-files','-s','-z'])).split('\0').filter(Boolean).map(row=>[row.slice(row.indexOf('\t')+1),row.slice(0,6)]));
    for (const file of new Map(files.map(file => [file.path, file])).values()) {
      options.signal?.throwIfAborted();
      try {
        const path = file.path.replace(/\\/g, '/');
        if (!path || path.includes('\0') || path.split('/').some(part => part === '..' || part.toLowerCase() === '.git') || isAbsolute(path)) throw new Error('不允许的文件路径');
        const target = resolve(root, path);
        let existingParent = dirname(target);
        while (!existsSync(existingParent) && existingParent !== dirname(existingParent)) existingParent = dirname(existingParent);
        const local = relative(actualRoot, await realpath(existingParent));
        if (local.startsWith('..') || isAbsolute(local)) throw new Error('文件不在当前 Source 内');
        let nested = dirname(target);
        while (nested !== resolve(root)) {
          if (existsSync(join(nested, '.git'))) throw new Error('嵌套 Git 仓库须单独提交');
          const next = dirname(nested); if (next === nested) throw new Error('不允许的文件路径'); nested = next;
        }
        if (staged.has(path)) throw new Error('该文件已有用户暂存修改，留待手动提交');
        if (file.deleted) {
          if (existsSync(target)) throw new Error('同步后文件已恢复或改变');
          entries.push(`0 ${'0'.repeat(base.length || 40)}\t${path}\0`);
        } else {
          if (!file.hash || !(await lstat(target)).isFile()) throw new Error('缺少同步内容凭据或文件不是普通文件');
          if ((await git(['check-ignore', '--', path], undefined, undefined, true)).trim()) throw new Error('Git 忽略的文件不自动提交');
          const snapshot = join(temporary, `file-${entries.length}`);
          await copyFile(target, snapshot);
          if (await sourceFileHash(snapshot) !== file.hash) throw new Error('文件在同步后已改变，等待下轮同步');
          const blob = (await git(['hash-object', '-w', `--path=${path}`, '--', snapshot])).trim();
          const mode = trackedFiles.get(path)==='100755' ? '100755' : '100644';
          entries.push(`${mode} ${blob}\t${path}\0`);
        }
        result.files.push(path);
      } catch (error) { options.signal?.throwIfAborted(); result.pending.push({ path: file.path, reason: error instanceof Error ? error.message : String(error) }); }
    }
    if (!entries.length) return result;
    (await git(['update-index', '-z', '--index-info'], treeIndex, entries.join('')));
    (await git(['update-index', '-z', '--index-info'], adjustedIndex, entries.join('')));
    const tree = (await git(['write-tree'], treeIndex)).trim();
    if (base && tree === (await git(['rev-parse', `${base}^{tree}`])).trim()) { result.files = []; return result; }
    const identity = [
      ...((await git(['config','--get','user.name'],undefined,undefined,true)).trim() ? [] : ['-c','user.name=PMBrain']),
      ...((await git(['config','--get','user.email'],undefined,undefined,true)).trim() ? [] : ['-c','user.email=pmbrain@localhost']),
    ];
    const commit = (await git([...identity, 'commit-tree', '--no-gpg-sign', tree, ...(base ? ['-p', base] : []), '-m', `PMBrain 快速维护：同步 ${result.files.length} 个文件`])).trim();
    await options.beforeCommit?.();
    options.signal?.throwIfAborted();
    copyFileSync(adjustedIndex, indexLock);
    (await git(['update-ref', ref, commit, base || '0'.repeat(commit.length)], undefined, undefined, false, true));
    renameSync(indexLock, index); lockOwned = false;
    result.committed = true; result.commit = commit;
    return result;
  } finally {
    if (lockOwned && indexLock) unlinkSync(indexLock);
    await rm(temporary, { recursive: true, force: true });
  }
}
