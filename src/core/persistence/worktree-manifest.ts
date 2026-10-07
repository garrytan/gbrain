/**
 * The canonical worktree manifest that writer transfer, rebind (`sources
 * set-path`), clone and reclone compare: a digest over relative path ->
 * sha256 of the file's bytes, plus the file count, with deletions caught by
 * exact path-set equality. Stored manifests carry only the digest, count and
 * scope, so their size does not grow with the worktree.
 *
 * #6099: a Git checkout is hashed in `git` scope, over the paths Git tracks
 * (`git ls-files -z --cached --stage`, hashed from the working-tree bytes; an
 * index entry missing on disk counts as deleted). Ignored files (a `.env.local`,
 * `node_modules`) are never opened, so a clean clone verifies and secrets are
 * never read or hashed. Untracked files Git does not ignore are reported as a
 * count only. A directory that is not the top of its own Git work tree keeps the
 * `tree` scope: every file except `.git`, `.gbrain-managed` and physical-root
 * metadata. A manifest without `scope` is in `tree` scope, which is also what every
 * manifest an older release stored is, so those keep verifying in that scope.
 *
 * Git runs through `hardened-git.ts` (the candidate directory's config is
 * untrusted). Symlinks, submodules (gitlinks) and tracked paths that resolve
 * outside the root (including an index entry with a `..` segment) refuse with
 * `writer_manifest_unsafe` before anything is read.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { opError } from '../ops/contract.ts';
import { createProgress, type ProgressOptions } from '../progress.ts';
import { hardenedGitSync } from '../hardened-git.ts';
import { digest, sha256 } from './digest.ts';
import { isPhysicalRootMetadata } from './root-metadata.ts';
import type { PhysicalRootRecovery } from './physical-root-recovery.ts';

export type WorktreeManifestScope = 'git' | 'tree';
export interface WorktreeManifest { digest: string; file_count: number;
  /** `git` for a Git-scoped manifest; absent means `tree` (the only scope older releases recorded). */
  scope?: 'git';
  /** Git scope only: untracked files Git does not ignore, which the manifest does not cover (count only, never names). */
  untracked_count?: number }
export type StoredWorktreeManifest = WorktreeManifest & { canonical_stamp?: string; self_transfer?: PhysicalRootRecovery };
export const MANIFEST_PROGRESS_MIN_FILES = 5000;
const GIT_LIMITS = { timeoutMs: 60_000, maxBytes: 256 * 1024 * 1024 };

/** The scope a stored manifest was recorded in (older releases recorded `tree` without saying so). */
export function storedManifestScope(manifest: { scope?: WorktreeManifestScope } | null | undefined): WorktreeManifestScope {
  return manifest?.scope === 'git' ? 'git' : 'tree';
}

/** `git` when `root` is the top of its own Git work tree, else `tree`. */
export function detectManifestScope(root: string): WorktreeManifestScope {
  const canonical = realpathSync(root);
  const top = hardenedGitSync(canonical, ['rev-parse', '--show-toplevel'], { timeoutMs: 10_000, maxBytes: 64 * 1024 });
  if (!top.ok) return 'tree';
  try { return realpathSync(top.stdout.toString('utf8').trim()) === canonical ? 'git' : 'tree'; } catch { return 'tree'; }
}

const unsafe = (message: string, suggestion: string) => opError('writer_manifest_unsafe', message, suggestion);
const excluded = (rel: string) => rel.split('/').some(part => part === '.git' || part === '.gbrain-managed' || isPhysicalRootMetadata(part));

/**
 * The manifest of `root` in `scope` (detected when omitted). `withFiles` also
 * returns the per-file map, for a caller that compares two local checkouts.
 */
export function worktreeManifest(root: string, opts: { progress?: ProgressOptions; scope?: WorktreeManifestScope; withFiles?: boolean } = {}): WorktreeManifest & { files?: Record<string, string> } {
  const canonical = realpathSync(root);
  const scope = opts.scope ?? detectManifestScope(canonical);
  const listed = scope === 'git' ? trackedPaths(canonical) : treePaths(canonical);
  const progress = opts.progress && listed.paths.length > MANIFEST_PROGRESS_MIN_FILES ? createProgress(opts.progress) : undefined;
  progress?.start('sources.manifest_hash', listed.paths.length);
  const files: Record<string, string> = {};
  for (const rel of listed.paths) {
    const bytes = scope === 'git' ? trackedBytes(canonical, rel) : readFileSync(join(canonical, ...rel.split('/')));
    if (bytes) files[rel] = sha256(bytes);
    progress?.tick();
  }
  progress?.finish();
  const count = Object.keys(files).length;
  return { digest: digest(files), file_count: count, ...(scope === 'git' ? { scope, untracked_count: listed.untracked ?? 0 } : {}),
    ...(opts.withFiles ? { files } : {}) };
}

