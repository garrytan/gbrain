---
kind: fix
---
Conversation fact extraction now saves a fact private when it restates a claim the speaker asked to keep quiet ("keep this quiet for now, but ...", "off the record", "don't tell anyone", or a sentence that opens with "between us,"), even on a page whose facts are otherwise shared. Other members' credentials and unbound tokens stop seeing those facts; the brain owner sees them as before. Facts extracted before this release keep their stored visibility, and a claim forgotten or purged earlier stays out. On a managed brain, a writer still on an older release saves such a fact at the page's visibility.
