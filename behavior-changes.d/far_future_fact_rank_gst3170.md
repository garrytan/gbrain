---
kind: fix
---
Newest-first fact reads now rank a fact whose valid_from is in the future by the time it was written, so a fact dated years ahead by mistake no longer stays at the top of entity facts, fact lists and question refresh. Facts dated today or earlier rank by their date as before.
