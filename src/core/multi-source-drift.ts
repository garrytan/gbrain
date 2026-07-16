/**
 * Multi-source drift detection.
 *
 * Surfaces pages that appear to have been written to the default source
 * instead of their configured source. Repository scans prefer git's tracked
 * file index and fall back to a bounded, loop-safe filesystem walk.
 */

import { readdirSync, lstatSync, realpathSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, relative, resolve } from 'path';
import type { BrainEngine } from './engine.ts';
import { pathToSlug } from './sync.ts';

export interface SourceWithPath {
  id: string;
  local_path: string;
}

export interface MisroutedSample {
  slug: string;
  intended_source: string;
  local_path: string;
}

export interface MisroutedResult {
  walk_truncated: boolean;
  count: number;
  sample: MisroutedSample[];
}

const DEFAULT_FILE_LIMIT = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const SAMPLE_LIMIT = 5;
const IGNORED_DIRS = new Set([
  '.git', '.next', '.cache', '.turbo', '.vercel',
  'node_modules', 'dist', 'build', 'coverage', 'generated',
]);

function positiveEnvInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function gitMarkdownFiles(
  root: string,
  limit: number,
  deadlineMs: number,
): { files: { relPath: string }[]; truncated: boolean } | null {
  if (Date.now() >= deadlineMs) return { files: [], truncated: true };
  try {
    const stdout = execFileSync(
      'git',
      ['-C', root, 'ls-files', '-z', '--', '*.md', '*.mdx'],
      {
        encoding: 'utf8',
        timeout: Math.max(1, deadlineMs - Date.now()),
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    const relPaths = stdout.split('\0').filter(Boolean).filter((relPath) => {
      const parts = relPath.replace(/\\/g, '/').split('/');
      return !parts.some(part => IGNORED_DIRS.has(part)) && !parts.at(-1)?.startsWith('_');
    });
    return {
      files: relPaths.slice(0, limit).map(relPath => ({ relPath })),
      truncated: relPaths.length > limit || Date.now() >= deadlineMs,
    };
  } catch {
    return null;
  }
}

function walkMarkdownAndMdxFiles(
  root: string,
  limit: number,
  deadlineMs: number,
): { files: { relPath: string }[]; truncated: boolean } {
  const files: { relPath: string }[] = [];
  const visited = new Set<string>();
  let truncated = false;

  function walk(dir: string): void {
    if (truncated) return;
    if (Date.now() >= deadlineMs) {
      truncated = true;
      return;
    }
    let canonical: string;
    try {
      canonical = realpathSync(dir).toLowerCase();
    } catch {
      return;
    }
    if (visited.has(canonical)) return;
    visited.add(canonical);

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (truncated) return;
      if (Date.now() >= deadlineMs) {
        truncated = true;
        return;
      }
      if (entry.startsWith('.') || IGNORED_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      // Windows junctions report as symbolic links. Never traverse either.
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!(entry.endsWith('.md') || entry.endsWith('.mdx'))) continue;
      if (entry.startsWith('_')) continue;
      files.push({ relPath: relative(root, full) });
      if (files.length >= limit) {
        truncated = true;
        return;
      }
    }
  }

  try {
    statSync(root);
    walk(root);
  } catch {
    // Missing and unreadable roots are non-fatal doctor evidence.
  }
  return { files, truncated };
}

async function batchProbeExistence(
  engine: BrainEngine,
  slugs: string[],
  sourceId: string,
): Promise<Map<string, Set<string>>> {
  if (slugs.length === 0) return new Map();
  const valuePlaceholders = slugs.map((_, i) => `($${i + 1}::text)`).join(', ');
  const sourceParamIdx = slugs.length + 1;
  const sql = `
    WITH candidates(slug) AS (VALUES ${valuePlaceholders})
    SELECT c.slug, p.source_id
    FROM candidates c
    LEFT JOIN pages p
      ON p.slug = c.slug AND p.deleted_at IS NULL
         AND p.source_id IN ('default', $${sourceParamIdx}::text)
    ORDER BY c.slug, p.source_id
  `;
  const rows = await engine.executeRaw<{ slug: string; source_id: string | null }>(
    sql,
    [...slugs, sourceId],
  );
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!map.has(row.slug)) map.set(row.slug, new Set());
    if (row.source_id != null) map.get(row.slug)!.add(row.source_id);
  }
  return map;
}

export async function findMisroutedPages(
  engine: BrainEngine,
  sources: SourceWithPath[],
  opts: { limit?: number; timeoutMs?: number } = {},
): Promise<MisroutedResult> {
  const limit = opts.limit ?? positiveEnvInt('GBRAIN_DRIFT_LIMIT') ?? DEFAULT_FILE_LIMIT;
  const timeoutMs = opts.timeoutMs ?? positiveEnvInt('GBRAIN_DRIFT_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS;
  const deadlineMs = Date.now() + timeoutMs;

  let totalCount = 0;
  let walkTruncated = false;
  const sample: MisroutedSample[] = [];

  for (const source of sources) {
    if (source.id === 'default' || !source.local_path) continue;
    if (Date.now() >= deadlineMs) {
      walkTruncated = true;
      break;
    }
    const root = resolve(source.local_path);
    const gitResult = gitMarkdownFiles(root, limit, deadlineMs);
    const { files, truncated } = gitResult ?? walkMarkdownAndMdxFiles(root, limit, deadlineMs);
    if (truncated) walkTruncated = true;
    if (files.length === 0) continue;

    const slugs = Array.from(new Set(files.map(file => pathToSlug(file.relPath))));
    const existenceMap = await batchProbeExistence(engine, slugs, source.id);
    for (const slug of slugs) {
      const present = existenceMap.get(slug);
      if (!present) continue;
      if (present.has('default') && !present.has(source.id)) {
        totalCount++;
        if (sample.length < SAMPLE_LIMIT) {
          sample.push({ slug, intended_source: source.id, local_path: source.local_path });
        }
      }
    }
  }

  return { walk_truncated: walkTruncated, count: totalCount, sample };
}
