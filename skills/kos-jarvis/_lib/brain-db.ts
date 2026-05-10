/**
 * Direct brain-DB reader for KOS quality-gate skills.
 *
 * Dual-engine: detects engine from `~/.gbrain/config.json`:
 *   - `engine: "pglite"` (legacy) → embedded WASM Postgres via @electric-sql/pglite
 *   - `engine: "postgres"` (default after Path 3 migration 2026-04-29) →
 *     postgres.js client against local Postgres 17 + pgvector.
 *
 * Why direct: `gbrain list` caps at 100 rows (MCP list_pages operation).
 * With 2k+ pages we need full-table access. `engine.listPages({ limit:
 * 100000 })` in upstream does exactly that; we call it the same way.
 *
 * Why we no longer fear lock contention (post-Path-3): Postgres allows
 * multiple concurrent clients (kos-compat-api server holds one pool, while
 * kos-patrol/dream-cycle/etc. open short-lived connections in parallel).
 * The PGLite single-writer file lock that motivated "open briefly, read,
 * close" is gone. We still call `close()` for cleanup hygiene.
 *
 * Surface API is unchanged from the PGLite-only version — current callers
 * (kos-patrol, orphan-reducer, server/kos-compat-api) keep working.
 * Archived: kos-lint + slug-normalize + frontmatter-ref-fix (M1, 2026-05-10);
 * dikw-compile + evidence-gate + confidence-score (M2-A, 2026-05-10).
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import postgres from "postgres";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";

const DEFAULT_PGLITE_PATH = `${homedir()}/.gbrain/brain.pglite`;
const CONFIG_PATH = `${homedir()}/.gbrain/config.json`;

type EngineKind = "pglite" | "postgres";

interface GbrainConfig {
  engine: EngineKind;
  database_path?: string;  // pglite
  database_url?: string;   // postgres
}

function readConfig(): GbrainConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { engine: "pglite", database_path: DEFAULT_PGLITE_PATH };
  }
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as GbrainConfig;
    if (!cfg.engine) cfg.engine = "pglite";
    return cfg;
  } catch {
    return { engine: "pglite", database_path: DEFAULT_PGLITE_PATH };
  }
}

export type PageRow = {
  id: number;
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
};

export type BackrefCount = { to_slug: string; inbound: number };

// Eval capture (v0.25.0 — BrainBench-Real). Mirrored locally so BrainDb
// stays self-contained with no upstream type import dependency. Shape
// must match `src/core/types.ts:EvalCandidateInput` and friends; the
// schema lives in src/core/pglite-schema.ts and src/schema.sql.
export type EvalToolName = 'query' | 'search';
export type EvalDetailLevel = 'low' | 'medium' | 'high';
export type EvalCaptureFailureReason =
  | 'db_down'
  | 'rls_reject'
  | 'check_violation'
  | 'scrubber_exception'
  | 'other';

export interface EvalCandidateInput {
  tool_name: EvalToolName;
  /** Caller's responsibility to scrub PII before passing in. */
  query: string;
  retrieved_slugs: string[];
  retrieved_chunk_ids: number[];
  source_ids: string[];
  expand_enabled: boolean | null;
  detail: EvalDetailLevel | null;
  detail_resolved: EvalDetailLevel | null;
  vector_enabled: boolean;
  expansion_applied: boolean;
  latency_ms: number;
  remote: boolean;
  job_id: number | null;
  subagent_id: number | null;
}

export interface EvalCandidate extends EvalCandidateInput {
  id: number;
  created_at: Date;
}

export interface EvalCaptureFailure {
  id: number;
  ts: Date;
  reason: EvalCaptureFailureReason;
}

export class BrainDb {
  private engineKind: EngineKind = "pglite";
  private pglite: PGlite | null = null;
  private pgClient: ReturnType<typeof postgres> | null = null;

  /** `path` is only consulted for PGLite mode and only as fallback when the
   * config file omits database_path. Post-Path-3 migration the value is
   * irrelevant on production (engine=postgres); kept for back-compat with
   * any caller that constructs `new BrainDb(custom_pglite_path)` for tests
   * or scratch brains. */
  constructor(private path: string = DEFAULT_PGLITE_PATH) {}

