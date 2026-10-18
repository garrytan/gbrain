/**
 * #6729: Git pairs renames by content similarity, so `git diff -M` can pair
 * two near-identical files the wrong way round when they are moved and
 * rewritten in one range. Every sync path used to carry the old page's
 * identity (facts, links, aliases, a slug redirect) across each pair, so a
 * wrong guess moved one page's knowledge onto another.
 *
 * confirmRenameIdentities is the one stage between the manifest parser and
 * every consumer (classic, managed and the dirty-tree manifest):
 *
 *   - an exact rename (R100, byte-identical) stays a rename;
 *   - an inexact pair keeps its identity only when (a) both sides carry the
 *     same frontmatter id and no other file in the range or live page
 *     carries it, or (b) neither side has an id and the frontmatter slug:
 *     or the title (parseMarkdown's: frontmatter title:, then the first H1;
 *     the old side as its page row stores it) matches, that value is unique
 *     across every deleted and added path of the range, and (for a title) no
 *     other live page has it.
 *     Conflicting ids veto;
 *   - an added file whose id uniquely matches a file deleted in the same
 *     range is a rename (a move and an edit in separate commits, or a pair
 *     Git crossed) when the two also show continuity (same file name, same
 *     title or same bytes), as decideImportIdentity asks of a move;
 *   - every other inexact pair becomes a delete plus an add and is listed in
 *     downgradedRenames.
 *
 * Both sides are read through one git cat-file --batch stream (frontmatter
 * only: at most the first 64 KiB of each blob is kept).
 */
import { createHash } from 'node:crypto';
import { lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { JSON_SCHEMA, load as yamlLoad } from 'js-yaml';
import type { BrainEngine } from './engine.ts';
import { spawn } from './spawn.ts';
import { gitChildEnv } from './git-env.ts';
import { explicitMarkdownTitle } from './markdown.ts';
import { isMarkdownFilePath, resolveSlugForPath, type DowngradedRename, type RenameDowngradeReason, type RenameSideSource, type SyncManifest } from './sync.ts';
import { computeSyncDelta, type SyncDeltaResult } from './sync-delta.ts';

const HEAD_BYTES = 64 * 1024;

/** `digest`: sha256 of the whole file when it fit in the head read (null for a longer file), the content-continuity signal. */
export interface FrontmatterIdentity { id: string | null; slug: string | null; title: string | null; digest: string | null }
const NO_IDENTITY: FrontmatterIdentity = { id: null, slug: null, title: null, digest: null };

/**
 * The identity fields of a file: `id` and `slug` from its leading frontmatter block (unparseable or absent frontmatter
 * carries none), and the title parseMarkdown gives it (frontmatter `title:`, then the body's first H1) without the
 * filename fallback, so an H1-only page has the title its page row stores.
 */
export function frontmatterIdentity(head: Buffer | string | null): FrontmatterIdentity {
  if (head === null) return NO_IDENTITY;
  const text = (typeof head === 'string' ? head : head.toString('utf8')).replace(/^\uFEFF/, '');
  let title: string | null;
  try { title = explicitMarkdownTitle(text) || null; } catch { title = null; }
  const digest = Buffer.byteLength(head) < HEAD_BYTES ? createHash('sha256').update(head).digest('hex') : null;
  const block = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!block) return { ...NO_IDENTITY, title, digest };
  let data: unknown;
  try { data = yamlLoad(block[1]!, { schema: JSON_SCHEMA }); } catch { return { ...NO_IDENTITY, title, digest }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ...NO_IDENTITY, title, digest };
  const field = (key: string, numeric = false): string | null => {
    const value = (data as Record<string, unknown>)[key];
    const text = typeof value === 'string' ? value.trim() : numeric && typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    return text === '' ? null : text;
  };
  return { id: field('id', true), slug: field('slug'), title, digest };
}

/** The first 64 KiB of each `<rev>:<path>` object through one `git cat-file --batch` stream; null for a missing object or a non-blob. */
export async function catFileHeads(repo: string, objects: string[]): Promise<Array<Buffer | null>> {
  if (objects.length === 0) return [];
  return new Promise((done, fail) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '-C', repo, 'cat-file', '--batch'], { env: gitChildEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Array<Buffer | null> = [];
    let pending: Buffer = Buffer.alloc(0), remaining = -1, blob = false, kept: Buffer[] = [], keptBytes = 0, stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        if (remaining < 0) {
          const newline = pending.indexOf(10);
          if (newline < 0) return;
          const header = /^[0-9a-f]{40,64} (\S+) (\d+)$/.exec(pending.subarray(0, newline).toString('utf8'));
          pending = pending.subarray(newline + 1);
          if (!header) { out.push(null); continue; }
          blob = header[1] === 'blob'; remaining = Number(header[2]) + 1; kept = []; keptBytes = 0;
          continue;
        }
        if (pending.length === 0) return;
        const piece = pending.subarray(0, Math.min(remaining, pending.length));
        if (keptBytes < HEAD_BYTES) { const keep = piece.subarray(0, HEAD_BYTES - keptBytes); kept.push(Buffer.from(keep)); keptBytes += keep.length; }
        pending = pending.subarray(piece.length); remaining -= piece.length;
        if (remaining === 0) { remaining = -1; out.push(blob ? Buffer.concat(kept) : null); }
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8').slice(0, 2000); });
    child.on('error', fail);
    child.on('close', (code: number | null) => {
      if (code !== 0 || out.length !== objects.length) fail(new Error(`git cat-file --batch failed in ${repo} (exit ${code}): ${stderr.trim().slice(0, 300)}`));
      else done(out);
    });
    child.stdin!.end(objects.map(object => `${object}\n`).join(''));
  });
}