function treePaths(canonical: string): { paths: string[]; untracked?: number } {
  const paths: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git' || name === '.gbrain-managed' || isPhysicalRootMetadata(name)) continue;
      const path = join(dir, name), info = lstatSync(path);
      if (info.isSymbolicLink()) throw unsafe('Canonical worktree transfer requires a symlink-free manifest.',
        `${relative(canonical, path).split(sep).join('/')} in the checkout is a symlink, so no manifest was recorded. Ask the user to replace it with a real file or directory (or remove it), then run the transfer step again.`);
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) paths.push(relative(canonical, path).split(sep).join('/'));
    }
  };
  visit(canonical);
  return { paths };
}

function trackedPaths(canonical: string): { paths: string[]; untracked: number } {
  const listed = hardenedGitSync(canonical, ['ls-files', '-z', '--cached', '--stage'], GIT_LIMITS);
  if (!listed.ok) throw unsafe('The canonical manifest is recorded from tracked Git files, and Git could not list them here.',
    `Git could not list the tracked files of ${canonical} (${listed.reason === 'exit' ? 'it is not the top of a Git checkout, or its index is unreadable' : listed.reason}), so no manifest was compared. `
      + 'Use a Git checkout of the same repository: for example git clone <the owner\'s repository> <this directory>, check out the same commit, then run the step again.');
  const paths = new Set<string>();
  for (const record of listed.stdout.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const mode = record.slice(0, record.indexOf(' ')), rel = record.slice(tab + 1);
    if (!insideCheckout(rel)) throw outsideCheckout(canonical);
    if (excluded(rel)) continue;
    if (mode === '160000') throw unsafe('Canonical worktree transfer does not support Git submodules.',
      `${rel} in ${canonical} is a Git submodule, so no manifest was recorded. Ask the user to replace the submodule with ordinary tracked files (or remove it), then run the step again.`);
    if (mode === '120000') throw unsafe('Canonical worktree transfer requires a symlink-free manifest.',
      `${rel} in the checkout is a tracked symlink, so no manifest was recorded. Ask the user to replace it with a real file (or remove it), then run the transfer step again.`);
    paths.add(rel);
  }
  const others = hardenedGitSync(canonical, ['ls-files', '-z', '--others', '--exclude-standard'], GIT_LIMITS);
  const untracked = others.ok ? others.stdout.toString('utf8').split('\0').filter(rel => rel && !excluded(rel)).length : 0;
  return { paths: [...paths].sort(), untracked };
}

/** A repository-relative path that names a file under the checkout: no empty, `.` or `..` segment and not absolute. */
function insideCheckout(rel: string): boolean {
  return !isAbsolute(rel) && rel.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
const outsideCheckout = (canonical: string) => unsafe('Canonical worktree transfer only hashes files inside the checkout.',
  `The Git index of ${canonical} lists a path that leaves the checkout (a hand-edited or corrupted index), so no manifest was recorded and nothing outside the checkout was read. `
    + 'Ask the user to replace the checkout with a fresh git clone of the same repository at the same commit, then run the step again.');

/** The working-tree bytes of a tracked path; null when it is missing on disk (counted as deleted). */
function trackedBytes(canonical: string, rel: string): Buffer | null {
  if (!insideCheckout(rel)) throw outsideCheckout(canonical);
  const path = join(canonical, ...rel.split('/'));
  const within = relative(canonical, path);
  if (within === '' || within.split(sep)[0] === '..' || isAbsolute(within)) throw outsideCheckout(canonical);
  let real: string;
  try { real = realpathSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw error;
  }
  if (real !== path || lstatSync(path).isSymbolicLink()) throw unsafe('Canonical worktree transfer requires a symlink-free manifest.',
    `${rel} in the checkout resolves through a symlink, so no manifest was recorded. Ask the user to replace the link with a real file or directory (or remove it), then run the transfer step again.`);
  if (!lstatSync(path).isFile()) return null;
  return readFileSync(path);
}

/** Drops a legacy per-file map from a stored manifest, keeping every other field. */
export function compactStoredManifest<T extends { digest: string; files?: Record<string, string>; file_count?: number }>(manifest: T): Omit<T, 'files'> & { file_count: number } {
  const { files, ...rest } = manifest;
  return { ...rest, file_count: rest.file_count ?? Object.keys(files ?? {}).length };
}

/** The first `limit` relative paths whose bytes differ, or that only one of two local checkouts has, in `scope`. */
export function manifestDifferences(left: string, right: string, scope: WorktreeManifestScope, limit = 5): { paths: string[]; total: number } {
  const a = worktreeManifest(left, { scope, withFiles: true }).files!, b = worktreeManifest(right, { scope, withFiles: true }).files!;
  const differing = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter(path => a[path] !== b[path]);
  return { paths: differing.slice(0, limit), total: differing.length };
}
