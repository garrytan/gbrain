/**
 * MarkdownGreenfieldSource — one-shot bulk importer for the v0.41
 * your OpenClaw → gbrain epistemology migration.
 *
 * @one-shot — this module is intentionally long-lived after the
 * single production migration completes. Per D10, future similar
 * migrations (other downstream agents, brain merges, schema-pack
 * upgrades) reuse the migration-mode IngestionSource pattern shipped
 * here. Deleting the working example is short-sighted.
 *
 * Migration semantics (per T2, codex outside-voice challenge): bulk
 * historical replay needs PERMANENT slug-keyed idempotency, NOT a 24h
 * trickle dedup window. mode: 'migration' on this source signals the
 * daemon's handleEmit branch to bypass DedupWindow.mark(); we own dedup
 * via the imported_from frontmatter marker + op_checkpoint (which the
 * caller wires via gbrain capture --source markdown-greenfield).
 *
 * Walk:
 *   - ~/git/brain/atoms/{YYYY-MM-DD}/*.md (~13K files, atoms)
 *   - ~/git/brain/concepts/*.md (~11K files, concepts)
 *   - ~/git/brain/ideas/*.md (small set, idea pages)
 *
 * Per file:
 *   1. Read content, split frontmatter via gray-matter
 *   2. Validate the frontmatter has required `type:` (atom/concept/idea/etc)
 *   3. Stamp imported_from='markdown-greenfield' in frontmatter
 *      (downstream extract_atoms + synthesize_concepts phases skip on
 *      this marker per D7 — lossless import with provenance, no
 *      re-extraction)
 *   4. Preserve all other original frontmatter under metadata.
 *      original_frontmatter
 *   5. Emit IngestionEvent
 *
 * Per-row validation failure:
 *   - Append a JSONL line to ~/.gbrain/audit/markdown-greenfield-failures-
 *     YYYY-Www.jsonl with {path, error, ts} per D12
 *   - Continue with remaining files (don't fail-fast on one bad row)
 *
 * CLI activation: gbrain capture --source markdown-greenfield
 *   --repo ~/git/brain [--dry-run] [--limit N]
 *
 * The --repo path is the brain directory containing atoms/, concepts/,
 * ideas/. Defaults to ~/git/brain when omitted.
 */

