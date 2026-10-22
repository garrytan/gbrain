/**
 * CLI half of the bounded-listing contract (#7246): `--limit`, `--cursor` and
 * `--all` parsing and the next page argv. Kept apart from bounded-listing.ts
 * so a command that only caps rows does not inherit these flags in the
 * generated CLI flag registry.
 */
import { opError } from './ops/contract.ts';
import { LISTING_DEFAULT_LIMIT, type ListingPage, type ListingRequest } from './bounded-listing.ts';

/**
 * Parses --limit/--cursor/--all out of argv for a CLI listing. Returns the
 * request and the argv without --cursor (the base for next_command, so the
 * next page keeps the caller's --limit).
 */
export function parseListingFlags(args: readonly string[], command: string): { request: ListingRequest; rest: string[] } {
  let limit: number | undefined;
  let cursor: string | undefined;
  let all = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const eq = token.indexOf('=');
    const flag = eq < 0 ? token : token.slice(0, eq);
    const inline = eq < 0 ? undefined : token.slice(eq + 1);
    if (token === '--all') { all = true; continue; }
    if (flag !== '--limit' && flag !== '--cursor') { rest.push(token); continue; }
    const value = inline ?? args[++i];
    if (value === undefined || value === '' || (inline === undefined && value.startsWith('--'))) {
      throw opError('invalid_params', `${flag} needs a value.`, `Example: ${command} ${flag === '--limit' ? `--limit ${LISTING_DEFAULT_LIMIT}` : '--cursor <next_cursor>'}`);
    }
    if (flag === '--cursor') { cursor = value; continue; }
    rest.push(...(inline === undefined ? [flag, value] : [token]));
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      throw opError('invalid_params', `--limit must be a positive integer (got "${value}").`, `Example: ${command} --limit ${LISTING_DEFAULT_LIMIT}, or --all for every row.`);
    }
    limit = n;
  }
  if (all && (limit !== undefined || cursor !== undefined)) {
    throw opError('invalid_params', '--all lists every row, so it takes no --limit or --cursor.', `Use ${command} --all, or ${command} --limit <n> [--cursor <next_cursor>].`);
  }
  return { request: { limit: all ? null : (limit ?? LISTING_DEFAULT_LIMIT), ...(cursor !== undefined ? { cursor } : {}) }, rest };
}

/** The argv of the next page, or null when the page was the last one. */
export function nextListingCommand(base: readonly string[], page: Pick<ListingPage<unknown>, 'next_cursor'>): string[] | null {
  return page.next_cursor === null ? null : [...base, '--cursor', page.next_cursor];
}
