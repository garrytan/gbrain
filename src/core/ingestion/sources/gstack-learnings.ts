/**
 * GStackLearningsSource — bridge gstack's JSONL learnings into gbrain.
 *
 * v0.41 T8 — engineer-pack-active bridge. gstack ships an
 * append-only JSONL learnings system at
 * `~/.gstack/projects/{repo}/learnings.jsonl` with 7 typed entries
 * (pattern, pitfall, preference, architecture, tool, operational,
 * investigation). The data never makes it into gbrain today — engineers
 * accumulate insights in a separate file the brain can't query.
 *
 * This source closes the gap. For each JSONL line, emits an
 * IngestionEvent typed as a `learning` page (the type declared by
 * gbrain-engineer pack manifest). The daemon routes to put_page,
 * frontmatter carries the original JSONL fields verbatim
 * (learning_type, confidence, source, files, skill), and the brain
 * can query learnings the same way as any other page.
 *
 * Lifecycle:
 *   - start(): seeds the dedup window with content_hashes of every
 *     EXISTING line in every watched JSONL (so the first run after a
 *     fresh install doesn't re-emit thousands of historical lines).
 *     Then begins watching for new appends via fs.watch (polling
 *     fallback for cross-platform compat).
 *   - emit per new JSONL line: parse line as JSON, validate shape,
 *     compute content_hash on the canonical-JSON of the parsed object
 *     (so reformatting whitespace doesn't trigger re-emit), emit
 *     IngestionEvent.
 *   - stop(): closes watchers. JSONL state preserved (gstack owns the
 *     files; gbrain only reads).
 *
 * Pack-active gating: this source is only registered with the daemon
 * when the active pack is gbrain-engineer (or gbrain-everything which
 * borrows learning from engineer). The daemon's startup probes
 * `loadActivePack().manifest.page_types` for the `learning` type and
 * only constructs the source when it's present. When the user switches
 * away from an engineer-flavored pack, the daemon stops the source on
 * the next restart.
 *
 * Cross-project scope: when gstack's `cross_project_learnings: true`
 * config is set, watches every learnings.jsonl across all project
 * directories. Otherwise watches only the current project's file
 * (resolved via git repo root). v0.42 may add a per-project filter.
 *
 * mode: 'trickle' — uses the daemon's standard 24h content_hash dedup
 * window. Line-level content_hash means re-emit of an unchanged line
 * is a silent dedup hit. Migration mode is NOT needed because there's
 * no bulk-historical-replay concern — gstack's append-only JSONL is
 * the canonical source of truth and stays there forever.
 */

