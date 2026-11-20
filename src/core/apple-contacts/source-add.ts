/** `sources add --kind apple-contacts`: the registered config. Never a token: only the path of the file that holds it. */
import { SYNC_INTERVAL_MIN_FLOOR } from '../meetings/types.ts';
import type { MeetingsRecordChoice } from '../meetings/source-add.ts';
import { APPLE_CONTACTS_DEFAULT_DIR, APPLE_CONTACTS_DEFAULT_PORT, APPLE_CONTACTS_KIND } from './types.ts';

export interface AddSourceAppleContactsOpts {
  helperHost: string;
  helperPort?: number;
  proxy?: string;
  tokenFile: string;
  contactsDir?: string;
  record: 'auto' | 'git' | 'database';
  dir?: string;
  syncIntervalMin?: number;
}

/**
 * The `sources.config` a new apple-contacts source is registered with. The source is owner-only (access/owner-only.ts):
 * only the trusted local CLI and the owner's own credentials read its pages. It joins unqualified reads unless
 * --no-federated, so "what is Alice's number?" finds the contact page.
 */
export function appleContactsSourceConfig(opts: AddSourceAppleContactsOpts, choice: MeetingsRecordChoice, federated: boolean | null | undefined, managed = false): Record<string, unknown> {
  return {
    kind: APPLE_CONTACTS_KIND,
    ac_helper_host: opts.helperHost,
    ...(opts.helperPort !== undefined && opts.helperPort !== APPLE_CONTACTS_DEFAULT_PORT ? { ac_helper_port: opts.helperPort } : {}),
    ...(opts.proxy ? { ac_proxy: opts.proxy } : {}),
    ac_token_file: opts.tokenFile,
    ...(opts.contactsDir && opts.contactsDir !== APPLE_CONTACTS_DEFAULT_DIR ? { ac_contacts_dir: opts.contactsDir } : {}),
    ac_record: choice.record,
    ...(choice.dir ? { ac_dir: choice.dir } : {}),
    ...(opts.syncIntervalMin !== undefined ? { sync_interval_min: Math.max(SYNC_INTERVAL_MIN_FLOOR, opts.syncIntervalMin) } : {}),
    owner_only: true,
    federated: federated ?? true,
    // A managed Git-recorded source is strict, so its private contact pages are never committed.
    ...(managed && choice.record === 'git' ? { canonical: 'git' } : {}),
  };
}
