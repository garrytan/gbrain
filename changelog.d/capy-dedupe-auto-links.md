**`gbrain dedupe auto` links the duplicate person pages a labelled check showed are safe, and every link can be undone.**

<!-- behavior-change: dedupe_auto_links_gst3642 -->

### Added
- `gbrain dedupe auto` lists the pairs of person pages it would link and changes nothing; `--apply` links them. Only classes that passed a labelled sample link, today C2 (an email or phone that only those two person pages hold, in two sources, with names that differ only in form, such as a one-word handle beside a name). A pair of two full names that disagree, or with a page not every reader may read, is never linked, with or without a repository. Each link is a "same" decision recorded like your own confirm, with `decided_by: dedupe:auto:C2`: `gbrain dedupe undo <id>` removes one, `gbrain dedupe reject` keeps a pair apart for good, and `gbrain dedupe auto --off C2` removes them all and stops the class.
- `gbrain doctor` prints the last 24 hours of automatic links by class, with their undo commands (`dedupe_auto_links`).
- `gbrain dedupe sample --class C2 --since 7d --n 20` picks recent automatic links for the weekly check.

### Changed
- `gbrain dedupe classes` leaves out a page and its copy kept under the same slug in another source (counted as mirror copies), and keeps one pair where a third page paired with each copy; when the pages it pairs with are not copies of each other, every pair is kept.
- An account id that a page with another name also holds (an id copied between cofounders' pages) no longer counts as proof that two pages are one person; such a pair waits (C6).
- A page whose title reads as a room, a team, a shared mailbox or a business never links automatically.
- The family hold on automatic links reads each relationship value on its own and skips only labels and values that are someone else's (a family office, family friends, "wife of a colleague", a school parent). A full birth date counts for the minor hold, not just its year. Web search still leaves those pages out.
