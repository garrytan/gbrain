**`gbrain dedupe decide` records your choice for each Google contact that waits for a decision, and every choice can be undone.**

<!-- behavior-change: google_contact_mirrors_link_gbra782 -->

### Added
- `gbrain dedupe decide --source <id> --file <choices.json> [--dry-run]` takes one line per waiting contact: `link` to a named person page, `new` to create a person page and link it, `reject` to drop one candidate pair, `ignore` to stop proposing the contact, or `skip`. All lines are recorded in one run, in git when the brain has a repository and in the database otherwise, so a rebuild keeps them. Each line prints the command that undoes it.
- `gbrain dedupe undo` forgets a recorded choice and puts the contact back in the review list.
- `gbrain link-contacts --json` without `--apply` lists the contacts that wait, with each candidate page, why the contact waits (`several_people` or `name_disagrees`) and which kind of key matched.

### Changed
- Google contact linking treats copies of one person page held in several sources (same slug, same matched email or phone, agreeing names) as one person, and links the contact to the default source's copy. Copies that disagree on the key, or that you marked as different people, still wait for you.
- A rejected candidate is cleared for that contact only; other contacts can still be proposed that page.
