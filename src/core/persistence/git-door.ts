/**
 * G2, the door of git-canonical memory (Git is the source of truth; the database derives from it): a source whose row says `config.canonical = "git"` (strict, default off)
 * commits each published file to Git before its database row commits. publishMutation and publishGroup commit the
 * published paths with one commit under the worktree's writer lock, after the files are renamed into place and before
 * the database transaction commits, and stamp the commit on the receipt (`outcome.persistence.git_commit`). The Git
 * effect of such a write only pushes.
 *
 * The commit is made by plumbing, without the checkout's index (GBRA-174: a porcelain `commit --only` rewrites and
 * refreshes the whole index, about 1.7 s at 312k files): `hash-object -w` hashes each published file (its clean
 * filters apply, as `git add` would), the trees along the changed paths are rebuilt from HEAD's (`cat-file tree`, then
 * `hash-object -w -t tree`, which refuses a malformed tree), `commit-tree` writes the commit with the porcelain path's
 * message (`commitMessage`), and `update-ref <branch> <new> <old>` moves the branch only if it still names the HEAD the
 * commit was built on. A branch that moved meanwhile (a commit made in the checkout) is read again and the commit
 * rebuilt once; a second move refuses, so the publication rolls back. The checkout's index then gets exactly the
 * published entries (`update-index --cacheinfo` / `--force-remove`): `git status` shows them clean, a later commit from
 * that index keeps them, and every other entry, staged or not, is left as it was.
 *
 * Each file comes with its planned state (`DoorFile.planned`): the sha256 of the bytes the publication wrote there, or
 * null for a removal. The door commits exactly that state or nothing. The file on disk must hash to the plan before
 * and after `hash-object -w` stores it (an edit landing during the write refuses `git_target_changed`), and each
 * target's index entry must equal HEAD's before the commit is built (a staged change of a target refuses
 * `git_index_conflict`, index untouched). After the branch moves, an entry someone staged meanwhile is left as it is
 * and the write reports that its commit landed. An entry still holding the version the path's last commit replaced counts
 * as clean, whatever commits of other paths landed since: it is what an interrupted refresh after the door's own commit
 * leaves, and its bytes are in history, so the
 * next write (or a replay whose blob HEAD already holds) refreshes it and reports the paths (`onIndexRestored`, the
 * `git_index_restored` notice); any other staged entry refuses `git_index_conflict`.
 *
 * Recovery inverts for those writes: the recovery record names the HEAD it was prepared against (`door`), and a
 * publication that stopped after its commit landed keeps the committed file instead of restoring the prior bytes.
 * The request is queued again; its replay finds the file already holding the bytes it publishes, committed, and
 * completes the database row against it (page-prepare.ts).
 *
 * Door commits of one checkout run one at a time in this process (lane groups and a foreground write beside them share
 * the writer lock). They are not coalesced across publications: a single write holds its worktree lock exclusively
 * from its file rename to its database commit, the consumer runs one single write per root at a time, and a
 * publication refuses while another request of its worktree holds a recovery record, so no second write is ever
 * waiting at the door to join. Batching independent writes needs those three to change; until then a batch commits
 * once through publishGroup.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Notice } from '../agent-output.ts';
import { literalPathspecs } from '../git-env.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { commitMessage, git, gitBytes, gitFailure, gitStepTimeoutMs, ignoredTargetError, reclaimAbandonedIndexLock, withSession, type GitSession } from './effect-git.ts';
import type { GitCommitNote } from './effect-model.ts';
import { persistenceHome } from './identity.ts';
import { ignoreCandidates } from './ignore-rules.ts';
import { hashFile } from './large-file.ts';
import type { FileRecoveryRecord, SqlEngine } from './model.ts';
import { nativeFileTarget } from './native-file-target.ts';
import type { NativeLockHandle } from './native-lock.ts';
import { committedBlob, headBlob, headCommit } from './pending-import.ts';

/** Whether `sourceId` is a strict (git-canonical) source; `lock` reads its row FOR SHARE inside a publication. */
export async function sourceCanonicalGit(engine: SqlEngine, sourceId: string, lock = false): Promise<boolean> {
  const [row] = await engine.executeRaw<{ strict: boolean }>(
    `SELECT COALESCE(config->>'canonical','')='git' AS strict FROM sources WHERE id=$1${ lock ? ' FOR SHARE' : ''}`, [sourceId]);
  return row?.strict === true;
}

