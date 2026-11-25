**Household records stay private in a few more edge cases, and ordinary dates are no longer mistaken for card numbers.**

### Fixed
- A subject page that sync deleted and wrote again can no longer become a child while household records about it are still shared with helpers; `household_add --child` (about_role child) narrows those records to adults first, even when the subject page was deleted.
- `household_add` answers a household record the caller cannot read as `page_not_found`, the same as any hidden page, instead of `household_exists`, so it no longer reveals that a private record exists.
- `household_add` runs every check before it writes anything, so a refused role change, a hidden subject or a reused `request_id` leaves no record and no changed subject behind. A subject the caller cannot read is answered as `page_not_found` even when it already has the requested role.
- Over remote MCP, only the brain owner's connection can make a subject a child with `household_add`; other connections get one `household_reclassify` refusal that does not depend on which records exist.
- On a brain that serves several people, a household record with no reader list counts as shared with helpers, so its subject cannot be made a child until `gbrain household replace` narrows it.
- `gbrain household replace` re-places every record, archived ones included, however many there are, instead of refusing above 2,000 records, and no longer skips one when another is deleted while it runs.
- The account-number check catches a frontmatter key shaped like a card or account number without repeating it back, no longer reads date ranges as card numbers, and no longer refuses plain `bank` or `card` keys; `account`, `acct`, `iban` and `routing` keys still count.
