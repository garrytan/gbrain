import { mkdir, open, readFile } from 'node:fs/promises';
import matter from 'gray-matter';
import { configDir, gbrainPath, loadConfig, loadConfigFileOnly } from './config.ts';
import { computeContentHash } from './ingestion/types.ts';
import { operations, type OperationContext } from './operations.ts';
import type { BrainEngine } from './engine.ts';
import { resolveSourceWithTier } from './source-resolver.ts';

export const DEFAULT_OUTLOOK_CLIENT_ID = '';
export const DEFAULT_OUTLOOK_TENANT_ID = '';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DEFAULT_SCOPES = [
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Calendars.Read',
  'Contacts.Read',
];

export interface OutlookTokenCache {
  token_type: string;
  scope?: string;
  access_token: string;
  refresh_token?: string;
  expires_at: number;
}

export interface OutlookMessage {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: OutlookEmailAddress };
  toRecipients?: Array<{ emailAddress?: OutlookEmailAddress }>;
  ccRecipients?: Array<{ emailAddress?: OutlookEmailAddress }>;
  bodyPreview?: string;
  importance?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  webLink?: string;
}

export interface OutlookEvent {
  id: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  organizer?: { emailAddress?: OutlookEmailAddress };
  attendees?: Array<{ emailAddress?: OutlookEmailAddress }>;
  webLink?: string;
}

export interface OutlookContact {
  id: string;
  displayName?: string;
  companyName?: string;
  emailAddresses?: OutlookEmailAddress[];
}

export interface OutlookEmailAddress {
  name?: string;
  address?: string;
}

export interface OutlookScanInput {
  messages: OutlookMessage[];
  events: OutlookEvent[];
  contacts: OutlookContact[];
  knownDomains?: string[];
  selfDomains?: string[];
  selfEmails?: string[];
}

interface OutlookMe {
  mail?: string;
  userPrincipalName?: string;
}

export interface OutlookScanSummary {
  kept: number;
  skipped_spam_newsletters: number;
  people_detected: number;
  threads_worth_saving: number;
  people: OutlookPersonSignal[];
  companies: OutlookCompanySignal[];
  threads: OutlookThreadSignal[];
  meetings: OutlookMeetingSignal[];
}

export interface OutlookPersonSignal {
  key: string;
  name: string;
  email: string;
  domain: string;
  company?: string;
  reasons: string[];
  messageCount: number;
  calendarLinked: boolean;
}

export interface OutlookCompanySignal {
  domain: string;
  name: string;
  people: string[];
  reasons: string[];
}

export interface OutlookThreadSignal {
  conversationId: string;
  subject: string;
  people: string[];
  messageCount: number;
  reasons: string[];
  latestAt?: string;
  preview?: string;
  webLink?: string;
}

export interface OutlookMeetingSignal {
  id: string;
  subject: string;
  people: string[];
  startsAt?: string;
  endsAt?: string;
  reasons: string[];
  webLink?: string;
}

