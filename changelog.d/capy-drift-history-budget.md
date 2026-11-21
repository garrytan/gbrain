**A sync that re-screens many held notes against their files' earlier versions now spends at most two minutes per pass reading Git history, keeps what a cut-short read already found, and keeps reporting progress while it reads.**

### Fixed
- Reading a held note's earlier versions walks every commit that changed its file, so on a deep repository a pass over thousands of such holds could spend many minutes in Git. A pass now stops starting new history reads after two minutes. A note it didn't get to keeps its hold, is counted as `driftHistoryUnread` in the pass's counts, and is re-screened after `gbrain sources retry-held`.
- A history read that timed out used to drop everything it had read for its group of notes. It now keeps the versions it found, so those notes can still clear.
- While a long history read streams, the pass now reports progress every second or so instead of only when the read ends, so a slow read no longer looks stalled and a cancelled sync stops promptly.
- The read now collects 5 distinct versions per file, which is what sync and `gbrain repair file-drift --held` use, instead of 50. A file listed twice no longer keeps its group's read from stopping early.
