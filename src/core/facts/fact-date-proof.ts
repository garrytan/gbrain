import { z } from 'zod';
import { sha256 } from '../persistence/digest.ts';
import { claimDate } from './bulk-days.ts';

export const FACT_DATE_VERIFICATION = 'verify_fact_date';
export const FACT_DATE_REVOCATION = 'revoke_fact_date_verification';

const digestHex = z.string().regex(/^[a-f0-9]{64}$/);
export const DATE_CONTEXT_CHARS = 4096;
const ARCHIVE_REFERENCE = /\[\[[^\]\r\n]*|\]\(<[^>\r\n]*|\]\([^\)\r\n]*|^[ \t]*\[[^\]\r\n]+\]:[^\r\n]*|(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>()\[\]]+/gim;
export const factDateProof = z.strictObject({
  source_incarnation: z.uuid(),
  fact_id: z.int().positive(),
  fact_digest: digestHex,
  utc_day: z.iso.date(),
  original_page_id: z.int().positive(),
  original_revision: z.uuid(),
  excerpt_start: z.int().positive().max(2_147_483_647 - 4000),
  excerpt_length: z.int().positive().max(4000),
  excerpt_sha256: digestHex,
});
export type FactDateProof = z.infer<typeof factDateProof>;

export interface DateExcerpt { text: string; before: string; after: string }

export function matchesDatedExcerpt(proof: FactDateProof, archived: DateExcerpt | null): boolean {
  if (!archived || Array.from(archived.text).length !== proof.excerpt_length ||
      sha256(archived.text) !== proof.excerpt_sha256 || !/\p{L}/u.test(archived.text)) return false;
  const tokens = [...archived.text.matchAll(/[0-9]{4}-[0-9]{2}-[0-9]{2}/g)];
  if (!tokens.length || tokens.some(token => token[0] !== proof.utc_day)) return false;
  const nextDay = proof.utc_day === '9999-12-31' ? '9999-12-32'
    : new Date(Date.parse(proof.utc_day) + 86_400_000).toISOString().slice(0, 10);
  const date = claimDate(proof.utc_day, nextDay);
  if (!('date' in date) || date.date !== proof.utc_day) return false;
  const previousLine = archived.before.lastIndexOf('\n');
  const nextLine = archived.after.indexOf('\n');
  if ((previousLine < 0 && proof.excerpt_start > DATE_CONTEXT_CHARS + 1) ||
      (nextLine < 0 && Array.from(archived.after).length === DATE_CONTEXT_CHARS)) return false;
  const before = archived.before.slice(previousLine + 1);
  const line = before + archived.text + (nextLine < 0 ? archived.after : archived.after.slice(0, nextLine));
  const references = [...line.matchAll(ARCHIVE_REFERENCE)];
  return tokens.every(token => {
    const start = before.length + token.index;
    const suffix = line.slice(start + date.date.length);
    return !/[0-9]/.test(line.charAt(start - 1)) && !/^[0-9]|^[ \t]*[「『《“]/.test(suffix) &&
      !references.some(match => match.index <= start && start < match.index + match[0].length);
  });
}
