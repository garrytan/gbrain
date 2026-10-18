/**
 * #5012 item 6: changing the contextual retrieval mode (`config set
 * search.contextual_retrieval`, `sources set-cr-mode`) does not restamp
 * existing pages: each keeps the mode recorded when it was imported, and the
 * new value applies to pages imported from then on. Only pages with no
 * recorded mode are stamped by `gbrain repair contextual-mode`. Printed after
 * the value is written.
 */
export function contextualModeHint(sourceId?: string): string {
  const scope = sourceId ? ` --source ${sourceId}` : '';
  return 'Existing pages keep the contextual retrieval mode recorded when they were imported; the new mode applies to pages imported from now on.\n'
    + `Pages with no recorded mode get one from: gbrain repair contextual-mode${scope} --apply (preview first: gbrain repair contextual-mode${scope})`;
}
