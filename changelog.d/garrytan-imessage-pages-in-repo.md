**On a personal brain with a Git checkout, iMessage chat-day pages are now files in that checkout, kept and pushed like your other pages, with one commit per sync.**

<!-- behavior-change: imessage_pages_in_checkout_gst3022 -->

### Added
- An iMessage source writes each chat day to `.gbrain-owned/<source-id>/imessage/<chat>/<day>.md` in the default source's checkout when the brain is personal and not managed. Each sync that changed something makes one commit before the database rows; a quiet sync commits nothing. The first commit adds an `OWNER.json` and a README that names where the checkout pushes.
- `gbrain sources status` shows `pages_in` for these sources: the folder or the database (and why), the last commit, whether it is pushed, and how many days are held.
- `gbrain sources rebind <id>` records a changed push destination after a preview (`--yes` to apply); until then the pages stay in the database only.
- `gbrain sync --source <id> --full` rebuilds the database pages from the folder when GBrain Helper is not reachable.

### Changed
- The pages stay in the database only, with a `[gbrain notice owned_folder_database_only]` line naming the reason, on a brain that is shared or managed, when Git ignores or filters the folder, or when the push destination changed since the first write. A repo-less brain is unchanged.
- A day file gbrain did not write, or one edited by hand, is never overwritten or deleted (`owned_folder_conflict`); that day stays in the database. Under `secrets.on_push refuse`, a day that looks like it holds a secret is kept out of Git (`owned_day_secret_held`). A day file is removed only when the helper reports that day empty, and a sync that would remove more than 20 day files, or more than a tenth of them, removes none.
- The default source's sync (including `--include-hidden '**'`), `gbrain import`, `file_upload`, `gbrain git commit-push` and its `--untrack`, `frontmatter validate --fix`, `frontmatter generate --fix` and company inspection leave `.gbrain-owned/` alone, and `put_page`, `edit_page`, `delete_page` and the other page writes into such a source are refused.
- `gbrain sources remove` (and the MCP `sources_remove`, the expired-archive purge and `sources purge`) removes the source's files in one commit, keeps any file it cannot prove it wrote, and says the remote's history still holds what was pushed; `--keep-storage` leaves them.
