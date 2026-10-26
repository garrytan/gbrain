import { createComposioCalendarFetch, createComposioGmailFetch } from '../core/google/composio-proxy.ts';

export function validateComposioGoogleSource(
  account: string,
  services: string[],
  accountRef: string | undefined,
): string | undefined {
  if (!accountRef || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(accountRef)) {
    return '--access composio requires --composio-account-ref <registry-alias>.';
  }
  if (services.length !== 1 || !['gmail', 'calendar'].includes(services[0]!)) {
    return 'Composio access requires one service: --services gmail or --services calendar.';
  }
  if (services[0] === 'gmail') createComposioGmailFetch(account, accountRef);
  else createComposioCalendarFetch(account, accountRef);
  return undefined;
}
