-- Down migration: drop Confer source-isolation policies.
-- Leaves upstream's ENABLE/FORCE RLS state unchanged (we never altered it).

DROP POLICY IF EXISTS confer_source_isolation_pages          ON pages;
DROP POLICY IF EXISTS confer_source_isolation_content_chunks ON content_chunks;
DROP POLICY IF EXISTS confer_source_isolation_links          ON links;
DROP POLICY IF EXISTS confer_source_isolation_take_proposals ON take_proposals;
