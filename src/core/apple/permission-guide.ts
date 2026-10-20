/**
 * Where a denied Apple service is fixed (issue #6855). Pure data shared by
 * `gbrain apple setup|status` and the `apple_permissions` doctor check so the
 * pane named to the user can never diverge from the reader's own `fix`.
 *
 * The pane names follow documented macOS behavior (System Settings > Privacy
 * & Security); they were not verified against a live TCC prompt.
 */
import { fixFor, type AppleReaderErrorCode } from './readers/errors.ts';
import type { AppleService } from './types.ts';

/** Codes that wait on the user (a grant or an account), as opposed to a broken helper. */
export const USER_ACTION_CODES: readonly AppleReaderErrorCode[] = ['permission_denied', 'permission_not_determined', 'automation_denied', 'mail_not_running_or_unconfigured'];
/** Codes doctor reports as a permission problem. */
export const PERMISSION_CODES: readonly AppleReaderErrorCode[] = ['permission_denied', 'permission_not_determined', 'automation_denied'];

export const APPLE_HOST_APP = 'the app that runs gbrain (Terminal, iTerm, or the launcher/daemon host app)';

export interface PermissionGuide {
  service: AppleService;
  code: AppleReaderErrorCode;
  /** The System Settings location, or null when the problem is not a privacy pane. */
  pane: string | null;
  /** Which app to enable in that pane. */
  app: string;
  /** The reader's own actionable fix string. */
  fix: string;
}

export function permissionGuide(service: AppleService, code: AppleReaderErrorCode, fix?: string): PermissionGuide {
  let pane: string | null = null;
  if (code === 'permission_denied' || code === 'permission_not_determined' || code === 'automation_denied') {
    pane = service === 'calendar' ? 'System Settings > Privacy & Security > Calendars (or Full Calendar Access)'
      : service === 'contacts' ? 'System Settings > Privacy & Security > Contacts'
        : 'System Settings > Privacy & Security > Automation (enable the "Mail" switch under the app that runs gbrain)';
  } else if (code === 'mail_not_running_or_unconfigured') {
    pane = 'Mail.app (open it and add an account; not a Privacy pane)';
  }
  return { service, code, pane, app: APPLE_HOST_APP, fix: fix ?? fixFor(code, service) };
}

export function guideLines(guide: PermissionGuide): string[] {
  const name = guide.service[0]!.toUpperCase() + guide.service.slice(1);
  return [
    `${name}: ${guide.code}`,
    ...(guide.pane ? [`  Open: ${guide.pane}`, `  Enable: ${guide.app}`] : []),
    `  ${guide.fix}`,
  ];
}
