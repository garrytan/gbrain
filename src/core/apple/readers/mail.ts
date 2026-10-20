/** Mail reader: Mail.app public scripting dictionary via scripts/apple/mail.js (JXA, read-only). */
import { fileURLToPath } from 'node:url';
import type { AppleMailListing, AppleMailMessage, AppleMailRouting, AppleMailTarget, AppleUnavailableMessage } from '../types.ts';
import { buildMailRouting, routingCoversAllAccounts, type AppleMailAccountMeta } from '../mail-routing.ts';
import { readerError } from './errors.ts';
import { DEFAULT_HELPER_TIMEOUT_MS, runHelperDocument } from './run-helper.ts';
import { str, strArray, withScriptArgs, type HelperOverrides } from './calendar.ts';

/** Source-tree path of the helper (tests / `osacompile`). Runtime uses the embedded text. */
export const MAIL_SCRIPT = fileURLToPath(new URL('../../../../scripts/apple/mail.js', import.meta.url));
export const OSASCRIPT_BIN = '/usr/bin/osascript';
export const MAIL_BODY_CAP = 20000;
/**
 * Wall-clock budget the helper gets for reading message bodies. Mail.app can take ~20 s to produce
 * `content` for one HTML newsletter (live-Mac observation), so the helper stops starting new body
 * batches after this and returns what it has as `truncated` + `budgetExhausted`; the sweep resumes
 * from the last message next run. Counted from helper start. This is a SOFT limit; the helper is also told
 * the real hard timeout (`--timeout-ms`) and starts a batch only if its projected end fits inside it, so a
 * slow pre-phase shrinks or skips the body phase instead of overrunning the kill.
 *
 * Limitation (not a guarantee): the JXA helper cannot interrupt a synchronous Apple event, so a single
 * event (accounts(), a listing, one `content` read) that is itself slower than the remaining time is only
 * stopped by the hard kill (`helper_timeout`). The pre-phase is not budgeted.
 */
export const MAIL_BODY_BUDGET_MS = 45_000;

export function normalizeMessage(raw: unknown): AppleMailMessage {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = str(o.id);
  const date = str(o.date);
  if (!id || !date) throw readerError('malformed_output', 'mail', 'mail item missing id/date');
  const body = typeof o.body === 'string' ? o.body.slice(0, MAIL_BODY_CAP) : '';
  return {
    id,
    threadId: str(o.threadId) ?? id,
    mailbox: str(o.mailbox) ?? '',
    subject: typeof o.subject === 'string' ? o.subject : '',
    from: typeof o.from === 'string' ? o.from : '',
    to: strArray(o.to),
    cc: strArray(o.cc),
    date,
    body,
    read: o.read === true,
    // Header verdicts for open-loop tracking: present only when the helper reported them (absent = unclassified).
    ...(typeof o.automated === 'boolean' ? { automated: o.automated } : {}),
    ...(typeof o.bulk === 'boolean' ? { bulk: o.bulk } : {}),
  };
}

const OSASCRIPT_PREFIX = ['-l', 'JavaScript'];

/**
 * The proven-unreadable messages of a helper document. An entry without a stable id, a parseable date and a thread
 * cannot identify what to hold, so it is dropped and the listing is reported `incomplete` instead (conservative: the
 * cursor stays pinned and nothing is counted or removed).
 */
function unavailableMessagesOf(doc: Record<string, unknown>): { messages: AppleUnavailableMessage[]; malformed: boolean } {
  const raw = Array.isArray(doc.unavailable_messages) ? doc.unavailable_messages : [];
  const messages: AppleUnavailableMessage[] = [];
  let malformed = false;
  for (const entry of raw) {
    const o = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const id = str(o.id);
    const date = str(o.date);
    const threadId = str(o.thread_id);
    if (id && date && threadId && Number.isFinite(Date.parse(date))) messages.push({ id, date, threadId });
    else malformed = true;
  }
  return { messages, malformed };
}

/**
 * The `--routing` argument: exactly the accounts the caller decided on, with the metadata it decided on (the helper
 * re-verifies each against Mail and refuses on any difference). Omitted without routing: the macOS helper then refuses the
 * read (it never reads unified mailboxes), which is the fail-closed behaviour; injected fake helpers are unaffected.
 */
function routingArgs(routing: AppleMailRouting | undefined): string[] {
  if (!routing) return [];
  if (routing.eligible.length === 0) throw readerError('mail_not_running_or_unconfigured', 'mail', 'No Mail account is eligible for the Apple connector to read.');
  return ['--routing', JSON.stringify({
    eligible: routing.eligible.map((a) => ({ id: a.id, server_name: a.serverName, account_type: a.accountType })),
    account_ids: routing.accountIds,
    observed: routing.observed.map((a) => ({ id: a.id, server_name: a.serverName, account_type: a.accountType, enabled: a.enabled })),
  })];
}

