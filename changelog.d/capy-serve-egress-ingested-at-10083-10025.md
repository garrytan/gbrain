---
important: data-loss
---
**Read-write `gbrain serve` processes stop re-downloading a publishing write's whole journal row on every poll, and provenance repair and `put` keep a page's existing `ingested_at`.**

### Fixed
- Every read-write `gbrain serve` (and any other full writer) on a host polled for unfinished publications and downloaded each publishing write's full journal row, its content and before-image included, twice on each poll (about once a second) for as long as another process was publishing it. In the report, one write to a 416 KB page cost 166 to 186 MB of database traffic on a host with 17 to 19 writer processes. The poll now reads only the row's id and state, and reads the full row once it holds the folder's lock; a write whose staged file changed under it now waits 30 seconds between polls, like one whose page file changed, instead of one. Reported by @joelsartain (#10083); first fixed by @Masashi-Ono0611 and @joelsartain.
- `gbrain repair provenance --include-ambiguous --apply` removed `ingested_at` from pages whose earliest saved version had none, and counted them as repaired. A restore now never removes an existing `ingested_at` (#10025).
- On a managed brain, a `put` to a page whose `ingested_at` was only in its frontmatter (written before gbrain stored it in its own column) replaced it with the time of the write. The put now keeps the stored value, and leaves gbrain's own column empty, so provenance repair still checks that value against the page's history (#10025).