/** The first 64 KiB of a regular file inside `root`; null for a missing, escaping or non-regular path. */
/** The digest a dirty-tree rename verdict is bound to: sha256 of the first 64 KiB the verdict read. */
export const identityHeadDigest = (bytes: Buffer): string => createHash('sha256').update(bytes.subarray(0, HEAD_BYTES)).digest('hex');

/** `identityHeadDigest` of a working-tree file now; null when it is gone, not a regular file, or outside `root`. */
export function workingTreeIdentityHead(root: string, path: string): string | null {
  const head = workingTreeHead(root, path);
  return head === null ? null : identityHeadDigest(head);
}

function workingTreeHead(root: string, path: string): Buffer | null {
  const base = resolve(root);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- a git-reported repo-relative path, accepted only when it stays inside the repo root (checked on the next line) and is a regular file, never a symlink
  const absolute = resolve(base, path);
  if (!absolute.startsWith(base + sep)) return null;
  try {
    if (!lstatSync(absolute).isFile()) return null;
    const fd = openSync(absolute, 'r');
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      return buffer.subarray(0, readSync(fd, buffer, 0, HEAD_BYTES, 0));
    } finally { closeSync(fd); }
  } catch { return null; }
}

/**
 * The explicit-id veto every identity takeover consults (#6729): a file whose frontmatter id differs from the id of the
 * page it would inherit is a different document. Exported for the managed freeze loop's takeover branches.
 */
export function explicitIdVeto(incomingId: string | null, holderId: string | null): boolean {
  return !!incomingId && !!holderId && incomingId !== holderId;
}

/** A live page that shares an identity value with a renamed file; `source_path` and `slug` tell whether it belongs to a path of this range. */
export interface LiveIdentityHolder { slug: string; source_path: string | null; fm_id: string | null; title: string | null }

export interface RenameIdentityInputs {
  /** Frontmatter of the base side (deleted and renamed-from paths) and the target side (added and renamed-to paths). */
  base: (path: string) => FrontmatterIdentity;
  target: (path: string) => FrontmatterIdentity;
  /** Live pages carrying any candidate id or title. */
  live: LiveIdentityHolder[];
  /** Maps a Git path to its source-relative form; a page recording either form belongs to the range. */
  sourcePathOf?: (gitPath: string) => string;
  /** Where the target side was read (the base side is always a committed blob); defaults to `commit`. */
  targetSource?: RenameSideSource;
}

/** Inexact pairs, or an add/delete pool rule (c) can pair; with neither the manifest passes through untouched. */
export function needsRenameConfirmation(manifest: SyncManifest): boolean {
  return manifest.renamed.some(rename => rename.similarity !== undefined && rename.similarity < 100)
    || (manifest.added.some(isMarkdownFilePath) && manifest.deleted.some(isMarkdownFilePath));
}

/**
 * The pure decision over one manifest (see the module header). Returns a new manifest: confirmed renames stay in
 * `renamed`, every other inexact pair is split into `deleted` + `added` and listed in `downgradedRenames`.
 */
