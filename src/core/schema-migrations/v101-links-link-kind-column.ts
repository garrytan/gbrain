import type { Migration } from './types.ts';

export const v101: Migration = {
  version: 101,
  name: 'links_link_kind_column',
  // v0.41.18.0 (gbrain onboard wave, A10 + codex finding #12):
  // NER link extraction adds a nullable link_kind column instead of
  // splitting link_source='ner' as a new provenance — keeps
  // backlink-count + orphan-ratio queries stable while letting
  // NER-aware callers distinguish typed links.
  //
  // Three kinds: 'plain' | 'typed_ner' | NULL (legacy, semantically plain).
  // NOT in the links UNIQUE constraint so a plain-mention row coexists
  // with future typed_ner promotions via explicit ON CONFLICT DO UPDATE.
  //
  // Slot history: originally v98, bumped to v101 after master merge
  // claimed v98 (lock-refresh) + v99 (conversation parser cache) +
  // v100 (per master's own merges).
  sql: `
      ALTER TABLE links ADD COLUMN IF NOT EXISTS link_kind TEXT
        CHECK (link_kind IS NULL OR link_kind IN ('plain', 'typed_ner'));
    `,
  sqlFor: {
    pglite: `
        ALTER TABLE links ADD COLUMN IF NOT EXISTS link_kind TEXT
          CHECK (link_kind IS NULL OR link_kind IN ('plain', 'typed_ner'));
      `,
  },
};
