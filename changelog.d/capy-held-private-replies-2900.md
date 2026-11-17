---
important: security
---
**A private fact restated as world and held for the owner's accept stays hidden in more places from callers who cannot read the private fact: `think` leaves it out, the reply to the held write reads like an ordinary save, and a restatement written onto another page about the same entity is held too.**

<!-- behavior-change: held_private_replies_2900 -->

### Fixed
- `think` now leaves a held fence row out of the pages it reads and the evidence it delivers for callers who cannot read the private fact, as get_page and search already do. The owner's callers and the local CLI read the same as before.
- The reply to a held write (`remember`, `put_page` and the other page writes) named the owner's proposal in `contested.proposal_ref`, which told a caller who guessed a claim that a more private copy of it exists. For a caller who cannot read that private fact, the reply, its `outcome` and `write_request` copies, `get_write_request` and `list_write_requests` now leave the reference out, so the reply reads like a saved write. The owner's callers, the local CLI and callers who can read the private fact still get it, and a `contested` reference for any other reason (a write that tried to replace a more trusted fact) is unchanged.
- A page write whose `## Facts` row restated a more trusted private fact about the page's own entity, kept off that page (a remembered fact with no page row, or a row on a holding page), was stored as world. It is now stored private with a proposal, like a restatement on the same page, and `gbrain trust confirm tp<N>` makes it world. Like the same-page hold, this applies to the owner's own local writes and sync too, when the private copy is more trusted than the writer.
- A credential with a `private_facts: granted_sources` grant reads a held row again in `get_page`, search and `think`, as it did before the held-row page reads, when it can read every private copy the row restates. A row restating a copy the grant can't read (on a member or restricted page, or on no page) stays held from it. Known: such a credential's `put_page` still restores a held row it can see, so its edit or delete of that row doesn't stick and an edit can leave two rows.
- A remote `get_page` or `get_versions` of a page stored in segments reported a size that counted held rows. It now reports the size of what the caller can read.
- Still not held: a restatement about another entity, a reworded claim, captured prose and extracted facts. A writer that cannot read the private fact still can't read its own held row back (page reads and recall leave it out) until the owner accepts it, which a saved row would not do.