/** The door marker a strict publication's recovery record carries: the checkout it commits in and the HEAD it started from. */
export async function doorMarker(root: string): Promise<NonNullable<FileRecoveryRecord['door']>> {
  return { root, head: await headCommit(root) };
}

/** The refusal when a strict source's flag changed between preparation and publication. */
export function strictChanged(sourceId: string): OperationError {
  return new OperationError('source_changed', `Source ${sourceId}'s canonical mode changed after this write was prepared; nothing was published.`,
    'Retry the write with a new request_id.');
}

/** Test seam: runs after a door commit is written and before the compare-and-swap that moves the branch to it. */
export const doorSeams: { beforeUpdateRef?: (root: string, attempt: number) => Promise<void> | void } = {};

const doorTurns = new Map<string, Promise<void>>();
/** Refusals that keep their own code: the checkout's state, not the commit, stopped the write. */
const TYPED = new Set(['git_detached_head', 'git_branch_unborn', 'git_index_locked', 'git_index_stale', 'git_target_changed', 'git_index_conflict']);
const landedFailures = new WeakSet<object>();

/** One published file of a door commit and the state the commit must give its path. */
export interface DoorFile {
  path: string;
  /** The planned state: the sha256 of the bytes the publication wrote at `path`, or null for a removal. */
  planned: string | null;
  note?: GitCommitNote;
}

/**
 * Commits the published files of one publication under the caller's writer lock and returns the commit HEAD then
 * names (the commit that holds these bytes, also when every path was already committed). Each path is committed in
 * its planned state or not at all. A target Git refuses, a file that no longer holds its plan, or a target with a
 * staged change throws, so the publication rolls back.
 */
export async function commitThroughDoor(root: string, files: DoorFile[], writerLock?: NativeLockHandle, onIndexRestored?: (paths: string[]) => void): Promise<string | null> {
  let key = resolve(root);
  try { key = realpathSync(root); } catch { /* the session reports a missing checkout */ }
  const prior = doorTurns.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const turn = prior.then(() => new Promise<void>(done => { release = done; }));
  doorTurns.set(key, turn);
  await prior;
  try {
    return await withSession(root, undefined, writerLock ? { writerLock } : undefined, false, session => doorCommit(session, root, files, onIndexRestored));
  } catch (error) {
    if (!(error instanceof OperationError) || TYPED.has(error.code) || landedFailures.has(error)) throw error;
    const paths = files.map(file => relative(root, file.path).split(sep).join('/'));
    throw opError(error.code === 'git_target_ignored' ? 'git_target_ignored' : 'git_unavailable', `The strict source's commit of ${paths.join(', ')} failed, so this write was not published.`,
      `${error.message} A strict (canonical: git) source publishes a file only once Git holds it; recovery restores the prior bytes. Fix the checkout (git status on the brain host), then retry the write with a new request_id.`);
  } finally {
    release?.();
    if (doorTurns.get(key) === turn) doorTurns.delete(key);
  }
}

interface TreeEntry { mode: string; oid: Buffer }
interface Target { rel: string; name: string; dir: string; planned: string | null; note?: GitCommitNote; mode?: string; oid?: string; head?: string }
/** The index entries of the targets (`<mode> <oid>`, or `unmerged`) and the index file's identity when they were read. */
interface IndexSnapshot { signature: string; entries: Map<string, string> }

const TREE_MODE = '40000';
const latin1 = (text: string) => Buffer.from(text, 'utf8').toString('latin1');

interface Found { start: number; end: number; mode: string; oid: Buffer }
interface Dir { raw: Buffer; found: Map<string, Found>; edits: Map<string, TreeEntry | null> }

