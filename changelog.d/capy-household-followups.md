**Household records stay private in a few more edge cases, and ordinary dates are no longer mistaken for card numbers.**

### Fixed
- A subject page that sync deleted and wrote again can no longer become a child while household records about it are still shared with helpers; `household_add --child` (about_role child) narrows those records to adults first, even when the subject page was deleted.
- `household_add` answers a household record the caller cannot read as `page_not_found`, the same as any hidden page, instead of `household_exists`, so it no longer reveals that a private record exists.
- `household_add` checks a subject role change before it writes the record, so a refused role change leaves no record behind.
- `gbrain household replace` re-places every record, archived ones included, however many there are, instead of refusing above 2,000 records.
- The account-number check catches a frontmatter key shaped like a card or account number without repeating it back, no longer reads date ranges as card numbers, and no longer refuses plain `bank` or `card` keys.
