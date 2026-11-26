---
kind: fix
---
A --since date that is not a real calendar day, such as 2026-02-30, is now refused with a usage error by agent logs, access read-log, beliefs, repair and recall, and by the recall tool's since parameter. Before, the date rolled over into the next month and the command quietly used a different window. The code-callers, code-callees, code-def and code-refs commands now refuse a --limit that is not a whole number of 1 or more, or that has no value, instead of failing with an unknown error or quietly reading 5abc as 5, 0 as an empty list and 1.5 as 1.
