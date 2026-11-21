**The one-time re-read after the frontmatter upgrade no longer pays the model again for a page it already scanned or judged, loses the cost of a judgment still running, gives a failing page extra paid tries, or breaks the retry of a held page.**

### Fixed
- A page whose title reads differently under the old frontmatter typing (title: 1.10) keeps its atom scan state through the re-read, so no paid scan runs again. (pages-03)
- A chronicle judgment that is running, or waiting out a retry delay, when the re-read changes its page keeps its row, its cost and its campaign limit: the re-read never moves such a row, also when its lease ended or its campaign ran out of attempts while the model was still answering. The page is then judged once more at its new content, outside the campaign. A page the re-read renamed is judged at its new path, and a page with extraction turned off stays unjudged. (pages-03)
- The re-read keeps scan and judging state only for a page the older importer stored, so a page today's importer wrote (for example a title edited from 1.1 to 1.10) is scanned again. (pages-03)
- A page changed after the older importer stored it (for example a body edit that kept the title) is scanned and judged again after the re-read, instead of keeping state for content it no longer has. (pages-03)
- A late chronicle judgment does not change the decision recorded for the page's new content (for example extraction turned off), and events it wrote just before the re-read stay owned by the page. An event you edited by hand in that moment is never taken over, so a later judgment keeps your edit. (pages-03)
- A page with failed paid atom extractions gets only the tries it had left after the re-read, also when the input cap cut the page and the request receipts were already cleaned up. (pages-03)
- The retry shown for a held page works after the re-read, also when the same sync renamed the page; the held list shows the new name. (pages-03)
- An older page whose id an earlier release stored as a number (id: 007 stored as 7) keeps its identity across a rename only when its import record shows the earlier release imported it and it has not been written since. A page with no import record now refuses a file that says id: 007 as page_identity_changed; write the id as the page stores it (id: 7) to keep that page. (pages-03)

<!-- behavior-change: older_id_rename_needs_record_pages03 -->
