---
kind: fix
---
gbrain sources status --json now counts git_holds.by_code over every hold of the source. Before, the counts came only from the held files the listing read (at most 500), so a source with more holds under-counted each code. A code with no held file in the listing has no example. If the per-code count cannot be read, by_code falls back to the listed files and by_code_complete is false.
