---
kind: fix
---
The query facts block now marks a fact another saved fact disputes, as recall already did. When a fact is in a pending gbrain decide supersede proposal, its row ends with (contested by #ID) naming the other fact, but only when the caller can read that other fact (remote callers see world facts only; private provenance and the trust floor apply). If the lookup fails, the rows carry no label and the response reports the degraded stage contested_unavailable.
