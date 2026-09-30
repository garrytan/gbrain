import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, lstatSync, openSync, fstatSync, readSync, closeSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { OperationError } from '../ops/contract.ts';
import {
  COMPANY_BRAIN_MAX_ENTRIES, COMPANY_BRAIN_MAX_FILE_BYTES, COMPANY_BRAIN_MAX_METADATA_BYTES,
  type CommittedEntry, type InspectionLimits, type RevisionIdentity, type UncommittedEntry,
} from './types.ts';

export function inspectionLimits(input: InspectionLimits = {}): Required<InspectionLimits> {
  const defaults = { maxEntries: COMPANY_BRAIN_MAX_ENTRIES, maxMetadataBytes: COMPANY_BRAIN_MAX_METADATA_BYTES, maxFileBytes: COMPANY_BRAIN_MAX_FILE_BYTES };
  for (const key of Object.keys(defaults) as (keyof InspectionLimits)[]) {
    const value = input[key] ?? defaults[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > defaults[key]) {
      throw new OperationError('invalid_params', 'Inspection limits must be positive integers no larger than the built-in limits.');
    }
    defaults[key] = value;
  }
  return defaults;
}

export function safeRepositoryPath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !/[\\\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', LC_ALL: 'C' };
}

async function gitRead(root: string, args: string[], maxBytes: number, onChunk?: (chunk: Buffer) => void): Promise<Buffer> {
  return await new Promise((accept, reject) => {
    const child = spawn('git', ['--no-pager', '--no-optional-locks', '--no-replace-objects',
      '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false',
      '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', 'credential.helper=',
      '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', root, ...args],
    { env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new OperationError('invalid_source', 'Git inspection timed out; narrow the repository and retry.');
      child.kill('SIGKILL');
    }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failure = new OperationError('request_too_large', 'Inspection exceeds its bounded metadata or file limit; partition the repository or narrow selection.');
        child.kill('SIGKILL');
        return;
      }
      try { if (onChunk) onChunk(chunk); else chunks.push(chunk); }
      catch (error) { failure = error as Error; child.kill('SIGKILL'); }
    });
    child.stderr.resume();
    child.on('error', () => { failure = new OperationError('invalid_source', 'Git is unavailable for local inspection.'); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new OperationError('invalid_source', 'The local Git revision is unavailable or invalid; inspect a committed checkout.'));
      else accept(Buffer.concat(chunks));
    });
  });
}

async function gitRecords(root: string, args: string[], limits: Required<InspectionLimits>, visit: (record: string) => void): Promise<void> {
  let pending = Buffer.alloc(0);
  let count = 0;
  await gitRead(root, args, limits.maxMetadataBytes, chunk => {
    pending = Buffer.concat([pending, chunk]);
    let offset = 0;
    for (;;) {
      const end = pending.indexOf(0, offset);
      if (end < 0) break;
      if (++count > limits.maxEntries) throw new OperationError('request_too_large', 'Inspection exceeds the entry limit; partition the repository.');
      let record: string;
      try { record = new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(offset, end)); }
      catch { throw new OperationError('invalid_source', 'Git contains a path that is not valid UTF-8.'); }
      visit(record);
      offset = end + 1;
    }
    pending = pending.subarray(offset);
  });
  if (pending.length) throw new OperationError('invalid_source', 'Git returned an incomplete inventory.');
}

export async function resolveCommittedRevision(path: string, revision?: string): Promise<RevisionIdentity> {
  const root = resolve(path);
  try {
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory() || /[\x00-\x1f\x7f]/.test(root)) throw new Error();
  } catch { throw new OperationError('invalid_source', 'Inspect a real local directory without symlink components.'); }
  if (revision !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) {
    throw new OperationError('invalid_source', 'An approved revision must be a full Git commit object ID.');
  }
  const text = async (args: string[]) => (await gitRead(root, args, 64 * 1024)).toString('utf8').replace(/\n$/, '');
  const gitRoot = await text(['rev-parse', '--show-toplevel']);
  const gitDir = await text(['rev-parse', '--absolute-git-dir']);
  if (realpathSync(gitRoot) !== gitRoot || realpathSync(gitDir) !== gitDir) {
    throw new OperationError('invalid_source', 'The Git directory or checkout resolves through a symlink.');
  }
  const scope = relative(gitRoot, root).split(sep).join('/');
  if (scope && !safeRepositoryPath(scope)) throw new OperationError('invalid_source', 'The source directory is outside its Git checkout.');
  const commit = await text(['rev-parse', '--verify', '--end-of-options', `${revision ?? 'HEAD'}^{commit}`]);
  const tree = await text(['rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`]);
  const objectFormat = await text(['rev-parse', '--show-object-format']);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree) ||
    (objectFormat !== 'sha1' && objectFormat !== 'sha256')) throw new OperationError('invalid_source', 'Unsupported Git object identity.');
  const rootStat = lstatSync(root, { bigint: true });
  const gitStat = lstatSync(gitDir, { bigint: true });
  return { root, git_root: gitRoot, git_dir: gitDir, scope, commit, tree, object_format: objectFormat,
    root_device: String(rootStat.dev), root_inode: String(rootStat.ino), git_device: String(gitStat.dev), git_inode: String(gitStat.ino) };
}

