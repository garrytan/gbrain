import type { Migration } from './types.ts';
import { hnswMaxDimsForType } from '../vector-index.ts';

export const v144: Migration = {
  version: 144,
  name: 'open_loops',
  // Gmail-first open-loop engine: the structured record behind
  // "who is waiting on you, what you promised". One row per open loop,
  // deduped per source on dedup_key:
  //   'thread:<threadId>:<loop_type>'  — deterministic thread-state loops
  //   'commit:<sha8(canonical json)>'  — LLM-extracted commitments
  // Loops CLOSE by state transition (done/dropped/stale), never delete —
  // reply-driven auto-close flips status and keeps the audit trail.
  // fact_id points at the projected facts row (kind=commitment) so entity
  // cards / recall see the same commitment through the existing read paths.
  // Written by src/core/google/loop-detect.ts + loops-extract.ts; read by
  // the open_loops op (src/core/ops/loops.ts). Same DDL on both engines.
  idempotent: true,
  sql: `
      -- Skew-guard re-apply of master's v143 (dream_verdicts_ttl) for
      -- branch-tester DBs that recorded 142/143 before the renumber; all
      -- statements are idempotent no-ops where v143 already ran.
      ALTER TABLE dream_verdicts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
      UPDATE dream_verdicts
        SET expires_at = judged_at + interval '30 days'
        WHERE expires_at IS NULL;
      ALTER TABLE dream_verdicts
        ALTER COLUMN expires_at SET DEFAULT (now() + interval '30 days'),
        ALTER COLUMN expires_at SET NOT NULL;
      CREATE INDEX IF NOT EXISTS dream_verdicts_expires_idx
        ON dream_verdicts (expires_at);
      CREATE TABLE IF NOT EXISTS open_loops (
        id                 BIGSERIAL PRIMARY KEY,
        source_id          TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        dedup_key          TEXT NOT NULL,
        loop_type          TEXT NOT NULL CHECK (loop_type IN (
                             'commitment_owed_by_me','commitment_owed_to_me',
                             'unanswered_inbound','unanswered_outbound','decision_pending')),
        counterparty_slug  TEXT,
        counterparty_email TEXT,
        summary            TEXT NOT NULL,
        evidence           JSONB NOT NULL DEFAULT '[]'::jsonb,
        thread_id          TEXT,
        page_slug          TEXT,
        due_at             TIMESTAMPTZ,
        status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped','stale')),
        detector           TEXT NOT NULL CHECK (detector IN ('deterministic_thread','llm_extract','manual')),
        confidence         REAL NOT NULL DEFAULT 1.0,
        fact_id            BIGINT,
        opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_activity_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_at          TIMESTAMPTZ,
        closed_by          TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT open_loops_dedup UNIQUE (source_id, dedup_key)
      );
      CREATE INDEX IF NOT EXISTS open_loops_status_idx
        ON open_loops (source_id, status, last_activity_at DESC);
      CREATE INDEX IF NOT EXISTS open_loops_counterparty_idx
        ON open_loops (source_id, counterparty_slug) WHERE status = 'open';
      CREATE INDEX IF NOT EXISTS open_loops_thread_idx
        ON open_loops (source_id, thread_id) WHERE status = 'open';
      CREATE TABLE IF NOT EXISTS loop_suppressions (
        id         BIGSERIAL PRIMARY KEY,
        source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('sender','thread')),
        value      TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT loop_suppressions_uniq UNIQUE (source_id, kind, value)
      );
    `,
  // Skew guard (mirrors master's own renumber pattern): the
  // gmail-open-loop-engine branch shipped open_loops as v142, then v143,
  // while master consumed v142 (takes_embedding_dimension_matches_config,
  // #2089) and v143 (dream_verdicts_ttl, #4069) — a brain that ran the
  // branch pre-merge recorded 142/143 and would skip those forever. The
  // sql above re-applies dream_verdicts_ttl (idempotent DDL) and this
  // handler re-applies the takes resize (dimension check = no-op
  // everywhere it already ran).
  handler: async (engine) => {
    const dimRows = await engine.executeRaw<{ value: string }>(
      `SELECT value FROM config WHERE key = 'embedding_dimensions'`,
    );
    const configured = Number.parseInt(dimRows[0]?.value ?? '', 10);
    const embeddingDim = Number.isInteger(configured) && configured > 0 && configured <= 16000
      ? configured
      : 1536;
    const typeRows = await engine.executeRaw<{ formatted: string | null }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS formatted
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = 'takes'
           AND a.attname = 'embedding'
           AND NOT a.attisdropped`,
    );
    const current = typeRows[0]?.formatted?.match(/vector\((\d+)\)/i)?.[1];
    if (current && Number.parseInt(current, 10) === embeddingDim) return;

    await engine.executeRaw(`DROP INDEX IF EXISTS idx_takes_embedding_hnsw`);
    await engine.executeRaw(`UPDATE takes SET embedding = NULL, embedded_at = NULL`);
    await engine.executeRaw(`ALTER TABLE takes DROP COLUMN IF EXISTS embedding`);
    await engine.executeRaw(`ALTER TABLE takes ADD COLUMN embedding VECTOR(${embeddingDim})`);
    if (embeddingDim <= hnswMaxDimsForType('vector')) {
      await engine.executeRaw(
        `CREATE INDEX IF NOT EXISTS idx_takes_embedding_hnsw ON takes
             USING hnsw (embedding vector_cosine_ops)
             WHERE active AND embedding IS NOT NULL`,
      );
    }
    process.stderr.write(`  v144 skew guard: takes.embedding resized to vector(${embeddingDim})\n`);
  },
};
