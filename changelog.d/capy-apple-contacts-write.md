**Your agent can now change your Apple Contacts when you ask, through GBrain Helper on your Mac, with a saved copy, a journal and undo; it ships switched off.**

<!-- behavior-change: apple_contacts_write_gst3278 -->

### Added
- `gbrain apple-contacts write <verb>` sends one owner-signed change to GBrain Helper's new write route, `POST /v1/contacts/batch`: `fill`, `add-value`, `create` and `group-add` only add; `set`, `remove-value`, `group-remove`, `delete` and `merge` change or remove, and also need `apple_contacts.destructive_writes` on. Every call carries the owner's words as `--owner-instruction`. `gbrain apple-contacts status` shows the switches.
- Three switches, all off by default: `apple_contacts.write` (`off`, `dry_run`, `on`), `apple_contacts.destructive_writes`, and on the Mac `gbrain-apple-helper contacts-write on|off`.
- GBrain Helper saves a daily copy of every contact (0600, kept 7 days) before its first change, journals each change before and after, reads each card back, refuses linked cards and duplicate creates, keeps daily limits (50 new cards, 25 deletes, 200 edits) and puts a batch back with `gbrain-apple-helper contacts-restore --batch <id> --apply`.
- An enrichment token with the `write:contacts:enrich` scope may only add, and every card it touches joins the group "Added by GBrain". Nothing in this release uses it yet.
- macOS now asks for Contacts access with wording that says the helper can update contacts, saves a copy first, and that every change can be undone.
