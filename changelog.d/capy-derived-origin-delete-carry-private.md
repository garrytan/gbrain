---
important: security
---

**Deleting a private page no longer opens the pages derived from it: each page that was private only because of the deleted page now gets its own `visibility: private` label before the deleted page's row goes.**

<!-- behavior-change: derived_origin_carry_private_gst2689 -->

### Fixed

- A summary whose `derived_from` names a private page, an atom extracted from a private page, and a synthesized concept built from such an atom read as private to remote callers even when their own label says world, because their origin is private. Once the origin's row was removed (an explicit `gbrain delete --purge`, or the purge after the 72-hour recovery window, including after a remote delete or a `git rm`), nothing kept them private any more, and every remote caller that is not the owner could read them through `get_page`, `get_versions`, `list_pages` and search.
- Now gbrain gives each such page `visibility: private` first, as a label-only write. The page keeps its trust tier, no lowering proposal is filed, and on a brain with Git only the label line of its file changes. A soft delete (local or over MCP) writes the label once the delete committed, as a maintenance write (on a managed brain its batch names the delete's request id); if that write fails, the delete still goes through and the purge writes the label later. The delete's response is unchanged and names none of the labelled pages. Every purge writes the label again for each origin expired or expiring within a day before it removes any row, so an origin removed outside gbrain is covered from the next cycle.
- Pages that are already private, pinned questions and pages that do not derive from the deleted page are never changed. A page that names readers (`readable_by`) and was hidden from them only through its private origin gets the label too and keeps its readers, so its listed readers still can't read it. The owner, a `granted_sources` credential and a listed reader read exactly the same pages as before.
- When a label cannot be written (for example a file in the checkout that gbrain may not write), the deleted page is kept soft-deleted instead of purged. An explicit purge returns `purge_held`, the purge phase lists the page as `derived_origin_parked` and warns, and the new doctor check `derived_origin_parked` names the page with the derived page that blocks it and the reason. Once the cause is fixed, the next purge writes the label and frees the page, and the purge after removes it (a consented `gbrain pages purge-deleted --yes` does both, so its preview lists it). A derived page that is itself soft-deleted holds the deleted page the same way until it is purged or restored, so restoring it never brings it back readable.
- A deleted page that is restored and later made world leaves its derived pages private until the owner relabels them. (GST-2689)
