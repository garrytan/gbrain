import type { Migration } from './types.ts';

export const v071: Migration = {
  version: 71,
  name: 'take_nudge_log_v0_36',
  // v0.36.1.0 — E7 nudge log + cooldown state (D16/F3 + CDX-5).
  //
  // Polymorphic reference (CDX-5 fix): a nudge can fire on a
  // canonical take (take_id set) OR on a pending proposal (proposal_id
  // set) BEFORE the proposal gets accepted. CHECK constraint enforces
  // exactly one is set.
  //
  // (take_id, nudge_pattern, fired_at DESC) index supports the cooldown
  // probe ("did we fire this pattern for this take in the last 14 days?").
  // Same shape works for proposal_id via the index below.
  //
  // channel column lets future routing (webhook/admin-spa-toast) reuse
  // the same cooldown semantics. v0.36.1.0 ships with channel='stderr'
  // only (multi-channel routing deferred to v0.37+).
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS take_nudge_log (
        id              BIGSERIAL PRIMARY KEY,
        source_id       TEXT         NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        take_id         BIGINT,
        proposal_id     BIGINT       REFERENCES take_proposals(id) ON DELETE CASCADE,
        nudge_pattern   TEXT         NOT NULL,
        fired_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
        channel         TEXT         NOT NULL DEFAULT 'stderr',
        wave_version    TEXT         NOT NULL DEFAULT 'v0.36.1.0',
        CONSTRAINT take_nudge_log_target_xor
          CHECK ((take_id IS NOT NULL) <> (proposal_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS take_nudge_log_take_cooldown_idx
        ON take_nudge_log (take_id, nudge_pattern, fired_at DESC)
        WHERE take_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS take_nudge_log_proposal_cooldown_idx
        ON take_nudge_log (proposal_id, nudge_pattern, fired_at DESC)
        WHERE proposal_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS take_nudge_log_wave_idx
        ON take_nudge_log (wave_version, fired_at DESC);
    `,
};
