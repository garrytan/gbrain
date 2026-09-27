export const SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS: readonly string[] = [
  `ALTER TABLE persistence_brain ADD COLUMN IF NOT EXISTS writer_protocol_floor integer NOT NULL DEFAULT 1 CHECK (writer_protocol_floor IN (1,2))`,
  `ALTER TABLE persistence_brain ADD COLUMN IF NOT EXISTS skill_bundles_enabled boolean NOT NULL DEFAULT false`,
  `ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS target_kind text NOT NULL DEFAULT 'page' CHECK (target_kind IN ('page','skill_bundle'))`,
  `ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS protocol_version integer NOT NULL DEFAULT 1 CHECK (protocol_version IN (1,2))`,
  `CREATE TABLE IF NOT EXISTS persistence_writer_protocols (
    worktree_id uuid NOT NULL REFERENCES persistence_worktrees(id),
    host_id uuid NOT NULL,
    owner_epoch bigint NOT NULL,
    protocol_version integer NOT NULL CHECK (protocol_version=2),
    registered_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(worktree_id,host_id)
  )`,
  `CREATE OR REPLACE FUNCTION gbrain_require_persistence_protocol(required integer) RETURNS void LANGUAGE plpgsql AS $$
  BEGIN
    IF required >= 2 AND COALESCE(current_setting('gbrain.persistence_protocol',true),'') <> '2' THEN
      RAISE EXCEPTION 'writer_upgrade_required: this mutation requires persistence protocol 2' USING ERRCODE='42501';
    END IF;
  END $$`,
  `CREATE OR REPLACE FUNCTION gbrain_guard_request_protocol() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE target text; version integer; floor integer; active boolean; record jsonb;
  BEGIN
    IF TG_OP='DELETE' THEN target:=OLD.target_kind; version:=OLD.protocol_version;
    ELSE target:=NEW.target_kind; version:=NEW.protocol_version; END IF;
    SELECT writer_protocol_floor,skill_bundles_enabled INTO floor,active FROM persistence_brain WHERE singleton=1 FOR SHARE;
    PERFORM gbrain_require_persistence_protocol(GREATEST(floor,version,CASE WHEN target='skill_bundle' THEN 2 ELSE 1 END));
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    IF TG_OP='UPDATE' AND (NEW.target_kind<>OLD.target_kind OR NEW.protocol_version<>OLD.protocol_version) THEN
      RAISE EXCEPTION 'unsupported_mutation_protocol: a request target is immutable' USING ERRCODE='42501';
    END IF;
    IF NEW.operation IN ('put_skill','delete_skill','adopt_skillpack') AND target<>'skill_bundle' THEN
      RAISE EXCEPTION 'unsupported_mutation_protocol: skill operations require a typed target' USING ERRCODE='42501';
    END IF;
    IF target='skill_bundle' THEN
      IF version<>2 OR NEW.page_id IS NOT NULL OR NEW.worktree_id IS NULL THEN
        RAISE EXCEPTION 'unsupported_mutation_protocol: invalid skill target' USING ERRCODE='42501';
      END IF;
      IF TG_OP='INSERT' AND NOT active THEN
        RAISE EXCEPTION 'writer_not_quiesced: shared publication is disabled' USING ERRCODE='42501';
      END IF;
      IF (TG_OP='INSERT' OR (NEW.state='running' AND OLD.state IS DISTINCT FROM 'running')) AND NOT EXISTS (SELECT 1 FROM persistence_worktrees w JOIN persistence_writer_protocols p
        ON p.worktree_id=w.id AND p.host_id=w.owner_host_id AND p.owner_epoch=w.owner_epoch AND p.protocol_version=2
        WHERE w.id=NEW.worktree_id AND w.state='active') THEN
        RAISE EXCEPTION 'writer_not_quiesced: canonical owner capability must be revalidated' USING ERRCODE='42501';
      END IF;
    ELSIF version<>1 THEN
      RAISE EXCEPTION 'unsupported_mutation_protocol: invalid page target' USING ERRCODE='42501';
    END IF;
    record:=NEW.recovery;
    IF record IS NOT NULL AND ((target='page' AND record->>'version' IS DISTINCT FROM '1')
      OR (target='skill_bundle' AND (record->>'version' IS DISTINCT FROM '2' OR record->>'target' IS DISTINCT FROM 'skill_bundle'
        OR jsonb_typeof(record->'files') IS DISTINCT FROM 'array'))) THEN
      RAISE EXCEPTION 'unsupported_mutation_protocol: recovery target mismatch' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END $$`,
  `DROP TRIGGER IF EXISTS gbrain_request_protocol ON persistence_requests`,
  `CREATE TRIGGER gbrain_request_protocol BEFORE INSERT OR UPDATE OR DELETE ON persistence_requests
    FOR EACH ROW EXECUTE FUNCTION gbrain_guard_request_protocol()`,
  `CREATE OR REPLACE FUNCTION gbrain_guard_effect_protocol() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE floor integer;
  BEGIN
    SELECT writer_protocol_floor INTO floor FROM persistence_brain WHERE singleton=1 FOR SHARE;
    PERFORM gbrain_require_persistence_protocol(floor);
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END $$`,
  `DROP TRIGGER IF EXISTS gbrain_effect_protocol ON persistence_effects`,
  `CREATE TRIGGER gbrain_effect_protocol BEFORE INSERT OR UPDATE OR DELETE ON persistence_effects
    FOR EACH ROW EXECUTE FUNCTION gbrain_guard_effect_protocol()`,
  `CREATE OR REPLACE FUNCTION gbrain_guard_protocol_activation() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.writer_protocol_floor<OLD.writer_protocol_floor THEN
      RAISE EXCEPTION 'writer_upgrade_required: the protocol floor cannot be lowered' USING ERRCODE='42501';
    END IF;
    IF NEW.writer_protocol_floor>OLD.writer_protocol_floor OR (NEW.skill_bundles_enabled AND NOT OLD.skill_bundles_enabled) THEN
      PERFORM gbrain_require_persistence_protocol(2);
      IF COALESCE(current_setting('gbrain.writer_quiesced',true),'')<>'true' OR NOT NEW.enabled OR NEW.writer_protocol_floor<>2
        OR EXISTS (SELECT 1 FROM persistence_requests WHERE state IN ('queued','running','recovering') OR recovery IS NOT NULL)
        OR EXISTS (SELECT 1 FROM persistence_effects WHERE state='running' OR recovery IS NOT NULL)
        OR EXISTS (SELECT 1 FROM persistence_worktrees w WHERE EXISTS
          (SELECT 1 FROM persistence_source_bindings b JOIN sources s ON s.id=b.source_id AND s.incarnation=b.source_incarnation
            WHERE b.worktree_id=w.id AND NOT s.archived) AND (w.state<>'active' OR NOT EXISTS
          (SELECT 1 FROM persistence_writer_protocols p WHERE p.worktree_id=w.id AND p.host_id=w.owner_host_id
            AND p.owner_epoch=w.owner_epoch AND p.protocol_version=2))) THEN
        RAISE EXCEPTION 'writer_not_quiesced: drain and verify all canonical owners before activation' USING ERRCODE='42501';
      END IF;
    END IF;
    RETURN NEW;
  END $$`,
  `DROP TRIGGER IF EXISTS gbrain_protocol_activation ON persistence_brain`,
  `CREATE TRIGGER gbrain_protocol_activation BEFORE UPDATE ON persistence_brain
    FOR EACH ROW EXECUTE FUNCTION gbrain_guard_protocol_activation()`,
  `CREATE OR REPLACE FUNCTION gbrain_guard_skill_publication() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE permitted jsonb;
  BEGIN
    PERFORM gbrain_require_persistence_protocol(2);
    IF NOT EXISTS (SELECT 1 FROM persistence_brain WHERE singleton=1 AND enabled AND skill_bundles_enabled AND writer_protocol_floor=2) THEN
      RAISE EXCEPTION 'writer_not_quiesced: shared publication is disabled' USING ERRCODE='42501';
    END IF;
    BEGIN permitted:=COALESCE(NULLIF(current_setting('gbrain.write_sources',true),''),'[]')::jsonb;
    EXCEPTION WHEN OTHERS THEN permitted:='[]'::jsonb; END;
    IF jsonb_typeof(permitted)<>'array'
      OR (TG_OP<>'INSERT' AND NOT permitted @> jsonb_build_array(OLD.source_id))
      OR (TG_OP<>'DELETE' AND NOT permitted @> jsonb_build_array(NEW.source_id)) THEN
      RAISE EXCEPTION 'writer_coordinator_required: canonical skill writes require a coordinated source capability' USING ERRCODE='42501';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END $$`,
];

export const SHARED_SKILLS_PUBLICATION_GUARD_STATEMENTS: readonly string[] = ['shared_skill_packs', 'shared_skill_heads', 'shared_skill_revisions']
  .flatMap(table => [
    `DROP TRIGGER IF EXISTS gbrain_skill_publication ON ${table}`,
    `CREATE TRIGGER gbrain_skill_publication BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION gbrain_guard_skill_publication()`,
  ]);
