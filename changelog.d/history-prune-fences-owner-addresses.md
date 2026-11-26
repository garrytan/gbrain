**You can now trim old page history, clear the outside-fences warning for imported transcripts in one pass, and tell Gmail open loops about your other mailboxes; a Gmail backfill held up by one rate-limited thread now keeps moving.**

### Added
- `gbrain pages prune-history` removes saved versions from pages' history: one page, a prefix, a type or the whole brain, keeping the newest N, only versions older than a date, or named versions. It previews first and applies only with `--yes --expect <plan_hash>`; the live page never changes. Reported by @oakleaf, with measurements from @Walliiee (#9737).
- `gbrain transcripts accept-fences` reviews doctor's `outside_content_fences` warning for imported chat transcripts in one preview-then-apply pass. Only conversation pages the transcript importer wrote qualify, and a page returns to the list when its rows change or another writer edits it; re-embedding its rows does not bring it back. Reported by @cupit01 (#9427).
- `loops.owner_addresses` lists the owner's other mailboxes. Mail from them opens no reply-owed loop, and a reply sent from one closes the loop as answered. Reported and first fixed by @codingfeng-fufu (#10094, #10230).

### Fixed
- A Gmail backfill whose batch hit a rate limit or a failed thread kept its floor where it was, so every sweep fetched the same threads again and the floor never moved. The walk now banks the threads that landed ahead of the failure, and a managed sweep banks its first landed thread at once, so a sweep cut off by its deadline still moves the floor. The check behind each banked step is best-effort: if it fails, the sweep carries on, and after a gbrain.io usage limit no further searches are sent. Reported by @PropFunderBrett (#10473).
