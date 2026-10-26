import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); the fresh-install
// copy in src/schema.sql carries the same table.
//
// Wave C 1E (large pages, streaming reads and exports): a short-lived read pin
// per paged read or export of a segmented page (src/core/page-body/read-pins.ts).
// A live pin is a GC root for its body generation, like a retained version, so
// an append mid-read never collects the generation a reader is paging; it also
// records the rendered view the read is bound to (view_key: head, metadata and
// overlay identity) and that view's size and sha256. Hashes and sizes only, no
// page text. Rows expire (expires_at) and go with their page (ON DELETE
// CASCADE). DDL only, nothing to backfill. RLS is enabled here (under a role
// that bypasses it), since `gbrain apply-migrations --yes` never replays the
// schema blob's RLS block (v275).
export const v276: Migration = {
  version: 276,
  name: 'page_read_pins',
  idempotent: true,
  sql: `
    CREATE TABLE IF NOT EXISTS page_read_pins (
      token TEXT PRIMARY KEY,
      page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      body_generation BIGINT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('read','export')),
      audience TEXT NOT NULL CHECK (audience IN ('trusted','remote')),
      view TEXT CHECK (view IN ('read','markdown')),
      view_key TEXT,
      principal TEXT,
      revision TEXT NOT NULL,
      total_bytes BIGINT CHECK (total_bytes >= 0),
      total_lines BIGINT CHECK (total_lines >= 0),
      sha256 TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS page_read_pins_generation ON page_read_pins (page_id, body_generation);
    DO $rls$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
        ALTER TABLE page_read_pins ENABLE ROW LEVEL SECURITY;
      END IF;
    END $rls$;
  `,
};
