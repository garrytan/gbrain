**Purging a page now removes the secret store originals only that page held.**

### Changed
- `gbrain delete <slug> --purge`, the batch hard delete and the expiry of a deleted page now remove the places the redactor recorded on that page, and every sealed original no other page and no publish commit still references. An original another page holds, or that a redacted publish commit points to, stays. A place recorded under a slug the page had before a rename goes with the page.
- Renaming a page moves the places the redactor recorded on it to the new slug, so a later purge of a page that takes the old slug leaves them alone.
- `gbrain secrets backup --restore` adds the recorded places of an entry the store already holds, and skips an original whose every place was on a page this brain does not hold (`skipped_no_page`), so it never brings back what a purge removed. When it skips every entry that way, it refuses with `invalid_params` and writes nothing.
- `gbrain doctor`'s `secret_store` check counts sealed originals no page or commit references.

### Known limits
- Backups uploaded to the storage bucket before a purge still hold that page's sealed original (encrypted, under the store key). Delete those objects from the bucket when it must be gone from there too.
