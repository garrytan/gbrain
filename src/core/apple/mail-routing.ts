/**
 * apple mail-routing — which Mail.app accounts the Apple connector may read (Google-hosted accounts are routed to the
 * Google connector and never ingested through Apple Mail).
 *
 * The input is PUBLIC account metadata only, read from Mail's scripting dictionary by `scripts/apple/mail.js --accounts`:
 * the account `id`, `server name`, `account type` and `enabled`. Never the password, user name, email addresses or full
 * name, and never a guess from an email domain: a Google Workspace account on a custom domain is recognised by the
 * documented Gmail IMAP/POP host it is configured with, a `gmail.com` address on another provider's server is not Google.
 *
 * Policy (fail closed, user-approved):
 *  - enabled account on a documented Google host                      -> `google`: excluded, read by the Google connector;
 *  - enabled account on a Google-like host that is NOT documented, an
 *    unreadable/malformed host, an unsupported account type, an
 *    unreadable id/enabled flag or a duplicate id                     -> `unknown`: the WHOLE Mail sweep stops, nothing is read;
 *  - enabled imap/pop/iCloud account on any other host                -> `apple_eligible`;
 *  - disabled account                                                  -> `disabled`: never read, never judged.
 *
 * Pure: no I/O, no Apple access. The fingerprint covers what decides WHAT IS READ: the policy version and, for every
 * eligible account, its id, normalized host and account type. A provider change under the same account id therefore
 * changes it (no weak id-only signature), while adding an unrelated Google account does not.
 */
import { createHash } from 'node:crypto';
import type { AppleMailAccountObservation, AppleMailAccountScope, AppleMailRouting, AppleMailRoutingStatus, AppleMailRoutingUnknown } from './types.ts';

export const APPLE_MAIL_ROUTING_VERSION = 1;

/** Documented Gmail / Google Workspace receiving hosts (Workspace custom domains use the same hosts). */
export const GOOGLE_MAIL_HOSTS: readonly string[] = ['imap.gmail.com', 'imap.googlemail.com', 'pop.gmail.com', 'pop.googlemail.com'];

/** Account types Mail's dictionary defines for a receiving account that the connector can reason about. */
const ELIGIBLE_ACCOUNT_TYPES: readonly string[] = ['imap', 'pop', 'icloud'];

/** Public metadata as the helper reports it: a string/boolean when readable, anything else (null) when not. */
export interface AppleMailAccountMeta {
  id: unknown;
  serverName: unknown;
  accountType: unknown;
  enabled: unknown;
}

export type AppleMailAccountRoute = 'apple_eligible' | 'google' | 'disabled' | 'unknown';

