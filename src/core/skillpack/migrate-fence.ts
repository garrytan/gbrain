/**
 * skillpack/migrate-fence.ts — `gbrain skillpack migrate-fence`.
 *
 * One-shot conversion for users running on the old (v0.19–v0.32.x)
 * managed-block model. Strips the `<!-- gbrain:skillpack:begin -->` /
 * `end -->` markers and the manifest receipt comment, but preserves
 * every row inside the fence verbatim. Rows become user-owned routing
 * the agent can still see during the transition to frontmatter-based
 * discovery.
 *
 * Also copies any missing skill directories the old fence referenced.
 * Additive only — never overwrites existing files.
 *
 * Idempotent. Re-running after migration finds no fence and exits 0.
 *
 * Receipt-then-row fallback (F-CDX-8): the `cumulative-slugs="…"`
 * receipt is the primary source of truth for which skills the fence
 * claims to manage. If the receipt is missing, malformed, or its slug
 * set doesn't match the rows in the fence, falls back to parsing rows
 * directly. Loud stderr warning when fallback fires.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { copyArtifacts, walkSourceDir } from './copy.ts';
import { findGbrainRoot, loadBundleManifest } from './bundle.ts';
import { findResolverFile } from '../resolver-filenames.ts';

const MANAGED_BEGIN = '<!-- gbrain:skillpack:begin -->';
const MANAGED_END = '<!-- gbrain:skillpack:end -->';
const RECEIPT_RE =
  /<!-- gbrain:skillpack:manifest cumulative-slugs="([^"]*)" version="([^"]*)" -->/;
const ROW_RE = /`skills\/([^/]+)\/SKILL\.md`/g;

export interface MigrateFenceOptions {
  /** Absolute path to the target workspace (parent of skills/). */
  targetWorkspace: string;
  /** Absolute path to gbrain repo root (source-of-truth bundle). When
   *  unset, copy-missing-skills is skipped (caller's resolver-file
   *  scrub still runs). */
  gbrainRoot?: string;
  /** Dry-run: preview, no writes. */
  dryRun?: boolean;
}

export type MigrateFenceStatus =
  | 'nothing_to_migrate'
  | 'fence_stripped'
  | 'fence_malformed';

export interface MigrateFenceResult {
  status: MigrateFenceStatus;
  /** Path to the resolver file. */
  resolverFile: string | null;
  /** Slugs the fence claimed to manage (from receipt or row fallback). */
  fenceSlugs: string[];
  /** Whether the receipt comment was missing/stale and we fell back to row parsing. */
  usedRowFallback: boolean;
  /** Skill dirs that were copied in (additive). */
  skillsCopied: string[];
  /** Skill dirs already present on host (skipped). */
  skillsAlreadyPresent: string[];
  dryRun: boolean;
}

/**
 * Parse a resolver file's content for the gbrain managed-block fence.
 * Returns null when no fence is present. Returns a structured shape
 * with begin/end offsets when present.
 */
export interface ParsedFence {
  /** Inclusive byte offset of the start of the begin marker. */
  beginIdx: number;
  /** Inclusive byte offset of the end of the end marker. */
  endIdx: number;
  /** Full text of the fence including markers. */
  block: string;
  /** Slugs extracted from cumulative-slugs receipt, or null when absent. */
  receiptSlugs: string[] | null;
  /** Version from receipt, or null. */
  receiptVersion: string | null;
  /** Slugs extracted from row patterns inside the fence. */
  rowSlugs: string[];
}

export function parseFence(content: string): ParsedFence | null {
  const beginIdx = content.indexOf(MANAGED_BEGIN);
  const endIdx = content.indexOf(MANAGED_END);
  if (beginIdx === -1 && endIdx === -1) return null;
  if (beginIdx === -1 || endIdx === -1) {
    // Malformed (one marker without the other). Signal upstream so the
    // caller can refuse to migrate and prompt for hand-fix.
    return {
      beginIdx,
      endIdx,
      block: '',
      receiptSlugs: null,
      receiptVersion: null,
      rowSlugs: [],
    };
  }
  if (endIdx <= beginIdx) {
    return {
      beginIdx,
      endIdx,
      block: '',
      receiptSlugs: null,
      receiptVersion: null,
      rowSlugs: [],
    };
  }

  const blockEnd = endIdx + MANAGED_END.length;
  const block = content.slice(beginIdx, blockEnd);

  const receiptMatch = RECEIPT_RE.exec(block);
  let receiptSlugs: string[] | null = null;
  let receiptVersion: string | null = null;
  if (receiptMatch) {
    receiptSlugs = receiptMatch[1].length === 0 ? [] : receiptMatch[1].split(',');
    receiptVersion = receiptMatch[2];
  }

  const rowSlugs: string[] = [];
  // Reset the regex's lastIndex (it's global) before exec'ing in a new context.
  ROW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROW_RE.exec(block)) !== null) {
    rowSlugs.push(m[1]);
  }

  return {
    beginIdx,
    endIdx: blockEnd,
    block,
    receiptSlugs,
    receiptVersion,
    rowSlugs,
  };
}

/**
 * Resolve the effective slug set for the fence, using receipt-first
 * with row-parsing fallback (F-CDX-8). Emits a stderr warning when
 * the receipt is missing, empty, or doesn't match the rows.
 */
