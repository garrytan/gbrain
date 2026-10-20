/**
 * Synthetic Apple Mail for the poison-recovery suites: a mailbox of messages, per-message unreadability, and a reader
 * that behaves like the helper (windowed listing in (date,id) order, `exclude`, `after`, `max`, proven/deferred
 * verdicts, a read by id). No macOS, no Mail.app, no private data; placeholders only.
 */
import type { AppleMailListing, AppleMailMessage, AppleMailRouting, AppleMailTarget, AppleReaders } from '../../src/core/apple/types.ts';
import { AppleReaderError } from '../../src/core/apple/readers/errors.ts';

export const OWNER = 'me-example@example.com';
export const NOW = Date.parse('2026-10-16T12:00:00-07:00');
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const dayIso = (daysAgo: number, hour = 9): string => new Date(Date.UTC(2026, 9, 16 - daysAgo, hour, 0, 0)).toISOString();

export function mk(id: string, threadId: string, daysAgo: number, over: Partial<AppleMailMessage> = {}): AppleMailMessage {
  return { id, threadId, mailbox: 'INBOX', subject: `Subject ${threadId}`, from: 'Alice Example <alice-example@example.com>', to: [OWNER], cc: [],
    date: dayIso(daysAgo), body: `Synthetic body of ${id}.`, read: true, automated: false, bulk: false, ...over };
}

// ── Synthetic Mail ───────────────────────────────────────────────────────────

export interface FakeMail {
  /** Every message in the mailbox, readable or not. */
  box: AppleMailMessage[];
  /** Ids Mail cannot produce a body for (the reader proves each unreadable on its own). */
  unreadable: Set<string>;
  /** Threads the reader reports unavailable WITHOUT proof (a failed batch it could not retry). */
  deferred: Set<string>;
  main: Array<{ since: string; after?: { date: string; id: string }; exclude: string[]; max?: number }>;
  byId: AppleMailTarget[][];
  failMain?: Error;
  failById?: Error;
  /** Ignored by the reader when set: every message is reported unavailable and nothing is read (a Mail outage). */
  outage?: boolean;
  /** Reader without `mailMessages` (cannot read by id). */
  noById?: boolean;
  /** Return a budget-exhausted empty slice instead of reading. */
  budgetStop?: boolean;
  /** The N-th (0-based, per `byId` call in this run's order) read by id fails with this error. */
  failByIdAt?: { call: number; error: Error };
  /** Called with the 0-based index of every read by id before it answers (e.g. to abort the run's signal). */
  onById?: (call: number) => void;
  /** Ids a read by id silently leaves unresolved: neither read, nor missing, nor unavailable (a truncated helper read). */
  dropById: Set<string>;
  /**
   * Mail account routing. Unset: the reader has no `mailRouting` and reads everything, as before. Set: the reader resolves it,
   * REQUIRES each read to carry the same fingerprint (a changed one is `mail_routing_changed`, like the helper), and only
   * messages whose account (`accountOf`, default 'acct-apple') is eligible exist for it.
   */
  routing?: AppleMailRouting;
  accountOf: Record<string, string>;
  /** Runs right after `mailRouting` answered: tests flip `routing` here to change the accounts mid-run. */
  afterRoutingRead?: () => void;
  /** The fingerprint every scoped read carried, in call order. */
  seenRouting: Array<{ kind: 'main' | 'byId'; fingerprint: string | undefined }>;
}
export const fakeMail = (box: AppleMailMessage[] = []): FakeMail => ({ box, unreadable: new Set(), deferred: new Set(), main: [], byId: [], dropById: new Set(), accountOf: {}, seenRouting: [] });

/** A routing fixture built without production code (the fingerprint is a plain function of the eligible ids and hosts). */
export function fakeRouting(spec: { apple?: Array<string | [string, string]>; google?: string[]; disabled?: string[]; unknown?: string[] }): AppleMailRouting {
  const eligible = (spec.apple ?? []).map((a) => (Array.isArray(a) ? { id: a[0], serverName: a[1], accountType: 'imap' } : { id: a, serverName: 'imap.example.com', accountType: 'imap' }))
    .sort((x, y) => (x.id < y.id ? -1 : 1));
  const unknown = (spec.unknown ?? []).map((id) => ({ id, reason: 'google_like_host' as const }));
  const observed = [
    ...eligible.map((a) => ({ id: a.id, serverName: a.serverName, accountType: a.accountType, enabled: true })),
    ...(spec.google ?? []).map((id) => ({ id, serverName: 'imap.gmail.com', accountType: 'imap', enabled: true })),
    ...(spec.disabled ?? []).map((id) => ({ id, serverName: 'imap.example.com', accountType: 'imap', enabled: false })),
    ...(spec.unknown ?? []).map((id) => ({ id, serverName: 'imap.google.com', accountType: 'imap', enabled: true })),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    version: 1, observed, accountIds: [...new Set(observed.map((a) => a.id))].sort(), fingerprint: `fp:${JSON.stringify(eligible.map((e) => [e.id, e.serverName, e.accountType]))}`,
    status: unknown.length ? 'unknown' : eligible.length ? ((spec.google ?? []).length ? 'mixed' : 'apple') : (spec.google ?? []).length ? 'google_only' : 'no_enabled_accounts',
    eligible, google: spec.google ?? [], disabled: spec.disabled ?? [], unknown,
  };
}
const cmp = (a: AppleMailMessage, b: AppleMailMessage): number => a.date.localeCompare(b.date) || a.id.localeCompare(b.id);