export async function inventoryCommittedRevision(revision: RevisionIdentity, input?: InspectionLimits): Promise<CommittedEntry[]> {
  const limits = inspectionLimits(input);
  const entries: CommittedEntry[] = [];
  await gitRecords(revision.git_root, ['ls-tree', '-r', '-l', '-z', '--full-tree', revision.tree], limits, record => {
    const tab = record.indexOf('\t');
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40,64}) +(-|\d+)$/.exec(record.slice(0, tab));
    if (tab < 0 || !match) throw new OperationError('invalid_source', 'Git returned an invalid tree entry.');
    const path = record.slice(tab + 1);
    if (revision.scope && !path.startsWith(`${revision.scope}/`)) return;
    const bytes = match[4] === '-' ? null : Number(match[4]);
    if (bytes !== null && !Number.isSafeInteger(bytes)) throw new OperationError('request_too_large', 'Git blob size exceeds supported bounds.');
    entries.push({ path: revision.scope ? path.slice(revision.scope.length + 1) : path,
      mode: match[1]!, object_type: match[2] as 'blob' | 'commit', object_id: match[3]!, bytes });
  });
  return entries;
}

export async function readCommittedBlob(revision: RevisionIdentity, entry: CommittedEntry, input?: InspectionLimits): Promise<Buffer> {
  const limits = inspectionLimits(input);
  if (!safeRepositoryPath(entry.path) || !/^100(?:644|755)$/.test(entry.mode) || entry.object_type !== 'blob' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.object_id)) {
    throw new OperationError('invalid_source', 'Only safe committed regular blobs can be read.');
  }
  if (entry.bytes === null || entry.bytes > limits.maxFileBytes) throw new OperationError('request_too_large', 'Markdown exceeds the import file limit; split it into smaller files.');
  const gitPath = revision.scope ? `${revision.scope}/${entry.path}` : entry.path;
  const treeEntry = (await gitRead(revision.git_root,
    ['ls-tree', '-r', '-l', '-z', '--full-tree', revision.tree, '--', `:(literal)${gitPath}`], 64 * 1024)).toString('utf8');
  const separator = treeEntry.indexOf('\t');
  const expected = `${entry.mode} blob ${entry.object_id} ${entry.bytes}`;
  if (separator < 0 || treeEntry.slice(0, separator).replace(/ +/g, ' ') !== expected || treeEntry.slice(separator + 1) !== `${gitPath}\0`) {
    throw new OperationError('invalid_source', 'The blob does not belong to the approved revision and path.');
  }
  const result = await gitRead(revision.git_root, ['cat-file', 'blob', entry.object_id], limits.maxFileBytes);
  const hash = createHash(revision.object_format).update(`blob ${result.length}\0`).update(result).digest('hex');
  if (result.length !== entry.bytes || hash !== entry.object_id) throw new OperationError('invalid_source', 'The approved committed blob identity does not match its bytes.');
  return result;
}

function workingBlob(root: string, path: string, format: string, cap: number): string | null {
  let fd: number | undefined;
  try {
    let component = root;
    for (const part of path.split('/')) {
      component = join(component, part);
      if (lstatSync(component).isSymbolicLink()) return null;
    }
    fd = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > cap || realpathSync(dirname(join(root, path))) !== dirname(join(root, path))) return null;
    const hash = createHash(format).update(`blob ${stat.size}\0`);
    const buffer = Buffer.alloc(Math.min(cap, 64 * 1024));
    let total = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > cap) return null;
      hash.update(buffer.subarray(0, count));
    }
    return total === stat.size ? hash.digest('hex') : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export async function inspectUncommitted(revision: RevisionIdentity, entries: CommittedEntry[], eligible: (path: string) => boolean,
  input?: InspectionLimits): Promise<UncommittedEntry[]> {
  const limits = inspectionLimits(input);
  const index = new Map<string, { oid: string; mode: string; stage: string }>();
  const local = (path: string) => revision.scope ? path.startsWith(`${revision.scope}/`) ? path.slice(revision.scope.length + 1) : null : path;
  await gitRecords(revision.git_root, ['ls-files', '--stage', '-z'], limits, record => {
    const tab = record.indexOf('\t');
    const match = /^(\d{6}) ([a-f0-9]{40,64}) ([0-3])$/.exec(record.slice(0, tab));
    if (!match) throw new OperationError('invalid_source', 'Git returned an invalid index entry.');
    const path = local(record.slice(tab + 1));
    if (path !== null) index.set(path, { oid: match[2]!, mode: match[1]!, stage: match[3]! });
  });
  const dirty = new Map<string, UncommittedEntry>();
  const committed = new Map(entries.map(entry => [entry.path, entry]));
  for (const path of new Set([...committed.keys(), ...index.keys()])) {
    const before = committed.get(path);
    const staged = index.get(path);
    const selected = eligible(path);
    let kind: UncommittedEntry['kind'] | undefined;
    if (before?.object_id !== staged?.oid || before?.mode !== staged?.mode || (staged && staged.stage !== '0')) kind = 'staged';
    if (selected) {
      if (!safeRepositoryPath(path)) kind = 'unsafe';
      else if (workingBlob(revision.root, path, revision.object_format, limits.maxFileBytes) !== before?.object_id) {
        kind ??= existsSync(join(revision.root, path)) ? 'modified' : 'deleted';
      }
    }
    if (kind) dirty.set(path, { path, kind, eligible: selected });
  }
  await gitRecords(revision.git_root, ['ls-files', '--others', '--exclude-standard', '-z'], limits, record => {
    const path = local(record);
    if (path !== null) dirty.set(path, { path, kind: 'untracked', eligible: eligible(path) });
  });
  const result = [...dirty.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (result.length > limits.maxEntries || Buffer.byteLength(JSON.stringify(result)) > limits.maxMetadataBytes) {
    throw new OperationError('request_too_large', 'Uncommitted inventory exceeds inspection limits; narrow the repository.');
  }
  return result;
}
