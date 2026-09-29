---
title: "Payment Gateway Timeout Incident"
type: note
---

On June 3 checkout latency rose sharply when the third-party payment vendor began responding in over 20 seconds. Our client library used a 30-second timeout with three automatic retries, so each stuck request held a worker thread for up to 90 seconds. Within eleven minutes the checkout service exhausted its thread pool and began rejecting all traffic, including carts that never reached payment. Erin Example declared the incident and disabled retries through a feature flag, which restored capacity. Impact lasted 37 minutes and affected about 12% of sessions. Root cause: unbounded retries with no circuit breaker. Fixes: reduce the timeout to five seconds, cap retries at one, add a circuit breaker, and isolate payment calls into their own thread pool. A broader discussion of what the team learned appears in the session held later that month.