  async open(): Promise<void> {
    if (this.pglite || this.pgClient) return;

    const cfg = readConfig();
    if (cfg.engine === "postgres") {
      if (!cfg.database_url) {
        throw new Error(
          `BrainDb: config.engine="postgres" but database_url missing in ${CONFIG_PATH}`
        );
      }
      this.engineKind = "postgres";
      this.pgClient = postgres(cfg.database_url, {
        onnotice: () => {},  // suppress NOTICE log noise
        idle_timeout: 20,
        connect_timeout: 10,
        // Bypass prepared statements — we issue ad-hoc queries via unsafe()
        // and don't want session-level prep cache bloat.
        prepare: false,
      });
    } else {
      this.engineKind = "pglite";
      // Match src/core/pglite-engine.ts:48 — without the `vector` extension the
      // `<=>` operator fails at load time with code 58P01 on fresh handles.
      const dataDir = cfg.database_path ?? this.path;
      this.pglite = await PGlite.create({
        dataDir: `file://${dataDir}`,
        extensions: { vector, pg_trgm },
      });
    }
  }

  async close(): Promise<void> {
    if (this.pglite) {
      // Mirror the fork-local WAL-durability patch in
      // src/core/pglite-engine.ts:disconnect(). pglite 0.4.4 on macOS
      // 26.3 loses writes on close() unless a WAL switch forces the
      // durable LSN forward. See docs/UPSTREAM-PATCHES/
      // v018-pglite-wal-durability-fix.md. Harmless on read-only
      // handles (pg_switch_wal is a no-op when no new WAL records).
      try {
        await this.pglite.query("SELECT pg_switch_wal()");
      } catch {
        // best-effort: close still proceeds even if the switch fails
      }
      await this.pglite.close();
      this.pglite = null;
    }
    if (this.pgClient) {
      // 5s grace for in-flight queries; postgres.js then forces socket close.
      await this.pgClient.end({ timeout: 5 });
      this.pgClient = null;
    }
  }

