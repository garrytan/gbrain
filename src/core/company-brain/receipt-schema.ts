export const SOURCE_INGESTION_RECEIPTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS source_ingestion_receipts (
  id uuid PRIMARY KEY,
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_incarnation uuid NOT NULL REFERENCES sources(incarnation) ON DELETE CASCADE,
  approved_revision text NOT NULL CHECK (approved_revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  profile text NOT NULL CHECK (length(profile) BETWEEN 1 AND 128),
  schema_fingerprint text NOT NULL CHECK (schema_fingerprint ~ '^[a-f0-9]{64}$'),
  extractor_version text NOT NULL CHECK (length(extractor_version) BETWEEN 1 AND 128),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  phase text NOT NULL DEFAULT 'ADMITTED' CHECK (phase IN ('ADMITTED','CONTENT','GRAPH','VERIFY','COMPLETE')),
  outcome text NOT NULL DEFAULT 'incomplete' CHECK (outcome IN ('incomplete','complete','discarded')),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object' AND octet_length(counts::text) <= 4096),
  lifecycle_request_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(lifecycle_request_ids) <= 128),
  checkpoint_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checkpoint_refs) = 'array' AND jsonb_array_length(checkpoint_refs) <= 32 AND octet_length(checkpoint_refs::text) <= 16384),
  diagnostic text CHECK (diagnostic IN ('interrupted','content_incomplete','graph_incomplete','verification_failed','pending_writes','source_changed','checkpoint_missing','operation_failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  discarded_at timestamptz,
  CHECK ((phase = 'COMPLETE') = (outcome = 'complete')),
  CHECK ((completed_at IS NOT NULL) = (outcome = 'complete')),
  CHECK ((discarded_at IS NOT NULL) = (outcome = 'discarded'))
);
ALTER TABLE source_ingestion_receipts ADD COLUMN IF NOT EXISTS policy_fingerprint text
  CHECK (policy_fingerprint ~ '^[a-f0-9]{64}$');
CREATE INDEX IF NOT EXISTS source_ingestion_receipts_source
  ON source_ingestion_receipts(source_id, source_incarnation, created_at DESC);
CREATE INDEX IF NOT EXISTS source_ingestion_receipts_retention
  ON source_ingestion_receipts(source_id, source_incarnation, completed_at DESC, id DESC) WHERE outcome = 'complete';
CREATE INDEX IF NOT EXISTS source_ingestion_receipts_active
  ON source_ingestion_receipts(id) WHERE outcome = 'incomplete';
`;
