/**
 * brain-writer — frontmatter validation/audit/auto-fix orchestrator.
 *
 * Thin layer on top of `parseMarkdown(..., {validate:true})` (the canonical
 * source of frontmatter validation rules) and `isSyncable()` (the canonical
 * brain-page filter). Three consumers call into this module: the
 * `gbrain frontmatter` CLI, the `frontmatter_integrity` doctor subcheck, and
 * the v0.22.4 migration audit phase. Single source of truth — no parallel
 * validation stack.
 *
 * Path-guard contract: writeBrainPage refuses to write outside the source
 * path. .bak backups are the safety contract (works for both git and non-git
 * brain repos; the existing src/core/dry-fix.ts:getWorkingTreeStatus rejects
 * non-git repos as unsafe, which is the wrong shape for brain rewrites).
 */

import { existsSync, readFileSync, readdirSync, statSync, copyFileSync, writeFileSync, mkdirSync, lstatSync } from 'fs';
import { join, relative, resolve, dirname } from 'path';
import type { BrainEngine } from './engine.ts';
import type { ProgressReporter } from './progress.ts';
import {
  parseMarkdown,
  type ParseValidationCode,
  type ParseValidationError,
} from './markdown.ts';
import { isSyncable, slugifyPath } from './sync.ts';

export type { ParseValidationCode };

export interface AuditFix {
  code: ParseValidationCode;
  description: string;
}

export interface PerSourceReport {
  source_id: string;
  source_path: string;
  total: number;
  errors_by_code: Partial<Record<ParseValidationCode, number>>;
  sample: { path: string; codes: ParseValidationCode[] }[];
}

export interface AuditReport {
  ok: boolean;
  total: number;
  errors_by_code: Partial<Record<ParseValidationCode, number>>;
  per_source: PerSourceReport[];
  scanned_at: string;
}

const SAMPLE_PER_SOURCE = 20;

// ---------------------------------------------------------------------------
// autoFixFrontmatter
// ---------------------------------------------------------------------------

/**
 * Mechanical auto-repair for the fixable subset of validation codes:
 *   - NULL_BYTES        — strip \x00 characters
 *   - NESTED_QUOTES     — rewrite `"... "inner" ..."` to single-quoted outer
 *   - MISSING_CLOSE     — insert `---` before the first heading found inside
 *                          the YAML zone
 *   - SLUG_MISMATCH     — remove `slug:` line (gbrain derives slug from path)
 *
 * Idempotent: running twice is a no-op on already-clean input. Any error class
 * not in the list above is left untouched (e.g. EMPTY_FRONTMATTER, YAML_PARSE,
 * MISSING_OPEN — those need human review).
 */
