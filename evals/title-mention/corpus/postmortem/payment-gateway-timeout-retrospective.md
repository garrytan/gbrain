---
title: "Payment Gateway Timeout Retrospective"
type: note
---

Held on June 20 with Erin Example facilitating, this session looked back at the June checkout slowdown caused by the payment vendor. Participants said the on-call engineer spent eight minutes finding the right dashboard, because gateway latency was not on the main checkout board. We agreed to add p99 vendor latency panels and a synthetic payment probe. Frank Example pointed out that the vendor status page was updated 25 minutes late, so we should not rely on it. What went well: the feature flag worked quickly and communication with support was clear. What went poorly: nobody owned the retry configuration. Decisions: assign retry settings to the checkout team, run a quarterly game day simulating vendor slowness, and add a circuit breaker template to the service starter kit. The technical timeline and metrics live in the original incident report.