export interface OutlookWriteResult {
  written: number;
  slugs: string[];
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function outlookTokenPath(): string {
  return gbrainPath('outlook-token.json');
}

export function resolveOutlookAppConfig(opts: {
  clientId?: string;
  tenantId?: string;
  env?: Record<string, string | undefined>;
} = {}): { clientId: string; tenantId: string } {
  const env = opts.env ?? process.env;
  const cfg = loadConfigFileOnly()?.outlook;
  const clientId = opts.clientId || env.GBRAIN_OUTLOOK_CLIENT_ID || cfg?.client_id || DEFAULT_OUTLOOK_CLIENT_ID;
  const tenantId = opts.tenantId || env.GBRAIN_OUTLOOK_TENANT_ID || cfg?.tenant_id || DEFAULT_OUTLOOK_TENANT_ID;
  if (!clientId) {
    throw new Error('Missing Outlook client id. Pass --client-id, set GBRAIN_OUTLOOK_CLIENT_ID, or set outlook.client_id in ~/.gbrain/config.json');
  }
  if (!tenantId) {
    throw new Error('Missing Outlook tenant id. Pass --tenant-id, set GBRAIN_OUTLOOK_TENANT_ID, or set outlook.tenant_id in ~/.gbrain/config.json');
  }
  return { clientId, tenantId };
}

export async function runDeviceCodeLogin(opts: {
  clientId?: string;
  tenantId?: string;
  scopes?: string[];
  fetchImpl?: FetchLike;
  now?: () => number;
  out?: Pick<typeof console, 'log'>;
} = {}): Promise<OutlookTokenCache> {
  const { clientId, tenantId } = resolveOutlookAppConfig(opts);
  const scopes = opts.scopes ?? DEFAULT_SCOPES;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const out = opts.out ?? console;
  const base = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0`;

  const dc = await postForm(fetchImpl, `${base}/devicecode`, {
    client_id: clientId,
    scope: scopes.join(' '),
  });
  const message = String(dc.message ?? '');
  if (!message) throw new Error('Microsoft device-code response did not include a sign-in message');
  out.log(message);

  const intervalMs = Math.max(1, Number(dc.interval ?? 5)) * 1000;
  const deadline = now() + Math.max(60, Number(dc.expires_in ?? 900)) * 1000;
  while (now() < deadline) {
    await sleep(intervalMs);
    const token = await postForm(fetchImpl, `${base}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: String(dc.device_code),
    }, { tolerateOAuthPending: true });
    if (token.error === 'authorization_pending') continue;
    if (token.error === 'slow_down') {
      await sleep(intervalMs);
      continue;
    }
    if (token.error) throw new Error(`Microsoft login failed: ${token.error_description ?? token.error}`);
    return saveToken(tokenToCache(token, now));
  }
  throw new Error('Microsoft login timed out before approval completed');
}

