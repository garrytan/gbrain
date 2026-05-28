-- Down migration for 0002_confer_epistemology.
DROP INDEX IF EXISTS pages_pack_version_idx;
ALTER TABLE pages           DROP COLUMN IF EXISTS schema_pack_version;
ALTER TABLE take_proposals  DROP COLUMN IF EXISTS relayed_by;
ALTER TABLE take_proposals  DROP COLUMN IF EXISTS world_consensus;
