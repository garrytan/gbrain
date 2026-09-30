---
title: "Certificate Expiry Login Outage"
type: note
---

On September 9 at 08:00 UTC the TLS certificate for the internal identity service expired, and every employee and customer login failed with a handshake error. The certificate had been issued manually two years earlier by Henry Example, who had since moved teams, and the renewal reminder went to a mailbox nobody read. Diagnosis took 25 minutes because the errors looked like a network problem in the Harbor Street office. Iris Example issued a replacement certificate and restarted the identity pods; logins recovered at 08:47. Root cause: manual certificate lifecycle with no monitoring on expiry dates. Remediation: inventory all certificates, alert at 30, 14, and 7 days before expiry, and move to automated renewal. The step-by-step procedure was written afterwards as a separate runbook for on-call engineers.