export function readersOf(f: FakeMail): AppleReaders {
  const verdict = (selected: AppleMailMessage[]): AppleMailListing => {
    const bad = f.outage ? selected : selected.filter((m) => f.unreadable.has(m.id));
    const deferredThreads = [...new Set(selected.filter((m) => f.deferred.has(m.threadId) && !bad.includes(m)).map((m) => m.threadId))];
    return {
      messages: structuredClone(selected.filter((m) => !bad.includes(m) && !f.deferred.has(m.threadId))),
      unavailableThreads: [...new Set([...bad.map((m) => m.threadId), ...deferredThreads])],
      unavailableMessages: bad.map((m) => ({ id: m.id, date: m.date, threadId: m.threadId })),
      deferredThreads,
    };
  };
  // With routing, a read exists only for the accounts of the routing it carried, and a changed account setup refuses it.
  const scope = (kind: 'main' | 'byId', carried: AppleMailRouting | undefined): AppleMailMessage[] => {
    if (!f.routing) return f.box;
    f.seenRouting.push({ kind, fingerprint: carried?.fingerprint });
    if (!carried) throw new AppleReaderError('helper_failed', 'mail', '--routing is required', 'pass the routing');
    if (carried.fingerprint !== f.routing.fingerprint) throw new AppleReaderError('mail_routing_changed', 'mail', 'the Mail accounts changed', 'run again');
    const eligible = new Set(f.routing.eligible.map((e) => e.id));
    return f.box.filter((m) => eligible.has(f.accountOf[m.id] ?? 'acct-apple'));
  };
  const echo = (): Pick<AppleMailListing, 'routing'> => (f.routing ? { routing: { version: f.routing.version, fingerprint: f.routing.fingerprint } } : {});
  const readers: AppleReaders = {
    async calendar() { return []; },
    async contacts() { return []; },
    async mail(opts) {
      f.main.push({ since: opts.since.toISOString(), ...(opts.after ? { after: opts.after } : {}), exclude: opts.exclude ?? [], max: opts.max });
      const visible = scope('main', opts.routing);
      if (f.failMain) throw f.failMain;
      if (f.budgetStop) return { messages: [], truncated: true, budgetExhausted: true, ...echo() };
      const excluded = new Set(opts.exclude ?? []);
      const all = visible.filter((m) => Date.parse(m.date) > opts.since.getTime() && !excluded.has(m.id)
        && (!opts.after || m.date > opts.after.date || (m.date === opts.after.date && m.id > opts.after.id))).sort(cmp);
      const max = opts.max ?? 500;
      return { ...verdict(all.slice(0, max)), truncated: all.length > max, ...echo() };
    },
    async probe() { return { ok: true as const }; },
    async mailMessages(opts) {
      const call = f.byId.length;
      f.byId.push(opts.targets.map((t) => ({ ...t })));
      f.onById?.(call);
      if (f.failById) throw f.failById;
      if (f.failByIdAt && f.failByIdAt.call === call) throw f.failByIdAt.error;
      const visible = scope('byId', opts.routing);
      const asked = opts.targets.filter((t) => !f.dropById.has(t.id));
      const found = asked.flatMap((t) => visible.filter((m) => m.id === t.id));
      const listing = verdict(found.sort(cmp));
      const notFound = asked.filter((t) => !visible.some((m) => m.id === t.id)).map((t) => t.id);
      // Not found in the scoped accounts proves the message is gone only when no account is routed away or disabled.
      const covers = !f.routing || (f.routing.google.length === 0 && f.routing.disabled.length === 0);
      return { ...listing, ...(covers ? { targetMissing: notFound } : { targetOutOfScope: notFound }), ...echo() };
    },
    ...(f.routing ? { async mailRouting() { const r = structuredClone(f.routing!); f.afterRoutingRead?.(); return r; } } : {}),
  };
  if (f.noById) delete readers.mailMessages;
  return readers;
}
