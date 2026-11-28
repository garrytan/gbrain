---
kind: fix
---
An embedding job you queue with gbrain jobs submit embed, embed-backfill or embed-catch-up and approve with --max-usd now stops when it reaches that amount; before, the approval was dropped and the job ran under only the backfill's default cap, or none. These jobs now carry their approval on the row, so restart every jobs worker after upgrading: an older worker cannot claim them. Under any dollar cap, each embedding request is now held at the most input it can bill (one token per byte of text, capped per input) and settled to the provider's reported tokens, so a capped run can stop a little before its cap, and a request whose usage the provider did not report stays charged at that hold. Uncapped runs are unchanged.
