---
title: "Primary Database Failover Followup"
type: note
---

This review tracks the action items that came out of the March database failover. Carol Example owns the failover controller change so that promotion is blocked when replication lag exceeds 60 seconds; it shipped in release 4.12. Dan Example reduced the replication lag alert from thirty minutes to five and verified it in a staging drill. The batch job scheduler now defers heavy jobs whenever a replica is behind. Two items remain open: a quarterly failover drill on the Harbor Street cluster, and a runbook rewrite covering manual promotion. We also measured a second drill in April: automatic failover completed in 22 seconds with zero failed requests. The original timeline, customer impact figures, and root cause analysis are in the earlier outage write-up, so this page only covers remediation status, owners, and due dates.