  /** Query adapter that hides the engine difference from individual methods.
   * - PGLite: `pg.query(sql, params)` returns `{ rows }`.
   * - postgres.js: `pg.unsafe(sql, params)` returns the rows array directly.
   * Both engines accept `$1, $2, ...` placeholders so the SQL strings are
   * shared verbatim across engines. */
  private async _q<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    if (this.engineKind === "postgres" && this.pgClient) {
      // unsafe is the parameterized escape hatch for ad-hoc SQL in postgres.js.
      const rows = await this.pgClient.unsafe(sql, params as never[]);
      return rows as unknown as T[];
    }
    if (this.pglite) {
      const { rows } = await this.pglite.query<T>(sql, params);
      return rows;
    }
    throw new Error("BrainDb.open() not called");
  }

  /** Normalize a frontmatter cell. PGLite returns jsonb as a string;
   * postgres.js v3 returns it parsed already. The check covers both. */
  private normalizeFrontmatter(raw: unknown): Record<string, unknown> {
    if (raw == null) return {};
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    }
    return raw as Record<string, unknown>;
  }

  async listAllPages(filter?: { type?: string }): Promise<PageRow[]> {
    const where = filter?.type ? `WHERE type = $1` : "";
    const params = filter?.type ? [filter.type] : [];
    const rows = await this._q<PageRow>(
      `SELECT id, slug, type, title, compiled_truth, timeline, frontmatter,
              content_hash, created_at, updated_at
       FROM pages ${where}
       ORDER BY updated_at DESC`,
      params
    );
    return rows.map((r) => ({
      ...r,
      frontmatter: this.normalizeFrontmatter(r.frontmatter),
    }));
  }

  async getPage(slug: string): Promise<PageRow | null> {
    const rows = await this._q<PageRow>(
      `SELECT id, slug, type, title, compiled_truth, timeline, frontmatter,
              content_hash, created_at, updated_at
       FROM pages WHERE slug = $1`,
      [slug]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      ...r,
      frontmatter: this.normalizeFrontmatter(r.frontmatter),
    };
  }

  /** Count inbound links grouped by target slug, for all pages in one scan. */
  async inboundCounts(): Promise<Map<string, number>> {
    const rows = await this._q<{ slug: string; inbound: number | string }>(
      `SELECT p.slug, COUNT(l.id)::int AS inbound
       FROM pages p
       LEFT JOIN links l ON l.to_page_id = p.id
       GROUP BY p.slug`
    );
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.slug, Number(r.inbound) || 0);
    return m;
  }

  /**
   * Insert or update one link row. Mirrors src/core/pglite-engine.ts:365
   * (engine.addLink). Default link_source='manual' — our callers are
   * programmatic writers, not markdown extraction.
   *
   * Returns true if a new row was inserted, false if it was a no-op
   * (ON CONFLICT DO UPDATE touches the same row).
   */
  async addLink(
    from: string,
    to: string,
    opts: {
      linkType?: string;
      context?: string;
      linkSource?: "markdown" | "frontmatter" | "manual";
    } = {}
  ): Promise<boolean> {
    const src = opts.linkSource ?? "manual";
    const result = await this._q<{ id: number; xmax: number | string }>(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source)
       SELECT f.id, t.id, $3, $4, $5
       FROM pages f, pages t
       WHERE f.slug = $1 AND t.slug = $2
       ON CONFLICT (from_page_id, to_page_id, link_type, link_source, origin_page_id) DO UPDATE SET
         context = EXCLUDED.context
       RETURNING id, xmax::text::int AS xmax`,
      [from, to, opts.linkType ?? "", opts.context ?? "", src]
    );
    if (result.length === 0) return false;
    // xmax is 0 on pure INSERT, non-zero when the ON CONFLICT branch fired.
    return Number(result[0].xmax) === 0;
  }

  /** Count rows in the links table (fast, used by tests/validation). */
  async countLinks(filter?: { linkType?: string; linkSource?: string }): Promise<number> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.linkType !== undefined) {
      params.push(filter.linkType);
      clauses.push(`link_type = $${params.length}`);
    }
    if (filter?.linkSource !== undefined) {
      params.push(filter.linkSource);
      clauses.push(`link_source = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this._q<{ n: number | string }>(
      `SELECT COUNT(*)::int AS n FROM links ${where}`,
      params
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Raw query escape hatch. Prefer the helpers above when one fits. */
  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    return this._q<T>(sql, params);
  }

  /**
   * Pages with zero inbound links — matches `gbrain orphans` SQL
   * (src/core/pglite-engine.ts:685). Returns raw unfiltered rows; caller
   * applies pseudo/domain filters (see src/commands/orphans.ts:shouldExclude).
   */
  async listOrphans(): Promise<Array<{ slug: string; title: string; domain: string | null }>> {
    return await this._q<{ slug: string; title: string; domain: string | null }>(
      `SELECT p.slug,
              COALESCE(p.title, p.slug) AS title,
              p.frontmatter->>'domain' AS domain
       FROM pages p
       WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)
       ORDER BY p.slug`
    );
  }

  /**
   * Vector-similar pages to a given slug via pgvector cosine distance.
   * Uses the first embedded chunk of the source page as the anchor vector;
   * returns top-K pages (dedup'd at the page level via MIN(distance)).
   * Callers that want per-chunk precision should query content_chunks
   * directly.
   */
  async findSimilar(
    slug: string,
    limit: number
  ): Promise<
    Array<{ slug: string; title: string; compiled_truth: string; distance: number }>
  > {
    const rows = await this._q<{
      slug: string;
      title: string;
      compiled_truth: string;
      distance: number | string;
    }>(
      `WITH target AS (
         SELECT c.embedding, p.id AS page_id
         FROM content_chunks c
         JOIN pages p ON p.id = c.page_id
         WHERE p.slug = $1 AND c.embedding IS NOT NULL
         ORDER BY c.chunk_index ASC
         LIMIT 1
       )
       SELECT p.slug,
              COALESCE(p.title, p.slug) AS title,
              p.compiled_truth,
              MIN(c.embedding <=> t.embedding)::float AS distance
       FROM content_chunks c
       JOIN pages p ON p.id = c.page_id
       CROSS JOIN target t
       WHERE p.id != t.page_id AND c.embedding IS NOT NULL
       GROUP BY p.slug, p.title, p.compiled_truth
       ORDER BY distance ASC
       LIMIT $2`,
      [slug, limit]
    );
    return rows.map((r) => ({ ...r, distance: Number(r.distance) }));
  }

  /** Chunk count per page — used by citation-density heuristic. */
  async chunkCounts(): Promise<Map<string, number>> {
    const rows = await this._q<{ slug: string; n: number | string }>(
      `SELECT p.slug, COUNT(c.id)::int AS n
       FROM pages p
       LEFT JOIN content_chunks c ON c.page_id = p.id
       GROUP BY p.slug`
    );
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.slug, Number(r.n) || 0);
    return m;
  }

  // ───────── Eval capture (v0.25.0 BrainBench-Real safety net) ─────────
  //
  // Upstream's BrainEngine grew 5 methods in v0.25.0; BrainDb is NOT a
  // BrainEngine implementation, so the schema migration alone is enough
  // to keep production healthy. We mirror the surface here as a safety
  // net so any future kos-jarvis skill that wants to read `gbrain eval
  // export` data (e.g. retrieval regression dashboards) can stay on the
  // fork-local DB layer instead of reaching into upstream code.
  //
  // Implementation notes:
  // - Engine-portable SQL via the shared _q adapter ($1, $2 placeholders
  //   work on both PGLite and postgres.js).
  // - listEvalCandidates uses `ORDER BY created_at DESC, id DESC` to match
  //   upstream's deterministic-pagination contract (same-millisecond rows
  //   stay ordered across windowed exports).
  // - logEvalCaptureFailure is intentionally not best-effort here — the
  //   caller decides whether to swallow errors. BrainDb is a thin DB
  //   wrapper, not the policy layer.

  /** Insert a captured candidate row. Returns the new row id. */
  async logEvalCandidate(input: EvalCandidateInput): Promise<number> {
    const rows = await this._q<{ id: number }>(
      `INSERT INTO eval_candidates (
         tool_name, query, retrieved_slugs, retrieved_chunk_ids, source_ids,
         expand_enabled, detail, detail_resolved, vector_enabled, expansion_applied,
         latency_ms, remote, job_id, subagent_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        input.tool_name,
        input.query,
        input.retrieved_slugs,
        input.retrieved_chunk_ids,
        input.source_ids,
        input.expand_enabled,
        input.detail,
        input.detail_resolved,
        input.vector_enabled,
        input.expansion_applied,
        input.latency_ms,
        input.remote,
        input.job_id,
        input.subagent_id,
      ]
    );
    return rows[0]!.id;
  }

  /** Read candidates by time window / limit / tool filter. */
  async listEvalCandidates(filter?: {
    since?: Date;
    limit?: number;
    tool?: EvalToolName;
  }): Promise<EvalCandidate[]> {
    const raw = filter?.limit;
    const limit =
      raw === undefined || raw === null || !Number.isFinite(raw) || raw <= 0
        ? 1000
        : Math.min(Math.floor(raw), 100000);
    const since = filter?.since ?? new Date(0);
    const tool = filter?.tool ?? null;
    const rows = tool
      ? await this._q<EvalCandidate>(
          `SELECT * FROM eval_candidates
           WHERE created_at >= $1 AND tool_name = $2
           ORDER BY created_at DESC, id DESC LIMIT $3`,
          [since, tool, limit]
        )
      : await this._q<EvalCandidate>(
          `SELECT * FROM eval_candidates
           WHERE created_at >= $1
           ORDER BY created_at DESC, id DESC LIMIT $2`,
          [since, limit]
        );
    return rows;
  }

  /** Delete candidates created before `date`. Returns rows deleted. */
  async deleteEvalCandidatesBefore(date: Date): Promise<number> {
    const rows = await this._q<{ id: number }>(
      `DELETE FROM eval_candidates WHERE created_at < $1 RETURNING id`,
      [date]
    );
    return rows.length;
  }

  /** Log a capture failure. Used by `gbrain doctor` cross-process visibility. */
  async logEvalCaptureFailure(reason: EvalCaptureFailureReason): Promise<void> {
    await this._q(
      `INSERT INTO eval_capture_failures (reason) VALUES ($1)`,
      [reason]
    );
  }

  /** Read capture failures within an optional time window. */
  async listEvalCaptureFailures(filter?: { since?: Date }): Promise<EvalCaptureFailure[]> {
    const since = filter?.since ?? new Date(0);
    return await this._q<EvalCaptureFailure>(
      `SELECT * FROM eval_capture_failures
       WHERE ts >= $1
       ORDER BY ts DESC`,
      [since]
    );
  }
}
