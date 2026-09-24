/** Durable staging only; completed bytes live in the configured StorageBackend. */
export const ATTACHMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS attachment_uploads (
  id UUID PRIMARY KEY,
  owner_key TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 67108864),
  sha256 TEXT NOT NULL,
  storage_backend TEXT NOT NULL,
  storage_identity TEXT NOT NULL,
  storage_key UUID NOT NULL DEFAULT gen_random_uuid(),
  file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete', 'aborted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX IF NOT EXISTS attachment_uploads_owner ON attachment_uploads(owner_key, state);
CREATE INDEX IF NOT EXISTS attachment_uploads_expiry ON attachment_uploads(expires_at) WHERE state = 'pending';
CREATE TABLE IF NOT EXISTS attachment_chunks (
  upload_id UUID NOT NULL REFERENCES attachment_uploads(id) ON DELETE CASCADE,
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  data_base64 TEXT NOT NULL CHECK (length(data_base64) <= 349528),
  PRIMARY KEY (upload_id, byte_offset)
);
`;
