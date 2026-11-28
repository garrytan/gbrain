/**
 * Types for the whitelist-gated LinkedIn Data Export collector.
 *
 * Privacy contract:
 * - Zero pages are created for any LinkedIn contact until explicitly whitelisted.
 * - Bulk raw CSVs remain in the local export folder (outside Git).
 * - Every ingested contact source page carries `visibility: private` and `source_kind: linkedin`.
 * - User's own published posts (`Shares.csv`) are preserved verbatim in `originals/linkedin-posts`.
 */

export interface LinkedInConnection {
  key: string;
  name: string;
  url: string;
  email: string;
  company: string;
  position: string;
  connected_on: string;
}

export interface LinkedInMessage {
  conversation_id: string;
  date: string;
  from: string;
  from_url: string;
  to: string;
  to_url: string;
  subject: string;
  content: string;
  other_key: string;
  other_name: string;
  other_url: string;
  from_owner: boolean;
}

export interface LinkedInShare {
  date: string;
  share_link: string;
  commentary: string;
  shared_url: string;
  visibility: string;
}

export interface LinkedInWhitelistEntry {
  key: string;
  name: string;
  url: string;
  slug: string;
  category: string;
  added_at: string;
}

export interface LinkedInWhitelistFile {
  schema_version: string;
  policy: 'explicit_whitelist_only';
  contacts: LinkedInWhitelistEntry[];
}

export interface LinkedInCandidate {
  key: string;
  name: string;
  url: string;
  email: string;
  company: string;
  position: string;
  connected_on: string;
  message_count: number;
  last_message: string;
  slug: string;
  whitelisted: boolean;
  category: string;
}

export interface LinkedInSyncItem {
  key: string;
  name: string;
  slug: string;
  messages: number;
  source_slug: string;
  person_slug: string;
  person_created: boolean;
  timeline_added: boolean;
  skipped: boolean;
}

export interface LinkedInSyncResult {
  dry_run: boolean;
  source_id: string;
  whitelisted_count: number;
  synced: LinkedInSyncItem[];
  skipped: Array<{ key: string; name: string; reason: string }>;
}

export interface LinkedInPostsResult {
  ok: boolean;
  dry_run: boolean;
  source_id: string;
  post_count: number;
  source_slug: string;
  original_slug: string;
  skipped: boolean;
}