export async function loadOutlookToken(opts: {
  clientId?: string;
  tenantId?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
} = {}): Promise<OutlookTokenCache> {
  const now = opts.now ?? Date.now;
  let token: OutlookTokenCache;
  try {
    token = JSON.parse(await readFile(outlookTokenPath(), 'utf8')) as OutlookTokenCache;
  } catch {
    throw new Error('No Outlook token found. Run: gbrain outlook login');
  }
  if (token.expires_at - 60_000 > now()) return token;
  if (!token.refresh_token) throw new Error('Outlook token expired and has no refresh_token. Run: gbrain outlook login');

  const { clientId, tenantId } = resolveOutlookAppConfig(opts);
  const refreshed = await postForm(opts.fetchImpl ?? fetch, `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: token.refresh_token,
    scope: DEFAULT_SCOPES.join(' '),
  });
  return saveToken(tokenToCache(refreshed, now, token.refresh_token));
}

export async function fetchOutlookScanInput(token: string, opts: {
  days?: number;
  limit?: number;
  fetchImpl?: FetchLike;
} = {}): Promise<OutlookScanInput> {
  const days = opts.days ?? 14;
  const limit = opts.limit ?? 500;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const headers = { Authorization: `Bearer ${token}` };
  const top = Math.min(50, Math.max(1, limit));

  const messages = await graphCollect<OutlookMessage>(
    fetchImpl,
    `${GRAPH_BASE}/me/mailFolders/inbox/messages?$top=${top}&$orderby=receivedDateTime desc&$filter=receivedDateTime ge ${encodeURIComponent(since)}&$select=id,internetMessageId,conversationId,subject,receivedDateTime,from,toRecipients,ccRecipients,bodyPreview,importance,isRead,hasAttachments,webLink`,
    headers,
    limit,
  );
  const events = await graphCollect<OutlookEvent>(
    fetchImpl,
    `${GRAPH_BASE}/me/calendarView?startDateTime=${encodeURIComponent(since)}&endDateTime=${encodeURIComponent(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString())}&$top=${top}&$select=id,subject,start,end,organizer,attendees,webLink`,
    headers,
    Math.min(limit, 200),
  );
  const contacts = await graphCollect<OutlookContact>(
    fetchImpl,
    `${GRAPH_BASE}/me/contacts?$top=${top}&$select=id,displayName,companyName,emailAddresses`,
    headers,
    Math.min(limit, 500),
  );
  const me: OutlookMe = await graphGet<OutlookMe>(
    fetchImpl,
    `${GRAPH_BASE}/me?$select=mail,userPrincipalName`,
    headers,
  ).catch((): OutlookMe => ({}));
  const selfEmails = [me.mail, me.userPrincipalName].map(normalizeEmail).filter(Boolean);
  const selfDomains = selfEmails
    .map(email => email.split('@')[1])
    .filter((domain): domain is string => Boolean(domain && !genericEmailDomain(domain)));
  return { messages, events, contacts, selfEmails, selfDomains };
}

export function scanOutlook(input: OutlookScanInput): OutlookScanSummary {
  const knownDomains = new Set((input.knownDomains ?? []).map(normalizeDomain).filter(Boolean));
  const selfDomains = new Set((input.selfDomains ?? []).map(normalizeDomain).filter(Boolean));
  const selfEmails = new Set((input.selfEmails ?? []).map(normalizeEmail).filter(Boolean));
  const calendarEmails = new Set<string>();
  const contactByEmail = new Map<string, OutlookContact>();

  for (const ev of input.events) {
    for (const addr of eventAddresses(ev)) {
      const email = normalizeEmail(addr.address);
      if (email) calendarEmails.add(email);
    }
  }
  for (const c of input.contacts) {
    for (const addr of c.emailAddresses ?? []) {
      const email = normalizeEmail(addr.address);
      if (email) contactByEmail.set(email, c);
    }
  }

  const people = new Map<string, OutlookPersonSignal>();
  const threads = new Map<string, OutlookThreadSignal>();
  const conversationCounts = new Map<string, number>();
  let skipped = 0;

  for (const msg of input.messages) {
    if (!msg.conversationId) continue;
    conversationCounts.set(msg.conversationId, (conversationCounts.get(msg.conversationId) ?? 0) + 1);
  }

  for (const msg of input.messages) {
    const from = normalizeAddress(msg.from?.emailAddress);
    if (!from.email || selfEmails.has(from.email) || selfDomains.has(from.domain) || isSpammyMessage(msg, from.email)) {
      skipped++;
      continue;
    }
    const recipients = messageRecipients(msg).map(normalizeAddress).filter(a => a.email);
    const direct = recipients.some(a => selfEmails.has(a.email) || selfDomains.has(a.domain));
    const active = Boolean(msg.conversationId && (conversationCounts.get(msg.conversationId) ?? 0) > 1);
    const calendarLinked = calendarEmails.has(from.email);
    const knownBusiness = knownDomains.has(from.domain) || Boolean(contactByEmail.get(from.email)?.companyName);
    const reply = /^(re|fw|fwd):/i.test(msg.subject ?? '');
    const highSignal = direct || active || calendarLinked || knownBusiness || reply || msg.importance === 'high';
    if (!highSignal) {
      skipped++;
      continue;
    }

    const reasons = [
      direct ? 'direct human email' : null,
      knownBusiness ? 'known business domain/contact' : null,
      calendarLinked ? 'calendar-linked person' : null,
      active ? 'active thread' : null,
      reply ? 'reply' : null,
      msg.importance === 'high' ? 'high importance' : null,
    ].filter(Boolean) as string[];

    upsertPerson(people, from, {
      company: contactByEmail.get(from.email)?.companyName,
      reasons,
      calendarLinked,
    });

    const conversationId = msg.conversationId ?? msg.internetMessageId ?? msg.id;
    const existing = threads.get(conversationId);
    const threadPeople = [from.email, ...recipients.map(r => r.email)].filter(Boolean) as string[];
    const latestAt = maxIso(existing?.latestAt, msg.receivedDateTime);
    threads.set(conversationId, {
      conversationId,
      subject: cleanSubject(msg.subject ?? '(no subject)'),
      people: Array.from(new Set([...(existing?.people ?? []), ...threadPeople])),
      messageCount: (existing?.messageCount ?? 0) + 1,
      reasons: Array.from(new Set([...(existing?.reasons ?? []), ...reasons])),
      latestAt,
      preview: msg.bodyPreview ?? existing?.preview,
      webLink: msg.webLink ?? existing?.webLink,
    });
  }

  for (const ev of input.events) {
    for (const addr of eventAddresses(ev).map(normalizeAddress).filter(a => a.email)) {
      if (selfEmails.has(addr.email) || selfDomains.has(addr.domain) || isMachineAddress(addr.email)) continue;
      upsertPerson(people, addr, {
        company: contactByEmail.get(addr.email)?.companyName,
        reasons: ['calendar-linked person'],
        calendarLinked: true,
      });
    }
  }

  const meetings = input.events
    .filter(ev => eventAddresses(ev).some(a => {
      const email = normalizeEmail(a.address);
      return email && people.has(email);
    }))
    .map(ev => ({
      id: ev.id,
      subject: ev.subject ?? '(no subject)',
      people: eventAddresses(ev).map(a => normalizeEmail(a.address)).filter((e): e is string => Boolean(e && people.has(e))),
      startsAt: ev.start?.dateTime,
      endsAt: ev.end?.dateTime,
      reasons: ['calendar-linked people'],
      webLink: ev.webLink,
    }));

  const companyMap = new Map<string, OutlookCompanySignal>();
  for (const p of people.values()) {
    if (genericEmailDomain(p.domain)) continue;
    const existing = companyMap.get(p.domain);
    companyMap.set(p.domain, {
      domain: p.domain,
      name: p.company ?? domainToName(p.domain),
      people: Array.from(new Set([...(existing?.people ?? []), p.email])),
      reasons: Array.from(new Set([...(existing?.reasons ?? []), ...p.reasons])),
    });
  }

  const worthSaving = Array.from(threads.values()).filter(t => t.messageCount > 1 || t.reasons.length > 1 || t.reasons.includes('calendar-linked person'));
  return {
    kept: people.size + companyMap.size + worthSaving.length + meetings.length,
    skipped_spam_newsletters: skipped,
    people_detected: people.size,
    threads_worth_saving: worthSaving.length,
    people: Array.from(people.values()).sort((a, b) => a.email.localeCompare(b.email)),
    companies: Array.from(companyMap.values()).sort((a, b) => a.domain.localeCompare(b.domain)),
    threads: worthSaving.sort((a, b) => (b.latestAt ?? '').localeCompare(a.latestAt ?? '')),
    meetings,
  };
}

export async function writeOutlookScan(engine: BrainEngine, summary: OutlookScanSummary, opts: {
  sourceId?: string;
} = {}): Promise<OutlookWriteResult> {
  const putPageOp = operations.find((o) => o.name === 'put_page');
  if (!putPageOp) throw new Error('put_page operation missing');
  const cfg = loadConfig() ?? { engine: 'pglite' as const };
  const sourceId = opts.sourceId
    ?? (await resolveSourceWithTier(engine, undefined, process.cwd())).source_id;
  const ctx: OperationContext = {
    engine,
    config: cfg,
    logger: {
      info: (msg: string) => process.stderr.write(`[outlook] ${msg}\n`),
      warn: (msg: string) => process.stderr.write(`[outlook] WARN: ${msg}\n`),
      error: (msg: string) => process.stderr.write(`[outlook] ERROR: ${msg}\n`),
    },
    dryRun: false,
    remote: false,
    sourceId,
  };
  const pages = [
    ...summary.people.map(personPage),
    ...summary.companies.map(companyPage),
    ...summary.threads.map(threadPage),
    ...summary.meetings.map(meetingPage),
  ];
  const slugs: string[] = [];
  for (const page of pages) {
    await putPageOp.handler(ctx, {
      slug: page.slug,
      content: page.content,
      source_kind: 'outlook-collector',
      source_uri: page.sourceUri,
      ingested_via: 'outlook-collector',
      untrusted_payload: true,
    });
    slugs.push(page.slug);
  }
  return { written: slugs.length, slugs };
}

export function printScanSummary(summary: OutlookScanSummary, json = false): void {
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`kept: ${summary.kept}`);
  console.log(`skipped spam/newsletters: ${summary.skipped_spam_newsletters}`);
  console.log(`people detected: ${summary.people_detected}`);
  console.log(`threads worth saving: ${summary.threads_worth_saving}`);
}

async function saveToken(token: OutlookTokenCache): Promise<OutlookTokenCache> {
  await mkdir(configDir(), { recursive: true });
  const handle = await open(outlookTokenPath(), 'w', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(token, null, 2) + '\n', 'utf8');
  } finally {
    await handle.close();
  }
  return token;
}

function tokenToCache(raw: Record<string, unknown>, now: () => number, fallbackRefresh?: string): OutlookTokenCache {
  const accessToken = String(raw.access_token ?? '');
  if (!accessToken) throw new Error('Microsoft token response did not include access_token');
  return {
    token_type: String(raw.token_type ?? 'Bearer'),
    scope: typeof raw.scope === 'string' ? raw.scope : undefined,
    access_token: accessToken,
    refresh_token: typeof raw.refresh_token === 'string' ? raw.refresh_token : fallbackRefresh,
    expires_at: now() + Math.max(60, Number(raw.expires_in ?? 3600)) * 1000,
  };
}

async function postForm(fetchImpl: FetchLike, url: string, form: Record<string, string>, opts: { tolerateOAuthPending?: boolean } = {}): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok && !(opts.tolerateOAuthPending && typeof body.error === 'string')) {
    throw new Error(`Microsoft OAuth request failed (${res.status}): ${body.error_description ?? body.error ?? res.statusText}`);
  }
  return body;
}

async function graphCollect<T>(fetchImpl: FetchLike, url: string, headers: Record<string, string>, limit: number): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  while (next && out.length < limit) {
    const res = await fetchImpl(next, { headers });
    if (!res.ok) throw new Error(`Microsoft Graph request failed (${res.status}): ${await res.text()}`);
    const body = await res.json() as { value?: T[]; '@odata.nextLink'?: string };
    out.push(...(body.value ?? []));
    next = body['@odata.nextLink'];
  }
  return out.slice(0, limit);
}

async function graphGet<T>(fetchImpl: FetchLike, url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`Microsoft Graph request failed (${res.status}): ${await res.text()}`);
  return await res.json() as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isSpammyMessage(msg: OutlookMessage, fromEmail: string): boolean {
  const subject = `${msg.subject ?? ''} ${msg.bodyPreview ?? ''}`.toLowerCase();
  return isMachineAddress(fromEmail)
    || /\b(unsubscribe|newsletter|webinar|promotion|sale|discount|limited time|cold outreach)\b/i.test(subject)
    || /list-unsubscribe/i.test(subject);
}

function isMachineAddress(email: string): boolean {
  const local = email.split('@')[0] ?? '';
  return /^(no-?reply|donotreply|notifications?|mailer|marketing|news|newsletter|bounce|support|hello)$/i.test(local);
}

function normalizeAddress(addr?: OutlookEmailAddress): { name: string; email: string; domain: string } {
  const email = normalizeEmail(addr?.address);
  return { name: addr?.name?.trim() || email || 'Unknown', email, domain: email.split('@')[1] ?? '' };
}

function normalizeEmail(email: unknown): string {
  return typeof email === 'string' && email.includes('@') ? email.trim().toLowerCase() : '';
}

function normalizeDomain(domain: unknown): string {
  return typeof domain === 'string' ? domain.trim().toLowerCase().replace(/^@/, '') : '';
}

function messageRecipients(msg: OutlookMessage): OutlookEmailAddress[] {
  return [...(msg.toRecipients ?? []), ...(msg.ccRecipients ?? [])].map(r => r.emailAddress).filter(Boolean) as OutlookEmailAddress[];
}

function eventAddresses(ev: OutlookEvent): OutlookEmailAddress[] {
  return [
    ev.organizer?.emailAddress,
    ...(ev.attendees ?? []).map(a => a.emailAddress),
  ].filter(Boolean) as OutlookEmailAddress[];
}

function upsertPerson(map: Map<string, OutlookPersonSignal>, addr: { name: string; email: string; domain: string }, extra: { company?: string; reasons: string[]; calendarLinked: boolean }): void {
  const existing = map.get(addr.email);
  map.set(addr.email, {
    key: addr.email,
    name: existing?.name && existing.name !== existing.email ? existing.name : addr.name,
    email: addr.email,
    domain: addr.domain,
    company: existing?.company ?? extra.company,
    reasons: Array.from(new Set([...(existing?.reasons ?? []), ...extra.reasons])),
    messageCount: (existing?.messageCount ?? 0) + (extra.reasons.includes('direct human email') || extra.reasons.includes('active thread') ? 1 : 0),
    calendarLinked: existing?.calendarLinked || extra.calendarLinked,
  });
}

function cleanSubject(subject: string): string {
  return subject.replace(/^((re|fw|fwd):\s*)+/i, '').trim() || '(no subject)';
}

function maxIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function genericEmailDomain(domain: string): boolean {
  return ['gmail.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'yahoo.com', 'aol.com', 'proton.me', 'protonmail.com'].includes(domain);
}

function domainToName(domain: string): string {
  return domain.split('.')[0]?.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) ?? domain;
}

function slugPart(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unknown';
}

function markdownPage(slug: string, fm: Record<string, unknown>, body: string, sourceUri: string): { slug: string; content: string; sourceUri: string } {
  return { slug, content: matter.stringify(body.trim() + '\n', fm), sourceUri };
}

function personPage(p: OutlookPersonSignal) {
  const body = [
    `# ${p.name}`,
    '',
    `Email: ${p.email}`,
    p.company ? `Company: ${p.company}` : '',
    '',
    '## Outlook signal',
    ...p.reasons.map(r => `- ${r}`),
  ].filter(Boolean).join('\n');
  const slugBase = p.name === 'Unknown' ? p.email : `${p.name}-${p.domain}-${computeContentHash(p.email).slice(0, 8)}`;
  return markdownPage(`people/${slugPart(slugBase)}`, {
    type: 'person',
    title: p.name,
    outlook_email: p.email,
    outlook_domain: p.domain,
    captured_via: 'outlook-collector',
  }, body, `outlook://people/${p.email}`);
}

