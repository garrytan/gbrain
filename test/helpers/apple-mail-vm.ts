/**
 * Synthetic Mail.app for tests that run the REAL scripts/apple/mail.js in a vm: accounts with public metadata and
 * per-account mailboxes, and a harness that stops at the helper's first exit like the real `$.exit`. No macOS, no Mail,
 * no private data; placeholders only. Every account getter outside the public metadata set TRAPS (records and throws), so a
 * helper that reads a password, user name, email address, full name or display name fails the test that asked for it.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MAIL_SCRIPT } from '../../src/core/apple/readers/mail.ts';

export type Getter = unknown | (() => never);

export interface VmAccountSpec {
  id: string | Getter;
  serverName?: unknown;
  accountType?: unknown;
  enabled?: unknown;
  /** Top-level mailboxes, in the order Mail lists them: display name -> mailbox object (with `messages`). */
  mailboxes?: Array<[string, unknown]>;
  /** Optional nested mailboxes, for example a second Sent box under a different display name. */
  children?: Array<[string, unknown]>;
  /** Public getters that throw (a metadata failure). */
  throwOn?: Array<'id' | 'serverName' | 'accountType' | 'enabled'>;
}

/** Names of the account properties the helper must NEVER read. */
export const FORBIDDEN_ACCOUNT_GETTERS = ['userName', 'emailAddresses', 'fullName', 'name', 'password', 'authentication', 'port', 'delivery_account'] as const;

export function vmAccount(spec: VmAccountSpec, forbiddenCalls: string[] = []): Record<string, unknown> {
  const throws = new Set(spec.throwOn ?? []);
  const metadata = (key: 'id' | 'serverName' | 'accountType' | 'enabled', value: unknown) => (): unknown => {
    if (throws.has(key)) throw new Error(`synthetic ${key} failure`);
    return value;
  };
  const acct: Record<string, unknown> = {
    id: metadata('id', spec.id),
    serverName: metadata('serverName', spec.serverName),
    accountType: metadata('accountType', spec.accountType),
    enabled: metadata('enabled', spec.enabled === undefined ? true : spec.enabled),
    mailboxes: () => (spec.mailboxes ?? []).map(([name, mb]) => {
      const box = Object.assign(mb as object, { name: () => name });
      const children = (spec.children ?? []).map(([childName, child]) => Object.assign(child as object, { name: () => childName }));
      return Object.assign(box, { mailboxes: () => children });
    }),
  };
  for (const f of FORBIDDEN_ACCOUNT_GETTERS) acct[f] = () => { forbiddenCalls.push(f); throw new Error(`the helper must not read an account's ${f}`); };
  return acct;
}

export interface VmRun { doc: any; exitCode: number | null; output: string }

/** Runs `run(argv)` of the real mail.js against `mailApp`. The first exit/emit wins and stops the script, as in osascript. */
export function runMailHelper(mailApp: unknown, argv: string[], extra: Record<string, unknown> = {}): VmRun {
  const js = readFileSync(MAIL_SCRIPT, 'utf8');
  let output = '';
  let exitCode: number | null = null;
  class Exit extends Error { constructor() { super('exit'); } }
  const $: any = (value: string) => ({ dataUsingEncoding: () => value });
  $.NSUTF8StringEncoding = 1;
  $.NSFileHandle = { fileHandleWithStandardOutput: { writeData: (v: string) => { if (output === '') output = v; } } };
  $.exit = (code: number) => { if (exitCode === null) exitCode = code; throw new Exit(); };
  const sandbox = { ObjC: { import() {} }, $, Application: () => mailApp, console, ...extra };
  try { runInNewContext(`${js}\nrun(${JSON.stringify(argv)});`, sandbox); } catch (e) { if (!(e instanceof Error) || e.message !== 'exit') { if (exitCode === null) throw e; } }
  return { doc: output ? JSON.parse(output) : null, exitCode, output };
}

/** A mailbox with `ids` and received `dates` (message bodies `body-<mailbox>-<id>`), usable inside a vmAccount. */
export function vmMailbox(label: string, ids: number[], dates: Record<number, Date>, hooks: { contentCalls?: number[][] } = {}): Record<string, unknown> {
  return {
    messages: {
      whose: (query: any) => {
        let idx = [...ids];
        for (const clause of Array.isArray(query?._and) ? query._and : [query]) {
          const newerThan = clause?.dateReceived?._greaterThan;
          const notAfter = clause?.dateReceived?._lessThanEquals;
          if (newerThan instanceof Date) idx = idx.filter((i) => dates[i]!.getTime() > newerThan.getTime());
          if (notAfter instanceof Date) idx = idx.filter((i) => dates[i]!.getTime() <= notAfter.getTime());
        }
        if (Array.isArray(query?._or)) {
          const wanted = new Set(query._or.map((x: any) => x.id._equals));
          idx = idx.filter((i) => wanted.has(i));
        }
        const rfc = (i: number) => `<${label}-${i}>`;
        return {
          id: () => [...idx], messageId: () => idx.map(rfc), subject: () => idx.map((i) => `subject ${i}`),
          sender: () => idx.map(() => 'Alice Example <alice-example@example.com>'), dateReceived: () => idx.map((i) => dates[i]),
          readStatus: () => idx.map(() => true), allHeaders: () => idx.map((i) => `Message-ID: ${rfc(i)}`),
          content: () => { hooks.contentCalls?.push([...idx]); return idx.map((i) => `body-${label}-${i}`); },
        };
      },
    },
  };
}

export const ROUTE_ACCOUNT = { id: 'acct-example-1', server_name: 'imap.example.com', account_type: 'imap' };
/** `--routing` for the single synthetic account that `singleAccountApp` builds. */
export const ROUTE_ARGV = ['--routing', JSON.stringify({ eligible: [ROUTE_ACCOUNT], account_ids: [ROUTE_ACCOUNT.id], observed: [{ id: ROUTE_ACCOUNT.id, server_name: ROUTE_ACCOUNT.server_name, account_type: ROUTE_ACCOUNT.account_type, enabled: true }] })];

/** A Mail.app with one enabled IMAP account (`imap.example.com`) holding the given mailboxes by display name. */
export function singleAccountApp(mailboxes: Record<string, unknown>, over: { accountsHook?: () => void } = {}): Record<string, unknown> {
  const acct = vmAccount({ id: ROUTE_ACCOUNT.id, serverName: ROUTE_ACCOUNT.server_name, accountType: ROUTE_ACCOUNT.account_type, mailboxes: Object.entries(mailboxes) });
  return { running: () => true, accounts: () => { over.accountsHook?.(); return [acct]; } };
}
