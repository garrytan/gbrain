import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, lstatSync, openSync, fstatSync, readSync, closeSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Action } from '../agent-output.ts';
import { opError } from '../ops/contract.ts';
import { HARDENED_GIT_ARGS, hardenedGitEnvironment } from '../hardened-git.ts';
import {
  COMPANY_BRAIN_MAX_ENTRIES, COMPANY_BRAIN_MAX_FILE_BYTES, COMPANY_BRAIN_MAX_METADATA_BYTES,
  type CommittedEntry, type InspectionLimits, type RevisionIdentity, type UncommittedEntry,
} from './types.ts';

function inspectAgain(root: string, why: string, extra: string[] = []): Action {
  return { argv: ['gbrain', 'sources', 'inspect', root, '--profile', 'company-brain', ...extra, '--json'], consent: [], actor: 'agent', why, requires_exclusive: false };
}

export function inspectionLimits(input: InspectionLimits = {}): Required<InspectionLimits> {
  const defaults = { maxEntries: COMPANY_BRAIN_MAX_ENTRIES, maxMetadataBytes: COMPANY_BRAIN_MAX_METADATA_BYTES, maxFileBytes: COMPANY_BRAIN_MAX_FILE_BYTES };
  for (const key of Object.keys(defaults) as (keyof InspectionLimits)[]) {
    const value = input[key] ?? defaults[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > defaults[key]) {
      throw opError('invalid_params', 'Inspection limits must be positive integers no larger than the built-in limits.',
        `Omit the limits to use the built-ins, or pass positive integers no larger than maxEntries ${COMPANY_BRAIN_MAX_ENTRIES}, maxMetadataBytes ${COMPANY_BRAIN_MAX_METADATA_BYTES}, and maxFileBytes ${COMPANY_BRAIN_MAX_FILE_BYTES}.`);
    }
    defaults[key] = value;
  }
  return defaults;
}

export function safeRepositoryPath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !/[\\\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

async function gitRead(root: string, args: string[], maxBytes: number, onChunk?: (chunk: Buffer) => void): Promise<Buffer> {
  return await new Promise((accept, reject) => {
    const child = spawn('git', [...HARDENED_GIT_ARGS, '-C', root, ...args],
    { env: hardenedGitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = opError('invalid_source', 'Git inspection timed out; narrow the repository and retry.',
        `A local Git read in ${root} ran past its 30-second limit. Inspect a smaller checkout (a separate repository or sparse clone holding only the Markdown to import); the inspection is read-only, so rerunning it once after other disk activity settles is safe.`);
      child.kill('SIGKILL');
    }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failure = opError('request_too_large', 'Inspection exceeds its bounded metadata or file limit; partition the repository or narrow selection.',
          `Git output from ${root} passed its ${maxBytes}-byte cap. Split the content into a smaller checkout and inspect that path, or exclude the oversized files with --exclude on gbrain sources inspect.`);
        child.kill('SIGKILL');
        return;
      }
      try { if (onChunk) onChunk(chunk); else chunks.push(chunk); }
      catch (error) { failure = error as Error; child.kill('SIGKILL'); }
    });
    child.stderr.resume();
    child.on('error', () => { failure = opError('invalid_source', 'Git is unavailable for local inspection.',
      'Install Git and make sure `git` is on the PATH of the gbrain process, then run the inspection again; company sources are read only through local Git.'); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(opError('invalid_source', 'The local Git revision is unavailable or invalid; inspect a committed checkout.',
        `Git could not read ${root} at the requested revision. Confirm it is a Git checkout with at least one commit and that an approved commit still exists locally (no fetch is attempted), then inspect it again with gbrain sources inspect.`));
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
      if (++count > limits.maxEntries) throw opError('request_too_large', 'Inspection exceeds the entry limit; partition the repository.',
        `The checkout at ${root} lists more than ${limits.maxEntries} Git entries. Split it into smaller checkouts and inspect each one separately.`);
      let record: string;
      try { record = new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(offset, end)); }
      catch {
        throw opError('invalid_source', 'Git contains a path that is not valid UTF-8.',
          `Rename the file whose name is not valid UTF-8 in ${root}, commit the rename, then inspect again; plans cannot represent that path.`);
      }
      visit(record);
      offset = end + 1;
    }
    pending = pending.subarray(offset);
  });
  if (pending.length) {
    throw opError('invalid_source', 'Git returned an incomplete inventory.',
      `Git's listing of ${root} ended mid-record, usually because the checkout changed during the read. Let other Git activity finish, then inspect again; inspection is read-only.`);
  }
}