function companyPage(c: OutlookCompanySignal) {
  const body = [
    `# ${c.name}`,
    '',
    `Domain: ${c.domain}`,
    '',
    '## People seen',
    ...c.people.map(p => `- ${p}`),
    '',
    '## Outlook signal',
    ...c.reasons.map(r => `- ${r}`),
  ].join('\n');
  return markdownPage(`companies/${slugPart(c.domain.replace(/\./g, '-'))}`, {
    type: 'company',
    title: c.name,
    domain: c.domain,
    captured_via: 'outlook-collector',
  }, body, `outlook://companies/${c.domain}`);
}

function threadPage(t: OutlookThreadSignal) {
  const hash = computeContentHash(t.conversationId).slice(0, 10);
  const body = [
    `# ${t.subject}`,
    '',
    t.preview ?? '',
    '',
    '## People',
    ...t.people.map(p => `- ${p}`),
    '',
    '## Why saved',
    ...t.reasons.map(r => `- ${r}`),
  ].filter(Boolean).join('\n');
  return markdownPage(`outlook/threads/${slugPart(t.subject)}-${hash}`, {
    type: 'email',
    title: t.subject,
    conversation_id: t.conversationId,
    latest_at: t.latestAt,
    captured_via: 'outlook-collector',
  }, body, t.webLink ?? `outlook://threads/${t.conversationId}`);
}

function meetingPage(m: OutlookMeetingSignal) {
  const hash = computeContentHash(m.id).slice(0, 10);
  const body = [
    `# ${m.subject}`,
    '',
    m.startsAt ? `Starts: ${m.startsAt}` : '',
    m.endsAt ? `Ends: ${m.endsAt}` : '',
    '',
    '## People',
    ...m.people.map(p => `- ${p}`),
  ].filter(Boolean).join('\n');
  return markdownPage(`meetings/outlook-${slugPart(m.subject)}-${hash}`, {
    type: 'meeting',
    title: m.subject,
    starts_at: m.startsAt,
    captured_via: 'outlook-collector',
  }, body, m.webLink ?? `outlook://meetings/${m.id}`);
}
