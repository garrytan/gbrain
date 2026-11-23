**A page saved under an older spelling of its name (capitals, or a decomposed accent) can now be moved to its normal name, so replacing it and importing its file work again.**

### Added
- `gbrain repair slug-spelling --source <id>` previews every page stored under an older spelling and what would happen to each; `--apply --expect <hash> --yes` moves the ones that can move. A moved page keeps its id, versions, tags, timeline, links, facts and attachments, and the old spelling keeps opening it.
- A page whose normal name is already used by another page is never moved; the preview lists the pair so a person can merge them. A page whose file in a Git folder still has the old spelling is listed with the fix "rename the file first, then sync", because moving only the database row would split the page from its file.
- `gbrain doctor` warns `legacy_slug_spellings` with how many such pages each source has and the command to preview.
- A moved page keeps its protections: purged facts and takes stay refused under the normal name, and the move waits for an edit already under way instead of moving a page that changed.
- A page with a held (quarantined) write under either spelling is never moved: the preview lists it as needing a person (`slug_spelling_held_writes`) and says to release or drop the held writes first (`gbrain trust release` / `gbrain trust drop`). A held write that appears after the preview refuses the move for that page. One gap remains: a held write recorded for the old spelling by a transaction that commits while the move runs can still name the old spelling afterwards; `gbrain doctor` and a new preview list the page again.
- The repair refuses, before moving anything, when the database role cannot read the purge and held-write tables.
- On a managed brain the repair is unavailable and says a person is needed; the page stays readable and editable by its stored spelling.

### Changed
- The refusal of a replace by an older spelling, and the message that holds an import of such a page, now name `gbrain repair slug-spelling --source <id>` instead of saying a fix is coming.

<!-- behavior-change: legacy_slug_put_names_repair -->