const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_RE = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*$`);

/** A server name as a bare lower-case host, or null when it is not one (empty, a URL, an address, a port, spaces...). */
export function normalizeMailHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const host = raw.trim().toLowerCase().replace(/\.$/, '');
  return host.length > 0 && host.length <= 253 && HOST_RE.test(host) ? host : null;
}

export const isDocumentedGoogleMailHost = (host: string): boolean => GOOGLE_MAIL_HOSTS.includes(host);
const looksGoogle = (host: string): boolean => /gmail|google/.test(host);

const normalizeAccountType = (raw: unknown): string | null => (typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null);

interface Classified { route: AppleMailAccountRoute; reason?: AppleMailRoutingUnknown['reason']; host: string; type: string }

export function classifyMailAccount(meta: AppleMailAccountMeta): Classified {
  const type = normalizeAccountType(meta.accountType) ?? '';
  if (meta.enabled === false) return { route: 'disabled', host: '', type };
  if (meta.enabled !== true) return { route: 'unknown', reason: 'enabled_unreadable', host: '', type };
  // An empty (but readable) server name is accepted only for the Apple-hosted iCloud account type, which cannot be Google.
  if (typeof meta.serverName === 'string' && meta.serverName.trim() === '' && type === 'icloud') return { route: 'apple_eligible', host: '', type };
  if (typeof meta.serverName !== 'string') return { route: 'unknown', reason: 'server_name_unreadable', host: '', type };
  const host = normalizeMailHost(meta.serverName);
  if (host === null) return { route: 'unknown', reason: 'server_name_malformed', host: '', type };
  if (isDocumentedGoogleMailHost(host)) return { route: 'google', host, type };
  if (looksGoogle(host)) return { route: 'unknown', reason: 'google_like_host', host, type };
  if (!ELIGIBLE_ACCOUNT_TYPES.includes(type)) return { route: 'unknown', reason: 'account_type_unsupported', host, type };
  return { route: 'apple_eligible', host, type };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** SHA-256 over the policy version and every eligible account's (id, host, type); canonical JSON, no delimiter ambiguity. */
export function mailRoutingFingerprint(version: number, eligible: ReadonlyArray<{ id: string; host: string; type: string }>): string {
  const rows = eligible.map((a) => [a.id, a.host, a.type]).sort((a, b) => cmp(JSON.stringify(a), JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify({ v: version, eligible: rows })).digest('hex');
}

/** Builds the routing result from the accounts' public metadata. */
export function buildMailRouting(metas: readonly AppleMailAccountMeta[]): AppleMailRouting {
  const idCount = new Map<string, number>();
  for (const m of metas) if (typeof m.id === 'string' && m.id) idCount.set(m.id, (idCount.get(m.id) ?? 0) + 1);
  const eligible: AppleMailAccountScope[] = [];
  const observed: AppleMailAccountObservation[] = metas.flatMap((m) => (typeof m.id === 'string' && m.id ? [{
    id: m.id, serverName: typeof m.serverName === 'string' ? m.serverName : null,
    accountType: typeof m.accountType === 'string' ? m.accountType : null,
    enabled: typeof m.enabled === 'boolean' ? m.enabled : null,
  }] : [])).sort((a, b) => cmp(a.id, b.id));
  const eligibleKeys: Array<{ id: string; host: string; type: string }> = [];
  const google: string[] = [];
  const disabled: string[] = [];
  const unknown: AppleMailRoutingUnknown[] = [];
  for (const m of metas) {
    // Disabled accounts are never read or judged; an unreadable id on one cannot widen the scope.
    if (m.enabled === false) { if (typeof m.id === 'string' && m.id) disabled.push(m.id); continue; }
    if (typeof m.id !== 'string' || !m.id) { unknown.push({ id: null, reason: 'account_id_unreadable' }); continue; }
    if ((idCount.get(m.id) ?? 0) > 1) { unknown.push({ id: m.id, reason: 'duplicate_account_id' }); continue; }
    const c = classifyMailAccount(m);
    if (c.route === 'disabled') disabled.push(m.id);
    else if (c.route === 'google') google.push(m.id);
    else if (c.route === 'unknown') unknown.push({ id: m.id, reason: c.reason! });
    else {
      eligible.push({ id: m.id, serverName: typeof m.serverName === 'string' ? m.serverName : '', accountType: typeof m.accountType === 'string' ? m.accountType : '' });
      eligibleKeys.push({ id: m.id, host: c.host, type: c.type });
    }
  }
  eligible.sort((a, b) => cmp(a.id, b.id));
  google.sort(); disabled.sort();
  unknown.sort((a, b) => cmp(`${a.id ?? ''}|${a.reason}`, `${b.id ?? ''}|${b.reason}`));
  const status: AppleMailRoutingStatus = unknown.length > 0 ? 'unknown'
    : eligible.length > 0 ? (google.length > 0 ? 'mixed' : 'apple')
      : google.length > 0 ? 'google_only' : 'no_enabled_accounts';
  return {
    version: APPLE_MAIL_ROUTING_VERSION,
    observed,
    accountIds: [...new Set(metas.flatMap((m) => (typeof m.id === 'string' && m.id ? [m.id] : [])))].sort(),
    fingerprint: mailRoutingFingerprint(APPLE_MAIL_ROUTING_VERSION, eligibleKeys),
    status, eligible, google, disabled, unknown,
  };
}

/**
 * True when every account Mail has is inside the eligible scope (nothing is routed away or disabled). Only then does a
 * message the scoped read cannot find prove it is GONE; otherwise it may merely live in an account the Apple connector no
 * longer reads, and it must stay accounted for (a held message is kept, never cleared as deleted).
 */
export const routingCoversAllAccounts = (routing: Pick<AppleMailRouting, 'google' | 'disabled' | 'unknown'>): boolean =>
  routing.google.length === 0 && routing.disabled.length === 0 && routing.unknown.length === 0;

/** The routing without account identifiers: safe to print in a command envelope. */
export function routingSummary(routing: AppleMailRouting): Record<string, unknown> {
  return {
    version: routing.version, fingerprint: routing.fingerprint, status: routing.status,
    apple_accounts: routing.eligible.length, google_accounts_excluded: routing.google.length,
    disabled_accounts: routing.disabled.length, unknown_accounts: routing.unknown.length,
  };
}

export const APPLE_MAIL_GOOGLE_DISCLOSURE =
  'Mail accounts hosted by Google (Gmail or Google Workspace, recognised from the server name Mail has configured for the account, such as imap.gmail.com, never from an email address) '
  + 'are NOT read through Apple Mail: connect them with `gbrain google setup`. If Mail has an enabled account whose provider cannot be told apart from Google, '
  + 'the whole Mail sync stops and reads nothing rather than risk importing Google mail. Calendar and Contacts are not affected. Mail pages imported earlier are kept.';

/** Human text for an `unknown` routing (account ids only, never names or addresses). */
export function describeUnknownRouting(routing: Pick<AppleMailRouting, 'unknown'>): string {
  const reasons = routing.unknown.map((u) => `${u.id ?? '(no id)'}: ${u.reason}`);
  return `Mail has ${routing.unknown.length} enabled account(s) whose provider cannot be determined safely (${reasons.join('; ')}).`;
}

export const GOOGLE_SETUP_COMMAND = 'gbrain google setup';
