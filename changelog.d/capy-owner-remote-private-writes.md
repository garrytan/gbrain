**The brain owner's own remote agents can now edit, append to and relabel the private pages they already read, and everyone else is still refused.**

### Changed

- A credential bound to the brain owner, with write scope and speaking for itself, may change a `visibility: private` page it reads with `put_page`, `edit_page` or `append_page`, or with `put_pages` and staged uploads (`begin_page_upload` and `commit_page_upload`), and relabel it (for example to `visibility: world`). A `put_page` that leaves out `visibility` or `readable_by` keeps the stored ones, an empty `visibility` counts as left out, and a page private only through a privacy alias, a pinned question, a derived type or a private origin is saved as `visibility: private` (keeping its `pinned_question`) by any of these writes that states no visibility; the page revision and the journaled request name the owner's credential. Other members, unbound tokens and OAuth clients, attested calls, the owner's credential without write scope and writes to pages whose readers or folder rule leave the owner out get `page_not_found` (or their earlier refusal) as before, on repo-less and repo brains alike, and so does any write to a soft-deleted private page and a credential fenced to slug prefixes. A staged upload over the single-string ceiling is now held to the same `readable_by` check as a smaller one.

### Fixed

- Purging a private page now also labels a life-chronicle event private when the event's own `derived_from` names that page; if the label can't be written, the page stays soft-deleted instead of being purged.
- The purge's in-transaction check for derived pages reads only the pages that name the purged page instead of scanning the whole source, so single purges on large brains are much faster.
- `gbrain pages purge-deleted --dry-run` now lists exactly what `--yes` would purge, including parked pages a consented run would release, and nothing is written before consent.
- A purge held to keep derived pages private now tells the owner to finish it with `gbrain delete <slug> --purge --source-id <id>` as a new request, which writes the purge tombstones.

<!-- behavior-change: owner_remote_private_writes_gst2091 -->
