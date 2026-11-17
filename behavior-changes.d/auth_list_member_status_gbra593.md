---
kind: add
---
gbrain auth list --json adds a member_status field to each token: enabled, disabled or removed for the member the token is bound to, missing when that member row is gone, and null for an unbound token. The status field keeps its meaning (active or revoked). The text table prints refused for an active token whose member is disabled or removed, because the brain refuses that token at verification (access_member_disabled).
