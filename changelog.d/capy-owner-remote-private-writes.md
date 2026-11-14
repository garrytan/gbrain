**The brain owner's own remote agents can now edit, append to and relabel the private pages they already read, and everyone else is still refused.**

### Changed

- A credential bound to the brain owner, with write scope and speaking for itself, may change a `visibility: private` page it reads with `put_page`, `edit_page` or `append_page`, and relabel it (for example to `visibility: world`). A `put_page` that leaves out `visibility` or `readable_by` keeps the stored ones, and the page revision and the journaled request name the owner's credential. Other members, unbound tokens and OAuth clients, attested calls, the owner's credential without write scope and writes to pages whose readers or folder rule leave the owner out get `page_not_found` (or their earlier refusal) as before, on repo-less and repo brains alike.

<!-- behavior-change: owner_remote_private_writes_gst2091 -->
