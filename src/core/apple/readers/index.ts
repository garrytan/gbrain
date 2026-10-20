/** Default Apple readers (macOS only). Every entry point gates on darwin. */
import type { AppleReaders, AppleService } from '../types.ts';
import { AppleReaderError, fixFor, readerError } from './errors.ts';
import { assertDarwin } from './run-helper.ts';
import { readCalendar, probeCalendar, requestCalendarAccess, type HelperOverrides } from './calendar.ts';
import { readContacts, probeContacts, requestContactsAccess } from './contacts.ts';
import { readMail, readMailMessages, readMailRouting, probeMail } from './mail.ts';

export { AppleReaderError, fixFor, readerError } from './errors.ts';
export type { AppleReaderErrorCode } from './errors.ts';
export { runHelper } from './run-helper.ts';

export function createAppleReaders(overrides: HelperOverrides = {}): AppleReaders {
  return {
    async calendar(opts) {
      assertDarwin('calendar', overrides.platform);
      return readCalendar(opts, overrides);
    },
    async contacts(opts) {
      assertDarwin('contacts', overrides.platform);
      return readContacts(opts, overrides);
    },
    async mail(opts) {
      assertDarwin('mail', overrides.platform);
      return readMail(opts, overrides);
    },
    async mailMessages(opts) {
      assertDarwin('mail', overrides.platform);
      return readMailMessages(opts, overrides);
    },
    async mailRouting(opts) {
      assertDarwin('mail', overrides.platform);
      return readMailRouting(overrides, opts?.signal);
    },
    /**
     * Run the service's access request once so macOS shows its prompt. Calendar and Contacts use the
     * helper's `--request-access` (the non-probe path, no item is read); Mail's Automation prompt
     * appears on its first Apple event, which `probe` already sends, so it needs no separate step.
     */
    async requestAccess(service: AppleService) {
      try {
        assertDarwin(service, overrides.platform);
        if (service === 'calendar') await requestCalendarAccess(overrides);
        else if (service === 'contacts') await requestContactsAccess(overrides);
        else await probeMail(overrides);
        return { ok: true as const };
      } catch (e) {
        if (e instanceof AppleReaderError) return { ok: false as const, code: e.code, fix: e.fix };
        const err = readerError('helper_failed', service, e instanceof Error ? e.message : String(e));
        return { ok: false as const, code: err.code, fix: err.fix };
      }
    },
    async probe(service: AppleService) {
      try {
        assertDarwin(service, overrides.platform);
        if (service === 'calendar') await probeCalendar(overrides);
        else if (service === 'contacts') await probeContacts(overrides);
        else {
          // Mail: the account-metadata read is also the availability check (Mail running, an account configured). An account
          // whose provider cannot be told apart from Google is an explicit probe failure, not a silent pass.
          const routing = await readMailRouting(overrides);
          if (routing.status === 'unknown') return { ok: false as const, code: 'mail_routing_unknown' as const, fix: fixFor('mail_routing_unknown', 'mail') };
          if (routing.status === 'no_enabled_accounts') return { ok: false as const, code: 'mail_not_running_or_unconfigured' as const, fix: fixFor('mail_not_running_or_unconfigured', 'mail') };
          return { ok: true as const, routing };
        }
        return { ok: true as const };
      } catch (e) {
        if (e instanceof AppleReaderError) return { ok: false as const, code: e.code, fix: e.fix };
        const err = readerError('helper_failed', service, e instanceof Error ? e.message : String(e));
        return { ok: false as const, code: err.code, fix: err.fix };
      }
    },
  };
}
