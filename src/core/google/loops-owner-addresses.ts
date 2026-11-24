export const LOOPS_OWNER_ADDRESSES_KEY = 'loops.owner_addresses';

/** Comma-separated plain mailboxes, normalized like the Gmail message headers. */
export function parseLoopOwnerAddresses(raw: string | null | undefined): string[] | null {
  const addresses = (raw ?? '').split(',').map(address => address.trim().toLowerCase());
  if (addresses.length === 1 && addresses[0] === '') return [];
  return addresses.every(address => /^[^@\s,<>]+@[^@\s,<>]+$/.test(address)) ? addresses : null;
}
