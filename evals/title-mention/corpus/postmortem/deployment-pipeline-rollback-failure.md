---
title: "Deployment Pipeline Rollback Failure"
type: note
---

During the October release the automated rollback for the order service did not work. A bad schema migration made the new version crash, and the pipeline attempted to redeploy the previous image, but the migration had already dropped a column the older code required. Jack Example spent 70 minutes restoring the column from a snapshot before the service recovered. Customers saw errors on order history pages, though new checkouts still worked. Root cause: migrations ran before health checks and were not backward compatible, so reverting was never a safe option. Fixes: adopt expand-and-contract migrations, run schema changes as a separate gated stage, and rehearse rollbacks in staging every release. We also added a pipeline check that blocks column drops in the same release as the code change that stops using them.
