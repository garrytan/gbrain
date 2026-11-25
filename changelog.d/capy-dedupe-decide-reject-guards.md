**`gbrain dedupe decide` no longer undoes a choice you already made by accident.**

### Fixed
- A `link` line for a contact and a person page you had already marked as different people is now refused with `rejected_pair`, and the refusal names the `gbrain dedupe undo` command that clears the earlier choice. Before, the link quietly replaced the reject, and undoing the link then lost the reject too.
- A `reject` line that names the contact itself is now refused with `invalid_candidate`. Before, it recorded a broken one-member decision. To mark a contact as not a person, use `ignore`.