import { readFileSync, readdirSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { homedir } from 'node:os';
import matter from 'gray-matter';
import { computeContentHash } from '../types.ts';
import type {
  IngestionSource,
  IngestionSourceContext,
  IngestionEvent,
  IngestionSourceMode,
  IngestionSourceHealth,
} from '../types.ts';

export interface MarkdownGreenfieldOpts {
  /** Brain repo root (default: ~/git/brain). */
  repoPath?: string;
  /** Dry-run: walk + validate but don't emit. */
  dryRun?: boolean;
  /** Limit total files processed (useful for staged testing). */
  limit?: number;
  /** Audit JSONL output dir (default: ~/.gbrain/audit). */
  auditDir?: string;
  /** Test seam: alternative fs read. */
  _readFile?: (path: string) => string;
  /** Test seam: alternative existsSync. */
  _existsSync?: (path: string) => boolean;
  /** Test seam: alternative readdirSync. */
  _readdirSync?: (path: string) => string[];
  /** Test seam: alternative stat. */
  _statSync?: (path: string) => { isDirectory(): boolean; isFile(): boolean };
  /** Test seam: alternative appendFileSync for audit logs. */
  _appendFileSync?: (path: string, content: string) => void;
}

interface WalkResult {
  files: string[]; // absolute paths
  scanned: number;
}

export interface MarkdownGreenfieldStats {
  emitted: number;
  skipped_invalid: number;
  skipped_no_type: number;
  total_walked: number;
}

export class MarkdownGreenfieldSource implements IngestionSource {
  readonly id: string;
  readonly kind = 'markdown-greenfield';
  readonly mode: IngestionSourceMode = 'migration';

  private readonly opts: Required<Omit<MarkdownGreenfieldOpts, 'repoPath' | 'auditDir' | 'limit'>> & {
    repoPath: string;
    auditDir: string;
    limit: number | undefined;
  };
  private ctx: IngestionSourceContext | null = null;
  private _stats: MarkdownGreenfieldStats = {
    emitted: 0,
    skipped_invalid: 0,
    skipped_no_type: 0,
    total_walked: 0,
  };

  constructor(opts: MarkdownGreenfieldOpts = {}) {
    this.id = `markdown-greenfield:${process.pid}`;
    this.opts = {
      repoPath: opts.repoPath ?? join(homedir(), 'git', 'brain'),
      dryRun: opts.dryRun ?? false,
      limit: opts.limit,
      auditDir: opts.auditDir ?? join(homedir(), '.gbrain', 'audit'),
      _readFile: opts._readFile ?? ((p) => readFileSync(p, 'utf-8')),
      _existsSync: opts._existsSync ?? existsSync,
      _readdirSync: opts._readdirSync ?? ((p) => readdirSync(p)),
      _statSync: opts._statSync ?? ((p) => statSync(p)),
      _appendFileSync: opts._appendFileSync ?? ((p, c) => {
        try {
          mkdirSync(dirname(p), { recursive: true });
        } catch {
          // Directory likely exists; ignore.
        }
        appendFileSync(p, c);
      }),
    };
  }

  async start(ctx: IngestionSourceContext): Promise<void> {
    this.ctx = ctx;
    if (!this.opts._existsSync(this.opts.repoPath)) {
      throw new Error(
        `MarkdownGreenfieldSource: repo path does not exist: ${this.opts.repoPath}`,
      );
    }
    const walk = this.walkFiles();
    ctx.logger.info(
      `[markdown-greenfield] discovered ${walk.files.length} files under ${this.opts.repoPath}`,
    );

    let processed = 0;
    for (const path of walk.files) {
      if (this.opts.limit !== undefined && processed >= this.opts.limit) break;
      this._stats.total_walked++;
      processed++;
      try {
        const event = this.processFile(path);
        if (event === null) {
          this._stats.skipped_no_type++;
          continue;
        }
        if (this.opts.dryRun) {
          // No-op — dry-run reports counts without emitting
        } else {
          ctx.emit(event);
        }
        this._stats.emitted++;
      } catch (err) {
        this._stats.skipped_invalid++;
        const errMsg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`[markdown-greenfield] skipped ${path}: ${errMsg}`);
        this.appendFailureAudit(path, errMsg);
      }
    }

    ctx.logger.info(
      `[markdown-greenfield] done: ${this._stats.emitted} emitted, ` +
        `${this._stats.skipped_invalid} invalid, ${this._stats.skipped_no_type} no-type, ` +
        `${this._stats.total_walked} total`,
    );
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  async healthCheck(): Promise<IngestionSourceHealth> {
    const total = this._stats.emitted + this._stats.skipped_invalid + this._stats.skipped_no_type;
    if (this._stats.skipped_invalid > 0) {
      return {
        status: 'warn',
        message: `${this._stats.skipped_invalid}/${total} files failed validation; check audit log`,
      };
    }
    if (total === 0 && !this.ctx) {
      return { status: 'warn', message: 'not yet started' };
    }
    return { status: 'ok', message: `${this._stats.emitted}/${total} emitted cleanly` };
  }

  /** Diagnostic: import counters since start. */
  get stats(): MarkdownGreenfieldStats {
    return { ...this._stats };
  }

  /**
   * Walk atoms/{date}/*.md + concepts/*.md + ideas/*.md.
   * Returns absolute paths to .md files in deterministic sort order
   * (alphabetical by relative path) so dry-run + actual run process
   * the same prefix when --limit is honored.
   */
  private walkFiles(): WalkResult {
    const out: string[] = [];
    let scanned = 0;
    for (const subdir of ['atoms', 'concepts', 'ideas']) {
      const base = join(this.opts.repoPath, subdir);
      if (!this.opts._existsSync(base)) continue;
      this.walkRecursive(base, out, () => scanned++);
    }
    out.sort();
    return { files: out, scanned };
  }

  private walkRecursive(dir: string, out: string[], onScan: () => void): void {
    let entries: string[];
    try {
      entries = this.opts._readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      onScan();
      const full = join(dir, entry);
      let stat: { isDirectory(): boolean; isFile(): boolean };
      try {
        stat = this.opts._statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        this.walkRecursive(full, out, onScan);
      } else if (stat.isFile() && entry.endsWith('.md')) {
        out.push(full);
      }
    }
  }

  /**
   * Parse a markdown file's frontmatter + body, validate it has the
   * minimum required fields, return an IngestionEvent or null if the
   * frontmatter is empty/missing type (counts as skipped_no_type).
   *
   * Throws on parse error → caller catches and audits.
   */
  private processFile(path: string): IngestionEvent | null {
    const raw = this.opts._readFile(path);
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;
    const body = parsed.content;

    if (!fm || typeof fm.type !== 'string' || fm.type.length === 0) {
      // No frontmatter `type:` field — skip with no-type marker.
      return null;
    }

    // Stamp imported_from marker so downstream extract_atoms +
    // synthesize_concepts phases skip this page (D7). Preserve ALL
    // original frontmatter under metadata.original_frontmatter so the
    // put_page handler can reconstruct fidelity.
    const importedFm = {
      ...fm,
      imported_from: 'markdown-greenfield',
      imported_at: new Date().toISOString(),
    };

    const newBody = matter.stringify(body, importedFm);
    const slug = this.deriveSlugFromPath(path);

    return {
      source_id: this.id,
      source_kind: this.kind,
      source_uri: `file://${path}`,
      received_at: new Date().toISOString(),
      content_type: 'text/markdown',
      content: newBody,
      content_hash: computeContentHash(newBody),
      // local file, user's own your OpenClaw brain — trusted payload
      untrusted_payload: false,
      metadata: {
        slug,
        page_type: fm.type as string,
        original_path: relative(this.opts.repoPath, path),
        original_frontmatter: fm,
        importer: 'markdown-greenfield',
        importer_version: '0.41.0',
      },
    };
  }

  /**
   * Derive the gbrain page slug from the absolute file path. Strips
   * the repo prefix and the .md suffix. Preserves the directory
   * hierarchy so atoms/{date}/foo.md → atoms/{date}/foo.
   */
  private deriveSlugFromPath(path: string): string {
    const rel = relative(this.opts.repoPath, path);
    return rel.replace(/\.md$/, '');
  }

  private appendFailureAudit(path: string, errMsg: string): void {
    const week = this.isoWeekString(new Date());
    const auditPath = join(this.opts.auditDir, `markdown-greenfield-failures-${week}.jsonl`);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      path,
      error: errMsg,
      importer: 'markdown-greenfield',
    });
    try {
      this.opts._appendFileSync(auditPath, line + '\n');
    } catch (err) {
      // Audit write failure is non-fatal; log to ctx if available.
      if (this.ctx) {
        this.ctx.logger.warn(
          `[markdown-greenfield] audit write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private isoWeekString(d: Date): string {
    // Returns YYYY-Www where ww is ISO 8601 week number.
    const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = target.getUTCDay() || 7;
    target.setUTCDate(target.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((+target - +yearStart) / 86400000 + 1) / 7);
    return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }
}
