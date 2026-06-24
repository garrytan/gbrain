import type { Page } from '../types.ts';

/**
 * Some imported skill/docs trees use page type `email` because the skill is
 * about email, not because the page body is an email transcript. Those pages
 * are valuable documentation, but they should not trigger conversation parser
 * coverage warnings or bulk conversation-facts extraction.
 */
export function isConversationFactsCandidatePage(page: Page): boolean {
  if (page.type !== 'email') return true;

  const slug = page.slug.toLowerCase();
  if (
    slug.startsWith('skills/email/') ||
    slug.startsWith('optional-skills/email/') ||
    /^skills\/[^/]+\/skill$/.test(slug) ||
    /^optional-skills\/[^/]+\/skill$/.test(slug)
  ) {
    return false;
  }

  return true;
}
