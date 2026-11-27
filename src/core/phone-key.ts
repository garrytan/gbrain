/**
 * The canonical form of a phone number for exact identity matching (whois's phone arm, the apple-contacts matcher):
 * `+` followed by the country code and the national number, digits only (E.164 shape). The rule, with nothing fuzzy
 * in it (no last-N-digits, no partial or prefix match):
 *
 *   1. An extension is dropped: everything from `;`, `,`, `#`, `ext` or `x` before a digit.
 *   2. What is left may hold only digits, spaces, `- . ( ) /` and one leading `+`; anything else (a letter, a vanity
 *      number) has no canonical form.
 *   3. A number written with `+`, or with the international prefix `00` (and `011` when the default country is 1),
 *      already carries its country code.
 *   4. A number written without one gets the default country code (config `identity.phone_country_code`, default 1):
 *      for 1 (North America) exactly 10 digits, or 11 starting with 1; for any other code one leading trunk 0 is dropped.
 *   5. The result must have 8 to 15 digits and must not start with 0; otherwise the number has no canonical form.
 *
 * Two numbers match only when their canonical forms are equal.
 */
export const DEFAULT_PHONE_COUNTRY_CODE = '1';
export const PHONE_COUNTRY_CODE_CONFIG_KEY = 'identity.phone_country_code';

export function parsePhoneCountryCode(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().replace(/^\+/, '') : '';
  return /^[1-9]\d{0,2}$/.test(value) ? value : DEFAULT_PHONE_COUNTRY_CODE;
}

export function canonicalPhone(raw: string, countryCode: string = DEFAULT_PHONE_COUNTRY_CODE): string | null {
  const s = raw.normalize('NFKC').replace(/[\u00a0\u2000-\u200b\u2010-\u2015]/g, ' ').trim()
    .replace(/\s*(?:[;,#]|(?:ext(?:ension)?\.?|x)\s*\d).*$/i, '');
  if (!s || /[^0-9+\-.()/\s]/.test(s) || s.lastIndexOf('+') > 0) return null;
  const digits = s.replace(/\D/g, '');
  let full: string;
  if (s.startsWith('+')) full = digits;
  else if (digits.startsWith('00')) full = digits.slice(2);
  else if (countryCode === '1' && digits.startsWith('011')) full = digits.slice(3);
  else if (countryCode === '1') {
    if (digits.length === 10) full = `1${digits}`;
    else if (digits.length === 11 && digits.startsWith('1')) full = digits;
    else return null;
  } else full = countryCode + digits.replace(/^0/, '');
  return full.length >= 8 && full.length <= 15 && !full.startsWith('0') ? `+${full}` : null;
}

/**
 * The digit strings a stored value of the same number can reduce to (its digits with every separator removed), for a
 * candidate read that the caller then verifies with canonicalPhone: the full number, with `00` (or `011`), and the
 * national number with and without a trunk 0 when it carries the default country code.
 */
export function phoneProbeDigits(canonical: string, countryCode: string = DEFAULT_PHONE_COUNTRY_CODE): string[] {
  const full = canonical.replace(/^\+/, '');
  const out = [full, `00${full}`, ...(countryCode === '1' ? [`011${full}`] : [])];
  if (full.startsWith(countryCode)) {
    const national = full.slice(countryCode.length);
    out.push(national, `0${national}`);
  }
  return [...new Set(out)];
}
