/** Pure page-role evidence shared by link-type inference. */
import { stripCodeBlocks } from './markdown-code.ts';
import { rolePriorSuppressedRanges } from './machine-sections.ts';

// Page-role detection: if the source page describes a partner/investor at
// page level, that's a strong prior for outbound company refs being
// invested_in even when per-edge context lacks explicit investment verbs.
export const PARTNER_ROLE_RE = /\b(?:partner at|partner of|venture partner|VC partner|invested early|investor at|investor in|venture capital|early-stage investor|seed investor|fund [A-Z]|invests across|backs companies)\b/i;

// Advisor role prior: fires when the page-level description indicates the
// person IS an advisor (not just mentions advising). Broadened in v0.10.5
// from "full-time/professional/advises multiple" to catch any page that
// self-identifies the subject as an advisor.
export const ADVISOR_ROLE_RE = /\b(?:full-time advisor|professional advisor|advises (?:multiple|several|various)|is an? (?:advisor|security advisor|technical advisor|strategic advisor|industry advisor|product advisor|senior advisor)|took on advisory roles|(?:her|his|their) advisory (?:work|role|engagement|portfolio)|serves as (?:an )?advisor)\b/i;

// Employee role prior (new in v0.10.5): fires when the page-level description
// indicates the person IS an employee (senior/staff/lead engineer, director,
// head, etc.) at some company. Biases outbound company refs on that page
// toward works_at when per-edge verbs are absent (e.g. possessive phrasings
// "her work on Delta's pipeline..." where the verb "works" doesn't appear
// near the slug).
//
// Scope: only fires for person-page → company-page links. Companies' own
// pages mentioning their employees use the page-role layer differently.
/** The first match of each page-role prior in `text`: joined with newlines, they decide every prior exactly as the whole text does (no prior crosses a line). */
export function rolePriorPhrases(text: string): Array<string | null> {
  const cleanText = stripCodeBlocks(text);
  const suppressed = rolePriorSuppressedRanges(cleanText);
  let cursor = 0;
  let prose = '';
  for (const [start, end] of suppressed) {
    prose += cleanText.slice(cursor, start) + '\n';
    cursor = end;
  }
  prose += cleanText.slice(cursor);
  return [PARTNER_ROLE_RE, ADVISOR_ROLE_RE, EMPLOYEE_ROLE_RE].map(re => re.exec(prose)?.[0] ?? null);
}

export const EMPLOYEE_ROLE_RE = /\b(?:is an? (?:senior|staff|principal|lead|backend|frontend|full-?stack|ML|data|security|DevOps|platform)? ?engineer at|is an? (?:senior|staff|principal|lead)? ?(?:developer|designer|product manager|engineering manager|director|VP) (?:at|of)|holds? the (?:CTO|CEO|CFO|COO|CMO|CRO|VP) (?:role|position|seat|title) at|is the (?:CTO|CEO|CFO|COO|CMO|CRO) of|employee at|on the team at|works on .{0,30} at)\b/i;
