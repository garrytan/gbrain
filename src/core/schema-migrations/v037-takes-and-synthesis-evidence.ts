import type { Migration } from './types.ts';

// NOTE: v37 + v38 are the v0.28 takes migrations. Renumbered four times during
// the long-lived v0.28 branch as master shipped:
//   v0.28 originally targeted v31/v32
//   master v0.25 claimed v31 (eval_capture_tables) → renumbered to v32/v33
//   master v0.26 claimed v32 (oauth_infrastructure) and v33
//     (admin_dashboard_columns_v0_26_3) → renumbered to v34/v35
//   master v0.26.5 claimed v34 (destructive_guard_columns) → renumbered to v35/v36
//   master v0.26.8 + v0.27 claimed v35 (auto_rls_event_trigger) and v36
//     (subagent_provider_neutral_persistence_v0_27) → renumbered to v37/v38
// Runtime sort by version ascending means source-order doesn't matter.
export const v037: Migration = {
  version: 37,
  name: 'takes_and_synthesis_evidence',
  // v0.28: typed/weighted/attributed claims ("takes") + synthesis provenance.
  // Spec: docs/designs (CEO plan) + plan file. Schema decisions:
  //   - page_id FK (not page_slug) — pages.slug is unique only within source
  //   - (page_id, row_num) is the natural unique key (composite, append-only)
  //   - synthesis_evidence FK ON DELETE CASCADE — when a source take is hard-deleted,
  //     provenance rows go with it; synthesis renderer marks citations as removed
  //   - HNSW index on embedding (pgvector 0.7+ supports both Postgres + PGLite)
  //   - resolved_* columns ship now per CEO-review D4 + Codex P1 #13 (immutable)
  sql: `
      CREATE TABLE IF NOT EXISTS takes (
        id               BIGSERIAL PRIMARY KEY,
        page_id          INTEGER     NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        row_num          INTEGER     NOT NULL,
        claim            TEXT        NOT NULL,
        kind             TEXT        NOT NULL CHECK (kind IN ('fact','take','bet','hunch')),
        holder           TEXT        NOT NULL,
        weight           REAL        NOT NULL DEFAULT 0.5 CHECK (weight >= 0 AND weight <= 1),
        since_date       TEXT,
        until_date       TEXT,
        source           TEXT,
        superseded_by    INTEGER,
        active           BOOLEAN     NOT NULL DEFAULT TRUE,
        resolved_at      TIMESTAMPTZ,
        resolved_outcome BOOLEAN,
        resolved_value   REAL,
        resolved_unit    TEXT,
        resolved_source  TEXT,
        resolved_by      TEXT,
        embedding        VECTOR(1536),
        embedded_at      TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT takes_page_row_key UNIQUE (page_id, row_num)
      );
      CREATE INDEX IF NOT EXISTS idx_takes_page          ON takes(page_id);
      CREATE INDEX IF NOT EXISTS idx_takes_kind_active   ON takes(kind)   WHERE active;
      CREATE INDEX IF NOT EXISTS idx_takes_holder_active ON takes(holder) WHERE active;
      CREATE INDEX IF NOT EXISTS idx_takes_weight_active ON takes(weight DESC) WHERE active;
      CREATE INDEX IF NOT EXISTS idx_takes_resolved_at   ON takes(resolved_at) WHERE resolved_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_takes_embedding_hnsw ON takes
        USING hnsw (embedding vector_cosine_ops)
        WHERE active AND embedding IS NOT NULL;

      CREATE TABLE IF NOT EXISTS synthesis_evidence (
        synthesis_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        take_page_id      INTEGER NOT NULL,
        take_row_num      INTEGER NOT NULL,
        citation_index    INTEGER NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (synthesis_page_id, take_page_id, take_row_num),
        FOREIGN KEY (take_page_id, take_row_num)
          REFERENCES takes(page_id, row_num) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_synthesis_evidence_take
        ON synthesis_evidence(take_page_id, take_row_num);

      DO $$
      DECLARE
        has_bypass BOOLEAN;
      BEGIN
        SELECT EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) INTO has_bypass; -- #1385: superuser + inherited-role BYPASSRLS, not just the role's own rolbypassrls
        IF has_bypass THEN
          ALTER TABLE takes              ENABLE ROW LEVEL SECURITY;
          ALTER TABLE synthesis_evidence ENABLE ROW LEVEL SECURITY;
        END IF;
      END $$;
    `,
  sqlFor: {
    // PGLite: same DDL minus the RLS DO-block (no rolbypassrls). Same HNSW
    // index syntax — pgvector 0.7+ supports it. Same FK semantics.
    pglite: `
        CREATE TABLE IF NOT EXISTS takes (
          id               BIGSERIAL PRIMARY KEY,
          page_id          INTEGER     NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
          row_num          INTEGER     NOT NULL,
          claim            TEXT        NOT NULL,
          kind             TEXT        NOT NULL CHECK (kind IN ('fact','take','bet','hunch')),
          holder           TEXT        NOT NULL,
          weight           REAL        NOT NULL DEFAULT 0.5 CHECK (weight >= 0 AND weight <= 1),
          since_date       TEXT,
          until_date       TEXT,
          source           TEXT,
          superseded_by    INTEGER,
          active           BOOLEAN     NOT NULL DEFAULT TRUE,
          resolved_at      TIMESTAMPTZ,
          resolved_outcome BOOLEAN,
          resolved_value   REAL,
          resolved_unit    TEXT,
          resolved_source  TEXT,
          resolved_by      TEXT,
          embedding        VECTOR(1536),
          embedded_at      TIMESTAMPTZ,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT takes_page_row_key UNIQUE (page_id, row_num)
        );
        CREATE INDEX IF NOT EXISTS idx_takes_page          ON takes(page_id);
        CREATE INDEX IF NOT EXISTS idx_takes_kind_active   ON takes(kind)   WHERE active;
        CREATE INDEX IF NOT EXISTS idx_takes_holder_active ON takes(holder) WHERE active;
        CREATE INDEX IF NOT EXISTS idx_takes_weight_active ON takes(weight DESC) WHERE active;
        CREATE INDEX IF NOT EXISTS idx_takes_resolved_at   ON takes(resolved_at) WHERE resolved_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_takes_embedding_hnsw ON takes
          USING hnsw (embedding vector_cosine_ops)
          WHERE active AND embedding IS NOT NULL;

        CREATE TABLE IF NOT EXISTS synthesis_evidence (
          synthesis_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
          take_page_id      INTEGER NOT NULL,
          take_row_num      INTEGER NOT NULL,
          citation_index    INTEGER NOT NULL,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (synthesis_page_id, take_page_id, take_row_num),
          FOREIGN KEY (take_page_id, take_row_num)
            REFERENCES takes(page_id, row_num) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_synthesis_evidence_take
          ON synthesis_evidence(take_page_id, take_row_num);
      `,
  },
};
