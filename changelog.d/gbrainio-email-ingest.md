**Gmail can now flow into your brain through a gbrain.io terminal, so gbrain stores no mail credential, and private and bulk mail stay out of model reads.**

### Added
- `gbrain sources add <id> --kind google --access gbrainio --account <address>` reads Gmail through the `gbrainio` command instead of a Google token. Each sync reads the last `--history-days` of mail (newest first, resuming where it stopped) and fetches a thread again only when it has a new message. `--gbrainio-command` sets the full path when `gbrainio` is not on `PATH`. Every mail answer must name the account the source was added for, and a gbrain.io usage limit is handled like a Google rate limit.
- Threads on a gbrain.io source are sorted before anything is written: a normal page when you wrote in the thread, starred it or marked it important, or someone in it has a person page; a searchable record page that no model reads for other mail; no page for bulk mail; and an owner-only page for senders on a private list.
- `--private-senders-file <path>` (one address or `@domain` per line) gives every thread with a listed sender an owner-only page that no model reads, on gbrain.io and token sources alike. A missing, unreadable or empty file stops the sync before it writes anything. When you add someone, the next syncs rewrite their existing pages as private, at most 200 threads per sync; a page whose thread is gone from Gmail is never deleted for that.

### Changed
- Email pages marked `extract_atoms: false` are no longer sent to the chat model by the open-loops catch-up or the loop extraction job.