export function autoFixFrontmatter(
  content: string,
  opts?: { filePath?: string },
): { content: string; fixes: AuditFix[] } {
  const fixes: AuditFix[] = [];
  let working = content;

  // 1. NULL_BYTES — strip them. Cheap, byte-level. Run first so subsequent
  //    line-based passes don't trip on stray nulls.
  if (working.indexOf('\x00') >= 0) {
    working = working.replace(/\x00/g, '');
    fixes.push({ code: 'NULL_BYTES', description: 'Stripped null bytes' });
  }

  // 2. MISSING_CLOSE — if there's an opener but no closer before a heading,
  //    insert `---` immediately before the heading. Walk lines once.
  {
    const lines = working.split('\n');
    let firstNonEmpty = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().length > 0) { firstNonEmpty = i; break; }
    }
    if (firstNonEmpty >= 0 && lines[firstNonEmpty].trim() === '---') {
      let closeIdx = -1;
      let headingIdx = -1;
      for (let i = firstNonEmpty + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t === '---') { closeIdx = i; break; }
        if (/^#{1,6}\s/.test(t)) { headingIdx = i; break; }
      }
      if (closeIdx === -1 && headingIdx >= 0) {
        const fixed = [
          ...lines.slice(0, headingIdx),
          '---',
          '',
          ...lines.slice(headingIdx),
        ];
        working = fixed.join('\n');
        fixes.push({
          code: 'MISSING_CLOSE',
          description: `Inserted closing --- before heading at line ${headingIdx + 1}`,
        });
      }
    }
  }

  // 3. NESTED_QUOTES — rewrite `key: "...inner..."` lines that have 3+ unescaped
  //    double-quotes by switching the outer wrapper to single quotes and
  //    leaving inner quotes alone.
  {
    const lines = working.split('\n');
    let firstNonEmpty = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().length > 0) { firstNonEmpty = i; break; }
    }
    if (firstNonEmpty >= 0 && lines[firstNonEmpty].trim() === '---') {
      let closeIdx = lines.length;
      for (let i = firstNonEmpty + 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') { closeIdx = i; break; }
      }
      let fixedAny = false;
      for (let i = firstNonEmpty + 1; i < closeIdx; i++) {
        const m = lines[i].match(/^(\s*[A-Za-z_][\w-]*\s*:\s*)"(.*)"\s*(.*)$/);
        if (!m) continue;
        const [, prefix, inner, trailing] = m;
        let count = 0;
        for (let j = 0; j < inner.length; j++) {
          if (inner[j] === '"' && (j === 0 || inner[j - 1] !== '\\')) count++;
        }
        // Total " on the line includes the two outer quotes the regex
        // captured, plus whatever's in inner. We need 3+ to trigger.
        if (count >= 1) {
          // Inner already has unescaped " — outer wrap is causing the YAML
          // parse failure. Rewrite to 'single-quoted'. YAML escapes `'` inside
          // a single-quoted string by doubling it.
          const escapedInner = inner.replace(/'/g, "''");
          lines[i] = `${prefix}'${escapedInner}'${trailing ? ' ' + trailing : ''}`.replace(/\s+$/, '');
          fixedAny = true;
        }
      }
      if (fixedAny) {
        working = lines.join('\n');
        fixes.push({
          code: 'NESTED_QUOTES',
          description: 'Rewrote nested double-quoted YAML values to single-quoted',
        });
      }
    }
  }

  // 4. SLUG_MISMATCH — remove `slug:` line if filePath is provided and the
  //    declared slug doesn't match the path-derived one. Per PR #392 spec,
  //    gbrain derives slug from path; the field shouldn't be in frontmatter.
  if (opts?.filePath) {
    const expectedSlug = slugifyPath(opts.filePath);
    // Use the (possibly partially-fixed) working content to detect whether
    // the slug field is present and mismatched.
    const re = /^slug:\s*(.+?)\s*$/m;
    const m = working.match(re);
    if (m && m[1].replace(/^["']|["']$/g, '') !== expectedSlug) {
      working = working.replace(re, '').replace(/\n{3,}/g, '\n\n');
      fixes.push({
        code: 'SLUG_MISMATCH',
        description: `Removed mismatched slug field (was "${m[1]}", expected "${expectedSlug}")`,
      });
    }
  }

  return { content: working, fixes };
}

// ---------------------------------------------------------------------------
// writeBrainPage — path-guarded write with .bak backup
// ---------------------------------------------------------------------------

export class BrainWriterError extends Error {
  code: string;
  hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'BrainWriterError';
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Path-guarded brain page writer. Always writes `<filePath>.bak` before any
 * in-place mutation (the contract that replaces git-tree-clean for non-git
 * brain repos). Throws BrainWriterError if filePath is not under sourcePath.
 */
export function writeBrainPage(
  filePath: string,
  content: string,
  opts: { sourcePath: string; autoFix?: boolean },
): { fixes: AuditFix[] } {
  const resolvedSource = resolve(opts.sourcePath);
  const resolvedTarget = resolve(filePath);
  if (resolvedTarget !== resolvedSource && !resolvedTarget.startsWith(resolvedSource + '/')) {
    throw new BrainWriterError(
      'PATH_OUTSIDE_SOURCE',
      `writeBrainPage: ${filePath} is not under ${opts.sourcePath}`,
      'Pass --source <id> matching the source the file lives in.',
    );
  }

  let toWrite = content;
  let fixes: AuditFix[] = [];
  if (opts.autoFix) {
    const result = autoFixFrontmatter(content, { filePath });
    toWrite = result.content;
    fixes = result.fixes;
  }

  if (existsSync(filePath)) {
    copyFileSync(filePath, filePath + '.bak');
  } else {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  writeFileSync(filePath, toWrite, 'utf8');
  return { fixes };
}

// ---------------------------------------------------------------------------
// scanBrainSources
// ---------------------------------------------------------------------------

interface SourceRow {
  id: string;
  local_path: string | null;
}

export interface ScanOpts {
  /** Limit scan to one source. When omitted, all registered sources with a
   *  local_path are scanned. */
  sourceId?: string;
  onProgress?: ProgressReporter;
  signal?: AbortSignal;
}

export async function scanBrainSources(
  engine: BrainEngine,
  opts: ScanOpts = {},
): Promise<AuditReport> {
  const sources = await listSources(engine, opts.sourceId);
  const totals: Partial<Record<ParseValidationCode, number>> = {};
  const perSource: PerSourceReport[] = [];
  let grandTotal = 0;

  for (const src of sources) {
    if (opts.signal?.aborted) break;
    if (!src.local_path) continue;
    if (!existsSync(src.local_path)) {
      // Source registered but path is missing on disk; surface as a zero-row
      // entry with a synthetic SCAN_PATH_MISSING note via warn-and-skip.
      perSource.push({
        source_id: src.id,
        source_path: src.local_path,
        total: 0,
        errors_by_code: {},
        sample: [],
      });
      continue;
    }
    const report = scanOneSource(src.id, src.local_path, opts);
    perSource.push(report);
    grandTotal += report.total;
    for (const [code, n] of Object.entries(report.errors_by_code)) {
      const k = code as ParseValidationCode;
      totals[k] = (totals[k] ?? 0) + (n as number);
    }
  }

  return {
    ok: grandTotal === 0,
    total: grandTotal,
    errors_by_code: totals,
    per_source: perSource,
    scanned_at: new Date().toISOString(),
  };
}

function scanOneSource(
  sourceId: string,
  sourcePath: string,
  opts: ScanOpts,
): PerSourceReport {
  const errorsByCode: Partial<Record<ParseValidationCode, number>> = {};
  const sample: PerSourceReport['sample'] = [];
  const rootResolved = resolve(sourcePath);
  let scanned = 0;
  let total = 0;

  walkDir(rootResolved, (absPath) => {
    if (opts.signal?.aborted) return false;
    const relPath = relative(rootResolved, absPath);
    if (!isSyncable(relPath, { strategy: 'markdown' })) return true;
    scanned++;
    let content: string;
    try {
      content = readFileSync(absPath, 'utf8');
    } catch {
      return true; // skip unreadable
    }
    const expectedSlug = slugifyPath(relPath);
    const parsed = parseMarkdown(content, relPath, { validate: true, expectedSlug });
    const errs = parsed.errors ?? [];
    if (errs.length > 0) {
      total += errs.length;
      const codes: ParseValidationCode[] = [];
      for (const e of errs) {
        errorsByCode[e.code] = (errorsByCode[e.code] ?? 0) + 1;
        codes.push(e.code);
      }
      if (sample.length < SAMPLE_PER_SOURCE) {
        sample.push({ path: relPath, codes });
      }
    }
    if (opts.onProgress && scanned % 50 === 0) {
      opts.onProgress.tick(50);
    }
    return true;
  });

  if (opts.onProgress) {
    opts.onProgress.heartbeat(`scanned ${scanned} pages in ${sourceId}`);
  }

  return {
    source_id: sourceId,
    source_path: sourcePath,
    total,
    errors_by_code: errorsByCode,
    sample,
  };
}

/** Recursive directory walker with symlink-loop protection (via lstat).
 *  Calls `visit` for each regular file. Returning false from `visit` stops
 *  the walk. Skips entries lstat reports as symlinks (sync's no-symlink
 *  policy). */
function walkDir(root: string, visit: (absPath: string) => boolean | void): void {
  const stack: string[] = [root];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // matches sync's no-symlink policy
      if (st.isDirectory()) {
        const real = resolve(full);
        if (visited.has(real)) continue;
        visited.add(real);
        stack.push(full);
      } else if (st.isFile()) {
        const result = visit(full);
        if (result === false) return;
      }
    }
  }
}

async function listSources(engine: BrainEngine, sourceId?: string): Promise<SourceRow[]> {
  if (sourceId) {
    const rows = await engine.executeRaw<SourceRow>(
      `SELECT id, local_path FROM sources WHERE id = $1`,
      [sourceId],
    );
    return rows;
  }
  return engine.executeRaw<SourceRow>(
    `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL ORDER BY id`,
  );
}
