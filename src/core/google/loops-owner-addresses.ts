/**
 * #10094 `loops.owner_addresses`: the owner's other mailboxes (ones that forward into the connected Gmail account
 * without being its send-as aliases). Gmail sync adds them to the identity set (the account plus its send-as aliases,
 * sweep-shared.ts myAddressSet), so mail from them is the owner's own: it opens no reply-owed loop, and a reply sent
 * from one closes the thread as answered. Brain-wide; read once per sync.
 */
import type { BrainEngine } from '../engine.ts';
import type { CredentialEntry } from '../creds/vault.ts';
import { myAddressSet } from './sweep-shared.ts';
import { bareAddress } from './types.ts';

export const LOOPS_OWNER_ADDRESSES_KEY = 'loops.owner_addresses';
const MAILBOX = /^[^\s@<>,;"()]+@[^\s@<>,;"()]+\.[^\s@<>,;"()]+$/;

/**
 * A comma-, semicolon- or newline-separated list (or a JSON array) of mailboxes, each bare or `Name <address>`,
 * normalized like a Gmail From header (bareAddress: lowercased) and deduplicated. Empty means none; null means an entry
 * is not a mailbox.
 */
export function parseLoopOwnerAddresses(raw: string | null | undefined): string[] | null {
  const text = (raw ?? '').trim();
  if (!text) return [];
  let entries: unknown[];
  if (text.startsWith('[')) {
    try { entries = JSON.parse(text) as unknown[]; } catch { return null; }
    if (!Array.isArray(entries)) return null;
  } else entries = text.split(/[,;\n]/);
  const out = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'string') return null;
    if (!entry.trim()) continue;
    const address = bareAddress(entry);
    if (!MAILBOX.test(address)) return null;
    out.add(address);
  }
  return [...out];
}

/** Null when `gbrain config set` may store `value` for `key`; otherwise the refusal text (nothing is written). */
export function validateLoopOwnerAddressesConfigValue(key: string, value: string): string | null {
  if (key !== LOOPS_OWNER_ADDRESSES_KEY || parseLoopOwnerAddresses(value) !== null) return null;
  return `${key} must be a comma-separated list of email addresses (e.g. me@example.net, Me <me@example.org>); got "${value}". Nothing was written.`;
}

/** The configured addresses; a stored value that does not parse adds none and says so once per sync. */
export async function readLoopOwnerAddresses(engine: BrainEngine, log: (msg: string) => void): Promise<string[]> {
  const raw = await engine.getConfig(LOOPS_OWNER_ADDRESSES_KEY);
  const parsed = parseLoopOwnerAddresses(raw);
  if (parsed === null) log(`[google] ${LOOPS_OWNER_ADDRESSES_KEY} is not a list of email addresses; no extra owner addresses apply. Fix it with gbrain config set ${LOOPS_OWNER_ADDRESSES_KEY} "<a>, <b>".`);
  return parsed ?? [];
}

/** #10094: the identity set every "is this mine" decision of a sync reads: the account, its send-as aliases and, for Gmail, loops.owner_addresses. */
export async function ownerAddressSet(engine: BrainEngine, entry: CredentialEntry, gmail: boolean, log: (msg: string) => void): Promise<Set<string>> {
  const out = myAddressSet(entry);
  if (gmail) for (const address of await readLoopOwnerAddresses(engine, log)) out.add(address);
  return out;
}
