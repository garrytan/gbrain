**A page saved under an older spelling of its name (capitals, or a decomposed accent) can now be moved to its normal name, so replacing it and importing its file work again.**

### Added
- `gbrain repair slug-spelling --source <id>` previews every page stored under an older spelling and what would happen to each; `--apply --expect <hash> --yes` moves the ones that can move. A moved page keeps its id, versions, tags, timeline, links, facts and attachments, and the old spelling keeps opening it.
- A page whose normal name is already used by another page is never moved; the preview lists the pair so a person can merge them. A page whose file in a Git folder still has the old spelling is listed with the fix "rename the file first, then sync", because moving only the database row would split the page from its file.
- `gbrain doctor` warns `legacy_slug_spellings` with how many such pages each source has and the command to preview.
- A moved page keeps its protections: purged facts and takes stay refused under the normal name, and the move waits for an edit already under way instead of moving a page that changed.
- A page with a held (quarantined) write moves like any other, and the held write stays hidden on the moved page, including one written under the old spelling while or after the move runs. Held writes are not changed: `gbrain trust review` lists them as before.
- The repair refuses, before moving anything, when row-level security applies for the database role to any table of the brain; run it as the table owner or a role with BYPASSRLS. The doctor check then says the count is unknown instead of ok.
- Another stored spelling of the same name stops the move even when the preview's scan did not reach it.
- On a managed brain the repair is unavailable and says a person is needed; the page stays readable and editable by its stored spelling.

### Changed
- The refusal of a replace by an older spelling, and the message that holds an import of such a page, now name `gbrain repair slug-spelling --source <id>` instead of saying a fix is coming.

<!-- behavior-change: legacy_slug_put_names_repair -->
- On a Postgres database whose encoding is not UTF8, the upgrade skips the new spelling index instead of stopping, and the repair refuses (`slug_spelling_encoding`) without reading anything.