/** Each entry of a raw tree object, by byte range: [start, space) is its mode, (space, nul) its name, (nul, end) its id. */
function eachEntry(raw: Buffer, oidBytes: number, visit: (start: number, space: number, nul: number, end: number) => boolean | void): void {
  for (let at = 0; at < raw.length;) {
    const space = raw.indexOf(0x20, at), nul = space < 0 ? -1 : raw.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 1 + oidBytes > raw.length) throw gitFailure('Cannot read the canonical Git tree.', 'git cat-file returned a tree object that does not parse.');
    if (visit(at, space, nul, nul + 1 + oidBytes) === false) return;
    at = nul + 1 + oidBytes;
  }
}

/** The entries of a raw tree named in `names` (latin1), found in one pass without decoding the others. */
function lookupTree(raw: Buffer, oidBytes: number, names: string[]): Map<string, Found> {
  const found = new Map<string, Found>();
  const byLength = new Map<number, Buffer[]>();
  for (const name of new Set(names)) { const bytes = Buffer.from(name, 'latin1'); byLength.set(bytes.length, [...byLength.get(bytes.length) ?? [], bytes]); }
  if (!byLength.size) return found;
  eachEntry(raw, oidBytes, (start, space, nul, end) => {
    for (const name of byLength.get(nul - space - 1) ?? []) if (raw.compare(name, 0, name.length, space + 1, nul) === 0) {
      found.set(name.toString('latin1'), { start, end, mode: raw.toString('latin1', start, space), oid: raw.subarray(nul + 1, end) });
    }
    return found.size < names.length;
  });
  return found;
}

/**
 * A raw tree with `edits` applied (an entry set, or removed by null) and every other entry's bytes kept, in Git's
 * entry order: a new name is inserted where it sorts (a directory sorts as if its name ended in '/').
 */
function rewriteTree(dir: Dir, oidBytes: number): Buffer {
  const ops: { start: number; end: number; bytes: Buffer }[] = [];
  const inserts: { key: Buffer; bytes: Buffer }[] = [];
  for (const [name, entry] of dir.edits) {
    const before = dir.found.get(name);
    const bytes = entry ? Buffer.concat([Buffer.from(`${entry.mode} ${name}\0`, 'latin1'), entry.oid]) : Buffer.alloc(0);
    if (before && entry && (before.mode === TREE_MODE) === (entry.mode === TREE_MODE)) { ops.push({ start: before.start, end: before.end, bytes }); continue; }
    if (before) ops.push({ start: before.start, end: before.end, bytes: Buffer.alloc(0) });
    if (entry) inserts.push({ key: Buffer.from(entry.mode === TREE_MODE ? `${name}/` : name, 'latin1'), bytes });
  }
  inserts.sort((a, b) => Buffer.compare(a.key, b.key));
  let next = 0;
  if (inserts.length) eachEntry(dir.raw, oidBytes, (start, space, nul) => {
    const name = dir.raw.subarray(space + 1, nul);
    const key = space - start === TREE_MODE.length && dir.raw[start] === 0x34 ? Buffer.concat([name, Buffer.from('/')]) : name;
    while (next < inserts.length && Buffer.compare(inserts[next]!.key, key) < 0) ops.push({ start, end: start, bytes: inserts[next++]!.bytes });
    return next < inserts.length;
  });
  while (next < inserts.length) ops.push({ start: dir.raw.length, end: dir.raw.length, bytes: inserts[next++]!.bytes });
  ops.sort((a, b) => a.start - b.start || a.end - b.end);
  const chunks: Buffer[] = [];
  let at = 0;
  for (const op of ops) { chunks.push(dir.raw.subarray(at, op.start), op.bytes); at = op.end; }
  chunks.push(dir.raw.subarray(at));
  return Buffer.concat(chunks);
}

/** Git's whitespace cleanup of a `-m` paragraph, as `git commit -m` applies it: trailing blanks, repeated and edge blank lines go. */
function stripspace(paragraph: string): string {
  const lines: string[] = [];
  for (const line of paragraph.split('\n').map(text => text.replace(/[ \t\r]+$/, ''))) if (line || lines.length && lines[lines.length - 1]) lines.push(line);
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join('\n');
}

