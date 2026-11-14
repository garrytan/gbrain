/**
 * GBRA-504: a read's human output names every outside-guest note it returned, one warning line each, rendered from
 * the stamped guest fields (guests/stamp.ts). search, query and get_page print the line beside the row themselves
 * (search-row-format.ts, page-render.ts); `--json` carries origin and the guest object instead.
 */
import { guestWarningLine, type GuestStamp } from '../core/guests/marker.ts';

const SELF_RENDERED: ReadonlySet<string> = new Set(['search', 'query', 'get_page']);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function guestLines(v: unknown, out: Set<string>, depth = 0): Set<string> {
  if (depth > 8) return out;
  if (Array.isArray(v)) { for (const x of v) guestLines(x, out, depth + 1); return out; }
  if (!isObj(v)) return out;
  if (v.origin === 'guest' && isObj(v.guest)) {
    const slug = typeof v.slug === 'string' ? v.slug : typeof v.from_slug === 'string' ? v.from_slug : typeof v.page_id === 'number' ? `page ${v.page_id}` : 'unnamed';
    out.add(`${guestWarningLine(v.guest as unknown as GuestStamp)} ${typeof v.source_id === 'string' ? `${v.source_id}:` : ''}${slug}`);
  }
  for (const [k, x] of Object.entries(v)) if (k !== 'guest') guestLines(x, out, depth + 1);
  return out;
}

export function withGuestLines(op: string, result: unknown, params: Record<string, unknown>, output: string): string {
  if (!output || params.json === true || SELF_RENDERED.has(op)) return output;
  const lines = [...guestLines(result, new Set())];
  return lines.length ? `${lines.join('\n')}\n${output}` : output;
}
