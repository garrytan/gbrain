/**
 * cross-modal-eval/receipt-name — bind a receipt to a specific skill version.
 *
 * Receipt filenames embed a SHA-8 of the SKILL.md content, so the audit can
 * tell whether the receipt corresponds to the *current* version of the skill
 * (T10=A). Filename pattern:
 *
 *   <skill-slug>-<sha8>.json
 *
 * findReceiptForSkill returns one of:
 *   - { status: 'found', path }                 — receipt matches current SKILL.md
 *   - { status: 'stale', latestPath, sha }      — receipt(s) exist for older versions
 *   - { status: 'missing' }                     — no receipt for this skill
 *
 * Pure functions — no fs writes (the writer is in receipt-write.ts). The
 * skillify-check audit and the runner share these helpers so naming stays in
 * one place.
 */

import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join } from 'path';

export type ReceiptStatus =
  | { status: 'found'; path: string; sha: string }
  | { status: 'stale'; latestPath: string; latestSha: string; currentSha: string }
  | { status: 'missing'; currentSha: string };

/**
 * SHA-256 of skill content, truncated to 8 hex chars. 16M-receipt collision
 * space per slug is more than enough; the receipts are owned by one user.
 */
export function sha8(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Generate the canonical receipt filename for a (slug, content) pair.
 * Returned as a bare filename (no directory), so the caller controls layout.
 */
export function receiptName(slug: string, content: string): string {
  if (!slug || typeof slug !== 'string') throw new Error('receiptName: slug required');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug)) {
    throw new Error(`receiptName: slug must be alphanumeric/dash/underscore; got: ${slug}`);
  }
  return `${slug}-${sha8(content)}.json`;
}

/**
 * Read the SKILL.md at `skillPath` (or return null when missing) and look in
 * `receiptDir` for any receipt matching the slug embedded in skillPath.
 */
export function findReceiptForSkill(skillMdPath: string, receiptDir: string): ReceiptStatus {
  if (!existsSync(skillMdPath)) {
    return { status: 'missing', currentSha: '' };
  }

  const slug = inferSlugFromSkillPath(skillMdPath);
  const content = readFileSync(skillMdPath, 'utf-8');
  const currentSha = sha8(content);
  const expectedName = `${slug}-${currentSha}.json`;
  const expectedPath = join(receiptDir, expectedName);

  if (existsSync(expectedPath)) {
    return { status: 'found', path: expectedPath, sha: currentSha };
  }

  if (!existsSync(receiptDir)) {
    return { status: 'missing', currentSha };
  }

  // Look for stale receipts (same slug, different sha).
  const prefix = `${slug}-`;
  const matches: Array<{ path: string; sha: string; mtime: number }> = [];
  for (const entry of readdirSync(receiptDir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue;
    const sha = entry.slice(prefix.length, -'.json'.length);
    if (sha === currentSha) continue;
    if (!/^[0-9a-f]{8}$/i.test(sha)) continue;
    const path = join(receiptDir, entry);
    try {
      const mtime = statSync(path).mtimeMs;
      matches.push({ path, sha, mtime });
    } catch {
      // Skip files we can't stat — they'll be missing-by-effect.
    }
  }
  if (matches.length === 0) return { status: 'missing', currentSha };

  matches.sort((a, b) => b.mtime - a.mtime);
  const latest = matches[0]!;
  return {
    status: 'stale',
    latestPath: latest.path,
    latestSha: latest.sha,
    currentSha,
  };
}

/**
 * Pull the slug out of a SKILL.md path. We accept:
 *   - skills/<slug>/SKILL.md
 *   - <skills-root>/<slug>/SKILL.md
 *   - <slug>/SKILL.md (relative)
 * The slug is the immediate parent directory name.
 */
export function inferSlugFromSkillPath(skillMdPath: string): string {
  const parts = skillMdPath.replace(/\\/g, '/').split('/');
  const last = parts[parts.length - 1];
  if (last !== 'SKILL.md') {
    throw new Error(
      `inferSlugFromSkillPath: expected path ending in SKILL.md; got: ${skillMdPath}`,
    );
  }
  const parent = parts[parts.length - 2];
  if (!parent) {
    throw new Error(
      `inferSlugFromSkillPath: cannot infer slug — no parent directory in: ${skillMdPath}`,
    );
  }
  return parent;
}

export function describeReceiptStatus(slug: string, status: ReceiptStatus): string {
  switch (status.status) {
    case 'found':
      return `cross-modal eval receipt found for ${slug} (sha ${status.sha}; matches current SKILL.md)`;
    case 'stale':
      return (
        `cross-modal eval receipt for ${slug} exists for an older SKILL.md ` +
        `(receipt sha ${status.latestSha}, current sha ${status.currentSha}). ` +
        `Re-run \`gbrain eval cross-modal\` against the current skill output.`
      );
    case 'missing':
      return `no cross-modal eval receipt for ${slug} yet — run \`gbrain eval cross-modal\` to add one`;
  }
}

/** For tests + tools: pull all receipts for a slug, ordered newest first. */
export function listReceiptsForSlug(slug: string, receiptDir: string): string[] {
  if (!existsSync(receiptDir)) return [];
  const prefix = `${slug}-`;
  const out: Array<{ path: string; mtime: number }> = [];
  for (const entry of readdirSync(receiptDir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue;
    const path = join(receiptDir, entry);
    try {
      out.push({ path, mtime: statSync(path).mtimeMs });
    } catch {
      // Skip unreadable.
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.map(o => o.path);
}

/** Used by skillify-check to fall back to basename matching when needed. */
export function isReceiptFile(path: string): boolean {
  const name = basename(path);
  return /^[a-z0-9][a-z0-9_-]*-[0-9a-f]{8}\.json$/i.test(name);
}
