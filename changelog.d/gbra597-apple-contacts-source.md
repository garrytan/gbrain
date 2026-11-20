**Your Mac's address book can feed your brain: the new apple-contacts source pulls contacts from GBrain Helper every 15 minutes into private, owner-only contact pages, links each one to the matching person by exact email or phone, and adds company, job title and groups to that person's page.**

### Added
- `gbrain sources add <id> --kind apple-contacts --helper-host <host> --token-file <0600 json>` (with `--helper-port`, `--proxy socks5h://host:port`, `--contacts-dir`, `--record`, `--dir`, `--sync-interval-min`) reads `GET /v1/contacts/changes` from GBrain Helper, page by page with a saved cursor. Contact pages live under `contacts/apple/`, are `visibility: private` and stay in the database even on a brain with a Git repository.
- A contact whose email or phone equals the one on exactly one person page is linked to that person (an identity link); a contact matching two or more people waits in `gbrain sync status` under identity reviews until `gbrain dedupe` settles it. Names never match.
- The matched `people/` page gets a small block with company, job title and group names only. Phones and emails stay on the owner-only contact pages. The block is rewritten in place, removed when the match goes away, and nothing outside it changes except the agent-written trust marker every automated edit adds.
- A full re-read that comes back empty, or would delete more than 20% of the contacts, writes nothing (`apple_contacts_delete_floor`). An incremental pull keeps the deletions it receives pending until the end of the run and applies them only if they pass the same floor; held ones show under `held_deletes` in `gbrain sync status` and cancel when the contact comes back. Deleted contacts are soft-deleted and can be restored.
- A helper with its Contacts source turned off stops the run with `apple_contacts_disabled`, which names the config setting to change.
- `gbrain whois` matches phone numbers in any format.

<!-- behavior-change: whois_phone_numbers_gst3256 -->
