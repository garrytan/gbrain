/**
 * Apple reader errors (issue #6855). `types.ts` re-exports these; this file
 * must not import runtime values from `../types.ts` (cycle).
 */
export type AppleReaderService = 'calendar' | 'contacts' | 'mail';

export type AppleReaderErrorCode =
  | 'unsupported_platform'
  | 'permission_denied'
  | 'helper_failed'
  | 'helper_timeout'
  | 'malformed_output'
  | 'automation_denied'
  | 'mail_not_running_or_unconfigured'
  | 'permission_not_determined'
  | 'selection_not_found'
  | 'selection_ambiguous'
  | 'mail_routing_unknown'
  | 'mail_routing_changed'
  | 'macos_too_old';

export const APPLE_READER_ERROR_CODES: readonly AppleReaderErrorCode[] = [
  'unsupported_platform',
  'permission_denied',
  'helper_failed',
  'helper_timeout',
  'malformed_output',
  'automation_denied',
  'mail_not_running_or_unconfigured',
  'permission_not_determined',
  'selection_not_found',
  'selection_ambiguous',
  'mail_routing_unknown',
  'mail_routing_changed',
  'macos_too_old',
];

export class AppleReaderError extends Error {
  code: AppleReaderErrorCode;
  fix: string;
  service: AppleReaderService;

  constructor(code: AppleReaderErrorCode, service: AppleReaderService, message: string, fix: string) {
    super(message);
    this.name = 'AppleReaderError';
    this.code = code;
    this.service = service;
    this.fix = fix;
  }
}

export function isAppleReaderErrorCode(v: unknown): v is AppleReaderErrorCode {
  return typeof v === 'string' && (APPLE_READER_ERROR_CODES as readonly string[]).includes(v);
}

const SERVICE_LABEL: Record<AppleReaderService, string> = {
  calendar: 'Calendar',
  contacts: 'Contacts',
  mail: 'Mail',
};

/**
 * Actionable next step for each code. These are guidance strings based on
 * documented macOS behavior; they were not verified against a live TCC prompt.
 * Privacy panes live under System Settings > Privacy & Security.
 */
export function fixFor(code: AppleReaderErrorCode, service: AppleReaderService): string {
  switch (code) {
    case 'unsupported_platform':
      return 'The Apple connector reads Calendar, Contacts and Mail through macOS frameworks and only runs on macOS. Run this source on a Mac, or remove the apple source on this host.';
    case 'permission_denied': {
      if (service === 'mail') {
        return 'Grant access in System Settings > Privacy & Security > Automation (see automation_denied for Mail).';
      }
      const pane = service === 'calendar' ? 'Calendars (or Full Calendar Access)' : 'Contacts';
      return `Open System Settings > Privacy & Security > ${pane} and enable the app that runs gbrain (Terminal, iTerm, or the launcher/daemon host app), then retry. If the app is not listed, run the sync once from that app in an interactive session so macOS can prompt. If you previously denied it, reset with: tccutil reset ${service === 'calendar' ? 'Calendar' : 'AddressBook'} (all apps).`;
    }
    case 'permission_not_determined':
      return `macOS has not asked for ${SERVICE_LABEL[service]} access yet (not a denial). Run \`gbrain apple setup\` from an interactive session on the Mac (or \`gbrain sync --source <id>\` once) so macOS can show its permission prompt, then click Allow.`;
    case 'selection_not_found':
      return service === 'mail'
        ? 'A configured mailbox name matched no mailbox in Mail.app (INBOX and Sent must exist in EVERY account the Apple connector reads; any other name must exist in at least one), so the listing would be incomplete and nothing was read. Fix a_mail_mailboxes (names exactly as shown in Mail.app; a localized Sent folder needs its own name), then retry.'
        : 'A configured calendar id (a_calendar_ids) matched no calendar on this Mac, so the listing would be incomplete and nothing was read. Remove or correct that id, then retry.';
    case 'selection_ambiguous':
      return 'More than one mailbox in a single Mail account fits a role name (INBOX or Sent), and gbrain does not guess which one is meant. Name the exact mailbox in a_mail_mailboxes (names as shown in Mail.app), then retry.';
    case 'mail_routing_unknown':
      return 'Mail has an enabled account whose provider gbrain cannot tell apart from Google (an unreadable or Google-like-but-undocumented server name, or an account type it does not know), so the whole Mail sync was skipped and nothing was read. Disable or remove that account in Mail > Settings > Accounts, or opt Mail out: gbrain sources set-services <source> --remove mail. Calendar and Contacts are not affected.';
    case 'mail_routing_changed':
      return 'Mail\'s account setup changed while gbrain was reading (an account was added, removed, disabled, or its server changed). Nothing from that read was imported and your stored pages are untouched; run the sync again.';
    case 'macos_too_old':
      return 'The Calendar and Contacts helpers need macOS 14 (Sonoma) or newer with Xcode Command Line Tools 15 or newer. Update macOS and the tools (xcode-select --install, or Software Update), then retry.';
    case 'automation_denied':
      return 'Open System Settings > Privacy & Security > Automation, find the app that runs gbrain (Terminal, iTerm, or the launcher/daemon host app) and enable its "Mail" switch, then retry. If it is not listed, run the sync once from that app in an interactive session so macOS can prompt.';
    case 'mail_not_running_or_unconfigured':
      return 'Open Mail.app, add at least one account, and let it finish loading; the helper does not launch Mail itself. Then retry.';
    case 'helper_timeout':
      return `The ${SERVICE_LABEL[service]} helper did not finish in time. Retry; for large data sets reduce the window (history/future days, mail days) or mailboxes, and check that no macOS permission dialog is waiting for an answer.`;
    case 'malformed_output':
      return `The ${SERVICE_LABEL[service]} helper returned output gbrain could not parse. Retry once; if it persists, run the helper by hand and report the (redacted) output.`;
    case 'helper_failed':
      return `The ${SERVICE_LABEL[service]} helper failed. Check the message above; ensure Xcode Command Line Tools 15+ are installed (xcode-select --install) on macOS 14+ for Calendar and Contacts.`;
  }
}

export function readerError(
  code: AppleReaderErrorCode,
  service: AppleReaderService,
  message: string,
): AppleReaderError {
  return new AppleReaderError(code, service, message, fixFor(code, service));
}
