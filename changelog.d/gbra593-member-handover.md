**When someone leaves a company brain, `gbrain access member handover <member>` gives the pages they kept to themselves to the owner, and `--undo` puts them back.**

### Added
- `gbrain access member handover <member>` previews, then with `--yes --expect <plan_hash>` applies, giving a disabled or removed member's pages to someone who still reads them. Pages only they read and folder rules naming only them go to the owner by default; pages others read stay as they are; nothing opens to every reader unless asked. `--set kept=<member>`, `--set folder=everyone`, `--set shared=drop` and `--set source=<member>` change a group's target.
- A stopped or partial apply resumes when you run the same command again; `--status <id>` reports when Git has committed the page files; `--undo <id>` restores each page's and rule's recorded readers once the member is enabled again.
- `gbrain doctor` checks `access_pages_read_by_nobody`: pages no enabled member reads remotely, with the handover command when they name a disabled member.
- `gbrain access member disable` and `rm` now print the handover command.