export function decideRenameIdentities(manifest: SyncManifest, inputs: RenameIdentityInputs): SyncManifest {
  if (!needsRenameConfirmation(manifest)) return manifest;
  const sourcePathOf = inputs.sourcePathOf ?? ((path: string) => path);
  const exact = manifest.renamed.filter(rename => rename.similarity === undefined || rename.similarity >= 100);
  const inexact = manifest.renamed.filter(rename => rename.similarity !== undefined && rename.similarity < 100);
  const baseSide = [...manifest.deleted, ...manifest.renamed.map(rename => rename.from)];
  const targetSide = [...manifest.added, ...manifest.renamed.map(rename => rename.to)];
  const counter = (paths: string[], read: (path: string) => FrontmatterIdentity) => {
    const counts = new Map<string, number>();
    const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const path of paths) {
      const identity = read(path);
      if (identity.id) bump(`id\0${identity.id}`);
      if (identity.slug) bump(`slug\0${identity.slug}`);
      if (identity.title) bump(`title\0${identity.title}`);
    }
    return (key: string) => counts.get(key) ?? 0;
  };
  const baseCount = counter(baseSide, inputs.base), targetCount = counter(targetSide, inputs.target);
  // A live page belonging to a path this range removes or rewrites is the page being decided, not a competitor.
  const rangeOrigins = new Set([...baseSide, ...targetSide].flatMap(path => [path, sourcePathOf(path)]));
  const rangeSlugs = new Set([...rangeOrigins].map(path => resolveSlugForPath(path)).filter(Boolean));
  const competitors = inputs.live.filter(page => page.source_path !== null ? !rangeOrigins.has(page.source_path) : !rangeSlugs.has(page.slug));
  const liveIds = new Set(competitors.flatMap(page => page.fm_id ? [page.fm_id] : []));
  const liveTitles = new Set(competitors.flatMap(page => page.title ? [page.title] : []));
  const uniqueId = (id: string) => baseCount(`id\0${id}`) === 1 && targetCount(`id\0${id}`) === 1 && !liveIds.has(id);

  const confirmed: SyncManifest['renamed'] = [];
  const downgraded: DowngradedRename[] = [];
  for (const rename of inexact) {
    const before = inputs.base(rename.from), after = inputs.target(rename.to);
    const downgrade = (reason: RenameDowngradeReason) => downgraded.push({ from: rename.from, to: rename.to, similarity: rename.similarity!, reason,
      read: { from: 'commit', to: inputs.targetSource ?? 'commit' } });
    // A respelled path (case or separators) that keeps its slug is the same-slug takeover managed discovery already
    // performs: it keeps the page unless an explicit id conflicts.
    const sameSlug = resolveSlugForPath(sourcePathOf(rename.from)) === resolveSlugForPath(sourcePathOf(rename.to));
    if (sameSlug && !explicitIdVeto(after.id, before.id)) { confirmed.push(rename); continue; }
    if (before.id && after.id) {
      if (explicitIdVeto(after.id, before.id)) downgrade('id_conflict');
      else if (uniqueId(before.id)) confirmed.push(rename);
      else downgrade('id_shared');
      continue;
    }
    if (before.id || after.id) { downgrade('id_one_side'); continue; }
    const unique = (kind: 'slug' | 'title', value: string) => baseCount(`${kind}\0${value}`) === 1 && targetCount(`${kind}\0${value}`) === 1;
    if (before.slug && before.slug === after.slug && unique('slug', before.slug)) { confirmed.push(rename); continue; }
    if (before.title && before.title === after.title) {
      if (unique('title', before.title) && !liveTitles.has(before.title)) confirmed.push(rename);
      else downgrade('title_not_unique');
      continue;
    }
    downgrade(before.slug && before.slug === after.slug ? 'slug_not_unique' : 'no_identity_signal');
  }

  // Rule (c): an added file whose id uniquely matches a file this range deletes keeps that page's identity when the two
  // also show continuity, as decideImportIdentity asks of a move whose origin is gone: the same file name, the same
  // title, or the same bytes. A template id reused by an unrelated new note is not a rename.
  const continuous = (from: string, to: string) => {
    const before = inputs.base(from), after = inputs.target(to);
    return from.split('/').pop() === to.split('/').pop() || (!!before.title && before.title === after.title) || (!!before.digest && before.digest === after.digest);
  };
  const added = [...manifest.added, ...downgraded.map(pair => pair.to)];
  const deleted = [...manifest.deleted, ...downgraded.map(pair => pair.from)];
  const deletedById = new Map<string, string[]>();
  for (const path of deleted) {
    const id = isMarkdownFilePath(path) ? inputs.base(path).id : null;
    if (id) deletedById.set(id, [...(deletedById.get(id) ?? []), path]);
  }
  const promoted: SyncManifest['renamed'] = [];
  for (const path of added) {
    const id = isMarkdownFilePath(path) ? inputs.target(path).id : null;
    const from = id ? deletedById.get(id) : undefined;
    if (!id || from?.length !== 1 || !uniqueId(id) || !continuous(from[0]!, path)) continue;
    promoted.push({ from: from[0]!, to: path });
  }
  const promotedFrom = new Set(promoted.map(pair => pair.from)), promotedTo = new Set(promoted.map(pair => pair.to));
  const remaining = downgraded.filter(pair => !promotedFrom.has(pair.from) && !promotedTo.has(pair.to));
  return {
    added: added.filter(path => !promotedTo.has(path)),
    modified: manifest.modified,
    deleted: deleted.filter(path => !promotedFrom.has(path)),
    renamed: [...exact, ...confirmed, ...promoted],
    downgradedRenames: [...(manifest.downgradedRenames ?? []), ...remaining],
  };
}

