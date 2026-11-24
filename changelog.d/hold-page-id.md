**Held writes now stay held when their page is renamed.**

When the write gate holds a fact or take for your review, it now remembers which page it was held for by the page's permanent id, not just its name. Before, renaming the page (a Git rename picked up by sync, or `gbrain repair rename-identity`) made the held row show up in answers under the new name without you releasing it, and a different page that later took the old name inherited the hold.

- A held write recorded before any page had its name is claimed by the first page created there.
- Releasing a held fact publishes it on the page it was held for, under that page's current name. If that page is gone, the release is refused and the fact stays held.
- Purging a page removes only the holds that belong to that page; a hold that could belong to several pages stays until the last of them is purged.
- On upgrade, existing holds are matched to their page from the page that holds the name and its rename record (the rename history and the older aliases). A hold that cannot be matched to one page stays held for every page it could belong to and is listed by the new `gbrain doctor` check `write_gate_hold_ambiguous`; drop it in `gbrain trust review`. Identical duplicates are merged; a duplicate that differs is kept.
- The `gbrain doctor` check `write_gate_holds_stranded` now ignores holds that follow their page: a hold bound to a page that exists, or an unbound one that the rename record leads to a live page, is not reported, because renaming the page no longer lifts it. It lists only the holds that no live page matches (a soft-deleted page, or no page yet), as information, and still warns when it cannot count.
- Known limit: if two purges run at the same time on pages that share a reused name, a held write can be left behind. It stays hidden and is never shown. `gbrain trust review` shows it, and the owner can remove it with `gbrain trust drop`. A later maintenance sweep will remove these automatically.

<!-- behavior-change: held_writes_follow_page_rename -->

### For contributors
- Migration v333 adds `write_gate_holds.page_id` and `page_candidates`, with two disjoint partial unique indexes (bound on source, page id, fingerprint and detector version; unbound on source, slug, fingerprint and detector version). `recordWriteGateHold` takes an optional `pageId` that producers who already read the page pass; without it the page is found inside the same INSERT, with no page lock. The page-insert path binds waiting holds, `movePageIdReferences` carries holds with the page, and the purge sweeps delete by id (by slug only for unbound holds).
- The Rust engine's own hold store and rename paths still have to match this: see the contract in the pull request description.
