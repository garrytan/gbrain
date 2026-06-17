/**
 * archive-crawler-config.ts — gbrain.yml `archive-crawler:` section.
 *
 * D12 (codex HIGH-4): the archive-crawler skill REFUSES TO RUN unless
 * `archive-crawler.scan_paths:` is set explicitly in the brain repo's
 * gbrain.yml. This is a deliberate safety fence against the agent
 * over-scoping a scan and ingesting sensitive content (tax PDFs,
 * medical records, credentials).
 *
 * The shape mirrors storage-config.ts: same parsing pattern, same
 * normalize+validate split, same ~/ expansion and path-traversal
 * rejection. Kept in a sibling file because it's a separate concern
 * (archive scanning, not storage tiering) — adding it to
 * storage-config.ts would muddy single-responsibility for code that
 * just happens to share a config file.
 *
 * Example gbrain.yml:
 *
 *   archive-crawler:
 *     scan_paths:
 *       - ~/Documents/writing/
 *       - ~/Dropbox/Archive/
 *       - /mnt/backup/old-letters/
 *     # Optional, for paths inside scan_paths to deny:
 *     # deny_paths:
 *     #   - ~/Dropbox/Archive/finances/
 *     #   - ~/Documents/writing/.private/
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve as resolvePath } from 'path';

export interface ArchiveCrawlerConfig {
  /** Absolute paths the agent is permitted to scan. ~ expanded; paths
   * normalized to absolute form; trailing-slash normalized.
   * Required to be non-empty when the section exists. */
  scan_paths: string[];
  /** Absolute paths within scan_paths to explicitly deny. Optional;
   * may be empty. */
  deny_paths: string[];
}

export class ArchiveCrawlerConfigError extends Error {
  constructor(
    message: string,
    public code:
      | 'missing_section'
      | 'empty_scan_paths'
      | 'invalid_path'
      | 'parse_error',
  ) {
    super(message);
    this.name = 'ArchiveCrawlerConfigError';
  }
}

interface RawArchiveCrawler {
  scan_paths?: string[];
  deny_paths?: string[];
}

const ARCHIVE_KEYS = new Set(['scan_paths', 'deny_paths']);

function parseArchiveCrawlerYaml(content: string): RawArchiveCrawler | null {
  const lines = content.split('\n').map((line) => line.replace(/\r$/, ''));

  let inSection = false;
  let currentList: keyof RawArchiveCrawler | null = null;
  const raw: RawArchiveCrawler = {};
  let sawSection = false;

  for (const line of lines) {
    const noComment = line.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (noComment.trim() === '') continue;

    // Top-level key (no leading whitespace).
    if (!noComment.startsWith(' ') && !noComment.startsWith('\t')) {
      const colon = noComment.indexOf(':');
      if (colon === -1) continue;
      const key = noComment.slice(0, colon).trim();
      if (key === 'archive-crawler' || key === 'archive_crawler') {
        // accept both spellings; canonical is hyphenated to match the skill name
        inSection = true;
        sawSection = true;
        currentList = null;
        continue;
      }
      inSection = false;
      currentList = null;
      continue;
    }

    if (!inSection) continue;

    const indented = noComment.replace(/^\s+/, '');

    if (indented.startsWith('-')) {
      if (!currentList) continue;
      const value = indented.slice(1).trim().replace(/^["']|["']$/g, '');
      if (value) {
        if (!raw[currentList]) raw[currentList] = [];
        raw[currentList]!.push(value);
      }
      continue;
    }

    const colon = indented.indexOf(':');
    if (colon === -1) continue;
    const key = indented.slice(0, colon).trim();
    if (ARCHIVE_KEYS.has(key)) {
      currentList = key as keyof RawArchiveCrawler;
      const remainder = indented.slice(colon + 1).trim();
      if (remainder === '[]' && !raw[currentList]) {
        raw[currentList] = [];
      }
      continue;
    }
    currentList = null;
  }

  if (!sawSection) return null;
  return raw;
}

/**
 * Expand `~/...` to the user's home dir. Leaves absolute paths and
 * relative paths alone (the validator below will reject relative).
 */
function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return join(homedir(), p.slice(p.startsWith('~/') ? 2 : 1));
  }
  return p;
}

/**
 * Normalize and validate a parsed RawArchiveCrawler into the public
 * ArchiveCrawlerConfig shape.
 *
 * Validations:
 *   - scan_paths MUST be non-empty (D12: refuse to run without an
 *     explicit allow-list).
 *   - Every path must be absolute after ~ expansion (rejecting
 *     relative paths is a basic safety: relative depends on cwd,
 *     which the agent doesn't control). Throws invalid_path.
 *   - Path-traversal rejection: a path containing `..` after
 *     normalization is rejected to prevent allow-list escape via
 *     `~/Documents/../../../etc/passwd`. Throws invalid_path.
 *   - Trailing slash normalization: paths without trailing slash get
 *     one appended (so prefix matching is unambiguous: `/a/b/`
 *     does NOT match `/a/bc/`).
 */
