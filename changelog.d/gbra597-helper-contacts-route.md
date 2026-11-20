**GBrain Helper on a Mac can share your Apple Contacts with your gbrain, read-only, once you turn it on.**

### Added
- `gbrain-apple-helper contacts-setup` asks macOS for Contacts access once, from the helper itself, then turns the `contacts` source on. `contacts-setup --off` turns it off again.
- `GET /v1/contacts/changes` returns every contact, then only what changed since your last cursor: adds, edits, deletes and group changes. It needs a token with the new `read:contacts` scope, on the helper's local listener or, for the peers you listed, its Tailscale listener.
- Only names, nickname, organization, job title, emails, phones and group names leave the Mac. Notes, birthdays, addresses and photos never do, and the helper never changes a contact. To find changes it keeps one hash per contact in a file only you can read.
- Turning a source on or off in the helper's config now applies on its next request, with no restart.

### To take it back
- Run `contacts-setup --off`, and switch GBrain Helper off under System Settings > Privacy & Security > Contacts (or run `tccutil reset AddressBook io.gbrain.apple-helper`).
