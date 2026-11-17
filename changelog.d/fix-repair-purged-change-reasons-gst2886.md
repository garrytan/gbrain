**New `gbrain repair purged-change-reasons` finds page-history change reasons that still quote a claim you purged before the #8635 fix, and redacts them after you agree.**

### Added
- Before #8635 was fixed, a sync that read a page's `gbrain-reason` trailer just before a fact purge could still store the purged text as that page version's change reason. `gbrain repair purged-change-reasons` re-reads each reason the purge recorded from the source's Git checkout, counts the page versions that still hold it (for the whole brain and for each source, never printing the text), and with `--apply --expect <hash> --yes` sets exactly those to `[purged]`, the value a purge writes. The same text under another file, or from a commit that gives the file two reasons, is kept unless you pass `--include-ambiguous`. It runs only when you name it, and never on upgrade, sync or doctor. Repo-less sources have nothing to check and the preview still succeeds. Pages, files and Git history are not changed (GST-2886, follow-up to #8635).

<!-- behavior-change: purged_change_reasons_repair_gst2886 -->
