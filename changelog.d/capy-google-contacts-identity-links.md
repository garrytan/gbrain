**Google Contacts pages can now be linked to the person pages they describe, by exactly the same email or phone.**

`gbrain dedupe link-contacts --source <id>` counts how a Google source's contact pages would link and changes nothing. `--apply` links each contact page to the one person page with exactly the same email or phone, the rule Apple Contacts already uses, and keeps the contacts each sync changes linked. A contact that matches two or more people, or one person whose page has another name, waits for you in `gbrain sync status`, a name alone never links, and no page is edited. `gbrain dedupe reject` on a contact and person pair removes that link for good, for Apple Contacts links too, and `--unlink` removes all of a source's links.

<!-- behavior-change: google_contacts_identity_links_gst3609 -->

### For contributors
- `src/core/google/contact-identity.ts` settles the links through `linkContactPage` (apple-contacts/identity-match.ts), which now takes a link origin, the owner's "different" sets and a dry-run flag, and returns `different` for a single match the owner rejected. With `contactName` it returns `name_disagrees` for a single match whose page name clearly disagrees (`namesAgree`, entities/name-variants.ts), which waits as a review.
- `google_contacts.identity_links` (default off) is the switch `sweepContacts` reads; `--apply` and `--unlink` set it.
- test/google-contacts-identity-links.test.ts covers the dry run, apply, reviews, reject, a removed contact, another writer's link and `--unlink` on a repo-less brain.
