**The swap report no longer says criterion 5 covers "page and link writes"; it says which five writes it compares and names the rest.**

### Changed
- Criterion 5 compares only five writes: `putPage`, `deletePage`, `addLink`, `addLinksBatch` and `removeLink`. The swap report, the shadow status line and the swap guide now say "the pilot page and link writes" and name those five, instead of "page and link writes".
- The report's last line (the named loss) now lists the 24 other page and link writes by name (for example `pages:softDeletePage`, `pages:updateSlug`, `links:replaceDerivedLinks`). Each of them is counted `capability_missing`, as before.
- A test builds that list from the code, so a new page or link write fails it until the text names it.
- Wording only. Nothing about pass or fail changes, and no new write is compared.
