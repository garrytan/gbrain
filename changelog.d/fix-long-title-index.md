---
important: data-loss
---
**Brains with page titles longer than about 2,700 bytes upgrade again, and pages with long titles save instead of being refused (#9779).**

### Fixed
- The index behind exact-title lookups (`entity`, `whois`, context cards, search's alias check) was a btree on the lowercased title, and a btree entry must fit in 2,704 bytes. Upgrading a brain that already held a longer title stopped with "index row requires N bytes, maximum size is 8191", and on an upgraded brain saving such a page failed with `storage_error` ("index row size N exceeds btree version 4 maximum 2704"). The index is now a hash index on the lowercased title, which indexes a title of any length; the lookups are unchanged and still use it. Brains that already built the old index get the new one built online, then the old one dropped online, on the next upgrade. Reported by @mweber82.
- Transcript imports cap the title of a new page at 200 characters, ending in an ellipsis when cut. Some harnesses report a session's opening text as its title, which ran to over 100 KB. Pages already imported keep their titles.

<!-- behavior-change: transcript_title_cap_9779 -->