export function resolveFenceSlugs(parsed: ParsedFence): {
  slugs: string[];
  usedRowFallback: boolean;
} {
  if (parsed.receiptSlugs === null) {
    if (parsed.rowSlugs.length > 0) {
      console.error(
        '[migrate-fence] cumulative-slugs receipt missing — falling back to row parsing (' +
          parsed.rowSlugs.length +
          ' slugs found).',
      );
    }
    return { slugs: parsed.rowSlugs, usedRowFallback: true };
  }

  // Receipt present. If it doesn't match the rows in the fence, warn
  // and use the union (safe — copies more skills, never fewer).
  const receiptSet = new Set(parsed.receiptSlugs);
  const rowSet = new Set(parsed.rowSlugs);
  const drift =
    parsed.receiptSlugs.length !== parsed.rowSlugs.length ||
    parsed.receiptSlugs.some(s => !rowSet.has(s)) ||
    parsed.rowSlugs.some(s => !receiptSet.has(s));

  if (drift) {
    console.error(
      '[migrate-fence] cumulative-slugs receipt does not match rows — using the union of both sets.',
    );
    const union = new Set([...parsed.receiptSlugs, ...parsed.rowSlugs]);
    return { slugs: [...union].sort(), usedRowFallback: true };
  }
  return { slugs: [...parsed.receiptSlugs], usedRowFallback: false };
}

/**
 * Strip the fence's begin/end markers (and the receipt comment) from
 * the resolver content. Rows between the markers are preserved
 * verbatim. Returns the rewritten content.
 */
export function stripFence(content: string, parsed: ParsedFence): string {
  // Walk the block, removing only the begin marker line, the receipt
  // comment line, the gbrain-installed comment line, and the end
  // marker line. Everything else (rows, blank lines, surrounding
  // whitespace) is preserved.
  const before = content.slice(0, parsed.beginIdx);
  const after = content.slice(parsed.endIdx);

  // Block body sans begin/end markers.
  const inner = parsed.block
    .slice(MANAGED_BEGIN.length, parsed.block.length - MANAGED_END.length);

  // Strip the receipt comment line (regex-friendly).
  const innerSansReceipt = inner.replace(RECEIPT_RE, '');
  // Strip the "Installed by gbrain X.Y.Z — do not hand-edit" reminder
  // (matches even when version varies).
  const innerSansReminder = innerSansReceipt.replace(
    /<!-- Installed by gbrain [^>]*-->/,
    '',
  );

  // Collapse any resulting run of blank lines at the seams into a
  // single blank line for readability.
  const collapsed = innerSansReminder.replace(/\n{3,}/g, '\n\n');

  return before + collapsed + after;
}

export function runMigrateFence(opts: MigrateFenceOptions): MigrateFenceResult {
  const dryRun = opts.dryRun ?? false;

  // Find the resolver file (prefer skills-dir variant; fall back to
  // workspace root).
  const skillsDir = join(opts.targetWorkspace, 'skills');
  const resolverFile = findResolverFile(skillsDir) ?? findResolverFile(opts.targetWorkspace);
  if (!resolverFile) {
    return {
      status: 'nothing_to_migrate',
      resolverFile: null,
      fenceSlugs: [],
      usedRowFallback: false,
      skillsCopied: [],
      skillsAlreadyPresent: [],
      dryRun,
    };
  }

  const content = readFileSync(resolverFile, 'utf-8');
  const parsed = parseFence(content);
  if (parsed === null) {
    return {
      status: 'nothing_to_migrate',
      resolverFile,
      fenceSlugs: [],
      usedRowFallback: false,
      skillsCopied: [],
      skillsAlreadyPresent: [],
      dryRun,
    };
  }
  if (parsed.block === '') {
    // Malformed: one marker without the other.
    return {
      status: 'fence_malformed',
      resolverFile,
      fenceSlugs: [],
      usedRowFallback: false,
      skillsCopied: [],
      skillsAlreadyPresent: [],
      dryRun,
    };
  }

  const { slugs, usedRowFallback } = resolveFenceSlugs(parsed);

  // Copy any missing skills additively (uses scaffold's underlying
  // mechanic via copyArtifacts). Optional — when gbrainRoot is unset,
  // only the fence is stripped.
  const skillsCopied: string[] = [];
  const skillsAlreadyPresent: string[] = [];
  if (opts.gbrainRoot) {
    const root = opts.gbrainRoot;
    const manifest = loadBundleManifest(root);
    const bundleSet = new Set(manifest.skills.map(s => s.replace(/^skills\//, '')));
    for (const slug of slugs) {
      const hostDir = join(opts.targetWorkspace, 'skills', slug);
      if (existsSync(hostDir)) {
        skillsAlreadyPresent.push(slug);
        continue;
      }
      if (!bundleSet.has(slug)) {
        // Slug references a skill no longer in the bundle (renamed
        // upstream, or it was a user-added row inside the fence).
        // Leave the row alone — the user owns it.
        continue;
      }
      const srcDir = join(root, 'skills', slug);
      const items = walkSourceDir(srcDir, hostDir);
      if (!dryRun) {
        copyArtifacts(items, {});
      }
      skillsCopied.push(slug);
    }
  }

  // Rewrite the resolver file with the fence stripped.
  if (!dryRun) {
    const rewritten = stripFence(content, parsed);
    writeFileSync(resolverFile, rewritten);
  }

  return {
    status: 'fence_stripped',
    resolverFile,
    fenceSlugs: slugs,
    usedRowFallback,
    skillsCopied,
    skillsAlreadyPresent,
    dryRun,
  };
}

// Convenience: auto-discover gbrainRoot via findGbrainRoot when caller
// doesn't pass one. Used by the CLI dispatch.
export function runMigrateFenceAuto(opts: MigrateFenceOptions): MigrateFenceResult {
  if (opts.gbrainRoot) return runMigrateFence(opts);
  const root = findGbrainRoot();
  return runMigrateFence({ ...opts, gbrainRoot: root ?? undefined });
}
