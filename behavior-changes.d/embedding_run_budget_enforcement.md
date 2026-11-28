---
kind: fix
---
Embedding runs now honor a configured embed.backfill_max_usd and queued approvals across foreground and background work. Capped requests reserve the provider token ceiling before sending, and unknown pricing or provider limits stop the request. Previously committed writes stay committed if their embedding effect is deferred.
