---
title: "Certificate Expiry Renewal Runbook"
type: note
---

Use this procedure when a monitoring alert warns that a TLS certificate will lapse within 30 days, or when a login failure suggests one already has. Step one: identify the certificate in the inventory and confirm its owner. Step two: generate a new key pair and request issuance from the internal authority. Step three: deploy to staging and verify the chain with the standard handshake check. Step four: roll the new certificate to production one region at a time, restarting the identity pods gradually. Step five: confirm the new dates in the dashboard and close the alert. Automated renewal is enabled for most services, but the identity service and legacy billing endpoints still need manual handling. If logins are already failing, page the security on-call, Iris Example, and skip staging only with approval. This document came out of the September review.
