---
kind: add
---
gbrain dedupe link-contacts --source <id> counts how a Google source's contact pages would link to your person pages, and --apply links each one to the one person page with exactly the same email or phone, then keeps the contacts each sync changes linked (google_contacts.identity_links). Two or more matches, or one person whose page has another name, wait for you in gbrain sync status, a name alone never links, and no page is edited. gbrain dedupe reject on a contact and person pair now removes that link for good, for Apple Contacts links as well. --unlink removes every link the source made.
