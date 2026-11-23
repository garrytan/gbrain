**Held writes now stay held when their page is renamed.**

When the write gate holds a fact or take for your review, it now remembers which page it was held for by the page's permanent id, not just its name. Before, renaming the page (a Git rename picked up by sync, or `gbrain repair rename-identity`) made the held row show up in answers under the new name without you releasing it, and a different page that later took the old name inherited the hold.

- A held write recorded before any page had its name is claimed by the first page created there.
- Releasing a held fact publishes it on the page it was held for, under that page's current name. If that page is gone, the release is refused and the fact stays held.
- Purging a page removes only the holds that belong to that page.
- On upgrade, existing holds are matched to their page from the page that holds the name and the rename history. A hold that cannot be matched to one page stays held for every page it could belong to and is listed by the new `gbrain doctor` check `write_gate_hold_ambiguous`; drop it in `gbrain trust review`. Identical duplicates are merged; a duplicate that differs is kept.

<!-- behavior-change: held_writes_follow_page_rename -->

### For contributors
- Migration v337 adds `write_gate_holds.page_id` and `page_candidates`, with two disjoint partial unique indexes (bound on source, page id, fingerprint and detector version; unbound on source, slug, fingerprint and detector version). `recordWriteGateHold` takes an optional `pageId` that producers who already read the page pass; without it the page is found inside the same INSERT, with no page lock. The page-insert path binds waiting holds, `movePageIdReferences` carries holds with the page, and the purge sweeps delete by id (by slug only for unbound holds).
- The migrations golden test ignores versions 332 to 336 while they are gaps, because those numbers belong to migrations landing on other branches.
- The Rust engine's own hold store and rename paths still have to match this: see the contract in the pull request description.
