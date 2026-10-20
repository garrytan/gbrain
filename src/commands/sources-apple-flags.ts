/**
 * `sources add --kind apple` flag validation (#6855), shared by the legacy
 * parser (sources.ts, exit 2) and the connected-source parser
 * (sources-lifecycle-args.ts, operation contract) so both accept exactly the
 * same values. Pure: no engine, no filesystem, no platform probe.
 *
 * Privacy posture: an unknown or empty `--services` entry is a coded error,
 * never "all services" (Mail and Contacts are private local data).
 */
import {
  APPLE_DEFAULT_ACCOUNT,
  APPLE_FUTURE_DAYS_MAX,
  APPLE_HISTORY_DAYS_MAX,
  APPLE_MAIL_DAYS_MAX,
  parseContactsDir,
  parseOwnerAddresses,
} from '../core/apple/source-config.ts';
import { ALL_APPLE_SERVICES, type AppleService } from '../core/apple/types.ts';
import type { AppleAddOptions } from '../core/apple/source-add-config.ts';

/** Flags that configure an apple source and are meaningless on any other kind. */
export const APPLE_ONLY_FLAGS = ['calendar-ids', 'mail-mailboxes', 'mail-days', 'mail-owner-addresses'] as const;
/** Boolean flag: explicit consent to read Mail (the most sensitive service). */
export const APPLE_CONFIRM_MAIL_FLAG = 'confirm-mail';
/** Boolean flag: explicit consent to send Mail thread text to the configured chat provider for commitment/decision extraction. */
export const APPLE_EXTRACT_CONSENT_FLAG = 'consent-loops-extraction';
/** Services a bare `sources add --kind apple` enables: Mail is never in the default. */
export const APPLE_DEFAULT_ADD_SERVICES: readonly AppleService[] = ['calendar', 'contacts'];
/** Flags google and apple share (each kind validates them its own way). */
export const APPLE_SHARED_FLAGS = ['account', 'services', 'history-days', 'future-days', 'contacts-dir'] as const;

export class AppleAddFlagError extends Error {
  constructor(public code: 'unknown_service' | 'empty_services' | 'invalid_value' | 'mail_confirmation_required' | 'extraction_consent_requires_identity', message: string, public suggestion: string) {
    super(message);
    this.name = 'AppleAddFlagError';
  }
}

export interface AppleAddRaw {
  services?: string;
  account?: string;
  historyDays?: string | number;
  futureDays?: string | number;
  calendarIds?: string;
  contactsDir?: string;
  mailMailboxes?: string;
  mailDays?: string | number;
  /** `--mail-owner-addresses a@x,b@y`: the mailbox owner's addresses (open-loop direction). */
  mailOwnerAddresses?: string;
  /** `--consent-loops-extraction`: the owner agreed Mail text may go to the chat provider for extraction. */
  loopsExtractConsent?: boolean;
  /** `--confirm-mail` (or setup's own confirmation): required for any source that includes Mail. */
  confirmMail?: boolean;
  dir: string;
}

const CALENDAR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:%+#@/=-]{0,254}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function tokens(raw: string): string[] {
  return [...new Set(raw.split(',').map((t) => t.trim()).filter(Boolean))];
}

function boundedInt(flag: string, raw: string | number, max: number): number {
  const n = typeof raw === 'number' ? raw : /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new AppleAddFlagError('invalid_value', `--${flag} must be a whole number between 1 and ${max}.`,
      `Pass --${flag} as a whole number of days from 1 to ${max}.`);
  }
  return n;
}

/** The services a `--services` csv names, validated. */
export function parseAppleServicesFlag(raw: string): AppleService[] {
  const parts = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) {
    throw new AppleAddFlagError('empty_services', '--services needs at least one service.',
      `Pass --services as a comma-separated subset of ${ALL_APPLE_SERVICES.join(',')}, or omit it for the default (calendar,contacts; Mail needs explicit consent).`);
  }
  const bad = parts.filter((p) => !(ALL_APPLE_SERVICES as readonly string[]).includes(p));
  if (bad.length > 0) {
    throw new AppleAddFlagError('unknown_service', `Unknown Apple service: ${bad.join(', ')}.`,
      `Valid services are ${ALL_APPLE_SERVICES.join(', ')}. Nothing was registered; an unknown name is never widened to "all services".`);
  }
  const uniq = new Set(parts);
  return ALL_APPLE_SERVICES.filter((s) => uniq.has(s));
}

