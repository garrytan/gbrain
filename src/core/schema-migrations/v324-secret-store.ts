import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-2988: the secret store (src/core/secret-store/). A redaction keeps the original value here, encrypted with
// AES-256-GCM under a key that never enters the database (secret-store/keyring.ts); the page keeps the marker
// `<REDACTED:<rule>:<id>>`. secret_store holds one row per (source, value): value_mac is an HMAC under a key derived
// from the store key, never a bare hash, so a short value cannot be guessed from the row; key_id and key_host say
// which key sealed it and on which host, so doctor and the push path can tell when two hosts sharing one database use
// different keys. secret_store_occurrence records each place the redactor put a marker; reveal and restore act only at
// a recorded occurrence, so a marker pasted anywhere else binds to nothing. Database only, so a repo-less brain gets
// it unchanged. Nothing is written on upgrade. No schema.sql mirror, like v307: it exists only through migrations.
// Provisional number: confirmed at landing.
export const v324: Migration = {
  version: 324,
  name: 'secret_store',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS secret_store (
  id TEXT PRIMARY KEY CHECK (id ~ '^ss_[0-9a-f]{12}$'),
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  rule TEXT NOT NULL CHECK (rule ~ '^[a-z0-9_]{1,64}$'),
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  tag TEXT NOT NULL,
  key_id TEXT NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),
  key_host TEXT NOT NULL DEFAULT '',
  value_mac TEXT NOT NULL CHECK (value_mac ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'allowed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, value_mac)
);
CREATE TABLE IF NOT EXISTS secret_store_occurrence (
  id BIGSERIAL PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES secret_store(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  slug TEXT,
  field TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('repair', 'publish_rebuild', 'transcript', 'archive', 'capture')),
  commit_sha TEXT,
  path TEXT,
  line INTEGER,
  pre_field_sha256 TEXT CHECK (pre_field_sha256 IS NULL OR pre_field_sha256 ~ '^[0-9a-f]{64}$'),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS secret_store_occurrence_entry_idx ON secret_store_occurrence (entry_id);
CREATE INDEX IF NOT EXISTS secret_store_occurrence_page_idx ON secret_store_occurrence (source_id, slug);
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE secret_store ENABLE ROW LEVEL SECURITY;
    ALTER TABLE secret_store_occurrence ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
