-- 0002_confer_epistemology.sql
-- Confer fork extension. Additive only. Per spec §6.4.
--
-- Adds:
--   take_proposals.world_consensus  - cached value of confer_world_consensus VIEW (refreshed nightly)
--   take_proposals.relayed_by       - distinct from upstream's acted_by; tracks Sherpa-style relay
--   pages.schema_pack_version       - which pack version typed this page (shadow-eval delta)
--
-- Does NOT add claim_genealogy table - lineage uses upstream's links primitive
-- with new link_types (refined_from / contradicted_by / escalated_from), declared
-- in the confer-everything-v1 pack, not in SQL.

ALTER TABLE take_proposals
  ADD COLUMN IF NOT EXISTS world_consensus REAL DEFAULT 0.0
  CHECK (world_consensus BETWEEN 0 AND 1);

ALTER TABLE take_proposals
  ADD COLUMN IF NOT EXISTS relayed_by TEXT;

COMMENT ON COLUMN take_proposals.relayed_by IS
  'Confer fork extension. Set when the agent that wrote the row is not the principal claim-holder. Distinct from acted_by. See spec section 6.4 + section 5 row 5.';

ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS schema_pack_version TEXT;

CREATE INDEX IF NOT EXISTS pages_pack_version_idx ON pages(schema_pack_version);