export async function resolveCommittedRevision(path: string, revision?: string): Promise<RevisionIdentity> {
  const root = resolve(path);
  try {
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory() || /[\x00-\x1f\x7f]/.test(root)) throw new Error();
  } catch {
    throw opError('invalid_source', 'Inspect a real local directory without symlink components.',
      `Pass the checkout's real path to gbrain sources inspect: ${root} must be an existing directory reached without symlinks or control characters.`);
  }
  if (revision !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) {
    throw opError('invalid_source', 'An approved revision must be a full Git commit object ID.',
      'Use the full 40- or 64-character commit ID recorded in the approved plan (plan.revision.commit), not a branch name or abbreviated hash.');
  }
  const text = async (args: string[]) => (await gitRead(root, args, 64 * 1024)).toString('utf8').replace(/\n$/, '');
  const gitRoot = await text(['rev-parse', '--show-toplevel']);
  const gitDir = await text(['rev-parse', '--absolute-git-dir']);
  if (realpathSync(gitRoot) !== gitRoot || realpathSync(gitDir) !== gitDir) {
    throw opError('invalid_source', 'The Git directory or checkout resolves through a symlink.',
      `The checkout at ${gitRoot} or its Git directory ${gitDir} is reached through a symlink. Clone or move it to a real path without symlinks, then inspect that path.`);
  }
  const scope = relative(gitRoot, root).split(sep).join('/');
  if (scope && !safeRepositoryPath(scope)) {
    throw opError('invalid_source', 'The source directory is outside its Git checkout.',
      `Inspect ${gitRoot} or a directory inside it whose relative path has no '.', '..', or .git components.`);
  }
  const commit = await text(['rev-parse', '--verify', '--end-of-options', `${revision ?? 'HEAD'}^{commit}`]);
  const tree = await text(['rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`]);
  const objectFormat = await text(['rev-parse', '--show-object-format']);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree) ||
    (objectFormat !== 'sha1' && objectFormat !== 'sha256')) {
    throw opError('invalid_source', 'Unsupported Git object identity.',
      `Git reported a commit, tree, or object format for ${gitRoot} that gbrain cannot verify. Inspect a SHA-1 or SHA-256 repository checked out at a normal commit.`);
  }
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
    if (tab < 0 || !match) {
      throw opError('invalid_source', 'Git returned an invalid tree entry.',
        `Git listed a tree entry in ${revision.git_root} that gbrain cannot parse. Check the repository with git fsck, then inspect it again.`);
    }
    const path = record.slice(tab + 1);
    if (revision.scope && !path.startsWith(`${revision.scope}/`)) return;
    const bytes = match[4] === '-' ? null : Number(match[4]);
    if (bytes !== null && !Number.isSafeInteger(bytes)) {
      throw opError('request_too_large', 'Git blob size exceeds supported bounds.',
        `A blob in ${revision.git_root} reports a size beyond safe integer bounds. Remove it from the repository or inspect a checkout without it.`);
    }
    entries.push({ path: revision.scope ? path.slice(revision.scope.length + 1) : path,
      mode: match[1]!, object_type: match[2] as 'blob' | 'commit', object_id: match[3]!, bytes });
  });
  return entries;
}

export async function readCommittedBlob(revision: RevisionIdentity, entry: CommittedEntry, input?: InspectionLimits): Promise<Buffer> {
  const limits = inspectionLimits(input);
  if (!safeRepositoryPath(entry.path) || !/^100(?:644|755)$/.test(entry.mode) || entry.object_type !== 'blob' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.object_id)) {
    throw opError('invalid_source', 'Only safe committed regular blobs can be read.',
      `Only committed regular files at safe repository paths are readable. Inspect ${revision.root} again so the plan lists only eligible files.`,
      { fix: inspectAgain(revision.root, 'A fresh read-only inspection rebuilds the manifest from verified committed blobs.') });
  }
  if (entry.bytes === null || entry.bytes > limits.maxFileBytes) {
    throw opError('request_too_large', 'Markdown exceeds the import file limit; split it into smaller files.',
      `${entry.path} is larger than the ${limits.maxFileBytes}-byte file limit. Split it into smaller files and commit them, or exclude it, then inspect again.`,
      { fix: inspectAgain(revision.root, 'Previews the plan without the oversized file; inspection is read-only.', [`--exclude=${entry.path}`]) });
  }
  const gitPath = revision.scope ? `${revision.scope}/${entry.path}` : entry.path;
  const treeEntry = (await gitRead(revision.git_root,
    ['ls-tree', '-r', '-l', '-z', '--full-tree', revision.tree, '--', `:(literal)${gitPath}`], 64 * 1024)).toString('utf8');
  const separator = treeEntry.indexOf('\t');
  const expected = `${entry.mode} blob ${entry.object_id} ${entry.bytes}`;
  if (separator < 0 || treeEntry.slice(0, separator).replace(/ +/g, ' ') !== expected || treeEntry.slice(separator + 1) !== `${gitPath}\0`) {
    throw opError('invalid_source', 'The blob does not belong to the approved revision and path.',
      `${entry.path} at approved commit ${revision.commit} is not in the checkout at ${revision.root} as planned. Inspect the checkout again; gbrain never substitutes current HEAD for an approved commit, so a missing commit needs a new reviewed plan.`,
      { fix: inspectAgain(revision.root, 'Shows what the checkout holds now without changing the brain or the repository.') });
  }
  const result = await gitRead(revision.git_root, ['cat-file', 'blob', entry.object_id], limits.maxFileBytes);
  const hash = createHash(revision.object_format).update(`blob ${result.length}\0`).update(result).digest('hex');
  if (result.length !== entry.bytes || hash !== entry.object_id) {
    throw opError('invalid_source', 'The approved committed blob identity does not match its bytes.',
      `Git returned bytes for ${entry.path} that do not hash to ${entry.object_id}, so the object store in ${revision.git_root} may be damaged. Check it with git fsck, then inspect ${revision.root} again.`,
      { fix: inspectAgain(revision.root, 'Re-reads and re-verifies every committed blob without changing the brain or the repository.') });
  }
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
    if (!match) {
      throw opError('invalid_source', 'Git returned an invalid index entry.',
        `Git listed an index entry in ${revision.git_root} that gbrain cannot parse. Check the index with git status and git fsck, then inspect ${revision.root} again.`);
    }
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
    throw opError('request_too_large', 'Uncommitted inventory exceeds inspection limits; narrow the repository.',
      `The checkout at ${revision.root} has more uncommitted or untracked files than the limits allow (${limits.maxEntries} entries, ${limits.maxMetadataBytes} metadata bytes). Commit, remove, or git-ignore them, then inspect again.`);
  }
  return result;
}
