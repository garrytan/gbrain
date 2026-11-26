---
kind: fix
---
forget on a read-only mirror source with no canonical owner still refuses a fact that a page file in the mirror carries, and now says why: the error names the source as a read-only mirror (detail read_only_mirror) and tells you to remove the claim in the upstream repository and run gbrain sources refresh <id>, or to make the source writable with gbrain sources mirror-writable <id> and bind it before forgetting again. Before, it said only that the source had no designated canonical owner.