function listingOf(items: unknown[], doc: Record<string, unknown>, routing?: AppleMailRouting): AppleMailListing {
  const proven = unavailableMessagesOf(doc);
  // A target missing from the scoped accounts proves the message is GONE only when the scope covered every Mail account.
  // With a Google or disabled account outside it the message may live there, so it is reported as out of scope instead.
  const notFound = Array.isArray(doc.target_missing) ? strArray(doc.target_missing) : undefined;
  const covers = !routing || routingCoversAllAccounts(routing);
  return {
    messages: items.map(normalizeMessage),
    truncated: doc.truncated === true,
    budgetExhausted: doc.budget_exhausted === true,
    unavailableThreads: strArray(doc.unavailable),
    ...(Array.isArray(doc.unavailable_messages) ? { unavailableMessages: proven.messages } : {}),
    ...(Array.isArray(doc.deferred) ? { deferredThreads: strArray(doc.deferred) } : {}),
    ...(notFound && covers ? { targetMissing: notFound } : {}),
    ...(notFound && !covers ? { targetOutOfScope: notFound } : {}),
    ...(routing ? { routing: { version: routing.version, fingerprint: routing.fingerprint } } : {}),
    incomplete: doc.incomplete === true || proven.malformed,
  };
}

export async function readMail(
  opts: { since: Date; mailboxes: string[]; max?: number; after?: { date: string; id: string }; exclude?: string[]; routing?: AppleMailRouting; signal?: AbortSignal },
  o: HelperOverrides = {},
): Promise<AppleMailListing> {
  const { items, doc } = await withScriptArgs('mail.js', o, OSASCRIPT_PREFIX, async (scriptArgs) => {
    const args = [...scriptArgs, '--since', opts.since.toISOString(), '--mailboxes', opts.mailboxes.join(','), ...routingArgs(opts.routing)];
    if (opts.max !== undefined) args.push('--max', String(opts.max));
    if (opts.after) args.push('--after-date', opts.after.date, '--after-id', opts.after.id);
    if (opts.exclude?.length) args.push('--exclude', JSON.stringify(opts.exclude));
    args.push('--budget-ms', String(MAIL_BODY_BUDGET_MS), '--timeout-ms', String(o.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS));
    return runHelperDocument({ service: 'mail', command: o.command ?? OSASCRIPT_BIN, args, signal: opts.signal, timeoutMs: o.timeoutMs, maxStdoutBytes: o.maxStdoutBytes, platform: o.platform, env: o.env });
  });
  return listingOf(items, doc, opts.routing);
}

/** Re-reads specific messages (stable id + received date) wherever they are; same time limits as a listing read. */
export async function readMailMessages(
  opts: { mailboxes: string[]; targets: AppleMailTarget[]; routing?: AppleMailRouting; signal?: AbortSignal },
  o: HelperOverrides = {},
): Promise<AppleMailListing> {
  const { items, doc } = await withScriptArgs('mail.js', o, OSASCRIPT_PREFIX, async (scriptArgs) => {
    const args = [...scriptArgs, '--targets', JSON.stringify(opts.targets.map((t) => ({ id: t.id, date: t.date }))), '--mailboxes', opts.mailboxes.join(','), ...routingArgs(opts.routing),
      '--budget-ms', String(MAIL_BODY_BUDGET_MS), '--timeout-ms', String(o.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS)];
    return runHelperDocument({ service: 'mail', command: o.command ?? OSASCRIPT_BIN, args, signal: opts.signal, timeoutMs: o.timeoutMs, maxStdoutBytes: o.maxStdoutBytes, platform: o.platform, env: o.env });
  });
  return listingOf(items, doc, opts.routing);
}

export async function probeMail(o: HelperOverrides = {}): Promise<void> {
  await withScriptArgs('mail.js', o, OSASCRIPT_PREFIX, (scriptArgs) =>
    runHelperDocument({ service: 'mail', command: o.command ?? OSASCRIPT_BIN, args: [...scriptArgs, '--probe'], timeoutMs: o.timeoutMs ?? 60_000, platform: o.platform, env: o.env }));
}

/**
 * Which Mail accounts the Apple connector may read, from the helper's PUBLIC account metadata (id, server name, account
 * type, enabled; nothing else is ever requested). A document without a well-formed `accounts` array is malformed output.
 */
export async function readMailRouting(o: HelperOverrides = {}, signal?: AbortSignal): Promise<AppleMailRouting> {
  const { doc } = await withScriptArgs('mail.js', o, OSASCRIPT_PREFIX, (scriptArgs) =>
    runHelperDocument({ service: 'mail', command: o.command ?? OSASCRIPT_BIN, args: [...scriptArgs, '--accounts'], signal, timeoutMs: o.timeoutMs ?? 60_000, platform: o.platform, env: o.env }));
  if (!Array.isArray(doc.accounts)) throw readerError('malformed_output', 'mail', 'Mail account helper output has no "accounts" array.');
  const metas: AppleMailAccountMeta[] = doc.accounts.map((raw) => {
    const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return { id: a.id, serverName: a.server_name, accountType: a.account_type, enabled: a.enabled };
  });
  return buildMailRouting(metas);
}
