---
kind: fix
---
Re-extracting a conversation page's facts (extract-conversation-facts --force, or a newer extractor version) no longer deletes the page's previous facts. Each previous fact is now expired and keeps its row, so recall without --include-expired shows only the new set while the old claims stay in history; before, a claim the new pass did not reproduce was deleted with no trace. Only the page's extraction checkpoint rows are still replaced. A page over the extraction window now counts only its active facts when deciding whether to keep them.
