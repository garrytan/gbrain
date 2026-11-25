/**
 * What the broker's `call` op accepts: Google's published /mcp/v1 tools for
 * each served product (Chat is not served), argument rules on the tools that
 * notify or reach other people, and the per-turn safety pauses (W-D1). Tool
 * names come from the live servers' tools/list (step 0 probe, 2026-11-25).
 */
import type { GoogleServer } from './protocol.ts';
import { SocketError } from './protocol.ts';

export const BROKER_ALLOWLIST: Record<GoogleServer, readonly string[]> = {
  gmail: ['create_draft', 'list_drafts', 'get_draft', 'get_thread', 'get_message', 'search_threads', 'label_thread', 'unlabel_thread',
    'apply_sensitive_thread_label', 'trash_thread', 'untrash_thread', 'mark_thread_spam', 'unmark_thread_spam', 'list_labels', 'label_message',
    'update_message_labels', 'unlabel_message', 'apply_sensitive_message_label', 'trash_message', 'untrash_message', 'mark_message_spam',
    'unmark_message_spam', 'create_label'],
  calendar: ['list_events', 'get_event', 'list_calendars', 'suggest_time', 'create_event', 'update_event', 'delete_event', 'respond_to_event', 'search_events'],
  drive: ['copy_file', 'create_file', 'download_file_content', 'get_file_metadata', 'get_file_permissions', 'list_recent_files', 'read_file_content',
    'search_files', 'upload_file_revision'],
  docs: ['read_doc', 'update_doc'],
  sheets: ['get_values', 'get_spreadsheet', 'update_spreadsheet', 'update_values', 'update_formulas', 'insert_dimension'],
  slides: ['read_presentation', 'read_slide_page', 'read_slide_page_thumbnail', 'update_presentation'],
  tasks: ['list_task_lists', 'list_tasks', 'get_task', 'create_task', 'update_task', 'delete_task', 'undelete_task', 'complete_task', 'uncomplete_task'],
};

export const MAX_DRAFT_RECIPIENTS = 20;
export const TURN_CALL_CAP = 25;
export const DAY_CALL_CAP = 1500;
/** The trash in a turn that pauses for the owner (the 11th). */
export const TRASH_PAUSE_AT = 11;
/** The outside address in a turn that pauses for the owner (the 2nd). */
export const OUTSIDE_PAUSE_AT = 2;

const CALENDAR_NOTIFYING = new Set(['create_event', 'update_event', 'delete_event', 'respond_to_event']);
const TRASHING: Record<string, ReadonlySet<string>> = {
  gmail: new Set(['trash_thread', 'trash_message']),
  calendar: new Set(['delete_event']),
  tasks: new Set(['delete_task']),
};

export function isAllowedTool(server: GoogleServer, tool: string): boolean {
  return BROKER_ALLOWLIST[server].includes(tool);
}

function addresses(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  if (Array.isArray(value)) {
    return value.flatMap(v => (typeof v === 'string' ? addresses(v) : typeof v === 'object' && v && typeof (v as { email?: unknown }).email === 'string' ? [(v as { email: string }).email] : []));
  }
  return [];
}

const bare = (address: string): string => (address.match(/<([^>]+)>/)?.[1] ?? address).trim().toLowerCase();
const domainOf = (address: string): string => bare(address).split('@').pop()!;
/** Public mail domains have no inside: every address but the account's own is outside. */
const PUBLIC_MAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'icloud.com', 'yahoo.com', 'outlook.com', 'hotmail.com']);

/** The invitee addresses a calendar write would add that count toward the outside-invite pause. */
export function outsideInvitees(account: string, server: GoogleServer, tool: string, args: Record<string, unknown>): string[] {
  if (server !== 'calendar') return [];
  const invited = tool === 'create_event' ? [...addresses(args.attendees), ...addresses(args.attendeeEmails)]
    : tool === 'update_event' ? [...addresses(args.addedAttendees), ...addresses(args.addedAttendeeEmails)] : [];
  const self = bare(account);
  const home = domainOf(account);
  return invited.filter(a => (PUBLIC_MAIL_DOMAINS.has(home) ? bare(a) !== self : domainOf(a) !== home));
}

export interface CallEffects {
  /** Arguments as sent upstream (calendar notification forced to NONE). */
  args: Record<string, unknown>;
  /** Addresses outside the account's domain this call invites or shares with. */
  outside: number;
  trash: boolean;
}

/** Applies the argument rules: returns the arguments to send, or throws broker_args_refused / tool_not_allowed. */
export function applyArgumentRules(account: string, server: GoogleServer, tool: string, args: Record<string, unknown>): CallEffects {
  if (!isAllowedTool(server, tool)) throw new SocketError('tool_not_allowed', `${server}.${tool} is not on the broker's allowlist`);
  const out: Record<string, unknown> = { ...args };
  let outside = 0;
  if (server === 'calendar' && CALENDAR_NOTIFYING.has(tool)) {
    if (out.notificationLevel !== undefined && out.notificationLevel !== 'NONE') {
      throw new SocketError('broker_args_refused', `calendar.${tool} sends no email from the broker: notificationLevel must be NONE or absent (got ${JSON.stringify(out.notificationLevel)})`, { field: 'notificationLevel' });
    }
    out.notificationLevel = 'NONE';
    outside = outsideInvitees(account, server, tool, out).length;
  }
  if (server === 'gmail' && tool === 'create_draft') {
    const recipients = [...addresses(out.to), ...addresses(out.cc), ...addresses(out.bcc)];
    if (recipients.length > MAX_DRAFT_RECIPIENTS) {
      throw new SocketError('broker_args_refused', `gmail.create_draft is capped at ${MAX_DRAFT_RECIPIENTS} recipients (got ${recipients.length})`, { field: 'to' });
    }
  }
  return { args: out, outside, trash: TRASHING[server]?.has(tool) ?? false };
}