async function doorCommit(session: GitSession, root: string, files: DoorFile[], onIndexRestored?: (paths: string[]) => void): Promise<string> {
  const symbolic = await git(session, ['symbolic-ref', '-q', 'HEAD']);
  if (symbolic.code !== 0) throw opError('git_detached_head', `${root} is on a detached HEAD, so the strict source's write has no branch to commit to; nothing was published.`,
    'Check out the branch the source tracks (git switch <branch>) on the brain host, then retry the write with a new request_id.');
  const branch = symbolic.stdout.trim();
  const layout = await git(session, ['rev-parse', '--show-object-format', '--show-prefix', '--git-path', 'index']);
  if (layout.code !== 0) throw gitFailure('Cannot inspect the canonical Git checkout.', 'git rev-parse failed.');
  const [format, prefix = '', indexPath = ''] = layout.stdout.split('\n');
  const index = resolve(root, indexPath);
  try { session.timeoutMs = gitStepTimeoutMs(statSync(index).size); } catch { /* the step floor stands */ }
  const algorithm = format === 'sha256' ? 'sha256' : 'sha1';
  const oidBytes = algorithm === 'sha256' ? 32 : 20;

  const targets = new Map<string, Target>();
  for (const file of files) {
    const rel = relative(root, nativeFileTarget(root, file.path, 'git_target_unsafe')).split(sep).join('/');
    const full = `${prefix}${rel}`;
    const slash = full.lastIndexOf('/');
    const target = targets.get(rel) ?? { rel, dir: slash < 0 ? '' : full.slice(0, slash), name: latin1(full.slice(slash + 1)), planned: file.planned };
    target.note ??= file.note;
    targets.set(rel, target);
  }
  refuseChanged(root, targets.values());
  const present = [...targets.values()].filter(target => existsSync(join(root, target.rel)));
  if (present.length) {
    const hashed = await git(session, ['hash-object', '-w', '--', ...present.map(target => target.rel)]);
    const oids = hashed.stdout.split('\n').filter(Boolean);
    if (hashed.code !== 0 || oids.length !== present.length) throw gitFailure('Cannot hash the canonical Git target.', `git hash-object failed for ${present.length} file(s).`);
    present.forEach((target, i) => { target.oid = oids[i]; target.mode = lstatSync(join(root, target.rel)).mode & 0o111 ? '100755' : '100644'; });
  }
  let fileModeTrusted: boolean | undefined;
  refuseChanged(root, targets.values());

  const temp = join(persistenceHome(), 'door');
  mkdirSync(temp, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(temp, 'commit-'));
  try {
    for (let attempt = 0; ; attempt++) {
      const resolved = await git(session, ['rev-parse', '-q', '--verify', `${branch}^{commit}`]);
      if (resolved.code !== 0) throw opError('git_branch_unborn', `Branch ${branch} in ${root} has no commit yet, so the strict source's write has nothing to commit on; nothing was published.`,
        'Make the first commit on the branch with git on the brain host, then retry the write with a new request_id.');
      const head = resolved.stdout.trim();

      // The directories along every target path, read from HEAD level by level; only the named entries are decoded.
      const want = new Map<string, string[]>([['', []]]);
      for (const target of targets.values()) {
        for (let i = target.dir.indexOf('/'); target.dir; i = target.dir.indexOf('/', i + 1)) {
          const dir = i < 0 ? target.dir : target.dir.slice(0, i);
          const slash = dir.lastIndexOf('/');
          if (!want.has(dir)) want.set(dir, []);
          const parent = slash < 0 ? '' : dir.slice(0, slash);
          want.get(parent)!.push(latin1(dir.slice(slash + 1)));
          if (i < 0) break;
        }
        want.get(target.dir)!.push(target.name);
      }
      const depth = (dir: string) => dir ? dir.split('/').length : 0;
      const byDepth = [...want.keys()].sort((a, b) => depth(a) - depth(b));
      const dirs = new Map<string, Dir>();
      const read = async (dir: string, spec: string | null) => {
        const raw = spec === null ? Buffer.alloc(0) : await gitBytes(session, ['cat-file', 'tree', spec]);
        if (!raw) throw gitFailure('Cannot read the canonical Git tree.', `git cat-file could not read ${spec}.`);
        dirs.set(dir, { raw, found: lookupTree(raw, oidBytes, want.get(dir)!), edits: new Map() });
      };
      const parentOf = (dir: string) => { const slash = dir.lastIndexOf('/'); return { parent: dirs.get(slash < 0 ? '' : dir.slice(0, slash))!, name: latin1(dir.slice(slash + 1)) }; };
      await read('', head);
      for (let level = 1; level <= depth(byDepth[byDepth.length - 1]!); level++) {
        await Promise.all(byDepth.filter(dir => depth(dir) === level).map(dir => {
          const { parent, name } = parentOf(dir);
          const entry = parent.found.get(name);
          return read(dir, entry?.mode === TREE_MODE ? entry.oid.toString('hex') : null);
        }));
      }

      const changed: Target[] = [];
      const fresh: Target[] = [];
      for (const target of targets.values()) {
        const dir = dirs.get(target.dir)!;
        const before = dir.found.get(target.name);
        const indexMode = before && /^100[0-7]{3}$/.test(before.mode) ? (parseInt(before.mode, 8) & 0o100 ? '100755' : '100644') : before?.mode;
        target.head = before && before.mode !== TREE_MODE ? `${indexMode} ${before.oid.toString('hex')}` : undefined;
        if (target.oid) {
          if (!before || before.mode === TREE_MODE) fresh.push(target);
          if (before && /^100[0-7]{3}$/.test(before.mode) && target.mode !== before.mode) {
            fileModeTrusted ??= (await git(session, ['config', '--type=bool', '--default=true', 'core.fileMode'])).stdout.trim() !== 'false';
            if (!fileModeTrusted) target.mode = before.mode;
          }
          if (before && before.mode === target.mode && before.oid.toString('hex') === target.oid) continue;
          dir.edits.set(target.name, { mode: target.mode!, oid: Buffer.from(target.oid, 'hex') });
        } else {
          if (!before || before.mode === TREE_MODE) continue;
          dir.edits.set(target.name, null);
        }
        changed.push(target);
      }
      if (fresh.length) await refuseIgnored(session, root, fresh);
      const indexed = await readIndex(session, index, [...targets.values()]);
      const staged = [...targets.values()].filter(target => indexed.entries.get(target.rel) !== target.head);
      if (staged.length) {
        const replaced = await replacedEntries(session, head, staged);
        const foreign = staged.filter(target => indexed.entries.get(target.rel) !== replaced.get(target.rel));
        if (foreign.length) throw indexConflict(root, foreign);
      }
      const restored = () => { if (staged.length) onIndexRestored?.(staged.map(target => target.rel)); };
      if (!changed.length) {
        if (staged.length) await syncIndex(session, root, prefix, index, [...targets.values()], head, indexed);
        restored();
        return head;
      }

      // The trees are rebuilt bottom-up: an emptied directory leaves its parent, the rest are written and linked.
      const written: { path: string; oid: string }[] = [];
      let tree = '';
      for (const path of [...byDepth].reverse()) {
        const dir = dirs.get(path)!;
        if (!dir.edits.size && path) continue;
        const content = rewriteTree(dir, oidBytes);
        const link = path ? parentOf(path) : null;
        if (link && !content.length) { link.parent.edits.set(link.name, null); continue; }
        const oid = createHash(algorithm).update(`tree ${content.length}\0`).update(content).digest();
        const file = join(scratch, `tree-${attempt}-${written.length}`);
        writeFileSync(file, content);
        written.push({ path: file, oid: oid.toString('hex') });
        if (link) link.parent.edits.set(link.name, { mode: TREE_MODE, oid });
        else tree = oid.toString('hex');
      }
      const stored = await git(session, ['hash-object', '-w', '-t', 'tree', '--no-filters', '--', ...written.map(entry => entry.path)]);
      if (stored.code !== 0 || stored.stdout.split('\n').filter(Boolean).join() !== written.map(entry => entry.oid).join()) {
        throw gitFailure('Cannot write the canonical Git tree.', `git hash-object refused a rebuilt tree: ${stored.stderr.trim().slice(0, 300) || 'object ids differ'}.`);
      }

      const noted = new Map(changed.flatMap(target => target.note ? [[target.rel, target.note] as const] : []));
      const message = commitMessage(changed.map(target => target.rel), noted).map(stripspace).filter(Boolean);
      const commit = await git(session, ['commit-tree', tree, '-p', head, ...message.flatMap(paragraph => ['-m', paragraph])]);
      if (commit.code !== 0) throw gitFailure('Cannot commit the canonical Git target.',
        `git commit-tree failed for ${changed.length} file(s); a missing Git identity (user.name, user.email) in that checkout is one cause to check.`);
      const created = commit.stdout.trim();
      await doorSeams.beforeUpdateRef?.(root, attempt);
      const moved = await git(session, ['update-ref', '-m', `commit: ${message[0]!.split('\n')[0]}`, branch, created, head]);
      if (moved.code === 0) {
        await syncIndex(session, root, prefix, index, [...targets.values()], created, indexed);
        restored();
        return created;
      }
      if (attempt) throw new OperationError('git_unavailable', `${branch} in ${root} moved twice while this write was being committed, so it was not committed.`,
        'Another commit landed in the checkout during the write; nothing of this write is in Git.');
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/**
 * The new targets a .gitignore rule excludes (a negated rule matching last un-ignores) refuse as `git_target_ignored`.
 * Only the targets some ignore rule could match (ignore-rules.ts) are asked of check-ignore.
 */
async function refuseIgnored(session: GitSession, root: string, fresh: Target[]): Promise<void> {
  const candidates = new Set(await ignoreCandidates(root, fresh.map(target => target.rel)));
  const asked = fresh.filter(target => candidates.has(target.rel));
  if (!asked.length) return;
  // check-ignore refuses pathspec magic and reads a path literally except a leading ':', which ./ keeps literal; -n prints one
  // line per path, in order, so no path is parsed back.
  const matched = await git(session, ['check-ignore', '-v', '-n', '--', ...asked.map(target => target.rel.startsWith(':') ? `./${target.rel}` : target.rel)]);
  if (matched.code !== 0 && matched.code !== 1) throw gitFailure('Cannot inspect the canonical Git target.', `git check-ignore failed for ${asked.length} file(s).`);
  const lines = matched.stdout.split('\n');
  asked.forEach((target, i) => {
    const rule = /^(.*):(\d+):(.*)$/.exec((lines[i] ?? '').split('\t')[0]!);
    if (rule && rule[3] && !rule[3].startsWith('!')) throw ignoredTargetError(target.rel, `${rule[1]}:${rule[2]}: ${rule[3]}`);
  });
}

/** The notice a write carries when the door restored index entries an interrupted refresh after its own commit left behind. */
export function indexRestoredNotice(paths: string[]): Notice {
  return { code: 'git_index_restored', kind: 'info',
    why: `gbrain restored index to HEAD after an interrupted door refresh for ${paths.join(', ')}: the index still held the version before an earlier gbrain commit (its update of the index had failed), so this write replaced that stale entry. Nothing was lost; the earlier version is in Git history.` };
}

/** The targets whose file no longer holds its planned state (its bytes, or no file for a removal) refuse as `git_target_changed`. */
function refuseChanged(root: string, targets: Iterable<Target>): void {
  const moved = [...targets].filter(target => { try { return hashFile(join(root, target.rel)) !== target.planned; } catch { return true; } }).map(target => target.rel);
  if (!moved.length) return;
  throw opError('git_target_changed', `${moved.join(', ')} in ${root} no longer holds the bytes this write published, so nothing was committed and the write was not published.`,
    'Another process changed the file during the write. If the file now holds neither this write\'s bytes nor the version before it, recovery leaves it as it is and holds the write, so the source\'s later writes wait: preview with gbrain repair stuck-recovery --json, ask the user which version to keep, then apply that choice with the --keep, --expect and --apply --yes flags the preview lists (--keep disk keeps the edit). If it holds the version before the write, nothing is held and the write failed; read the page before resubmitting it with a new request_id.', { detail: moved.join(',') });
}

/** Targets whose index entry differs from HEAD's and from the version their path's last commit replaced (a staged change, or a merge conflict) refuse as `git_index_conflict`. */
function indexConflict(root: string, staged: Target[]): OperationError {
  const paths = staged.map(target => target.rel);
  return opError('git_index_conflict', `${paths.join(', ')} in ${root} has a staged change that is not committed, so this write committed nothing and the index was left as it was.`,
    'Commit the staged change, or unstage it (git restore --staged -- <path> keeps the file on disk), then retry the write with a new request_id.', {
      detail: paths.join(','),
      fix: { ask_user: true, argv: ['git', '-C', root, 'restore', '--staged', '--', ...paths], consent: [], actor: 'user', requires_exclusive: false,
        why: 'The door commits a path only while its index entry equals HEAD\'s, so a staged change is never overwritten or committed under a gbrain commit. Unstaging keeps the file on disk; committing it publishes that change.',
        user_message: `${paths.join(', ')} in ${root} has a staged change that is not committed, so gbrain did not commit its write there. Commit the staged change, or unstage it (its bytes stay on disk), then retry the write?`,
        verify: { argv: ['git', '-C', root, 'diff', '--cached', '--name-only', '--', ...paths] } },
    });
}

const indexSignature = (index: string) => {
  try { const stat = statSync(index, { bigint: true }); return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; } catch { return ''; }
};

/** The index entries of the targets, keyed by path relative to the root; the signature is read first, so a later match proves no rewrite. */
async function readIndex(session: GitSession, index: string, targets: Target[]): Promise<IndexSnapshot> {
  const signature = indexSignature(index);
  const listed = await git(session, ['ls-files', '-s', '-z', '--', ...literalPathspecs(targets.map(target => target.rel))]);
  if (listed.code !== 0) throw gitFailure('Cannot read the canonical Git index.', `git ls-files failed for ${targets.length} file(s).`);
  const entries = new Map<string, string>();
  for (const record of listed.stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, oid, stage] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    entries.set(path, stage === '0' && !entries.has(path) ? `${mode} ${oid}` : 'unmerged');
  }
  return { signature, entries };
}

/**
 * Each target's blob entry as it was before the last commit reachable from `commit` that changed its path (none when that
 * commit added it, or the path was never committed): what the index still holds when that commit's refresh failed,
 * whatever commits touching other paths landed since.
 */
async function replacedEntries(session: GitSession, commit: string, targets: Target[]): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  for (const target of targets) {
    const last = await git(session, ['rev-list', '-1', commit, '--', ...literalPathspecs([target.rel])]);
    const changed = last.stdout.trim();
    if (last.code !== 0 || !changed) continue;
    const listed = await git(session, ['ls-tree', '-z', `${changed}^`, '--', ...literalPathspecs([target.rel])]);
    if (listed.code !== 0) continue;
    for (const record of listed.stdout.split('\0')) {
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const [mode, type, oid] = record.slice(0, tab).split(' ');
      if (type === 'blob' && record.slice(tab + 1) === target.rel) entries.set(target.rel, `${mode} ${oid}`);
    }
  }
  return entries;
}

/**
 * Points the checkout's index entries of the targets at `commit`'s (a removed target leaves the index) and touches no
 * other entry. An entry that changed since `seen` was read (someone staged it during the write) is left as it is. A
 * failure here comes after the commit landed, so it says so instead of claiming nothing was published.
 *
 * The compare and the write run under Git's own index lock (`<index>.lock`, created exclusively): the entries are read
 * and a copy of the index is updated while the lock is held, and the copy is renamed onto the lock and the lock onto the
 * index, as Git commits an index. No writer that takes the lock can change the index between the compare and the write.
 * A writer that reads the index before locking it (a raw `git commit -- <path>`) is outside this guarantee. The lock
 * stays open until its rename, so the #6932 proof never takes it for abandoned; a lock that proof does find abandoned is
 * reclaimed under the caller's writer lock before the refresh gives up.
 */
async function syncIndex(session: GitSession, root: string, prefix: string, index: string, targets: Target[], commit: string, seen: IndexSnapshot): Promise<void> {
  let failure = '', restaged: Target[] = [], held = false, fd: number | null = null;
  const lock = `${index}.lock`, copy = `${index}.gbrain-${process.pid}-${randomBytes(6).toString('hex')}`;
  const take = () => {
    try { return openSync(lock, 'wx'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null; throw error; }
  };
  try {
    fd = take();
    const reclaimed = fd === null ? reclaimAbandonedIndexLock(session, lock) : true;
    if (fd === null && reclaimed === true) fd = take();
    held = fd !== null;
    if (!held) failure = `Unable to create '${lock}': File exists; another git process holds the index lock${reclaimed === true ? '' : ` (not reclaimed: ${reclaimed})`}`;
    if (held) {
      const moved = indexSignature(index) !== seen.signature;
      // Git never rewrites an index in place (it writes <file>.lock and renames it), so a hard link is a safe copy.
      if (existsSync(index)) try { linkSync(index, copy); } catch { copyFileSync(index, copy); }
      if (moved) {
        const now = await readIndex({ ...session, indexFile: copy }, copy, targets);
        restaged = targets.filter(target => now.entries.get(target.rel) !== seen.entries.get(target.rel));
      }
      const synced = targets.filter(target => !restaged.includes(target));
      const kept = synced.filter(target => target.oid), removed = synced.filter(target => !target.oid);
      if (synced.length) {
        const updated = await git({ ...session, indexFile: copy }, ['update-index', '--add', '--force-write-index', ...kept.flatMap(target => ['--cacheinfo', `${target.mode},${target.oid},${prefix}${target.rel}`]),
          ...(removed.length ? ['--force-remove', '--', ...removed.map(target => target.rel)] : [])]);
        if (updated.code !== 0) failure = updated.stderr.trim().slice(0, 300) || `exit ${updated.code}`;
        else { closeSync(fd!); fd = null; renameSync(copy, lock); renameSync(lock, index); held = false; }
      }
    }
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally {
    if (fd !== null) closeSync(fd);
    rmSync(copy, { force: true });
    if (held) rmSync(lock, { force: true });
  }
  if (!failure && !restaged.length) return;
  const error = failure
    ? opError('git_unavailable', `The strict source's commit ${commit.slice(0, 12)} landed, but the index of ${root} was not updated for ${targets.map(target => target.rel).join(', ')}.`,
      `git update-index failed (${failure}). Git holds the write; until the index is refreshed, git status lists those paths as staged reversions and a commit made from that index would undo them. Run git reset -q -- <those paths> in that checkout on the brain host.`)
    : opError('git_unavailable', `The strict source's commit ${commit.slice(0, 12)} landed, but the index of ${root} was left as it was for ${restaged.map(target => target.rel).join(', ')}: a change was staged there during the write.`,
      'Git holds the write, and the staged change was not overwritten; git diff --cached -- <path> in that checkout shows it against the new commit. Commit it, or unstage it with git restore --staged -- <path> (the file stays on disk).');
  landedFailures.add(error);
  throw error;
}

/** Whether the working tree and HEAD both hold the record's published state at its path (its bytes, or no entry for a removal). */
export async function holdsCommittedAfter(record: FileRecoveryRecord & { door: NonNullable<FileRecoveryRecord['door']> }): Promise<boolean> {
  if (record.afterHash === null) return hashFile(record.path) === null && await headBlob(record.door.root, record.path) === null;
  return hashFile(record.path) === record.afterHash && await committedBlob(record.door.root, record.path) !== null;
}

/**
 * Whether the door commit of a stopped strict publication landed: HEAD moved past the record's starting point and
 * holds the published state. Such a file is kept, never restored.
 */
export async function doorCommitLanded(record: FileRecoveryRecord): Promise<boolean> {
  if (!record.door) return false;
  const head = await headCommit(record.door.root);
  return !!head && head !== record.door.head && await holdsCommittedAfter({ ...record, door: record.door });
}

/** A strict write replayed after its door commit landed: the file already holds the bytes it publishes, committed. */
export async function replayAfterDoorCommit(record: FileRecoveryRecord): Promise<boolean> {
  return !!record.door && record.beforeHash === record.afterHash && await holdsCommittedAfter({ ...record, door: record.door });
}
