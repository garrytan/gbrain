export const SHARED_SKILLS_ACCESS_SCHEMA_SQL = `DO $$
DECLARE has_bypass boolean; target text;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'USAGE')
    AND (r.rolbypassrls OR r.rolsuper)) INTO has_bypass;
  IF has_bypass THEN
    FOREACH target IN ARRAY ARRAY['shared_skill_state','shared_skill_policies','shared_skill_packs',
      'shared_skill_policy_audit','shared_skill_heads','shared_skill_revisions','shared_skill_revision_leases',
      'shared_skill_members','shared_skill_delivery_batches','persistence_writer_protocols'] LOOP
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',target);
    END LOOP;
  END IF;
END $$;`;