/** Validate raw flag values into the typed `AddSourceOpts.apple` payload. */
export function buildAppleAddOptions(raw: AppleAddRaw): AppleAddOptions {
  const services = raw.services === undefined ? [...APPLE_DEFAULT_ADD_SERVICES] : parseAppleServicesFlag(raw.services);
  if (services.includes('mail') && raw.confirmMail !== true) throw mailConfirmationRequired('--services');
  const account = raw.account === undefined ? undefined : raw.account.trim().replace(/\s+/g, ' ');
  if (account !== undefined && (account.length === 0 || account.length > 64 || CONTROL_RE.test(account))) {
    throw new AppleAddFlagError('invalid_value', '--account must be a short label (1-64 printable characters).',
      `Pass --account as a free-form label such as "personal"; it names the Apple account on this Mac and defaults to "${APPLE_DEFAULT_ACCOUNT}". It is never a credential.`);
  }
  const opts: AppleAddOptions = { services, dir: raw.dir };
  if (account !== undefined) opts.account = account;
  if (raw.historyDays !== undefined) opts.historyDays = boundedInt('history-days', raw.historyDays, APPLE_HISTORY_DAYS_MAX);
  if (raw.futureDays !== undefined) opts.futureDays = boundedInt('future-days', raw.futureDays, APPLE_FUTURE_DAYS_MAX);
  if (raw.mailDays !== undefined) opts.mailDays = boundedInt('mail-days', raw.mailDays, APPLE_MAIL_DAYS_MAX);
  if (raw.calendarIds !== undefined) {
    const ids = tokens(raw.calendarIds);
    if (ids.length === 0 || ids.some((id) => !CALENDAR_ID_RE.test(id))) {
      throw new AppleAddFlagError('invalid_value', '--calendar-ids needs a comma-separated list of calendar ids.',
        'List calendar ids with: gbrain apple services <source> after setup, or omit --calendar-ids to sync every calendar.');
    }
    opts.calendarIds = ids;
  }
  if (raw.contactsDir !== undefined) {
    const dir = parseContactsDir(raw.contactsDir);
    if (!dir) {
      throw new AppleAddFlagError('invalid_value', '--contacts-dir must be a relative directory of lower-case segments.',
        'Pass --contacts-dir as one or more segments of a-z, 0-9, - and _ (e.g. --contacts-dir contacts); it is relative to the source directory.');
    }
    opts.contactsDir = dir;
  }
  if (raw.mailOwnerAddresses !== undefined) {
    const owners = parseOwnerAddresses(raw.mailOwnerAddresses);
    const wanted = raw.mailOwnerAddresses.split(',').map((t) => t.trim()).filter(Boolean);
    if (owners.length === 0 || owners.length !== new Set(wanted.map((t) => t.toLowerCase())).size) {
      throw new AppleAddFlagError('invalid_value', '--mail-owner-addresses needs a comma-separated list of bare email addresses (at most 20).',
        'Pass the addresses (and aliases) you send mail from, e.g. --mail-owner-addresses me@example.com,me-alias@example.com. They decide which messages are yours for unanswered-mail tracking; the account label and the Sent mailbox are never used.');
    }
    opts.mailOwnerAddresses = owners;
  }
  if (raw.loopsExtractConsent === true) {
    if (!services.includes('mail')) {
      throw new AppleAddFlagError('invalid_value', '--consent-loops-extraction applies to Mail, which this source does not include.', 'Add mail to --services (with --confirm-mail), or remove --consent-loops-extraction.');
    }
    if (!opts.mailOwnerAddresses || opts.mailOwnerAddresses.length === 0) {
      throw new AppleAddFlagError('extraction_consent_requires_identity', 'Extraction consent needs --mail-owner-addresses: without the owner identity no thread is judged.',
        'Pass --mail-owner-addresses with your addresses together with --consent-loops-extraction.');
    }
    opts.loopsExtractConsent = true;
  }
  if (raw.mailMailboxes !== undefined) {
    const boxes = tokens(raw.mailMailboxes);
    if (boxes.length === 0 || boxes.some((b) => b.length > 128 || CONTROL_RE.test(b))) {
      throw new AppleAddFlagError('invalid_value', '--mail-mailboxes needs a comma-separated list of mailbox names.',
        'Pass --mail-mailboxes as names such as INBOX,Sent (the default); a name with spaces is allowed.');
    }
    opts.mailMailboxes = boxes;
  }
  return opts;
}

/**
 * Mail is the most sensitive service. Including it takes BOTH an explicit `mail` in the services list and
 * `--confirm-mail`, so no default, typo or copy-paste turns it on by accident.
 */
export function mailConfirmationRequired(via: '--services' | 'set-services'): AppleAddFlagError {
  return new AppleAddFlagError('mail_confirmation_required',
    'Mail needs an explicit confirmation: it is the most sensitive Apple service.',
    `gbrain will read the subject, sender, recipients, date and plain-text body of recent messages from Mail.app and store them as pages in your brain (attachments are never downloaded). Mail accounts hosted by Google (Gmail, Google Workspace) are never read through Apple Mail: connect them with: gbrain google setup. An account whose provider cannot be determined stops the whole Mail sync instead. Nothing is sent to an AI provider unless you separately pass --consent-loops-extraction (with --mail-owner-addresses): that sends Mail thread text to the chat provider configured for this brain. `
    + (via === '--services'
      ? 'If the user agrees, add --confirm-mail to the same command (and keep mail in --services).'
      : 'If the user agrees, re-run with --confirm-mail.')
    + ' Without Mail: --services calendar,contacts.');
}

/** A warning (never a refusal): registering on a non-macOS host works, syncing will not. */
export function appleAddPlatformWarning(platform: string = process.platform): string | null {
  return platform === 'darwin' ? null
    : 'Warning: the Apple connector reads Calendar, Contacts and Mail through macOS and only syncs on a Mac. This source is registered, but a sync on this host will report unsupported_platform.';
}
