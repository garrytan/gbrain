-- 0004_confer_source_config_keys.sql
-- Per spec §6.5 + audit finding T13: declare Confer-reserved JSONB keys
-- inside the existing sources.config column. No new column - pure
-- documentation via COMMENT ON COLUMN. Provides single source of truth
-- for which keys are meaningful in Confer's deployment.

COMMENT ON COLUMN sources.config IS
'JSONB config blob. Confer-reserved keys (additive to upstream gbrain keys):
- tier_weight (REAL 0..1) - source-tier weighting for confer_world_consensus view. Default 0.5 if unset. Higher = more authoritative.
- allowed_judges (TEXT[]) - which cross-modal eval judges may receive payloads from this source. Per spec section 6.5 tenant firewall. Default [claude-4.5-opus, gpt-5.5] for tenant sources.
- ingest_adapter (TEXT) - name of the gbrain ingestion adapter for this source (gstack-learnings | inbox-folder | markdown-greenfield | file-watcher). See spec section 15.2.
Upstream gbrain may add its own keys; Confer keys are NAMESPACED via this comment.';