export function normalizeAndValidateArchiveCrawlerConfig(
  raw: RawArchiveCrawler,
): ArchiveCrawlerConfig {
  const rawScan = raw.scan_paths ?? [];
  const rawDeny = raw.deny_paths ?? [];

  if (rawScan.length === 0) {
    throw new ArchiveCrawlerConfigError(
      'archive-crawler.scan_paths is empty. The skill refuses to run without an explicit allow-list. Add at least one path under archive-crawler.scan_paths in gbrain.yml.',
      'empty_scan_paths',
    );
  }

  const scan_paths = rawScan.map((raw) =>
    normalizeOnePath(raw, 'scan_paths'),
  );
  const deny_paths = rawDeny.map((raw) =>
    normalizeOnePath(raw, 'deny_paths'),
  );

  return { scan_paths, deny_paths };
}

function normalizeOnePath(raw: string, field: 'scan_paths' | 'deny_paths'): string {
  const expanded = expandHome(raw);

  if (!isAbsolute(expanded)) {
    throw new ArchiveCrawlerConfigError(
      `archive-crawler.${field} contains relative path "${raw}". Use an absolute path or ~/... — relative paths depend on cwd, which the agent doesn't control.`,
      'invalid_path',
    );
  }

  // Reject path traversal AFTER normalization. resolve() collapses
  // `..` segments, but we want to detect intent — a path that LITERALLY
  // contains `..` is suspicious regardless of where it resolves.
  if (raw.includes('..')) {
    throw new ArchiveCrawlerConfigError(
      `archive-crawler.${field} contains path-traversal segment "${raw}". Path-traversal patterns are rejected even when they resolve safely; use the canonical absolute path instead.`,
      'invalid_path',
    );
  }

  // Normalize: resolve any tail and ensure trailing slash for unambiguous
  // prefix-matching. resolve() strips trailing slash; we re-add it.
  const resolved = resolvePath(expanded);
  return resolved.endsWith('/') ? resolved : resolved + '/';
}

/**
 * Load gbrain.yml from the brain repo root and return the
 * archive-crawler config, or throw missing_section if absent.
 *
 * Returns:
 *   - ArchiveCrawlerConfig on success
 *
 * Throws:
 *   - ArchiveCrawlerConfigError(missing_section) when gbrain.yml
 *     exists but has no archive-crawler section (or gbrain.yml is
 *     absent entirely).
 *   - ArchiveCrawlerConfigError(empty_scan_paths) when the section
 *     exists but scan_paths is empty.
 *   - ArchiveCrawlerConfigError(invalid_path) on any path-shape
 *     violation (relative, traversal).
 *   - ArchiveCrawlerConfigError(parse_error) on YAML parse failure.
 *
 * The CLI / skill consumer should catch these and surface a clear
 * message to the user — the error code distinguishes "needs config"
 * from "config is broken."
 */
export function loadArchiveCrawlerConfig(
  repoPath?: string | null,
): ArchiveCrawlerConfig {
  if (!repoPath) {
    throw new ArchiveCrawlerConfigError(
      'No brain repo path provided. archive-crawler requires a brain repo with gbrain.yml. Run `gbrain init` or set sync.repo_path in gbrain config.',
      'missing_section',
    );
  }

  const yamlPath = join(repoPath, 'gbrain.yml');
  if (!existsSync(yamlPath)) {
    throw new ArchiveCrawlerConfigError(
      `gbrain.yml not found at ${yamlPath}. archive-crawler refuses to run without an explicit allow-list — add an archive-crawler section to gbrain.yml first.`,
      'missing_section',
    );
  }

  const content = readFileSync(yamlPath, 'utf-8');

  let raw: RawArchiveCrawler | null;
  try {
    raw = parseArchiveCrawlerYaml(content);
  } catch (e) {
    throw new ArchiveCrawlerConfigError(
      `Failed to parse archive-crawler section of ${yamlPath}: ${e instanceof Error ? e.message : String(e)}`,
      'parse_error',
    );
  }

  if (raw === null) {
    throw new ArchiveCrawlerConfigError(
      `${yamlPath} has no archive-crawler section. archive-crawler refuses to run without an explicit allow-list. Add:\n\n  archive-crawler:\n    scan_paths:\n      - ~/path/to/scan/\n\nto your gbrain.yml.`,
      'missing_section',
    );
  }

  return normalizeAndValidateArchiveCrawlerConfig(raw);
}

/**
 * isPathAllowed — true when the candidate path falls within scan_paths
 * AND is NOT inside any deny_paths. Used by the archive-crawler skill
 * (when it grows a runtime check) to gate per-file decisions.
 *
 * Both inputs are normalized via `resolvePath` and compared as absolute
 * directory prefixes (with trailing slash) so `media/x/` does not match
 * `media/xerox/foo`.
 */
export function isPathAllowed(
  candidate: string,
  config: ArchiveCrawlerConfig,
): boolean {
  const expanded = expandHome(candidate);
  if (!isAbsolute(expanded)) return false;
  const resolved = resolvePath(expanded);
  const prefix = resolved.endsWith('/') ? resolved : resolved + '/';

  // Must be inside at least one scan_path.
  const allowed = config.scan_paths.some((sp) => prefix.startsWith(sp));
  if (!allowed) return false;

  // Must NOT be inside any deny_path.
  const denied = config.deny_paths.some((dp) => prefix.startsWith(dp));
  return !denied;
}
