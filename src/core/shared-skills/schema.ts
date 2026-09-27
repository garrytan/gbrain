export const SHARED_SKILLS_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS shared_skill_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    token_secret TEXT NOT NULL DEFAULT (replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')),
    serving_epoch UUID NOT NULL DEFAULT gen_random_uuid()
  )`,
  `INSERT INTO shared_skill_state(singleton) VALUES(1) ON CONFLICT DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS shared_skill_policies (
    source_id TEXT NOT NULL, source_incarnation UUID NOT NULL,
    epoch UUID NOT NULL DEFAULT gen_random_uuid(), policy JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(source_id,source_incarnation)
  )`,
  `CREATE TABLE IF NOT EXISTS shared_skill_packs (
    source_id TEXT NOT NULL, source_incarnation UUID NOT NULL, pack_id TEXT NOT NULL,
    revision UUID NOT NULL, manifest JSONB NOT NULL, manifest_hash TEXT NOT NULL,
    PRIMARY KEY(source_id,source_incarnation),
    UNIQUE(source_id,source_incarnation,pack_id)
  )`,
  `CREATE TABLE IF NOT EXISTS shared_skill_policy_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_id TEXT NOT NULL, source_incarnation UUID NOT NULL,
    principal_kind TEXT NOT NULL, principal_id TEXT NOT NULL, previous_epoch TEXT NOT NULL,
    epoch UUID NOT NULL, policy JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS shared_skill_policy_audit_source_idx ON shared_skill_policy_audit(source_id,source_incarnation,created_at)`,
  `CREATE TABLE IF NOT EXISTS shared_skill_heads (
    source_id TEXT NOT NULL, source_incarnation UUID NOT NULL, pack_id TEXT NOT NULL, name TEXT NOT NULL,
    revision UUID NOT NULL, metadata JSONB NOT NULL, deleted BOOLEAN NOT NULL DEFAULT false,
    policy_epoch TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(source_id,source_incarnation,pack_id,name)
  )`,
  `CREATE TABLE IF NOT EXISTS shared_skill_revisions (
    source_id TEXT NOT NULL, source_incarnation UUID NOT NULL, pack_id TEXT NOT NULL, name TEXT NOT NULL,
    revision UUID NOT NULL, metadata JSONB NOT NULL, files JSONB NOT NULL,
    deleted BOOLEAN NOT NULL DEFAULT false, policy_epoch TEXT NOT NULL,
    request_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    stored_bytes BIGINT GENERATED ALWAYS AS (octet_length(files::text)+octet_length(metadata::text)) STORED,
    PRIMARY KEY(source_id,source_incarnation,pack_id,name,revision)
  )`,
  `CREATE INDEX IF NOT EXISTS shared_skill_revision_request_idx ON shared_skill_revisions(request_id)`,
  `CREATE INDEX IF NOT EXISTS shared_skill_heads_active_idx ON shared_skill_heads(source_id,source_incarnation,pack_id,name) WHERE NOT deleted`,
  `CREATE INDEX IF NOT EXISTS shared_skill_revision_retention_idx ON shared_skill_revisions(source_id,source_incarnation,name,created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS shared_skill_revision_uuid_idx ON shared_skill_revisions(revision)`,
  `CREATE TABLE IF NOT EXISTS shared_skill_revision_leases (
    lease_kind TEXT NOT NULL CHECK(lease_kind IN ('delivery','pin')), lease_id UUID NOT NULL,
    source_id TEXT NOT NULL, source_incarnation UUID NOT NULL, pack_id TEXT NOT NULL, name TEXT NOT NULL, revision UUID NOT NULL,
    principal_kind TEXT NOT NULL, principal_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(lease_kind,lease_id,source_id,source_incarnation,pack_id,name,revision),
    FOREIGN KEY(source_id,source_incarnation,pack_id,name,revision)
      REFERENCES shared_skill_revisions(source_id,source_incarnation,pack_id,name,revision) ON DELETE RESTRICT
  )`,
  `CREATE INDEX IF NOT EXISTS shared_skill_revision_lease_expiry_idx ON shared_skill_revision_leases(source_id,source_incarnation,expires_at)`,
  `CREATE INDEX IF NOT EXISTS shared_skill_revision_lease_target_idx ON shared_skill_revision_leases(source_id,source_incarnation,pack_id,name,revision,expires_at)`,
];

export const SHARED_SKILLS_DELIVERY_LEASE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE OR REPLACE FUNCTION gbrain_lease_shared_skill_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE item text; found_revision shared_skill_revisions%ROWTYPE; brain text;
  BEGIN
    SELECT brain_id::text INTO brain FROM persistence_brain WHERE singleton=1;
    FOR item IN SELECT value FROM jsonb_array_elements_text(NEW.revisions) ORDER BY value LOOP
      SELECT r.* INTO found_revision FROM shared_skill_revisions r
        WHERE r.revision::text=substring(item from '@([^@]+)$')
          AND item=brain || '/' || r.source_id || '/' || r.source_incarnation::text || '/' || r.pack_id || '/' || r.name || '@' || r.revision::text
        FOR KEY SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'revision_unavailable: delivery revision is no longer retained' USING ERRCODE='23503'; END IF;
      INSERT INTO shared_skill_revision_leases(lease_kind,lease_id,source_id,source_incarnation,pack_id,name,revision,principal_kind,principal_id,expires_at)
        VALUES('delivery',found_revision.revision,found_revision.source_id,found_revision.source_incarnation,found_revision.pack_id,found_revision.name,found_revision.revision,
          'application','delivery',LEAST(NEW.issued_at+interval '24 hours',now()+interval '24 hours'))
        ON CONFLICT(lease_kind,lease_id,source_id,source_incarnation,pack_id,name,revision)
          DO UPDATE SET expires_at=GREATEST(shared_skill_revision_leases.expires_at,excluded.expires_at);
    END LOOP;
    RETURN NEW;
  END $$`,
  `DROP TRIGGER IF EXISTS shared_skill_delivery_lease ON shared_skill_delivery_batches`,
  `CREATE TRIGGER shared_skill_delivery_lease AFTER INSERT OR UPDATE OF revisions ON shared_skill_delivery_batches
    FOR EACH ROW EXECUTE FUNCTION gbrain_lease_shared_skill_delivery()`,
];
