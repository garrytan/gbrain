/**
 * Types for the whitelist-gated local macOS WhatsApp Desktop collector.
 *
 * Privacy contract:
 * - Zero pages are created for any contact until explicitly added to the whitelist.
 * - ChatStorage.sqlite is opened strictly read-only.
 * - Every ingested page is stamped `visibility: private` and `source_kind: whatsapp`.
 */

export interface WhatsAppWhitelistEntry {
  jid: string;
  name: string;
  slug: string;
  category: string;
  added_at: string;
}

export interface WhatsAppWhitelistFile {
  schema_version: string;
  policy: 'explicit_whitelist_only';
  contacts: WhatsAppWhitelistEntry[];
}

export interface WhatsAppCandidate {
  jid: string;
  name: string;
  is_group: boolean;
  message_count: number;
  last_message: string;
  slug: string;
  whitelisted: boolean;
  category: string;
}

export interface WhatsAppMessage {
  id: number;
  timestampIso: string;
  fromMe: boolean;
  text: string;
}

export interface WhatsAppSyncItem {
  jid: string;
  name: string;
  slug: string;
  messages: number;
  source_slug: string;
  person_slug: string;
  person_created: boolean;
  timeline_added: boolean;
  skipped: boolean;
}

export interface WhatsAppSyncResult {
  dry_run: boolean;
  source_id: string;
  whitelisted_count: number;
  synced: WhatsAppSyncItem[];
  skipped: Array<{ jid: string; name: string; reason: string }>;
}
