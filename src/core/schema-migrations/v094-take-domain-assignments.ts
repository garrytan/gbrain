import type { Migration } from './types.ts';

export const v094: Migration = {
  version: 94,
  name: 'take_domain_assignments',
  // v0.41.2 lens packs (Section 1 D9/T1 — codex outside-voice challenge
  // to scalar `takes.domain` column). One take can legitimately belong to
  // multiple calibration domains (a take about "Sequoia's investment in
  // Anthropic" lands in deal_success AND market_call). A scalar column
  // forces single-bucket attribution AND bakes today's pack→domain mapping
  // into permanent fact. The JOIN table separates assignment from the take
  // itself: history preserved when packs/mappings change, multi-domain
  // attribution honest, third-party packs add domains without schema migration.
  //
  // Originally planned as v93; master shipped v93 (minions cathedral
  // `minions_v0_41_audit_and_budget`) so this slot moved to v94 during
  // post-merge resolution. Renumber-only — table shape and content
  // unchanged from the original v0.41 plan.
  //
  // Composite PK `(take_id, domain)` prevents duplicate assignment of the
  // same take to the same domain (idempotent re-assignment from
  // propose_takes). Domain index covers the aggregator JOIN direction
  // (calibration_profile widens to "for each domain in active pack's
  // calibration_domains, JOIN take_domain_assignments WHERE domain = $1
  // JOIN takes ON id = take_id WHERE active AND resolved").
  //
  // FK ON DELETE CASCADE because assignments are derived data — if the
  // underlying take is hard-deleted (rare; takes are usually soft-resolved),
  // assignments go with it. NULL `source` permits manual operator
  // assignments without a synthetic source string.
  sql: `
      CREATE TABLE IF NOT EXISTS take_domain_assignments (
        take_id     BIGINT      NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
        domain      TEXT        NOT NULL,
        pack        TEXT        NOT NULL,
        source      TEXT,
        confidence  REAL        NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (take_id, domain)
      );
      CREATE INDEX IF NOT EXISTS idx_take_domain_assignments_domain
        ON take_domain_assignments (domain, take_id);

      DO $$
      DECLARE
        has_bypass BOOLEAN;
      BEGIN
        SELECT EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) INTO has_bypass; -- #1385: superuser + inherited-role BYPASSRLS, not just the role's own rolbypassrls
        IF has_bypass THEN
          ALTER TABLE take_domain_assignments ENABLE ROW LEVEL SECURITY;
        END IF;
      END $$;
    `,
  sqlFor: {
    // PGLite: same DDL minus the RLS DO-block (no rolbypassrls).
    pglite: `
        CREATE TABLE IF NOT EXISTS take_domain_assignments (
          take_id     BIGINT      NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
          domain      TEXT        NOT NULL,
          pack        TEXT        NOT NULL,
          source      TEXT,
          confidence  REAL        NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
          assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (take_id, domain)
        );
        CREATE INDEX IF NOT EXISTS idx_take_domain_assignments_domain
          ON take_domain_assignments (domain, take_id);
      `,
  },
};
