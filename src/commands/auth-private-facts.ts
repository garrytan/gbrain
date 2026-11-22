/**
 * GBRA-575 (Discussion #8194): how `gbrain auth` shows the private-facts grant: its label in `auth clients` and
 * `auth rescope`, the warning rescope prints when it turns on, and its help lines. commands/auth.ts imports these.
 */
import type { PrivateFactsGrant } from '../core/grants/model.ts';

/** The plain warning printed when a credential's private-facts grant turns on. */
const WARNING = '  This key will read every private fact in the sources its grant names, including facts saved private on purpose.\n'
  + '  Facts on a private, readable_by, folder-ruled, quarantined or member page, and facts with no page to check\n'
  + '  (conversation archive, transcripts), stay hidden. Turn it off with --private-facts none.';

/** The private-facts axis as `auth clients` and `auth rescope` print it (`auth list` prints the mode alone). */
export function renderPrivateFacts(mode: PrivateFactsGrant | undefined): string {
  return mode === 'granted_sources' ? 'granted-sources (private facts in the sources this grant names)' : 'none';
}

/** The warning, when the grant goes from none to granted-sources; nothing otherwise. */
export function privateFactsWarning(before: PrivateFactsGrant | undefined, after: PrivateFactsGrant | undefined): string[] {
  return before !== 'granted_sources' && after === 'granted_sources' ? [WARNING] : [];
}

/** A token rescope's private-facts lines: the before/after line and the warning; nothing when it is none on both sides. */
export function privateFactsRescopeLines(before: PrivateFactsGrant | undefined, after: PrivateFactsGrant | undefined): string[] {
  if (!before && !after) return [];
  const [was, now] = [renderPrivateFacts(before), renderPrivateFacts(after)];
  return [`  Private facts: ${was === now ? now : `${was} -> ${now}`}`, ...privateFactsWarning(before, after)];
}

/** The `--private-facts` lines of `gbrain auth --help`. */
export const PRIVATE_FACTS_HELP = `     --private-facts <granted-sources|none>               Remote reads see every fact stamped private in the sources
                                                          this grant lists, including facts saved private on purpose;
                                                          never one on a private, readable_by, folder-ruled,
                                                          quarantined or member page, or a fact with no page to check
                                                          (transcripts); no fact is rewritten; 'none' (default)
                                                          hides them`;