import { readFileSync, existsSync, statSync, readdirSync, watch as fsWatch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { computeContentHash } from '../types.ts';
import type {
  IngestionSource,
  IngestionSourceContext,
  IngestionEvent,
  IngestionSourceMode,
  IngestionSourceHealth,
} from '../types.ts';

/** Shape of one JSONL line per `~/.claude/skills/gstack/bin/gstack-learnings-log`. */
export interface GstackLearningLine {
  skill: string;
  type: 'pattern' | 'pitfall' | 'preference' | 'architecture' | 'tool' | 'operational' | 'investigation';
  key: string;
  insight: string;
  confidence: number;
  source: 'observed' | 'user-stated' | 'inferred' | 'cross-model';
  files?: string[];
  ts?: string;
  branch?: string;
}

export interface GstackLearningsSourceOpts {
  /** Watched JSONL paths. Defaults to ~/.gstack/projects/&#42;/learnings.jsonl. */
  paths?: string[];
  /** Bypass cross-project discovery. When false, only the current project's
   *  learnings.jsonl is watched (resolved via cwd → repo root). Default true. */
  crossProject?: boolean;
  /** Test seam: alternative fs read. */
  _readFile?: (path: string) => string;
  /** Test seam: alternative existsSync. */
  _existsSync?: (path: string) => boolean;
  /** Test seam: skip fs.watch (tests inject events via emitLine instead). */
  _skipWatch?: boolean;
}

export class GstackLearningsSource implements IngestionSource {
  readonly id: string;
  readonly kind = 'gstack-learnings';
  // trickle mode — line-level content_hash dedup via the daemon's 24h window
  readonly mode: IngestionSourceMode = 'trickle';

  private readonly paths: string[];
  private readonly watchers: FSWatcher[] = [];
  private readonly seenLines = new Set<string>();
  private readonly opts: Required<Omit<GstackLearningsSourceOpts, 'paths' | 'crossProject'>> & {
    paths: string[];
    crossProject: boolean;
  };
  private ctx: IngestionSourceContext | null = null;

  constructor(opts: GstackLearningsSourceOpts = {}) {
    this.id = `gstack-learnings:${process.pid}`;
    this.opts = {
      paths: opts.paths ?? [],
      crossProject: opts.crossProject ?? true,
      _readFile: opts._readFile ?? ((p) => readFileSync(p, 'utf-8')),
      _existsSync: opts._existsSync ?? existsSync,
      _skipWatch: opts._skipWatch ?? false,
    };
    this.paths = this.opts.paths.length > 0 ? this.opts.paths : this.discoverPaths();
  }

  /**
   * Discover learnings.jsonl files via ~/.gstack/projects/*&#47;learnings.jsonl.
   * Idempotent — safe to call multiple times. Returns absolute paths.
   */
  private discoverPaths(): string[] {
    if (!this.opts.crossProject) {
      // Per-project mode: just the current cwd's project. Resolution via
      // git repo root would require a child process; for v0.41 minimal
      // viable, fall back to the cwd basename.
      const cwd = process.cwd();
      const projectName = cwd.split('/').pop() ?? 'unknown';
      const single = join(homedir(), '.gstack', 'projects', projectName, 'learnings.jsonl');
      return this.opts._existsSync(single) ? [single] : [];
    }
    const projectsRoot = join(homedir(), '.gstack', 'projects');
    if (!this.opts._existsSync(projectsRoot)) return [];
    try {
      const entries = readdirSync(projectsRoot, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => join(projectsRoot, e.name, 'learnings.jsonl'))
        .filter((p) => this.opts._existsSync(p));
    } catch {
      return [];
    }
  }

  async start(ctx: IngestionSourceContext): Promise<void> {
    this.ctx = ctx;
    // Seed the seen-lines set with the existing content of every watched
    // file. First-run-after-install must NOT replay thousands of historical
    // lines as fresh emits; that would flood the brain.
    for (const path of this.paths) {
      try {
        const content = this.opts._readFile(path);
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          // Hash the canonical-JSON shape, not the raw line, so reformatting
          // whitespace doesn't make a re-emit look new.
          try {
            const parsed = JSON.parse(trimmed) as GstackLearningLine;
            this.seenLines.add(computeContentHash(JSON.stringify(parsed)));
          } catch {
            // Malformed line — skip. Don't track in seenLines; future
            // re-emit (after gstack fixes the line) still ingests.
          }
        }
      } catch (err) {
        ctx.logger.warn(
          `[gstack-learnings] failed to seed seen-lines from ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Watch for new lines via fs.watch. Tests inject events via emitLine
    // to bypass the watcher (fs.watch is platform-flaky for tests).
    if (!this.opts._skipWatch) {
      for (const path of this.paths) {
        if (!this.opts._existsSync(path)) continue;
        try {
          const watcher = fsWatch(path, (eventType) => {
            if (eventType === 'change') {
              this.rescanFile(path).catch((err) => {
                ctx.logger.warn(
                  `[gstack-learnings] rescan failed for ${path}: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
            }
          });
          this.watchers.push(watcher);
        } catch (err) {
          ctx.logger.warn(
            `[gstack-learnings] failed to watch ${path}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  async stop(): Promise<void> {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.watchers.length = 0;
    this.ctx = null;
  }

  async healthCheck(): Promise<IngestionSourceHealth> {
    const allExist = this.paths.every((p) => this.opts._existsSync(p));
    if (this.paths.length === 0) {
      return { status: 'warn', message: 'no gstack learnings files discovered (is gstack installed?)' };
    }
    if (!allExist) {
      return { status: 'warn', message: 'one or more watched learnings.jsonl files have disappeared' };
    }
    return { status: 'ok', message: `${this.paths.length} watched, ${this.seenLines.size} lines seen` };
  }

  /** Test seam: directly emit a parsed JSONL line. Production code path
   *  goes through rescanFile via fs.watch. */
  emitLine(line: GstackLearningLine, sourceUri: string): void {
    if (!this.ctx) {
      throw new Error('GstackLearningsSource.emitLine: source not started');
    }
    const event = this.buildEvent(line, sourceUri);
    if (event === null) return; // dedup hit
    this.ctx.emit(event);
  }

  /**
   * Rescan a file after fs.watch fires 'change'. Reads every line, computes
   * canonical-JSON content_hash, emits for any line not in seenLines.
   *
   * O(N) per change event where N = total lines. Acceptable for the small
   * file sizes typical of learnings.jsonl (tens of MB at extreme).
   */
  private async rescanFile(path: string): Promise<void> {
    if (!this.ctx) return;
    let content: string;
    try {
      content = this.opts._readFile(path);
    } catch (err) {
      this.ctx.logger.warn(
        `[gstack-learnings] read failed for ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    for (const rawLine of content.split('\n')) {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) continue;
      let parsed: GstackLearningLine;
      try {
        parsed = JSON.parse(trimmed) as GstackLearningLine;
      } catch {
        // Malformed line — skip + warn. The next rescan re-checks; if
        // gstack appends a valid line later we'll catch it.
        this.ctx.logger.warn(`[gstack-learnings] malformed JSONL line in ${path}`);
        continue;
      }
      const event = this.buildEvent(parsed, path);
      if (event === null) continue;
      this.ctx.emit(event);
    }
  }

  /**
   * Build an IngestionEvent from a parsed JSONL line. Returns null when
   * the line's canonical-JSON content_hash is already in seenLines (dedup
   * hit). Updates seenLines as a side effect.
   */
  private buildEvent(line: GstackLearningLine, sourceUri: string): IngestionEvent | null {
    const canonical = JSON.stringify(line);
    const hash = computeContentHash(canonical);
    if (this.seenLines.has(hash)) return null;
    this.seenLines.add(hash);

    const body = this.renderMarkdown(line);
    return {
      source_id: this.id,
      source_kind: this.kind,
      source_uri: sourceUri,
      received_at: new Date().toISOString(),
      content_type: 'text/markdown',
      content: body,
      content_hash: computeContentHash(body),
      untrusted_payload: false, // local file, user's own gstack output
      metadata: {
        learning: line,
      },
    };
  }

  /** Render a learning JSONL line as a markdown body. Frontmatter carries
   *  the original fields verbatim so downstream consumers can read them
   *  without re-parsing the metadata block. */
  private renderMarkdown(line: GstackLearningLine): string {
    const fm: Record<string, unknown> = {
      type: 'learning',
      learning_type: line.type,
      confidence: line.confidence,
      source: line.source,
      skill: line.skill,
      key: line.key,
    };
    if (line.files !== undefined) fm.files = line.files;
    if (line.branch !== undefined) fm.branch = line.branch;
    if (line.ts !== undefined) fm.ts = line.ts;
    const fmLines = Object.entries(fm).map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`;
      }
      return `${k}: ${JSON.stringify(v)}`;
    });
    return `---\n${fmLines.join('\n')}\n---\n\n# ${line.key}\n\n${line.insight}\n`;
  }

  /** Diagnostic: number of lines seen since start. */
  get seenCount(): number {
    return this.seenLines.size;
  }

  /** Diagnostic: paths being watched. */
  get watchedPaths(): readonly string[] {
    return this.paths;
  }

  /** Stat the watched files to detect existence + size for the doctor. */
  describePaths(): Array<{ path: string; exists: boolean; size?: number }> {
    return this.paths.map((p) => {
      const exists = this.opts._existsSync(p);
      let size: number | undefined;
      if (exists) {
        try {
          size = statSync(p).size;
        } catch {
          size = undefined;
        }
      }
      return { path: p, exists, size };
    });
  }
}
