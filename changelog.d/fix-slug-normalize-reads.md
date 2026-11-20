**gbrain get, links, tags, timeline and every other slug read now find a page whatever its capitals or accent encoding, and an accented slug can no longer exist twice.**

### Fixed
- A slug read with capitals (`gbrain get People/Alice-Example`) finds the page that put stored as `people/alice-example`, instead of answering page not found with a soft-delete hint.
- Slugs are stored and read in one Unicode form (NFC), so `notes/café` typed composed or decomposed is one page, not two pages that look the same and block export.
- A wikilink written in decomposed form links the existing accented page instead of reporting it as a page to create.
- A fact saved with `remember --entity people/ünal-example` before the page exists keeps the accented slug, so the entity card and recall show it once the page is created.

<!-- behavior-change: slug_reads_normal_form -->