export interface ConfirmRenameOpts { sourceId: string; /** See `RenameIdentityInputs.sourcePathOf`. */ sourcePathOf?: (gitPath: string) => string }

/**
 * Reads both sides' frontmatter and the live pages sharing their ids and titles, then applies
 * `decideRenameIdentities`. `target` null reads the target side from the working tree (the dirty-tree manifest,
 * whose base is HEAD).
 */
export async function confirmRenameIdentities(engine: Pick<BrainEngine, 'executeRaw'>, repo: string, base: string, target: string | null,
  manifest: SyncManifest, opts: ConfirmRenameOpts): Promise<SyncManifest> {
  if (!needsRenameConfirmation(manifest)) return manifest;
  const readable = (path: string) => isMarkdownFilePath(path) && !path.includes('\n');
  const basePaths = [...new Set([...manifest.deleted, ...manifest.renamed.map(rename => rename.from)].filter(readable))];
  const targetPaths = [...new Set([...manifest.added, ...manifest.renamed.map(rename => rename.to)].filter(readable))];
  const objects = [...basePaths.map(path => `${base}:${path}`), ...(target === null ? [] : targetPaths.map(path => `${target}:${path}`))];
  const heads = await catFileHeads(repo, objects);
  const baseIdentity = new Map(basePaths.map((path, index) => [path, frontmatterIdentity(heads[index] ?? null)]));
  const targetHeads = new Map(targetPaths.map((path, index) => [path, target === null ? workingTreeHead(repo, path) : heads[basePaths.length + index] ?? null]));
  const targetIdentity = new Map(targetPaths.map(path => [path, frontmatterIdentity(targetHeads.get(path) ?? null)]));
  // The old side's title is the one its page row stores: a page whose title changed in the brain is compared as it is now.
  const titled = basePaths.filter(path => baseIdentity.get(path)!.title);
  const sourcePathOf = opts.sourcePathOf ?? ((path: string) => path);
  const stored = titled.length ? await engine.executeRaw<{ slug: string; source_path: string | null; title: string | null }>(
    `SELECT slug, source_path, title FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND (source_path = ANY($2::text[]) OR slug = ANY($3::text[]))`,
    [opts.sourceId, [...new Set(titled.flatMap(path => [path, sourcePathOf(path)]))], titled.map(path => resolveSlugForPath(sourcePathOf(path)))]) : [];
  for (const path of titled) {
    const row = stored.find(page => page.source_path === path || page.source_path === sourcePathOf(path))
      ?? stored.find(page => page.source_path === null && page.slug === resolveSlugForPath(sourcePathOf(path)));
    if (row) baseIdentity.set(path, { ...baseIdentity.get(path)!, title: row.title?.trim() || null });
  }
  const identities = [...baseIdentity.values(), ...targetIdentity.values()];
  const ids = [...new Set(identities.flatMap(identity => identity.id ? [identity.id] : []))];
  const titles = [...new Set(identities.flatMap(identity => identity.title ? [identity.title] : []))];
  const live = ids.length || titles.length ? await engine.executeRaw<LiveIdentityHolder>(
    `SELECT slug, source_path, frontmatter->>'id' AS fm_id, title FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL AND (frontmatter->>'id' = ANY($2::text[]) OR title = ANY($3::text[]))`,
    [opts.sourceId, ids, titles]) : [];
  const decided = decideRenameIdentities(manifest, {
    base: path => baseIdentity.get(path) ?? NO_IDENTITY,
    target: path => targetIdentity.get(path) ?? NO_IDENTITY,
    live, sourcePathOf: opts.sourcePathOf, targetSource: target === null ? 'working_tree' : 'commit',
  });
  if (target !== null) return decided;
  // A dirty-tree verdict holds only for the bytes it read: each kept rename carries their digest, and the identity move
  // re-checks it against the bytes it imports (classic applyRename, managed readSyncContent).
  const stamp = (rename: SyncManifest['renamed'][number]) => {
    const head = targetHeads.get(rename.to);
    return head ? { ...rename, identityHead: identityHeadDigest(head) } : rename;
  };
  return { ...decided, renamed: decided.renamed.map(stamp) };
}

/** `computeSyncDelta` of a commit range with its renames confirmed (the commit-range half of every incremental sync). */
export async function confirmedSyncDelta(engine: Pick<BrainEngine, 'executeRaw'>, repo: string, from: string, to: string, opts: ConfirmRenameOpts): Promise<SyncDeltaResult> {
  const delta = computeSyncDelta(repo, from, to);
  return delta.status === 'ok' ? { status: 'ok', manifest: await confirmRenameIdentities(engine, repo, from, to, delta.manifest, opts) } : delta;
}
