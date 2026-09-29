---
title: "Primary Database Failover Outage"
type: note
---

On March 14 at 02:10 UTC the primary database node in the Harbor Street data center lost its storage volume. Automatic failover to the replica was expected to finish within 30 seconds, but the replica lagged by 41 minutes because a long-running batch job started by Bob Example had saturated replication. Orders and login requests returned errors for 52 minutes. Engineers led by Alice Example promoted the replica manually after confirming the lag had cleared, then rebuilt the old primary as a new replica. Customer impact was roughly 8,400 failed checkouts. Root cause: the failover controller did not check replication lag before promotion, and the paging rule for lag only fired after 30 minutes. Immediate fixes: lower the lag alert threshold to five minutes and pause batch jobs during failover drills. Detailed action items and owners are tracked separately in the followup review.
